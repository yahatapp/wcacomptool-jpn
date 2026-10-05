import csv
import io
from datetime import date
from itertools import product

import pytest
from pydantic import ValidationError

from app.csv_checks import check_csv
from app.importer import ImportError
from app.models import CsvCheckOptions


def matrix(columns, rows):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(columns)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def registration(rows, *, columns=None):
    return matrix(columns or ["Name", "333", "Status", "WCA ID", "Birth Date"], rows)


def assignments(rows, *, columns=None):
    return matrix(columns or ["Name", "333"], rows)


def selected(**values):
    return CsvCheckOptions(participation=False, **values)


@pytest.mark.parametrize("flags", list(product((False, True), repeat=4))[1:])
def test_each_check_can_be_selected_independently_or_combined(flags):
    keys = ["participation", "newcomers", "age", "staffing"]
    options = CsvCheckOptions(
        **dict(zip(keys, flags, strict=True)),
        competition_date=date(2026, 10, 4),
        num_stations=2,
    )
    registered = registration([["Young (母国語名)", "1", "a", "", "2014-10-04"]])
    result = check_csv(
        registered, assignments([["Young", "J1;S2;R3"], ["Competitor", "2"]]), options
    )
    assert [check.key for check in result.checks] == [key for key, flag in zip(keys, flags) if flag]
    assert all(not check.passed for check in result.checks)
    assert not result.passed
    assert result.checks[0].issues


@pytest.mark.parametrize("role", ["J1", "S2", "R3"])
def test_newcomers_are_flagged_for_all_staff_roles_including_other_events(role):
    registered = registration(
        [
            ["New (初参加)", "1", "a", "  ", ""],
            ["Experienced", "1", "a", "2000TEST01", ""],
            ["Competes only", "1", "a", "", ""],
        ]
    )
    result = check_csv(
        registered,
        assignments(
            [
                ["New", "1", role],
                ["Experienced", "1", role],
                ["Competes only", "1", ""],
            ],
            columns=["Name", "333", "clock"],
        ),
        selected(newcomers=True),
    )
    check = result.checks[0]
    assert not check.passed
    assert len(check.issues) == 1
    assert check.issues[0].name == "New (初参加)"
    assert check.issues[0].kind == "newcomer_roles"
    assert check.issues[0].assignments[0].event_id == "clock"
    assert check.issues[0].assignments[0].role == role[0]


@pytest.mark.parametrize("role", ["J1", "S2", "R3"])
@pytest.mark.parametrize(
    "competition_date, flagged_age", [("2026-10-03", 12), ("2026-10-04", None)]
)
def test_age_uses_competition_day_and_includes_the_limit(role, competition_date, flagged_age):
    result = check_csv(
        registration([["Birthday", "1", "a", "2000TEST01", "2013-10-04"]]),
        assignments([["Birthday", f"2;{role}"]]),
        selected(age=True, age_limit=12, competition_date=competition_date),
    )
    check = result.checks[0]
    if flagged_age is None:
        assert check.passed
        assert not check.issues
    else:
        assert not check.passed
        assert check.issues[0].age == flagged_age
        assert check.issues[0].kind == "age_roles"


def test_custom_age_limit_and_invalid_birth_dates_are_reported_without_silent_passes():
    registered = registration(
        [
            ["At limit", "1", "a", "2000TEST01", "2012-10-04"],
            ["Older", "1", "a", "2000TEST02", "2011-10-04"],
            ["Missing birth date", "1", "a", "2000TEST03", ""],
            ["Future birth date", "1", "a", "2000TEST04", "2030-10-04"],
            ["No roles", "1", "a", "", "invalid but irrelevant"],
        ]
    )
    result = check_csv(
        registered,
        assignments(
            [
                ["At limit", "J1"],
                ["Older", "R1"],
                ["Missing birth date", "S1"],
                ["Future birth date", "J1"],
                ["No roles", "1"],
            ]
        ),
        selected(age=True, age_limit=14, competition_date="2026-10-04"),
    )
    issues = {issue.name: issue for issue in result.checks[0].issues}
    assert set(issues) == {"At limit", "Missing birth date", "Future birth date"}
    assert issues["At limit"].age == 14
    assert (
        issues["Missing birth date"].kind
        == issues["Future birth date"].kind
        == "invalid_birth_date"
    )


def test_station_count_checks_judges_only_and_accepts_surplus():
    result = check_csv(
        None,
        assignments(
            [
                ["A", "1;J2"],
                ["B", "2;J1"],
                ["C", "1;J1;J2"],
                ["D", "2;J1;S2"],
                ["E", "S1;R2"],
                ["F", "R1"],
            ]
        ),
        selected(staffing=True, num_stations=2),
    )
    assert result.passed
    assert [group.judge_count for group in result.checks[0].groups] == [3, 2]
    assert all(group.required_count == 2 for group in result.checks[0].groups)
    result = check_csv(
        None,
        assignments(
            [
                ["A", "1;J2"],
                ["B", "2;J1"],
                ["C", "S1;R2"],
                ["D", "R1;S2"],
                ["E", "1"],
                ["F", "2"],
            ]
        ),
        selected(staffing=True, num_stations=2),
    )
    assert not result.passed
    assert [issue.actual_count for issue in result.checks[0].issues] == [1, 1]


