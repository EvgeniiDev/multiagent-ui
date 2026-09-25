"""Run every control-center E2E against one build and summarise.

Every suite under scripts/e2e_*.py now starts what it needs itself (its
own web server via scripts/_e2e_harness.py, its own state server when it
reads panel state), so this runner just executes them in turn. A suite
that legitimately needs the live panel (e2e_shell_projects) prints SKIP
and exits 0 when it is unreachable.

Usage:  npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_all.py
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = str(Path.home() / ".hermes/tools-venv/bin/python")

SCRIPTS = [
    ("shell + projects", REPO / "scripts/e2e_shell_projects.py"),
    ("shortcuts", REPO / "scripts/e2e_shortcuts.py"),
    ("board", REPO / "scripts/e2e_board.py"),
    ("dashboard", REPO / "scripts/e2e_dashboard.py"),
    ("phone targets", REPO / "scripts/e2e_touch.py"),
    ("live stream", REPO / "scripts/e2e_live_stream.py"),
    ("history images", REPO / "scripts/e2e_history_images.py"),
    ("scrollbars", REPO / "scripts/e2e_scrollbars.py"),
    ("roles", REPO / "scripts/e2e_roles.py"),
    ("role files", REPO / "scripts/e2e_role_files.py"),
    ("card pipeline", REPO / "scripts/e2e_card_pipeline.py"),
    ("auto approve", REPO / "scripts/e2e_auto_approve.py"),
    ("runner", REPO / "scripts/e2e_runner.py"),
    ("plan queue", REPO / "scripts/e2e_planqueue.py"),
    ("dispatch", REPO / "scripts/e2e_dispatch.py"),
    ("model step", REPO / "scripts/e2e_modelstep.py"),
    ("watchdog", REPO / "scripts/e2e_watchdog.py"),
    ("agents tab", REPO / "scripts/e2e_agents_tab.py"),
    ("pm", REPO / "scripts/e2e_pm.py"),
    ("review", REPO / "scripts/e2e_review.py"),
    ("review checker", REPO / "scripts/e2e_review_checker.py"),
    ("dashboard math", REPO / "scripts/e2e_dash_math.py"),
    ("voice", REPO / "scripts/e2e_voice.py"),
    ("bridge timeout", REPO / "scripts/e2e_bridge_timeout.py"),
    ("https panel", REPO / "scripts/e2e_https_panel.py"),
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
