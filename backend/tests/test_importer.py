import csv
import io
from datetime import date

import pytest

from app.importer import MAX_CSV_BYTES, ImportError, import_registration

COLUMNS = [
    "Status",
    "Name",
    "Country",
    "WCA ID",
    "Birth Date",
    "Gender",
    "333",
    "444",
    "Email",
    "Comments",
    "Registration Status",
    "Registrant Id",
]


def make_csv(rows: list[list[str]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def registration(**changes) -> list[str]:
    values = dict(
        zip(
            COLUMNS,
            [
                "a",
                "名前, 日本語\n改行",
                "Japan",
                "TEST0001",
                "2013-10-02",
                "m",
                "1",
                "0",
                "private@example.invalid",
                "個人情報",
                "accepted",
                "1",
            ],
            strict=True,
        )
    )
    values.update(changes)
    return [values[key] for key in COLUMNS]


def test_wca_export_handles_bom_quotes_status_and_age():
    content = make_csv(
        [
            registration(),
            registration(**{"Registrant Id": "2", "Registration Status": "pending"}),
            registration(**{"Registrant Id": "3", "Registration Status": "cancelled"}),
        ]
    )
    result = import_registration(content, "Example-registration.csv", date(2026, 10, 1))
    assert result.competition_name == "Example"
    assert result.excluded_count == 2
    assert len(result.competitors) == 1
    person = result.competitors[0]
    assert person.age == 12
    assert person.name == "名前, 日本語\n改行"
    assert not person.is_newcomer
    assert list(person.events) == ["333"]
    assert [event.event_id for event in result.events] == ["333"]
    assert "private@example.invalid" not in result.model_dump_json()
    assert "個人情報" not in result.model_dump_json()
    birthday_result = import_registration(content, "sample.csv", date(2026, 10, 2))
    assert birthday_result.competitors[0].age == 13


def test_no_wca_id_is_editable_newcomer_and_status_fallback():
    row = registration(**{"WCA ID": "", "Registration Status": ""})
    result = import_registration(make_csv([row]), "sample.csv", date(2026, 10, 1))
    assert result.competitors[0].is_newcomer
    assert result.competitors[0].wca_id is None


@pytest.mark.parametrize(
    "rows, message",
    [
        ([registration(), registration()], "重複"),
        ([registration(**{"Birth Date": ""})], "生年月日"),
        ([registration(**{"Birth Date": "2030-01-01"})], "生年月日"),
        ([registration(**{"333": "yes"})], "0または1"),
        ([registration(**{"Registration Status": "pending"})], "承認済み"),
    ],
)
def test_invalid_registration_is_rejected(rows, message):
    with pytest.raises(ImportError, match=message):
        import_registration(make_csv(rows), "sample.csv", date(2026, 10, 1))


def test_missing_columns_and_large_files_are_rejected():
    with pytest.raises(ImportError, match="必要な列"):
        import_registration(b"name,333\na,1\n", "sample.csv", date(2026, 10, 1))
    with pytest.raises(ImportError, match="5MB"):
        import_registration(b"a" * (MAX_CSV_BYTES + 1), "sample.csv", date(2026, 10, 1))