@pytest.mark.parametrize(
    "competitors, stations, judges, required, passed",
    [
        (1, 3, 1, 1, True),
        (3, 3, 3, 3, True),
        (5, 3, 3, 3, True),
        (2, 3, 1, 2, False),
        (5, 3, 2, 3, False),
        (0, 3, 0, 0, True),
    ],
)
def test_required_judges_use_competitor_count_capped_by_stations(
    competitors, stations, judges, required, passed
):
    result = check_csv(
        None,
        assignments(
            [[f"Competitor {index}", "1"] for index in range(competitors)]
            + [[f"Judge {index}", "J1"] for index in range(judges)]
        ),
        selected(staffing=True, num_stations=stations),
    )
    assert result.passed == passed
    group = result.checks[0].groups[0]
    assert group.competitor_count == competitors
    assert group.judge_count == judges
    assert group.required_count == required
    assert group.passed == passed
    if not passed:
        issue = result.checks[0].issues[0]
        assert issue.required_count == required
        assert issue.actual_count == judges
        assert f"{required - judges}人不足" in issue.message


def test_competitor_counts_use_competing_groups_for_each_event():
    result = check_csv(
        None,
        assignments(
            [["A", "1;J2", "2;J1"], ["B", "2;J1", "1;J2"], ["C", "2", "1"]],
            columns=["Name", "333", "clock"],
        ),
        selected(staffing=True, num_stations=2),
    )
    assert [group.competitor_count for group in result.checks[0].groups] == [1, 2, 2, 1]
    assert [group.required_count for group in result.checks[0].groups] == [1, 2, 2, 1]
    assert [(issue.event_id, issue.group) for issue in result.checks[0].issues] == [
        ("333", 2), ("clock", 1)
    ]


def test_duplicate_people_or_tokens_cannot_inflate_competitor_or_judge_count():
    result = check_csv(
        None,
        assignments(
            [
                ["Competitor", "1"],
                [" Competitor ", "1"],
                ["Other competitor", "1"],
                ["Judge", "J1;J1"],
                [" Judge ", "J1"],
            ]
        ),
        selected(staffing=True, num_stations=2),
    )
    assert not result.passed
    assert result.checks[0].groups[0].competitor_count == 2
    assert result.checks[0].groups[0].judge_count == 1
    assert result.checks[0].issues[0].required_count == 2


def test_empty_groups_and_gaps_need_no_judges():
    result = check_csv(
        None,
        assignments(
            [
                ["A", "1;J3", ""],
                ["B", "3;J1", ""],
            ],
            columns=["Name", "333", "clock"],
        ),
        selected(staffing=True, num_stations=1),
    )
    check = result.checks[0]
    assert check.checked_count == 4
    assert check.passed
    assert not check.issues
    assert [group.required_count for group in check.groups] == [1, 0, 1, 0]
    empty = check_csv(None, assignments([]), selected(staffing=True, num_stations=1))
    assert empty.passed
    assert empty.checks[0].groups[0].required_count == 0
    assert empty.checks[0].groups[0].judge_count == 0


@pytest.mark.parametrize("key", ["newcomers", "age"])
def test_unknown_or_ambiguous_staff_names_do_not_pass_person_checks(key):
    registered = registration(
        [
            ["Same (名前A)", "1", "a", "", "2014-10-04"],
            ["Same (名前B)", "1", "a", "", "2014-10-04"],
        ]
    )
    result = check_csv(
        registered,
        assignments(
            [
                ["Same", "S1"],
                ["Unknown", "J1"],
            ]
        ),
        selected(**{key: True}, competition_date="2026-10-04"),
    )
    assert not result.passed
    assert {issue.kind for issue in result.checks[0].issues} == {
        "ambiguous_name",
        "unexpected_participant",
    }


def test_role_checks_include_accepted_people_without_events_but_skip_pending_registrations():
    result = check_csv(
        registration(
            [
                ["Staff", "0", "a", "", "2014-10-04"],
                ["Ignored", "1", "p", "", "bad"],
            ]
        ),
        assignments([["Staff", "S1"]]),
        selected(newcomers=True),
    )
    assert result.checks[0].issues[0].kind == "newcomer_roles"


def test_disabled_checks_do_not_require_age_or_newcomer_metadata():
    registered = registration([["A", "1", "a"]], columns=["Name", "333", "Status"])
    assert check_csv(registered, assignments([["A", "1"]]), CsvCheckOptions()).passed
    with pytest.raises(ImportError, match="WCA ID列"):
        check_csv(registered, assignments([["A", "J1"]]), selected(newcomers=True))
    with pytest.raises(ImportError, match="Birth Date列"):
        check_csv(
            registered,
            assignments([["A", "J1"]]),
            selected(age=True, competition_date="2026-10-04"),
        )
    with pytest.raises(ImportError, match="登録CSVが必要"):
        check_csv(None, assignments([["A", "1"]]), CsvCheckOptions())


@pytest.mark.parametrize(
    "options",
    [
        {"participation": False},
        {"age": True},
        {"age_limit": -1},
        {"age_limit": 121},
        {"num_stations": 0},
        {"num_stations": 101},
        {"competition_date": "invalid"},
    ],
)
def test_invalid_check_options_are_rejected(options):
    with pytest.raises(ValidationError):
        CsvCheckOptions(**options)
