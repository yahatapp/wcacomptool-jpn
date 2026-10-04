import csv
import io
from datetime import date

import pytest

from app.importer import MAX_CSV_BYTES, ImportError
from app.models import Assignment, Competitor, EventConfig, PersonalRecord, Role, SolveRequest
from app.result_csv import check_participation, export_csv


def csv_bytes(columns, rows):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(columns)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def registration_csv(rows):
    return csv_bytes(["Name", "333", "clock", "Registration Status", "Status"], rows)


def result_csv(rows, columns=None):
    return csv_bytes(columns or ["Name", "333", "clock"], rows)


def test_export_matrix_keeps_all_roles_event_order_and_quoted_names():
    people = [
        Competitor(
            competitor_id="1", name='日本語, "名前"\n改行', age=25, events={"333": PersonalRecord()}
        ),
        Competitor(
            competitor_id="2", name="Alice (アリス)", age=25, events={"clock": PersonalRecord()}
        ),
        Competitor(competitor_id="3", name="=formula", age=25, events={"333": PersonalRecord()}),
    ]
    request = SolveRequest(
        competition_name="Test",
        competition_date=date(2026, 10, 3),
        num_stations=2,
        competitors=people,
        events=[
            EventConfig(
                event_id=event_id, event_name=event_id, num_groups=1, num_scramblers_per_group=0
            )
            for event_id in ("clock", "333")
        ],
    )

    def item(person, event_id, group, role):
        return Assignment(
            competitor_id=person.competitor_id,
            name=person.name,
            wca_id=person.wca_id,
            age=person.age,
            event_id=event_id,
            group=group,
            role=role,
        )

    assignments = [
        item(people[0], "333", 4, Role.RUNNER),
        item(people[0], "333", 5, Role.JUDGE),
        item(people[0], "333", 2, Role.COMPETITOR),
        item(people[0], "333", 3, Role.JUDGE),
        item(people[0], "333", 1, Role.SCRAMBLER),
        item(people[1], "clock", 12, Role.COMPETITOR),
        item(people[1], "333", 1, Role.RUNNER),
        item(people[2], "333", 1, Role.COMPETITOR),
    ]
    exported = export_csv(request, assignments)
    reader = csv.DictReader(io.StringIO(exported, newline=""))
    assert reader.fieldnames == ["Name", "clock", "333"]
    rows = list(reader)
    assert rows == [
        {"Name": "'=formula", "clock": "", "333": "1"},
        {"Name": "Alice", "clock": "12", "333": "R1"},
        {"Name": people[0].name, "clock": "", "333": "2;J3;J5;S1;R4"},
    ]
    assert export_csv(request, list(reversed(assignments))) == exported
    assert check_participation(
        registration_csv(
            [
                [people[0].name, "1", "0", "accepted", "a"],
                [people[1].name, "0", "1", "accepted", "a"],
                [people[2].name, "1", "0", "accepted", "a"],
            ]
        ),
        exported.encode("utf-8-sig"),
    ).passed


def test_check_roles_are_not_participation_and_status_matches_importer():
    registered = registration_csv(
        [
            ["  Aoto   Otsuka ", "1", "0", "accepted", "a"],
            ["日本語", "0", "1", "", "a"],
            ["Pending", "1", "1", "pending", "a"],
            ["Cancelled", "1", "0", "cancelled", "a"],
            ["No events", "0", "0", "accepted", "a"],
        ]
    )
    assigned = result_csv(
        [
            ["Aoto Otsuka", "2; J3 ;S4;R12", "J1;S2;R3"],
            ["日本語", "J1", "12;R1"],
        ]
    )
    checked = check_participation(registered, assigned)
    assert checked.passed
    assert checked.checked_count == checked.matched_count == 2
    assert not checked.issues


def test_reports_missing_extra_events_and_missing_unknown_people():
    registered = registration_csv(
        [
            ["Changed", "1", "0", "accepted", "a"],
            ["Missing", "1", "1", "accepted", "a"],
        ]
    )
    checked = check_participation(
        registered,
        result_csv(
            [
                ["Changed", "J1;S2;R3", "3;J1"],
                ["Unknown", "", "J2"],
            ]
        ),
    )
    assert not checked.passed
    assert checked.matched_count == 0
    issues = {issue.name: issue for issue in checked.issues}
    assert issues["Changed"].kind == "event_mismatch"
    assert issues["Changed"].missing_events == ["333"]
    assert issues["Changed"].extra_events == ["clock"]
    assert issues["Missing"].kind == "missing_participant"
    assert issues["Missing"].missing_events == ["333", "clock"]
    assert issues["Unknown"].kind == "unexpected_participant"


@pytest.mark.parametrize(
    "name",
    [
        "Kenya Yahata (八幡 憲也)",
        " Kenya   Yahata   (八幡 憲也) ",
        "Kenya Yahata(八幡 憲也)",
        "Kenya Yahata (八幡 (憲也))",
        "Kenya Yahata",
    ],
)
def test_registration_native_name_suffix_is_ignored(name):
    checked = check_participation(
        registration_csv([[name, "1", "0", "accepted", "a"]]),
        result_csv([["Kenya Yahata ", "2;J3", "R1"]]),
    )
    assert checked.passed
    assert checked.matched_count == 1
    assert not checked.issues


