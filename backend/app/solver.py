"""Two-stage CP-SAT model adapted from the local comp-grouping implementation.

Keep its eligibility, pre-competition break, speed and fairness rules. Unlike the
reference, empty candidate sets still enforce staffing counts, and a separate
validator checks coverage and exclusivity before a solution is returned.
"""

import time
from collections import Counter, defaultdict

from ortools.sat.python import cp_model

from .models import (
    DEFAULT_JUDGE_EXEMPT_AGE,
    Assignment,
    Competitor,
    Role,
    SolveRequest,
    SolveResponse,
)
from .result_csv import export_csv

ROLE_LABELS = {
    Role.COMPETITOR: "競技者",
    Role.SCRAMBLER: "スクランブラー",
    Role.JUDGE: "ジャッジ",
    Role.RUNNER: "ランナー",
}


def assign_groups(request: SolveRequest) -> dict[tuple[str, str], int]:
    groups = {}
    for event in request.events:
        participants = sorted(
            (person for person in request.competitors if event.event_id in person.events),
            key=lambda person: person.events[event.event_id].average_time or float("inf"),
        )
        size, remainder = divmod(len(participants), event.num_groups)
        offset = 0
        for group in range(event.num_groups):
            for person in participants[offset : offset + size + (group < remainder)]:
                groups[person.competitor_id, event.event_id] = group
            offset += size + (group < remainder)
    return groups


def can_staff(person: Competitor, event_id: str, group: int, groups: dict) -> bool:
    own = groups.get((person.competitor_id, event_id))
    return own is None or group not in (own, own - 1)


def staffing_requirements(request: SolveRequest, groups: dict) -> dict:
    sizes = Counter((event_id, group) for (_, event_id), group in groups.items())
    return {
        (event.event_id, group): {
            Role.SCRAMBLER: event.num_scramblers_per_group,
            Role.JUDGE: min(sizes[event.event_id, group], request.num_stations),
            Role.RUNNER: event.num_runners_per_group if event.use_runners else 0,
        }
        for event in request.events
        for group in range(event.num_groups)
    }


def eligible(
    person: Competitor, event_id: str, role: Role, age_limit: int = DEFAULT_JUDGE_EXEMPT_AGE
) -> bool:
    if role == Role.SCRAMBLER:
        return person.can_scramble(event_id)
    if role == Role.JUDGE:
        return person.can_judge(age_limit)
    return not person.is_staff


def validate_assignments(request: SolveRequest, assignments: list[Assignment]) -> list[str]:
    """Independent post-solve checks; never export an incomplete staffing plan."""
    errors = []
    people = {person.competitor_id: person for person in request.competitors}
    events = {event.event_id: event for event in request.events}
    own_groups = {}
    competitor_counts = Counter()
    slot_counts = Counter()
    staffing_counts = Counter()
    for assignment in assignments:
        person = people.get(assignment.competitor_id)
        event = events.get(assignment.event_id)
        if not person or not event or not 1 <= assignment.group <= event.num_groups:
            errors.append("不明な参加者・競技・グループの割り当てがあります。")
            continue
        slot_counts[person.competitor_id, event.event_id, assignment.group] += 1
        if assignment.role == Role.COMPETITOR:
            competitor_counts[person.competitor_id, event.event_id] += 1
            own_groups[person.competitor_id, event.event_id] = assignment.group - 1
            if event.event_id not in person.events:
                errors.append(f"{person.name}: 登録していない競技に割り当てられています。")
        else:
            staffing_counts[event.event_id, assignment.group - 1, assignment.role] += 1
            if not eligible(
                person, event.event_id, assignment.role, request.options.judge_exempt_age
            ):
                errors.append(
                    f"{person.name}: {ROLE_LABELS[assignment.role]}の資格制約に違反しています。"
                )
    expected = Counter(
        {
            (person.competitor_id, event_id): 1
            for person in request.competitors
            for event_id in person.events
        }
    )
    if competitor_counts != expected:
        errors.append("全員の参加競技に対する競技グループが1つずつ必要です。")
    if any(count > 1 for count in slot_counts.values()):
        errors.append("同一グループで複数の役割を兼任しています。")
    for assignment in assignments:
        person = people.get(assignment.competitor_id)
        if (
            person
            and assignment.role != Role.COMPETITOR
            and not can_staff(
                person,
                assignment.event_id,
                assignment.group - 1,
                own_groups,
            )
        ):
            errors.append(f"{person.name}: 自分の競技グループまたは直前グループに役割があります。")
    # Expected headcounts come from the input groups, not staffing assignments.
    for (event_id, group), roles in staffing_requirements(request, assign_groups(request)).items():
        for role, needed in roles.items():
            if staffing_counts[event_id, group, role] != needed:
                errors.append(
                    f"{event_id} G{group + 1}: {ROLE_LABELS[role]}の必要人数を満たしていません。"
                )
    return errors


