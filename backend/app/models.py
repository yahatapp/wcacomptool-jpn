from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EVENT_NAMES = {
    "333": "3x3x3",
    "222": "2x2x2",
    "444": "4x4x4",
    "555": "5x5x5",
    "666": "6x6x6",
    "777": "7x7x7",
    "333bf": "3x3x3 目隠し",
    "333fm": "3x3x3 最少手数",
    "333oh": "3x3x3 片手",
    "clock": "クロック",
    "minx": "メガミンクス",
    "pyram": "ピラミンクス",
    "skewb": "スキューブ",
    "sq1": "スクエア1",
    "444bf": "4x4x4 目隠し",
    "555bf": "5x5x5 目隠し",
    "333mbf": "3x3x3 複数目隠し",
}

PositiveRecord = Annotated[float, Field(ge=0.01, le=86400, allow_inf_nan=False)]
DEFAULT_JUDGE_EXEMPT_AGE = 12


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PersonalRecord(Model):
    best_time: PositiveRecord | None = None
    average_time: PositiveRecord | None = None


class WcaRecordsResponse(Model):
    wca_id: str
    records: dict[str, PersonalRecord]
    fetched_at: datetime
    cached: bool = False


class Competitor(Model):
    competitor_id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=300)
    wca_id: str | None = None
    age: int = Field(ge=0, le=120)
    is_newcomer: bool = False
    is_judge_exempt: bool = False
    is_scrambler_exempt: bool = False
    # Same meaning as comp-grouping: organizers exempt from all staffing roles.
    is_staff: bool = False
    events: dict[str, PersonalRecord]

    def can_judge(self, age_limit: int = DEFAULT_JUDGE_EXEMPT_AGE) -> bool:
        return (
            self.age > age_limit
            and not self.is_newcomer
            and not self.is_judge_exempt
            and not self.is_staff
        )

    def can_scramble(self, event_id: str) -> bool:
        return event_id in self.events and not self.is_scrambler_exempt and not self.is_staff


class EventConfig(Model):
    event_id: str
    event_name: str
    num_groups: int = Field(ge=1, le=100)
    num_scramblers_per_group: int = Field(ge=0, le=100)
    use_runners: bool = False
    num_runners_per_group: int = Field(default=0, ge=0, le=100)

    @model_validator(mode="after")
    def valid_event(self) -> EventConfig:
        if self.event_id not in EVENT_NAMES:
            raise ValueError(f"未対応の競技ID: {self.event_id}")
        if not self.use_runners and self.num_runners_per_group:
            raise ValueError("ランナーを使わない場合、ランナー人数は0にしてください。")
        return self


class ImportedEvent(EventConfig):
    participant_count: int


class ImportResponse(Model):
    competition_name: str
    competition_date: date
    competitors: list[Competitor]
    events: list[ImportedEvent]
    excluded_count: int
    warnings: list[str]


class SolverOptions(Model):
    time_limit_seconds: float = Field(default=30, ge=1, le=120, allow_inf_nan=False)
    scrambler_speed_weight: int = Field(default=100, ge=0, le=1000)
    balance_weight: int = Field(default=50, ge=0, le=1000)
    judge_exempt_age: int = Field(default=DEFAULT_JUDGE_EXEMPT_AGE, ge=0, le=120)


class SolveRequest(Model):
    competition_name: str = Field(min_length=1, max_length=200)
    competition_date: date
    num_stations: int = Field(ge=1, le=100)
    events: list[EventConfig] = Field(min_length=1, max_length=17)
    competitors: list[Competitor] = Field(min_length=1, max_length=1000)
    options: SolverOptions = Field(default_factory=SolverOptions)

    @model_validator(mode="after")
    def consistent_ids(self) -> SolveRequest:
        event_ids = [event.event_id for event in self.events]
        if len(event_ids) != len(set(event_ids)):
            raise ValueError("競技IDが重複しています。")
        competitor_ids = [person.competitor_id for person in self.competitors]
        if len(competitor_ids) != len(set(competitor_ids)):
            raise ValueError("参加者IDが重複しています。")
        for person in self.competitors:
            if not person.events or not set(person.events).issubset(event_ids):
                raise ValueError("参加者の参加競技と競技設定が一致していません。")
        for event in self.events:
            count = sum(event.event_id in person.events for person in self.competitors)
            if count == 0 or event.num_groups > count:
                raise ValueError(
                    f"{event.event_name}: グループ数は参加者数（{count}人）以下にしてください。"
                )
        return self


class Role(StrEnum):
    COMPETITOR = "COMPETITOR"
    SCRAMBLER = "SCRAMBLER"
    JUDGE = "JUDGE"
    RUNNER = "RUNNER"


class Assignment(Model):
    competitor_id: str
    name: str
    wca_id: str | None
    age: int
    event_id: str
    group: int  # 1-based at the API boundary.
    role: Role


class SolveResponse(Model):
    status: Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "MODEL_INVALID"]
    solve_time_seconds: float
    objective_value: float | None = None
    assignments: list[Assignment] = Field(default_factory=list)
    diagnostics: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    validation_errors: list[str] = Field(default_factory=list)
    csv_content: str = ""


class ParticipationIssue(Model):
    kind: Literal[
        "event_mismatch", "missing_participant", "unexpected_participant", "ambiguous_name"
    ]
    name: str
    expected_events: list[str] = Field(default_factory=list)
    actual_events: list[str] = Field(default_factory=list)
    missing_events: list[str] = Field(default_factory=list)
    extra_events: list[str] = Field(default_factory=list)
    message: str


class ParticipationCheckResponse(Model):
    passed: bool
    checked_count: int
    matched_count: int
    issues: list[ParticipationIssue]


CsvCheckKey = Literal["participation", "newcomers", "age", "staffing"]


class CsvCheckOptions(Model):
    participation: bool = True
    newcomers: bool = False
    age: bool = False
    staffing: bool = False
    competition_date: date | None = None
    age_limit: int = Field(default=DEFAULT_JUDGE_EXEMPT_AGE, ge=0, le=120)
    num_stations: int = Field(default=20, ge=1, le=100)

    @model_validator(mode="after")
    def selected_checks(self) -> CsvCheckOptions:
        if not any((self.participation, self.newcomers, self.age, self.staffing)):
            raise ValueError("チェック項目を1つ以上選択してください。")
        if self.age and self.competition_date is None:
            raise ValueError("年齢チェックには大会日が必要です。")
        return self


class CsvRoleAssignment(Model):
    event_id: str
    group: int
    role: Literal["J", "S", "R"]


class CsvCheckIssue(ParticipationIssue):
    kind: Literal[
        "event_mismatch",
        "missing_participant",
        "unexpected_participant",
        "ambiguous_name",
        "newcomer_roles",
        "age_roles",
        "invalid_birth_date",
        "staffing_shortage",
    ]
    assignments: list[CsvRoleAssignment] = Field(default_factory=list)
    age: int | None = None
    event_id: str | None = None
    group: int | None = None
    required_count: int | None = None
    actual_count: int | None = None


class CsvGroupStaffing(Model):
    event_id: str
    group: int
    competitor_count: int
    judge_count: int
    scrambler_count: int
    runner_count: int
    required_count: int
    passed: bool


class CsvCheckResult(Model):
    key: CsvCheckKey
    passed: bool
    checked_count: int
    issues: list[CsvCheckIssue]
    groups: list[CsvGroupStaffing] = Field(default_factory=list)


class CsvCheckResponse(Model):
    passed: bool
    checks: list[CsvCheckResult]
