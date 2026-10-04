"""Compare the browser result with the preserved Python solver, using JSON on stdin."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models import Assignment, SolveRequest  # noqa: E402
from app.solver import solve, validate_assignments  # noqa: E402

payload = json.load(sys.stdin)
request = SolveRequest.model_validate(payload["request"])
result = solve(request)
print(json.dumps({
    "status": result.status,
    "objective_value": result.objective_value,
    "validation_errors": validate_assignments(
        request, [Assignment.model_validate(item) for item in payload["assignments"]]
    ),
}))