def test_native_name_suffix_does_not_hide_event_mismatch_or_original_display_name():
    name = "Kenya Yahata (八幡 憲也)"
    checked = check_participation(
        registration_csv([[name, "1", "0", "accepted", "a"]]),
        result_csv([["Kenya Yahata", "J3", "2"]]),
    )
    assert not checked.passed
    assert len(checked.issues) == 1
    issue = checked.issues[0]
    assert issue.kind == "event_mismatch"
    assert issue.name == name
    assert issue.missing_events == ["333"]
    assert issue.extra_events == ["clock"]


def test_same_english_name_with_different_native_names_is_ambiguous():
    checked = check_participation(
        registration_csv(
            [
                ["Same Name (母国語名A)", "1", "0", "accepted", "a"],
                ["Same Name (母国語名B)", "0", "1", "accepted", "a"],
            ]
        ),
        result_csv([["Same Name", "1", ""]]),
    )
    assert not checked.passed
    assert checked.matched_count == 0
    assert len(checked.issues) == 1
    assert checked.issues[0].kind == "ambiguous_name"


def test_registration_name_without_english_prefix_is_rejected():
    with pytest.raises(ImportError, match="英語名は必須"):
        check_participation(
            registration_csv([["(母国語名のみ)", "1", "0", "accepted", "a"]]),
            result_csv([["Someone", "1", ""]]),
        )


@pytest.mark.parametrize("duplicate_input", [True, False])
def test_duplicate_names_are_not_silently_matched(duplicate_input):
    registered = [["Same Name", "1", "0", "accepted", "a"]]
    assigned = [["Same Name", "1", ""]]
    if duplicate_input:
        registered.append([" Same  Name ", "0", "1", "accepted", "a"])
    else:
        assigned.append([" Same  Name ", "", "1"])
    checked = check_participation(registration_csv(registered), result_csv(assigned))
    assert not checked.passed
    assert checked.matched_count == 0
    assert len(checked.issues) == 1
    assert checked.issues[0].kind == "ambiguous_name"


def test_missing_event_column_is_reported_and_reordered_columns_are_supported():
    registered = registration_csv([["Alice", "1", "1", "accepted", "a"]])
    checked = check_participation(registered, result_csv([["Alice", "2"]], ["Name", "333"]))
    assert checked.issues[0].missing_events == ["clock"]
    assert check_participation(
        registered, result_csv([["1;J2", "Alice", "2"]], ["clock", "Name", "333"])
    ).passed


@pytest.mark.parametrize("token", ["0", "J0", "-1", "G1", "j1", "1;;J2", "1;", "1;2"])
def test_invalid_assignment_cells_do_not_produce_success(token):
    with pytest.raises(ImportError, match="結果CSVの2行目"):
        check_participation(
            registration_csv([["Alice", "1", "0", "accepted", "a"]]),
            result_csv([["Alice", token, ""]]),
        )


@pytest.mark.parametrize(
    "bad_csv, message",
    [
        (b"Name,333,333\nAlice,1,1\n", "列名が重複"),
        (b"Name,333\nAlice,1,extra\n", "列数"),
        (b"Name,333,clock\nAlice,1\n", "列数"),
        (b'Name,333\n"Alice,1\n', "引用符"),
        (b"Name,unknown\nAlice,1\n", "競技ID"),
        (b"Name,333\n,1\n", "名前は必須"),
        (b"Name,333\n\xff,1\n", "UTF-8"),
        (b"name,333\nAlice,1\n", "必要な列"),
    ],
)
def test_invalid_result_structure_is_rejected(bad_csv, message):
    with pytest.raises(ImportError, match=message):
        check_participation(
            registration_csv([["Alice", "1", "0", "accepted", "a"]]),
            bad_csv,
        )


def test_limits_apply_to_both_csvs():
    registered = registration_csv([["Alice", "1", "0", "accepted", "a"]])
    assigned = result_csv([["Alice", "1", ""]])
    with pytest.raises(ImportError, match="5MB"):
        check_participation(b"a" * (MAX_CSV_BYTES + 1), assigned)
    with pytest.raises(ImportError, match="5MB"):
        check_participation(registered, b"a" * (MAX_CSV_BYTES + 1))
    with pytest.raises(ImportError, match="1000人"):
        check_participation(registered, result_csv([["Alice", "1", ""]] * 1001))


def test_invalid_registration_values_and_no_accepted_people_are_rejected():
    assigned = result_csv([["Alice", "1", ""]])
    with pytest.raises(ImportError, match="0または1"):
        check_participation(registration_csv([["Alice", "2", "0", "accepted", "a"]]), assigned)
    with pytest.raises(ImportError, match="承認済み"):
        check_participation(registration_csv([["Alice", "1", "0", "pending", "a"]]), assigned)
