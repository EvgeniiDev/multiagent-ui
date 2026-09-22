"""Run every control-center E2E against the deployed bundle and summarise.

The prod static server (acp-ui-web.service) serves `dist-web/` on :25808, so the
harness only needs a fresh `npm run build:web` before running this.

Usage:  ~/.hermes/tools-venv/bin/python scripts/e2e_all.py
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = str(Path.home() / ".hermes/tools-venv/bin/python")

SCRIPTS = [
    ("shell + projects", REPO / "scripts/e2e_shell_projects.py"),
    ("board", REPO / "scripts/e2e_board.py"),
    ("dashboard", REPO / "scripts/e2e_dashboard.py"),
]


def main() -> int:
    failures = []
    for name, script in SCRIPTS:
        if not script.exists():
            print(f"[skip] {name}: {script.name} not present")
            continue
        print(f"\n===== {name} ({script.name})")
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

    print("\n===== summary")
    if failures:
        print("failed:", ", ".join(failures))
        return 1
    print("all E2E scripts passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
