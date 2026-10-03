#!/usr/bin/env python3
"""u7_run.py — whole-sequence orchestrator for the U7 test window.

Lifecycle ownership is explicit and evidence-bound:

  * A fresh `window` nonce is generated per invocation and passed to every
    transition call. The transition driver records `window-<nonce>.json`
    BEFORE the first scoped mutation (`stop cron`/`up`). restore() runs
    ONLY when that file exists — a refused apply (idle-preflight block,
    already-on-test-stack refusal, build failure) leaves no window file,
    so restore becomes a recorded no-op and never recreates live services
    over a window that owned nothing. Stale receipts from older windows
    can't trigger anything: the nonce is per-run.

  * Every spawned child heads its OWN process group (start_new_session).
    The group is tracked by PGID (= child pid), independent of the leader's
    lifetime — a suite that exits while a browser/`docker exec` grandchild
    survives is still drained: after EVERY spawn (normal exit, nonzero,
    timeout) the group is probe-killed (killpg 0 -> TERM -> KILL). Restore
    never runs while a group this window spawned is still alive, so no
    orphaned test driver can POST to the fixed endpoints mid-restore.

  * Signals: drain the owned group, then restore-if-owned, persist, exit.

  python3 scripts/u7_run.py --self-run-id <id> [--phases a,b,c]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIV = Path(os.path.expanduser("~/.cache/acp-u7-devin"))
TRANSITION = ROOT / "scripts" / "u7_transition.py"
LOG = PRIV / "u7-run.log"

# name -> (kind, target, timeout seconds, extra argv)
#   kind "transition" -> python3 u7_transition.py <target>
#   kind "suite"      -> python3|node <repo>/scripts/<target> <extra...>
# api-flow is split into one bounded phase PER CLI — u7_api_flow.py
# requires --cli; running it bare would exit 2 (usage) without launching
# anything, and the three runs stay strictly sequential (one process at a
# time, same workspace sandbox, never concurrent). u7_browser.py likewise
# requires --phase: the ON-stack flow (browser-on) and the default-off
# gates (browser-off, must run AFTER the "off" transition) are separate
# bounded phases — a bare "browser" entry would exit 2 untouched.
PHASES: dict[str, tuple[str, str, int, tuple[str, ...]]] = {
    "off-smoke":      ("suite", "u7_off_smoke.py",   600,  ()),
    "on":             ("transition", "on",           300,  ()),
    "api-flow-pi":    ("suite", "u7_api_flow.py",    1800, ("--cli", "pi")),
    "api-flow-codex": ("suite", "u7_api_flow.py",    1800, ("--cli", "codex")),
    "api-flow-devin": ("suite", "u7_api_flow.py",    1800, ("--cli", "devin")),
    "acp":            ("suite", "u7_acp_bridge.mjs", 600,  ()),
    "browser-on":     ("suite", "u7_browser.py",     3600, ("--phase", "on")),
    "browser-probe":  ("suite", "u7_browser.py",     600,  ("--phase", "probe")),
    "crash":          ("suite", "u7_crash.py",       1800, ()),
    "u5-incident":    ("suite", "u5_incident.py",    1200, ()),
    # F4: fusion runs the managed ON gates + ACP_EXEC_FUSION on top — the
    # "fusion" transition stacks compose.u7-fusion.yaml; the browser suite
    # drives the real panel UI (never together with "on"-phase suites that
    # assume the narrower overlay).
    "fusion":         ("transition", "fusion",       300,  ()),
    "browser-fusion": ("suite", "e2e_fusion.py",     3600, ()),
    "off":            ("transition", "off",          300,  ()),
    "browser-off":    ("suite", "u7_browser.py",     1800, ("--phase", "off")),
}
DEFAULT_ORDER = [
    "off-smoke", "on", "api-flow-pi", "api-flow-codex", "api-flow-devin",
    "acp", "browser-on", "crash", "u5-incident", "off", "browser-off",
]

# Suites needing a non-default interpreter: playwright + cached chromium
# live ONLY in the tools venv (never pip-installed into system python3,
# which is what sys.executable would otherwise hand the child).
VENV_PY = os.path.expanduser("~/.hermes/tools-venv/bin/python")
SUITE_INTERP = {"u7_browser.py": VENV_PY, "e2e_fusion.py": VENV_PY}

_results: dict = {}
_pgid: int | None = None        # owned process group of the running spawn
_restoring = False
_window = ""


def log(line: str) -> None:
    PRIV.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")
    try:
        print(line, flush=True)
    except OSError:
        pass  # a dead supervisor pipe must never kill the window


def phase_log_path(name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
    return PRIV / f"phase-{safe}-{_window or 'pre'}.log"


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def drain_group() -> None:
    """Terminate the tracked process GROUP — the suite leader may already
    be dead while a browser/`docker exec` grandchild still holds the pgid;
    ownership ends only when the group itself is empty. Only ever signals
    the group this window spawned (its own start_new_session pgid)."""
    global _pgid
    pg = _pgid
    _pgid = None
    if pg is None:
        return
    if not group_alive(pg):
        return
    try:
        os.killpg(pg, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    for _ in range(30):                     # up to ~3s for a clean exit
        if not group_alive(pg):
            return
        time.sleep(0.1)
    if group_alive(pg):
        try:
            os.killpg(pg, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        for _ in range(30):
            if not group_alive(pg):
                break
            time.sleep(0.1)


def spawn(argv: list[str], timeout: int, name: str = "phase") -> int | str:
    """Run a phase child in its own process group; ALWAYS drain that group
    afterwards (leader exit does not imply group exit). Child stdout/stderr
    go to a durable per-phase file — inherited stdout dies with the
    supervisor, which is exactly how two windows lost their failure
    details and one exited 120 on a dead-pipe shutdown flush."""
    global _pgid
    plog = phase_log_path(name)
    PRIV.mkdir(parents=True, exist_ok=True)
    with open(plog, "ab") as pf:
        pf.write(f"== spawn {' '.join(map(str, argv))}\n".encode())
        pf.flush()
        p = subprocess.Popen(argv, start_new_session=True,
                             stdout=pf, stderr=subprocess.STDOUT)
        _pgid = p.pid                       # leader pid IS the new pgid
        try:
            rc = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            rc = "timeout"
        finally:
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            drain_group()
        pf.write(f"== exit {rc}\n".encode())
    return rc


def window_mutated() -> bool:
    return bool(_window) and (PRIV / f"window-{_window}.json").exists()


def restore_and_verify() -> None:
    global _restoring
    if _restoring:
        return
    _restoring = True
    try:
        drain_group()                       # never restore under live spawn
        if not window_mutated():
            _results["restore"] = "skipped:no-window-mutation"
            _results["verify"] = "skipped"
            log("restore skipped — this window never mutated the stack")
            return
        log("== restore ==")
        try:
            _results["restore"] = spawn(
                [sys.executable, str(TRANSITION), "restore"], 900,
                "restore")
        except Exception as e:
            _results["restore"] = f"error:{e!r}"
        _persist()              # survive a kill between restore and verify
        log("== verify ==")
        try:
            _results["verify"] = spawn(
                [sys.executable, str(TRANSITION), "verify"], 300,
                "verify")
        except Exception as e:
            _results["verify"] = f"error:{e!r}"
    finally:
        _restoring = False


def _dead(signum, _frame):
    log(f"signal {signum} — drain owned group, restore-if-owned, exit")
    try:
        restore_and_verify()
    finally:
        _persist()
    os._exit(128 + signum)


def _persist() -> None:
    PRIV.mkdir(parents=True, exist_ok=True)
    fd = os.open(PRIV / "u7-run-result.json",
                 os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({**_results, "window": _window}, f, indent=2)
    log(f"results: {json.dumps(_results)}")


def main() -> int:
    global _window
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-run-id", required=True)
    ap.add_argument("--phases", default=",".join(DEFAULT_ORDER))
    ap.add_argument("--keep-going", action="store_true")
    args = ap.parse_args()
    signal.signal(signal.SIGINT, _dead)
    signal.signal(signal.SIGTERM, _dead)

    wanted = [p for p in args.phases.split(",") if p]
    # Validate EVERY phase target before any service change — a missing
    # suite fails fast with the stack untouched, never a silent skip.
    for name in wanted:
        spec = PHASES.get(name)
        if spec is None:
            print(f"unknown phase {name!r}; known: {', '.join(PHASES)}")
            return 2
        kind, target, _tmo, _extra = spec
        if kind == "suite":
            path = ROOT / "scripts" / target
            if not path.is_file():
                print(f"REFUSE: phase {name!r} suite file {path} missing — "
                      f"no service touched")
                return 2
            interp = SUITE_INTERP.get(target)
            if interp and not Path(interp).is_file():
                print(f"REFUSE: phase {name!r} interpreter {interp} "
                      f"missing — no service touched")
                return 2
        elif kind != "transition":
            print(f"unknown phase kind {kind!r}")
            return 2

    _window = secrets.token_hex(8)
    try:
        log(f"== apply (OFF transition) window={_window} ==")
        rc = spawn([sys.executable, str(TRANSITION), "apply",
                    "--self-run-id", args.self_run_id,
                    "--window", _window], 1800, "apply")
        _results["apply"] = rc
        _persist()
        if rc != 0:
            return 1
        for name in wanted:
            kind, target, tmo, extra = PHASES[name]
            log(f"== phase {name} ({kind}:{target} {' '.join(extra)}, "
                f"tmo={tmo}s) ==")
            if kind == "transition":
                argv = [sys.executable, str(TRANSITION), target,
                        "--window", _window]
            else:
                interp = ("node" if target.endswith(".mjs")
                          else SUITE_INTERP.get(target, sys.executable))
                argv = [interp, str(ROOT / "scripts" / target), *extra]
            rc = spawn(argv, tmo, name)
            _results[name] = rc
            log(f"phase {name}: {rc} — output {phase_log_path(name)}")
            _persist()          # every completed phase stays durable
            if rc != 0 and not args.keep_going:
                break
    finally:
        restore_and_verify()
        _persist()
    bad = {k: v for k, v in _results.items() if v not in (0, "0")}
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
