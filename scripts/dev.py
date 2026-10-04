"""Start the local API and web together and stop both on Ctrl-C."""

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    for tool in ("uv", "pnpm"):
        if not shutil.which(tool):
            print(f"{tool} が見つかりません。direnv allow または nix develop を実行してください。")
            return 1
    environment = os.environ | {"UV_CACHE_DIR": str(ROOT / ".cache" / "uv")}
    commands = [
        ["uv", "run", "--locked", "--project", "backend", "python", "-m", "uvicorn",
         "app.main:app", "--app-dir", "backend", "--host", "127.0.0.1", "--port", "8000"],
        ["pnpm", "--dir", "web", "dev", "--host", "127.0.0.1"],
    ]
    processes = []
    try:
        for command in commands:
            processes.append(subprocess.Popen(
                command, cwd=ROOT, env=environment, start_new_session=True,
            ))
        print("Web: http://127.0.0.1:3000  /  API docs: http://127.0.0.1:8000/docs", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.3)
        return next((process.returncode or 1 for process in processes
                     if process.poll() is not None), 1)
    except KeyboardInterrupt:
        return 0
    finally:
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


if __name__ == "__main__":
    sys.exit(main())
