"""Convert WCA registration exports; private contact columns are intentionally ignored."""

import csv
import io
from datetime import date
from pathlib import PurePath

from .models import (
    EVENT_NAMES,
    Competitor,
    ImportedEvent,
    ImportResponse,
    PersonalRecord,
)

MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_ROWS = 1000


class ImportError(ValueError):
    pass


def read_csv_rows(content: bytes) -> tuple[list[str], list[dict[str, str]]]:
    if len(content) > MAX_CSV_BYTES:
        raise ImportError("CSVは5MB以下にしてください。")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportError("UTF-8形式のCSVをアップロードしてください。") from error

    try:
        reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
        columns = reader.fieldnames or []
        if len(columns) != len(set(columns)):
            raise ImportError("CSVの列名が重複しています。")
        rows = []
        for row_number, row in enumerate(reader, start=2):
            if row_number > MAX_ROWS + 1:
                raise ImportError("CSVの参加者は1000人以下にしてください。")
            if None in row or any(value is None for value in row.values()):
                raise ImportError(f"{row_number}行目: 列数がヘッダーと一致していません。")
            rows.append(row)
        return columns, rows
    except csv.Error as error:
        raise ImportError("CSVの引用符や改行の形式を確認してください。") from error


def is_accepted(row: dict[str, str]) -> bool:
    status = row.get("Registration Status", "").strip().lower()
    return status == "accepted" if status else row.get("Status", "").strip() == "a"


def age_on_date(birth_date_text: str, competition_date: date) -> int:
    try:
        birth_date = date.fromisoformat(birth_date_text.strip())
    except ValueError as error:
        raise ImportError("生年月日はYYYY-MM-DD形式で必要です。") from error
    age = (
        competition_date.year
        - birth_date.year
        - ((competition_date.month, competition_date.day) < (birth_date.month, birth_date.day))
    )
    if birth_date > competition_date or age > 120:
        raise ImportError("生年月日または大会日を確認してください。")
    return age


def import_registration(content: bytes, filename: str, competition_date: date) -> ImportResponse:
    columns, rows = read_csv_rows(content)
    required = {"Name", "WCA ID", "Birth Date"}
    missing = required - set(columns)
    if missing:
        raise ImportError(f"CSVに必要な列がありません: {', '.join(sorted(missing))}")
    if "Registration Status" not in columns and "Status" not in columns:
        raise ImportError("Registration Status または Status 列が必要です。")
    id_column = next((key for key in ("Registrant Id", "User Id") if key in columns), None)
    if id_column is None:
        raise ImportError("Registrant Id または User Id 列が必要です。")
    event_ids = [column for column in columns if column in EVENT_NAMES]
    if not event_ids:
        raise ImportError("WCAの競技列（333、444など）が見つかりません。")

    competitors: list[Competitor] = []
    seen_ids: set[str] = set()
    excluded_count = 0
    warnings: list[str] = []
    for row_number, row in enumerate(rows, start=2):
        if not is_accepted(row):
            excluded_count += 1
            continue
        person_id = row[id_column].strip()
        name = row["Name"].strip()
        if not person_id or not name:
            raise ImportError(f"{row_number}行目: 参加者IDと名前は必須です。")
        if person_id in seen_ids:
            raise ImportError(f"{row_number}行目: 参加者IDが重複しています。")
        seen_ids.add(person_id)
        try:
            age = age_on_date(row["Birth Date"], competition_date)
        except ImportError as error:
            raise ImportError(f"{row_number}行目: {error}") from error
        registrations: dict[str, PersonalRecord] = {}
        for event_id in event_ids:
            value = row[event_id].strip()
            if value not in ("0", "1", ""):
                raise ImportError(f"{row_number}行目: {event_id}列は0または1で指定してください。")
            if value == "1":
                registrations[event_id] = PersonalRecord()
        if not registrations:
            warnings.append(f"{row_number}行目は参加競技がないため除外しました。")
            excluded_count += 1
            continue
        wca_id = row["WCA ID"].strip() or None
        competitors.append(
            Competitor(
                competitor_id=person_id,
                name=name,
                wca_id=wca_id,
                age=age,
                is_newcomer=wca_id is None,
                events=registrations,
            )
        )

    if not competitors:
        raise ImportError("参加競技がある承認済み参加者が見つかりません。")
    events = []
    for event_id in event_ids:
        count = sum(event_id in person.events for person in competitors)
        if not count:
            continue
        events.append(
            ImportedEvent(
                event_id=event_id,
                event_name=EVENT_NAMES[event_id],
                participant_count=count,
                num_groups=min(4, count),
                num_scramblers_per_group=1,
            )
        )
    warnings.extend(
        [
            "ベスト・平均タイムはCSVに含まれていません。未入力の場合、速度順の評価は行いません。",
            "初参加はWCA IDの有無から推定しています。"
            "免除・運営専任フラグと合わせて確認してください。",
            "グループ数とスクランブラー数は仮設定です。大会の運営計画に合わせて変更してください。",
        ]
    )
    return ImportResponse(
        competition_name=PurePath(filename).stem.removesuffix("-registration"),
        competition_date=competition_date,
        competitors=competitors,
        events=events,
        excluded_count=excluded_count,
        warnings=warnings,
    )
