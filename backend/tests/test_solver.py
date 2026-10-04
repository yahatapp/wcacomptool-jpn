from collections import Counter
from datetime import date

import pytest

from app.models import Competitor, EventConfig, PersonalRecord, Role, SolveRequest, SolverOptions
from app.solver import solve, validate_assignments


@pytest.fixture
def request_data() -> SolveRequest:
    return SolveRequest(
        competition_name="Synthetic test",
        competition_date=date(2026, 10, 1),
        num_stations=3,
        events=[
            EventConfig(
                event_id="333", event_name="3x3x3", num_groups=4, num_scramblers_per_group=1
            )
        ],
        competitors=[
            Competitor(
                competitor_id=str(index),
                name=f"参加者{index}",
                wca_id=f"TEST{index:04}",
                age=25,
                events={"333": PersonalRecord(best_time=5 + index, average_time=10 + index)},
            )
            for index in range(12)
        ],
        options=SolverOptions(time_limit_seconds=5),
    )


def test_solution_covers_all_roles_and_hard_constraints(request_data):
    request_data.competitors[0].is_staff = True
    request_data.competitors[1].age = 12
    request_data.competitors[4].is_newcomer = True
    request_data.competitors[7].is_judge_exempt = True
    request_data.competitors[10].is_scrambler_exempt = True
    request_data.events[0].use_runners = True
    request_data.events[0].num_runners_per_group = 1
    result = solve(request_data)
    assert result.status in ("OPTIMAL", "FEASIBLE")
    assert not result.validation_errors
    counts = Counter((item.group, item.role) for item in result.assignments)
    groups = {
        item.competitor_id: item.group
        for item in result.assignments
        if item.role == Role.COMPETITOR
    }
    assert len(groups) == 12
    assert [groups[str(index)] for index in range(12)] == [1] * 3 + [2] * 3 + [3] * 3 + [4] * 3
    for group in range(1, 5):
        assert counts[group, Role.COMPETITOR] == counts[group, Role.JUDGE] == 3
        assert counts[group, Role.SCRAMBLER] == counts[group, Role.RUNNER] == 1
    occupied = set()
    people = {person.competitor_id: person for person in request_data.competitors}
    for item in result.assignments:
        assert (item.competitor_id, item.group) not in occupied
        occupied.add((item.competitor_id, item.group))
        if item.role != Role.COMPETITOR:
            assert item.group not in (groups[item.competitor_id], groups[item.competitor_id] - 1)
            assert not people[item.competitor_id].is_staff
        if item.role == Role.JUDGE:
            assert people[item.competitor_id].age >= 13
            assert not people[item.competitor_id].is_newcomer
            assert not people[item.competitor_id].is_judge_exempt
        if item.role == Role.SCRAMBLER:
            assert not people[item.competitor_id].is_scrambler_exempt
    assert len(result.csv_content.splitlines()) == len(request_data.competitors) + 1


def test_fastest_eligible_scramblers_are_preferred(request_data):
    request_data.options.balance_weight = 0
    result = solve(request_data)
    assert result.status == "OPTIMAL"
    groups = {
        item.competitor_id: item.group
        for item in result.assignments
        if item.role == Role.COMPETITOR
    }
    for item in result.assignments:
        if item.role != Role.SCRAMBLER:
            continue
        candidates = [
            person
            for person in request_data.competitors
            if item.group not in (groups[person.competitor_id], groups[person.competitor_id] - 1)
        ]
        assert (
            item.competitor_id
            == min(
                candidates,
                key=lambda person: person.events["333"].average_time,
            ).competitor_id
        )


def test_no_candidates_is_infeasible_not_false_success(request_data):
    request_data.competitors = request_data.competitors[:1]
    request_data.events[0].num_groups = 1
    result = solve(request_data)
    assert result.status == "INFEASIBLE"
    assert not result.assignments
    assert not result.csv_content
    assert any("候補者は0人" in message for message in result.diagnostics)


def test_overlapping_candidates_cannot_fill_multiple_roles(request_data):
    request_data.events[0].num_groups = 3
    result = solve(request_data)
    assert result.status == "INFEASIBLE"
    assert any("兼任不可" in message for message in result.diagnostics)


def test_records_optional_and_waiting_seats_reported(request_data):
    request_data.num_stations = 2
    for person in request_data.competitors:
        person.events["333"] = PersonalRecord()
    result = solve(request_data)
    assert result.status in ("OPTIMAL", "FEASIBLE")
    assert any("平均記録が未入力" in message for message in result.warnings)
    assert any("待機席" in message for message in result.warnings)


def test_validator_rejects_missing_roles_and_duplicate_assignments(request_data):
    result = solve(request_data)
    missing_judge = [item for item in result.assignments if item.role != Role.JUDGE]
    assert any("必要人数" in error for error in validate_assignments(request_data, missing_judge))
    duplicated = result.assignments + [result.assignments[0]]
    assert any("兼任" in error for error in validate_assignments(request_data, duplicated))
