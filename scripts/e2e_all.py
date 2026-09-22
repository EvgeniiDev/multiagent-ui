"""Run every control-center E2E against the deployed bundle and summarise.

Serves `dist-web/` on the port each script expects (25998/25999) and runs the
scripts one after another, so the artefacts come from one and the same build.

Usage:  npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_all.py
"""
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = str(Path.home() / ".hermes/tools-venv/bin/python")

SCRIPTS = [
    ("shell + projects", REPO / "scripts/e2e_shell_projects.py", None),
    ("board", REPO / "scripts/e2e_board.py", 25999),
    ("dashboard", REPO / "scripts/e2e_dashboard.py", 25998),
]


def serve(port: int) -> subprocess.Popen:
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port)],
        cwd=str(REPO / "dist-web"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            return proc
        except Exception:
            time.sleep(0.25)
    return proc


def main() -> int:
    failures = []
    for name, script, port in SCRIPTS:
        if not script.exists():
            print(f"[skip] {name}: {script.name} not present")
            continue
        server = serve(port) if port else None
        print(f"\n===== {name} ({script.name})")
        try:
            proc = subprocess.run([PY, str(script)], capture_output=True, text=True, timeout=900)
            tail = "\n".join(proc.stdout.strip().splitlines()[-8:])
            print(tail or "(no stdout)")
            if proc.returncode != 0:
                failures.append(name)
                print(f"[FAIL] {name} exit={proc.returncode}")
                if proc.stderr.strip():
                    print("stderr tail:", "\n".join(proc.stderr.strip().splitlines()[-5:]))
            else:
                print(f"[PASS] {name}")
        finally:
            if server:
                server.terminate()
                server.wait(timeout=10)

    print("\n===== summary")
    if failures:
        print("failed:", ", ".join(failures))
        return 1
    print("all E2E scripts passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
