"""Read public WCA personal bests without sending registration data upstream.

The single process-wide lock and rate limiter also cover different browser tabs.
Only a WCA ID leaves this API. Cache entries contain records, not person profiles.
"""

import math
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from threading import Lock

import httpx

from .models import EVENT_NAMES, PersonalRecord, WcaRecordsResponse

WCA_ID_PATTERN = r"[0-9]{4}[A-Z]{4}[0-9]{2}"
WCA_RECORDS_URL = "https://www.worldcubeassociation.org/api/v0/persons"
REQUEST_INTERVAL_SECONDS = 1.0
CACHE_TTL_SECONDS = 6 * 60 * 60
MAX_CACHE_ENTRIES = 2000
MAX_RETRIES = 2
MAX_INLINE_WAIT_SECONDS = 30


class WcaFetchError(Exception):
    def __init__(self, message: str, status_code: int = 502, retry_after: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


def parse_records(payload: object) -> dict[str, PersonalRecord]:
    if not isinstance(payload, list):
        raise WcaFetchError("WCA APIの記録形式が想定と異なります。後で再実行してください。")
    records: dict[str, PersonalRecord] = {}
    for item in payload:
        if not isinstance(item, dict):
            raise WcaFetchError("WCA APIの記録形式が想定と異なります。")
        event_id, record_type, best = item.get("eventId"), item.get("type"), item.get("best")
        if not isinstance(event_id, str) or not isinstance(record_type, str):
            raise WcaFetchError("WCA APIの記録形式が想定と異なります。")
        # Multi-blind scores encode several values and cannot be stored as seconds.
        if event_id not in EVENT_NAMES or event_id == "333mbf":
            continue
        if record_type not in ("single", "average"):
            continue
        if type(best) is not int:
            raise WcaFetchError("WCA APIから不正な記録値を受け取りました。")
        if best <= 0:  # No result, DNF and DNS never become numeric records.
            continue
        # FMC singles are move counts; FMC averages and timed results use hundredths.
        value = float(best) if event_id == "333fm" and record_type == "single" else best / 100
        if not 0.01 <= value <= 86400:
            raise WcaFetchError("WCA APIから対応範囲外の記録値を受け取りました。")
        record = records.setdefault(event_id, PersonalRecord())
        if record_type == "average":
            record.average_time = value
        else:
            record.best_time = value
    return records


def retry_delay(value: str | None, fallback: float) -> float:
    if value:
        try:
            seconds = float(value)
            if math.isfinite(seconds):
                return max(0, seconds)
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(value)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=UTC)
                return max(0, (retry_at - datetime.now(UTC)).total_seconds())
            except (ValueError, TypeError, OverflowError):
                pass
    return fallback


def make_client() -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(10, connect=5),
        follow_redirects=False,
        headers={"Accept": "application/json", "User-Agent": "wcacomptool-jpn/0.1 (local tool)"},
    )


class WcaRecordsClient:
    def __init__(
        self,
        client_factory: Callable[[], httpx.Client] = make_client,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._client_factory = client_factory
        self._clock = clock
        self._sleep = sleep
        self._lock = Lock()
        self._next_request_at = 0.0
        self._cache: OrderedDict[str, tuple[float, WcaRecordsResponse]] = OrderedDict()

    def fetch(self, wca_id: str) -> WcaRecordsResponse:
        if not re.fullmatch(WCA_ID_PATTERN, wca_id):
            raise WcaFetchError("WCA IDの形式が不正です。", status_code=422)
        if not self._lock.acquire(blocking=False):
            raise WcaFetchError(
                "別のWCA記録取得が実行中です。完了後に再実行してください。", status_code=409
            )
        try:
            cached = self._cache.get(wca_id)
            if cached and cached[0] > self._clock():
                self._cache.move_to_end(wca_id)
                return cached[1].model_copy(deep=True, update={"cached": True})
            self._cache.pop(wca_id, None)
            with self._client_factory() as client:
                response = self._request(client, wca_id)
            try:
                records = parse_records(response.json())
            except ValueError as error:
                raise WcaFetchError("WCA APIの応答を読み取れませんでした。") from error
            result = WcaRecordsResponse(
                wca_id=wca_id, records=records, fetched_at=datetime.now(UTC)
            )
            self._cache[wca_id] = (self._clock() + CACHE_TTL_SECONDS, result)
            while len(self._cache) > MAX_CACHE_ENTRIES:
                self._cache.popitem(last=False)
            return result.model_copy(deep=True)
        finally:
            self._lock.release()

    def _request(self, client: httpx.Client, wca_id: str) -> httpx.Response:
        for attempt in range(MAX_RETRIES + 1):
            wait = max(0, self._next_request_at - self._clock())
            if wait > MAX_INLINE_WAIT_SECONDS:
                raise WcaFetchError(
                    "WCA APIから待機を求められています。時間を空けて再実行してください。",
                    status_code=429,
                    retry_after=math.ceil(wait),
                )
            if wait:
                self._sleep(wait)
            self._next_request_at = self._clock() + REQUEST_INTERVAL_SECONDS
            try:
                response = client.get(f"{WCA_RECORDS_URL}/{wca_id}/personal_records")
            except httpx.RequestError as error:
                self._next_request_at = max(
                    self._next_request_at, self._clock() + 2 ** (attempt + 1)
                )
                if attempt == MAX_RETRIES:
                    raise WcaFetchError(
                        "WCA APIに接続できませんでした。ネットワークを確認して再実行してください。"
                    ) from error
                continue
            if response.status_code == 200:
                return response
            if response.status_code == 404:
                raise WcaFetchError("WCA IDに対応する競技者が見つかりません。", status_code=404)
            if response.status_code == 429 or 500 <= response.status_code < 600:
                delay = retry_delay(response.headers.get("Retry-After"), 2 ** (attempt + 1))
                self._next_request_at = max(self._next_request_at, self._clock() + delay)
                if attempt < MAX_RETRIES and delay <= MAX_INLINE_WAIT_SECONDS:
                    continue
                raise WcaFetchError(
                    "WCA APIが混雑しています。時間を空けて再実行してください。",
                    status_code=429 if response.status_code == 429 else 503,
                    retry_after=math.ceil(max(1, self._next_request_at - self._clock())),
                )
            raise WcaFetchError(
                f"WCA APIから記録を取得できませんでした（{response.status_code}）。"
            )
        raise AssertionError("unreachable")
