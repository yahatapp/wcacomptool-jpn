"""Bind this API to 127.0.0.1; Vite proxies /api during local development."""

from datetime import date
from threading import Lock
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Path, UploadFile
from pydantic import ValidationError

from .csv_checks import check_csv
from .importer import MAX_CSV_BYTES, ImportError, import_registration
from .models import (
    CsvCheckOptions,
    CsvCheckResponse,
    ImportResponse,
    ParticipationCheckResponse,
    SolveRequest,
    SolveResponse,
    WcaRecordsResponse,
)
from .result_csv import check_participation
from .solver import solve
from .wca_records import WCA_ID_PATTERN, WcaFetchError, WcaRecordsClient

app = FastAPI(title="WCA役割分担 API", version="0.1.0")
solver_lock = Lock()
wca_records = WcaRecordsClient()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "solver": "OR-Tools CP-SAT"}


@app.get("/api/wca/records/{wca_id}", response_model=WcaRecordsResponse)
def get_wca_records(
    wca_id: Annotated[str, Path(pattern=f"^{WCA_ID_PATTERN}$")],
) -> WcaRecordsResponse:
    try:
        return wca_records.fetch(wca_id)
    except WcaFetchError as error:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after is not None else None
        raise HTTPException(
            status_code=error.status_code, detail=str(error), headers=headers
        ) from error


@app.post("/api/import", response_model=ImportResponse)
async def import_csv(
    file: Annotated[UploadFile, File()],
    competition_date: Annotated[date, Form()],
) -> ImportResponse:
    try:
        content = await file.read(MAX_CSV_BYTES + 1)
        return import_registration(content, file.filename or "competition.csv", competition_date)
    except ImportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await file.close()


@app.post("/api/check-participation", response_model=ParticipationCheckResponse)
async def check_csv_participation(
    registration_file: Annotated[UploadFile, File()],
    result_file: Annotated[UploadFile, File()],
) -> ParticipationCheckResponse:
    try:
        registration_content = await registration_file.read(MAX_CSV_BYTES + 1)
        result_content = await result_file.read(MAX_CSV_BYTES + 1)
        return check_participation(registration_content, result_content)
    except ImportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await registration_file.close()
        await result_file.close()


@app.post("/api/check-csv", response_model=CsvCheckResponse)
async def check_assignment_csv(
    result_file: Annotated[UploadFile, File()],
    registration_file: Annotated[UploadFile | None, File()] = None,
    options: Annotated[str, Form()] = "{}",
) -> CsvCheckResponse:
    try:
        settings = CsvCheckOptions.model_validate_json(options)
        registration_content = (
            await registration_file.read(MAX_CSV_BYTES + 1) if registration_file else None
        )
        result_content = await result_file.read(MAX_CSV_BYTES + 1)
        return check_csv(registration_content, result_content, settings)
    except ValidationError as error:
        detail = "\n".join(item["msg"].removeprefix("Value error, ") for item in error.errors())
        raise HTTPException(status_code=422, detail=detail) from error
    except ImportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        if registration_file:
            await registration_file.close()
        await result_file.close()


@app.post("/api/solve", response_model=SolveResponse)
def solve_assignments(request: SolveRequest) -> SolveResponse:
    # CPU-bound CP-SAT runs in FastAPI's sync endpoint thread pool, not the event loop.
    if not solver_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409, detail="別の計算が実行中です。完了後に再実行してください。"
        )
    try:
        return solve(request)
    finally:
        solver_lock.release()
