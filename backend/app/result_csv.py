"""Participant-by-event assignment export and registration participation checks."""

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass

from .importer import ImportError, is_accepted, read_csv_rows
from .models import (
    EVENT_NAMES,
    Assignment,
    CsvRoleAssignment,
    ParticipationCheckResponse,
    ParticipationIssue,
    Role,
    SolveRequest,
)

ROLE_PREFIX = {Role.COMPETITOR: "", Role.JUDGE: "J", Role.SCRAMBLER: "S", Role.RUNNER: "R"}
ROLE_ORDER = {role: index for index, role in enumerate(ROLE_PREFIX)}
ASSIGNMENT_TOKEN = re.compile(r"([JSR]?)([1-9][0-9]*)", re.ASCII)


def csv_name(name: str) -> str:
    # Preserve the spreadsheet formula protection used by the previous export.
    return "'" + name if name.lstrip().startswith(("=", "+", "-", "@")) else name


def registration_name(name: str) -> str:
    """WCA registration names append the native name after the English name."""
    return name.partition("(")[0].strip()


def export_csv(request: SolveRequest, assignments: list[Assignment]) -> str:
    cells: dict[tuple[str, str], list[Assignment]] = defaultdict(list)
    for item in assignments:
        cells[item.competitor_id, item.event_id].append(item)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Name", *(event.event_id for event in request.events)])
    for person in sorted(request.competitors, key=lambda person: person.name):
        writer.writerow(
            [
                csv_name(registration_name(person.name)),
                *(
                    ";".join(
                        f"{ROLE_PREFIX[item.role]}{item.group}"
                        for item in sorted(
                            cells[person.competitor_id, event.event_id],
                            key=lambda item: (ROLE_ORDER[item.role], item.group),
                        )
                    )
                    for event in request.events
                ),
            ]
        )
    return output.getvalue()


def normalize_name(name: str) -> str:
    return " ".join(name.split())


@dataclass
class RegistrationEntry:
    name: str
    events: set[str]
    wca_id: str | None
    birth_date: str | None


@dataclass
class ResultEntry:
    name: str
    events: set[str]
    roles: list[CsvRoleAssignment]
    groups: set[tuple[str, int]]
    competitor_groups: dict[str, int]


def read_registrations(
    content: bytes, *, include_without_events: bool = False
) -> list[RegistrationEntry]:
    columns, rows = read_csv_rows(content)
    if "Name" not in columns:
        raise ImportError("登録CSVに必要な列がありません: Name")
    if not {"Registration Status", "Status"}.intersection(columns):
        raise ImportError("登録CSVにRegistration Status または Status 列が必要です。")
    event_ids = [column for column in columns if column in EVENT_NAMES]
    if not event_ids:
        raise ImportError("登録CSVにWCAの競技列（333、444など）が見つかりません。")
    participants = []
    for row_number, row in enumerate(rows, start=2):
        if not is_accepted(row):
            continue
        name = row["Name"].strip()
        if not registration_name(name):
            raise ImportError(f"登録CSVの{row_number}行目: 英語名は必須です。")
        events = set()
        for event_id in event_ids:
            value = row[event_id].strip()
            if value not in ("0", "1", ""):
                raise ImportError(
                    f"登録CSVの{row_number}行目: {event_id}列は0または1で指定してください。"
                )
            if value == "1":
                events.add(event_id)
        if events or include_without_events:
            participants.append(
                RegistrationEntry(
                    name=name,
                    events=events,
                    wca_id=row.get("WCA ID"),
                    birth_date=row.get("Birth Date"),
                )
            )
    if not participants:
        raise ImportError("参加競技がある承認済み参加者が見つかりません。")
    return participants


def registration_participation(content: bytes) -> list[tuple[str, set[str]]]:
    return [(person.name, person.events) for person in read_registrations(content)]


