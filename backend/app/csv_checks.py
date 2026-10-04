"""Independent, selectable checks of an exported assignment matrix."""

from collections import defaultdict

from .importer import ImportError, age_on_date
from .models import (
    CsvCheckIssue,
    CsvCheckKey,
    CsvCheckOptions,
    CsvCheckResponse,
    CsvCheckResult,
    CsvGroupStaffing,
)
from .result_csv import (
    RegistrationEntry,
    ResultEntry,
    compare_participation,
    csv_name,
    normalize_name,
    read_registrations,
    read_results,
    registration_name,
)


def check_person_roles(
    key: CsvCheckKey,
    registrations: list[RegistrationEntry],
    results: list[ResultEntry],
    options: CsvCheckOptions,
) -> CsvCheckResult:
    expected: dict[str, list[RegistrationEntry]] = defaultdict(list)
    actual: dict[str, list[ResultEntry]] = defaultdict(list)
    for person in registrations:
        expected[normalize_name(csv_name(registration_name(person.name)))].append(person)
    for person in results:
        actual[normalize_name(person.name)].append(person)
    issues = []
    for name_key, output_rows in actual.items():
        roles = [role for row in output_rows for role in row.roles]
        if not roles:
            continue
        input_rows = expected[name_key]
        name = input_rows[0].name if input_rows else output_rows[0].name
        if len(input_rows) > 1 or len(output_rows) > 1:
            issues.append(
                CsvCheckIssue(
                    kind="ambiguous_name",
                    name=name,
                    assignments=roles,
                    message="同名の行があるため、役割を担当する人を特定できません。",
                )
            )
            continue
        if not input_rows:
            issues.append(
                CsvCheckIssue(
                    kind="unexpected_participant",
                    name=name,
                    assignments=roles,
                    message="役割がありますが、承認済みの登録に見つからず判定できません。",
                )
            )
            continue
        person = input_rows[0]
        if key == "newcomers":
            if not person.wca_id.strip():
                issues.append(
                    CsvCheckIssue(
                        kind="newcomer_roles",
                        name=name,
                        assignments=roles,
                        message="初参加者（WCA IDなし）に役割が割り当たっています。",
                    )
                )
        else:
            try:
                age = age_on_date(person.birth_date, options.competition_date)
            except ImportError as error:
                issues.append(
                    CsvCheckIssue(
                        kind="invalid_birth_date",
                        name=name,
                        assignments=roles,
                        message=f"年齢を判定できません: {error}",
                    )
                )
                continue
            if age <= options.age_limit:
                issues.append(
                    CsvCheckIssue(
                        kind="age_roles",
                        name=name,
                        assignments=roles,
                        age=age,
                        message=f"{age}歳（{options.age_limit}歳以下）の人に役割が割り当たっています。",
                    )
                )
    return CsvCheckResult(key=key, passed=not issues, checked_count=len(results), issues=issues)


def check_group_staffing(
    event_ids: list[str],
    results: list[ResultEntry],
    num_stations: int,
) -> CsvCheckResult:
    role_counts: dict[tuple[str, int, str], set[str]] = defaultdict(set)
    max_groups: dict[str, int] = defaultdict(int)
    for person in results:
        for event_id, group in person.groups:
            max_groups[event_id] = max(max_groups[event_id], group)
        for role in person.roles:
            # Count people, not repeated tokens or duplicated CSV rows.
            role_counts[role.event_id, role.group, role.role].add(normalize_name(person.name))
    groups = []
    issues = []
    for event_id in event_ids:
        for group in range(1, max(max_groups[event_id], 1) + 1):
            judge_count = len(role_counts[event_id, group, "J"])
            groups.append(
                CsvGroupStaffing(
                    event_id=event_id,
                    group=group,
                    judge_count=judge_count,
                    scrambler_count=len(role_counts[event_id, group, "S"]),
                    runner_count=len(role_counts[event_id, group, "R"]),
                    required_count=num_stations,
                    passed=judge_count >= num_stations,
                )
            )
            if judge_count < num_stations:
                issues.append(
                    CsvCheckIssue(
                        kind="staffing_shortage",
                        name=f"{event_id} G{group}",
                        event_id=event_id,
                        group=group,
                        required_count=num_stations,
                        actual_count=judge_count,
                        message=f"ジャッジ{judge_count}人 / 競技卓{num_stations}卓 "
                        f"（{num_stations - judge_count}人不足）。",
                    )
                )
    return CsvCheckResult(
        key="staffing",
        passed=not issues,
        checked_count=len(groups),
        issues=issues,
        groups=groups,
    )


def check_csv(
    registration_csv: bytes | None,
    result_csv: bytes,
    options: CsvCheckOptions,
) -> CsvCheckResponse:
    event_ids, results = read_results(result_csv)
    registrations = []
    if options.participation or options.newcomers or options.age:
        if registration_csv is None:
            raise ImportError("選択したチェックには登録CSVが必要です。")
        registrations = read_registrations(registration_csv)
    if options.newcomers and any(person.wca_id is None for person in registrations):
        raise ImportError("初参加者チェックには登録CSVのWCA ID列が必要です。")
    if options.age and any(person.birth_date is None for person in registrations):
        raise ImportError("年齢チェックには登録CSVのBirth Date列が必要です。")

    checks = []
    if options.participation:
        participation = compare_participation(
            [(person.name, person.events) for person in registrations],
            [(person.name, person.events) for person in results],
        )
        checks.append(
            CsvCheckResult(
                key="participation",
                passed=participation.passed,
                checked_count=participation.checked_count,
                issues=[CsvCheckIssue(**issue.model_dump()) for issue in participation.issues],
            )
        )
    if options.newcomers:
        checks.append(check_person_roles("newcomers", registrations, results, options))
    if options.age:
        checks.append(check_person_roles("age", registrations, results, options))
    if options.staffing:
        checks.append(check_group_staffing(event_ids, results, options.num_stations))
    return CsvCheckResponse(passed=all(check.passed for check in checks), checks=checks)
