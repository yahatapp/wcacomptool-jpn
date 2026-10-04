from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from app.wca_records import (
    CACHE_TTL_SECONDS,
    WcaFetchError,
    WcaRecordsClient,
    parse_records,
    retry_delay,
)

WCA_ID = "2009ZEMD01"
OTHER_ID = "2012PARK03"
PAYLOAD = [
    {"eventId": "333", "type": "single", "best": 412},
    {"eventId": "333", "type": "average", "best": 553},
    {"eventId": "444", "type": "single", "best": 1798},
]


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration


def make_service(handler, clock):
    return WcaRecordsClient(
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
        clock=clock,
        sleep=clock.sleep,
    )


def test_records_convert_hundredths_and_fmc_but_never_guess_missing_averages():
    records = parse_records(
        PAYLOAD
        + [
            {"eventId": "333fm", "type": "single", "best": 24},
            {"eventId": "333fm", "type": "average", "best": 2733},
            {"eventId": "333mbf", "type": "single", "best": 880282100},
            {"eventId": "clock", "type": "average", "best": -1},
            {"eventId": "skewb", "type": "average", "best": 0},
            {"eventId": "sq1", "type": "single", "best": -2},
            {"eventId": "magic", "type": "average", "best": 139},
        ]
    )
    assert records["333"].best_time == 4.12
    assert records["333"].average_time == 5.53
    assert records["444"].average_time is None
    assert records["333fm"].best_time == 24
    assert records["333fm"].average_time == 27.33
    assert set(records) == {"333", "444", "333fm"}
    assert parse_records([]) == {}


@pytest.mark.parametrize(
    "payload",
    [{}, [None], [{}], [{"eventId": "333", "type": "average", "best": "553"}]],
)
def test_malformed_api_records_are_rejected(payload):
    with pytest.raises(WcaFetchError):
        parse_records(payload)


def test_cache_deduplicates_requests_is_not_mutable_and_expires():
    clock, calls = FakeClock(), []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=PAYLOAD)

    service = make_service(handler, clock)
    first = service.fetch(WCA_ID)
    first.records["333"].average_time = 99
    cached = service.fetch(WCA_ID)
    assert not first.cached and cached.cached
    assert cached.records["333"].average_time == 5.53
    assert cached.fetched_at == first.fetched_at
    assert len(calls) == 1
    assert str(calls[0].url) == (
        "https://www.worldcubeassociation.org/api/v0/persons/2009ZEMD01/personal_records"
    )
    assert calls[0].content == b""
    clock.now += CACHE_TTL_SECONDS + 1
    assert not service.fetch(WCA_ID).cached
    assert len(calls) == 2


def test_all_ids_share_minimum_request_spacing_and_concurrent_fetches_are_rejected():
    clock, starts = FakeClock(), []

    def handler(request):
        starts.append(clock())
        with pytest.raises(WcaFetchError) as busy:
            service.fetch(OTHER_ID)
        assert busy.value.status_code == 409
        return httpx.Response(200, json=PAYLOAD)

    service = make_service(handler, clock)
    service.fetch(WCA_ID)
    service.fetch(OTHER_ID)
    assert starts == [1000, 1001]
    assert clock.sleeps == [1]


def test_retry_after_is_respected_and_success_is_cached():
    clock, starts = FakeClock(), []

    def handler(request):
        starts.append(clock())
        if len(starts) == 1:
            return httpx.Response(429, headers={"Retry-After": "5"})
        return httpx.Response(200, json=PAYLOAD)

    service = make_service(handler, clock)
    assert service.fetch(WCA_ID).records["333"].average_time == 5.53
    assert starts == [1000, 1005]
    assert service.fetch(WCA_ID).cached


def test_long_rate_limit_stops_without_sleeping_and_applies_to_later_ids():
    clock, calls = FakeClock(), []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "120"})

    service = make_service(handler, clock)
    for wca_id in (WCA_ID, OTHER_ID):
        with pytest.raises(WcaFetchError) as limited:
            service.fetch(wca_id)
        assert limited.value.status_code == 429
        assert limited.value.retry_after == 120
    assert len(calls) == 1
    assert clock.sleeps == []


def test_transient_server_errors_back_off_with_bounded_retries():
    clock, starts = FakeClock(), []

    def handler(request):
        starts.append(clock())
        return httpx.Response(503)

    service = make_service(handler, clock)
    with pytest.raises(WcaFetchError) as failure:
        service.fetch(WCA_ID)
    assert failure.value.status_code == 503
    assert starts == [1000, 1002, 1006]
    assert failure.value.retry_after == 8


def test_transport_failure_retries_and_json_errors_are_reported():
    clock, starts = FakeClock(), []

    def handler(request):
        starts.append(clock())
        if len(starts) == 1:
            raise httpx.ConnectError("unavailable", request=request)
        return httpx.Response(200, text="not json")

    service = make_service(handler, clock)
    with pytest.raises(WcaFetchError, match="応答を読み取れません"):
        service.fetch(WCA_ID)
    assert starts == [1000, 1002]


def test_not_found_and_invalid_ids_do_not_retry_or_accept_arbitrary_urls():
    clock, calls = FakeClock(), []

    def handler(request):
        calls.append(request)
        return httpx.Response(404)

    service = make_service(handler, clock)
    with pytest.raises(WcaFetchError) as missing:
        service.fetch(WCA_ID)
    assert missing.value.status_code == 404
    with pytest.raises(WcaFetchError) as invalid:
        service.fetch("../2009ZEMD01")
    assert invalid.value.status_code == 422
    assert len(calls) == 1


def test_retry_after_accepts_http_dates_and_rejects_invalid_numbers():
    future = format_datetime(datetime.now(UTC) + timedelta(seconds=20), usegmt=True)
    assert 18 <= retry_delay(future, 2) <= 20
    assert retry_delay("NaN", 2) == 2
    assert retry_delay("invalid", 2) == 2
    assert retry_delay("-1", 2) == 0