def read_results(content: bytes) -> tuple[list[str], list[ResultEntry]]:
    columns, rows = read_csv_rows(content)
    if "Name" not in columns:
        raise ImportError("結果CSVに必要な列がありません: Name")
    event_ids = [column for column in columns if column != "Name"]
    if not event_ids or any(event_id not in EVENT_NAMES for event_id in event_ids):
        raise ImportError("結果CSVはName列とWCA競技IDの列（333、444など）で指定してください。")
    participants = []
    for row_number, row in enumerate(rows, start=2):
        name = row["Name"].strip()
        if not name:
            raise ImportError(f"結果CSVの{row_number}行目: 名前は必須です。")
        events = set()
        roles = []
        groups = set()
        competitor_groups = {}
        for event_id in event_ids:
            cell = row[event_id].strip()
            if not cell:
                continue
            competition_groups = 0
            for token in cell.split(";"):
                match = ASSIGNMENT_TOKEN.fullmatch(token.strip())
                if not match:
                    raise ImportError(
                        f"結果CSVの{row_number}行目（{name}）、{event_id}列: "
                        "数字またはJ・S・Rと数字をセミコロンで区切ってください。"
                    )
                if not match[1]:
                    competition_groups += 1
                    events.add(event_id)
                if len(match[2]) > 3 or int(match[2]) > 100:
                    raise ImportError(
                        f"結果CSVの{row_number}行目（{name}）、{event_id}列: "
                        "グループ番号は1〜100で指定してください。"
                    )
                group = int(match[2])
                groups.add((event_id, group))
                if match[1]:
                    roles.append(CsvRoleAssignment(event_id=event_id, group=group, role=match[1]))
                else:
                    competitor_groups[event_id] = group
            if competition_groups > 1:
                raise ImportError(
                    f"結果CSVの{row_number}行目（{name}）、{event_id}列: "
                    "競技グループが複数あります。数字のみの項目は1つにしてください。"
                )
        participants.append(
            ResultEntry(
                name=name,
                events=events,
                roles=roles,
                groups=groups,
                competitor_groups=competitor_groups,
            )
        )
    return event_ids, participants


def result_participation(content: bytes) -> list[tuple[str, set[str]]]:
    _, participants = read_results(content)
    return [(person.name, person.events) for person in participants]


def check_participation(registration_csv: bytes, result_csv: bytes) -> ParticipationCheckResponse:
    registrations = registration_participation(registration_csv)
    results = result_participation(result_csv)
    return compare_participation(registrations, results)


def compare_participation(
    registrations: list[tuple[str, set[str]]], results: list[tuple[str, set[str]]]
) -> ParticipationCheckResponse:
    expected: dict[str, list[tuple[str, set[str]]]] = defaultdict(list)
    actual: dict[str, list[tuple[str, set[str]]]] = defaultdict(list)
    for name, events in registrations:
        # Compare protected exported names without stripping literal apostrophes.
        expected[normalize_name(csv_name(registration_name(name)))].append((name, events))
    for name, events in results:
        actual[normalize_name(name)].append((name, events))

    issues = []
    matched_count = 0
    for key in sorted(expected.keys() | actual.keys()):
        input_rows, output_rows = expected[key], actual[key]
        name = (input_rows or output_rows)[0][0]
        if len(input_rows) > 1 or len(output_rows) > 1:
            issues.append(
                ParticipationIssue(
                    kind="ambiguous_name",
                    name=name,
                    message=f"同名の行があり照合できません（登録CSV {len(input_rows)}行、"
                    f"結果CSV {len(output_rows)}行）。名前を区別して再チェックしてください。",
                )
            )
            continue
        registered = input_rows[0][1] if input_rows else set()
        assigned = output_rows[0][1] if output_rows else set()
        if input_rows and output_rows and registered == assigned:
            matched_count += 1
            continue
        if not input_rows:
            kind = "unexpected_participant"
            message = "結果CSVにのみ存在します。承認済みの登録に見つかりません。"
        elif not output_rows:
            kind = "missing_participant"
            message = "登録CSVに存在しますが、結果CSVに行がありません。"
        else:
            kind = "event_mismatch"
            message = "入力CSVと結果CSVの参加競技が一致していません。"
        issues.append(
            ParticipationIssue(
                kind=kind,
                name=name,
                message=message,
                expected_events=sorted(registered),
                actual_events=sorted(assigned),
                missing_events=sorted(registered - assigned),
                extra_events=sorted(assigned - registered),
            )
        )
    return ParticipationCheckResponse(
        passed=not issues,
        checked_count=len(registrations),
        matched_count=matched_count,
        issues=issues,
    )