def solve(request: SolveRequest) -> SolveResponse:
    started = time.monotonic()
    groups = assign_groups(request)
    requirements = staffing_requirements(request, groups)
    group_sizes = Counter((event_id, group) for (_, event_id), group in groups.items())
    candidates = {}
    diagnostics = []
    warnings = []
    for event in request.events:
        missing = sum(
            event.event_id in person.events and person.events[event.event_id].average_time is None
            for person in request.competitors
        )
        if missing:
            warnings.append(
                f"{event.event_name}: {missing}人の平均記録が未入力です（未入力者は順位の末尾）。"
            )
        for group in range(event.num_groups):
            counts = requirements[event.event_id, group]
            if group_sizes[event.event_id, group] > request.num_stations:
                warnings.append(
                    f"{event.event_name} G{group + 1}: 競技者が競技卓数を超えています。"
                    "待機席が必要です。"
                )
            unique_candidates = set()
            for role, needed in counts.items():
                people = [
                    person
                    for person in request.competitors
                    if needed
                    and can_staff(person, event.event_id, group, groups)
                    and eligible(person, event.event_id, role, request.options.judge_exempt_age)
                ]
                candidates[event.event_id, group, role] = people
                unique_candidates.update(person.competitor_id for person in people)
                if len(people) < needed:
                    diagnostics.append(
                        f"{event.event_name} G{group + 1}: {ROLE_LABELS[role]}は"
                        f"{needed}人必要ですが、条件を満たす候補者は{len(people)}人です。"
                    )
            if len(unique_candidates) < sum(counts.values()):
                diagnostics.append(
                    f"{event.event_name} G{group + 1}: 兼任不可のためスタッフは"
                    f"合計{sum(counts.values())}人必要ですが、候補者は{len(unique_candidates)}人です。"
                )
    if diagnostics:
        return SolveResponse(
            status="INFEASIBLE",
            solve_time_seconds=time.monotonic() - started,
            diagnostics=diagnostics,
            warnings=warnings,
        )

    model = cp_model.CpModel()
    by_person = defaultdict(list)
    by_slot = defaultdict(list)
    variables = {}
    for (event_id, group, role), people in candidates.items():
        role_vars = []
        for person in people:
            var = model.new_bool_var(f"{role}_{person.competitor_id}_{event_id}_{group}")
            variables[person.competitor_id, event_id, group, role] = var
            by_person[person.competitor_id].append(var)
            by_slot[person.competitor_id, event_id, group].append(var)
            role_vars.append(var)
        model.add(sum(role_vars) == requirements[event_id, group][role])
    for role_vars in by_slot.values():
        model.add(sum(role_vars) <= 1)

    objective = []
    for event in request.events:
        times = [
            person.events[event.event_id].average_time
            for person in request.competitors
            if event.event_id in person.events
            and person.events[event.event_id].average_time is not None
        ]
        if not times:
            continue
        max_time = max(times)
        for (person_id, event_id, _, role), var in variables.items():
            if event_id != event.event_id or role != Role.SCRAMBLER:
                continue
            person = next(
                person for person in request.competitors if person.competitor_id == person_id
            )
            average = person.events[event_id].average_time
            score = min(1_000_000, int(max_time / average * 1000)) if average else 0
            objective.append(var * score * request.options.scrambler_speed_weight)
    max_roles = sum(event.num_groups for event in request.events)
    totals = []
    for person in request.competitors:
        total = model.new_int_var(0, max_roles, f"total_{person.competitor_id}")
        model.add(total == sum(by_person[person.competitor_id]))
        totals.append(total)
    most = model.new_int_var(0, max_roles, "max_roles")
    least = model.new_int_var(0, max_roles, "min_roles")
    model.add_max_equality(most, totals)
    model.add_min_equality(least, totals)
    objective.append(-(most - least) * request.options.balance_weight * 1000)
    model.maximize(sum(objective))

    cp_solver = cp_model.CpSolver()
    cp_solver.parameters.max_time_in_seconds = request.options.time_limit_seconds
    cp_solver.parameters.num_search_workers = 8
    cp_solver.parameters.random_seed = 0
    status = cp_solver.solve(model)
    status_name = cp_solver.status_name(status)
    result = SolveResponse(
        status=status_name, solve_time_seconds=time.monotonic() - started, warnings=warnings
    )
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        result.diagnostics = [
            "制約を同時に満たす割り当てが見つかりませんでした。グループ数、必要人数、免除設定を確認してください。"
            if status == cp_model.INFEASIBLE
            else "制限時間内に解が見つかりませんでした。実行時間を増やして再実行してください。"
        ]
        return result

    people = {person.competitor_id: person for person in request.competitors}

    def assignment(person_id: str, event_id: str, group: int, role: Role) -> Assignment:
        person = people[person_id]
        return Assignment(
            competitor_id=person_id,
            name=person.name,
            wca_id=person.wca_id,
            age=person.age,
            event_id=event_id,
            group=group + 1,
            role=role,
        )

    assignments = [
        assignment(person_id, event_id, group, Role.COMPETITOR)
        for (person_id, event_id), group in groups.items()
    ]
    assignments.extend(
        assignment(person_id, event_id, group, role)
        for (person_id, event_id, group, role), var in variables.items()
        if cp_solver.value(var)
    )
    assignments.sort(key=lambda item: (item.event_id, item.group, item.role, item.competitor_id))
    result.validation_errors = validate_assignments(request, assignments)
    if result.validation_errors:
        result.status = "MODEL_INVALID"
        result.diagnostics = ["結果検証で制約違反が検出されたため、割り当ての出力を中止しました。"]
        return result
    result.objective_value = cp_solver.objective_value
    result.assignments = assignments
    result.csv_content = export_csv(request, assignments)
    return result
