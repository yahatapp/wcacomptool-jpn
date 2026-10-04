from pathlib import Path

import httpx
from fastapi.testclient import TestClient

import app.main as main
from app.main import app, solver_lock
from app.wca_records import WcaRecordsClient

client = TestClient(app)
SAMPLE = Path(__file__).resolve().parents[2] / "web/public/samples/registration.csv"


def test_import_solve_and_csv_end_to_end():
    assert client.get("/api/health").json()["status"] == "ok"
    imported = client.post(
        "/api/import",
        files={"file": ("Sample-registration.csv", SAMPLE.read_bytes())},
        data={"competition_date": "2026-10-01"},
    )
    assert imported.status_code == 200
    data = imported.json()
    data.pop("warnings")
    data.pop("excluded_count")
    for event in data["events"]:
        event.pop("participant_count")
    data["num_stations"] = 3
    data["options"] = {"time_limit_seconds": 5}
    solved = client.post("/api/solve", json=data)
    assert solved.status_code == 200
    result = solved.json()
    assert result["status"] in ("OPTIMAL", "FEASIBLE")
    assert len(result["assignments"]) == 56
    assert not result["validation_errors"]
    assert result["csv_content"].startswith("Name,333,444\r\n")
    checked = client.post(
        "/api/check-participation",
        files={
            "registration_file": ("registration.csv", SAMPLE.read_bytes()),
            "result_file": ("result.csv", result["csv_content"].encode("utf-8-sig")),
        },
    )
    assert checked.status_code == 200
    assert checked.json() == {
        "passed": True,
        "checked_count": 12,
        "matched_count": 12,
        "issues": [],
    }


def test_check_participation_api_reports_missing_people_and_csv_errors():
    response = client.post(
        "/api/check-participation",
        files={
            "registration_file": ("registration.csv", SAMPLE.read_bytes()),
            "result_file": ("result.csv", b"Name,333,444\r\n"),
        },
    )
    assert response.status_code == 200
    assert not response.json()["passed"]
    assert len(response.json()["issues"]) == 12
    response = client.post(
        "/api/check-participation",
        files={
            "registration_file": ("registration.csv", SAMPLE.read_bytes()),
            "result_file": ("result.csv", b"Name,333\nTest,invalid\n"),
        },
    )
    assert response.status_code == 422
    assert "結果CSVの2行目" in response.json()["detail"]
    assert client.post("/api/check-participation").status_code == 422


def test_api_reports_import_errors_and_requires_date():
    response = client.post(
        "/api/import",
        files={"file": ("bad.csv", b"bad\n")},
        data={"competition_date": "2026-10-01"},
    )
    assert response.status_code == 422
    assert "必要な列" in response.json()["detail"]
    response = client.post("/api/import", files={"file": ("sample.csv", SAMPLE.read_bytes())})
    assert response.status_code == 422


def test_invalid_solve_settings_are_rejected():
    assert client.post("/api/solve", json={}).status_code == 422


def test_busy_solver_does_not_start_another_solve():
    imported = client.post(
        "/api/import",
        files={"file": ("sample.csv", SAMPLE.read_bytes())},
        data={"competition_date": "2026-10-01"},
    ).json()
    payload = {
        key: value for key, value in imported.items() if key not in ("warnings", "excluded_count")
    }
    for event in payload["events"]:
        event.pop("participant_count")
    payload["num_stations"] = 3
    solver_lock.acquire()
    try:
        assert client.post("/api/solve", json=payload).status_code == 409
        assert client.get("/api/health").status_code == 200
    finally:
        solver_lock.release()


def test_wca_records_api_returns_only_records_and_reuses_cache(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[{"eventId": "333", "type": "average", "best": 553}])

    service = WcaRecordsClient(
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler))
    )
    monkeypatch.setattr(main, "wca_records", service)
    response = client.get("/api/wca/records/2009ZEMD01")
    assert response.status_code == 200
    data = response.json()
    assert data["records"]["333"]["average_time"] == 5.53
    assert set(data) == {"wca_id", "records", "cached", "fetched_at"}
    assert not data["cached"]
    assert client.get("/api/wca/records/2009ZEMD01").json()["cached"]
    assert len(calls) == 1
    assert client.get("/api/wca/records/invalid").status_code == 422
    assert len(calls) == 1


def test_wca_rate_limit_is_forwarded_to_ui_without_repeated_requests(monkeypatch):
    service = WcaRecordsClient(
        client_factory=lambda: httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(429, headers={"Retry-After": "120"})
            )
        )
    )
    monkeypatch.setattr(main, "wca_records", service)
    response = client.get("/api/wca/records/2009ZEMD01")
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 119
    assert "時間を空けて" in response.json()["detail"]
