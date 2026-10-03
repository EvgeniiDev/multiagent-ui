#!/usr/bin/env python3
"""u5_incident.py — controlled reproduction attempt for the U5 stop/check
incident (2026-10-01 05:01 run, u5_domain_selftest.mjs:451):

    ✖ U5 stop during a running check drains the proven group (10564.95ms)
      Error: drive timeout — last run failed/verify val=failed/verify

The run terminalized `failed/verify` while the test waited ~10.56s for a
live recorded check proc (original check: `sleep 60`, timeoutSec 90). A
later green run does NOT explain that — this suite reproduces the exact
original shape under controlled host load and collects per-iteration
terminal evidence.

Strategy (listener-free — no services, in-process state service):
  1. `node --test --test-name-pattern 'incident probe'` — the probe test
     added to u5_domain_selftest.mjs replicates the original shape verbatim;
     its drive() timeout dump contains the actual proc states, check-report
     exit codes, diagnostics and event tail.
  2. Iterations run under synthetic load (CPU burners + an IO loop) matching
     the incident's suspected race window.
  3. The gate-held variant runs under identical load as a regression check.

Verdict is honest: PASS means N/N iterations reproduced-or-clean with
recorded evidence; the report prints every iteration's outcome + any
failure dump so the reviewer sees exact proc/exit/event evidence — never
"closed because green".

Usage: python3 scripts/u5_incident.py [--iters 3] [--load]
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SELFTEST = REPO / "scripts" / "u5_domain_selftest.mjs"
# Full per-iteration diagnostics persist here — never truncated.
LOG_DIR = Path("/home/hermes/.cache/acp-u7-devin/u5-incident")

checks: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def sleep60_pids():
    """Pids of live `sleep 60` processes — the probe check's footprint."""
    r = subprocess.run(["pgrep", "-x", "-f", r"^sleep 60$"],
                       capture_output=True, text=True)
    return {int(p) for p in r.stdout.split() if p.strip().isdigit()}


def start_load():
    """Bounded host load: <=4 CPU burners + one finite IO churn, hard time
    cap ~180s so a forgotten load can never burn the shared host."""
    script = (
        "for i in $(seq 4); do (end=$((SECONDS+180)); "
        "while [ $SECONDS -lt $end ]; do :; done) & done; "
        "(end=$((SECONDS+180)); while [ $SECONDS -lt $end ]; do "
        "dd if=/dev/zero of=/tmp/u5-incident-io bs=1M count=16 "
        "conv=fdatasync 2>/dev/null; done) & wait"
    )
    p = subprocess.Popen(["bash", "-c", script], start_new_session=True)
    return p


def stop_load(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        p.wait(timeout=10)
    except Exception:
        pass


def verify_load_clean():
    r = subprocess.run(["pgrep", "-f", "u5-incident-io"], capture_output=True,
                       text=True)
    io_gone = Path("/tmp/u5-incident-io").exists() is False
    burners = subprocess.run(
        ["pgrep", "-f", r"SECONDS\+180"], capture_output=True, text=True)
    return not r.stdout.strip() and not burners.stdout.strip() and io_gone


def run_probe(pattern, tag, timeout=240):
    """Run the named node test once in its own process group; on timeout the
    whole group is killed and `sleep 60` strays are reaped. Returns
    (ok, duration_s, logfile, outcome) where outcome is pass|fail|timeout."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logf = LOG_DIR / f"{tag}-{int(time.time())}.log"
    baseline = sleep60_pids()
    t0 = time.time()
    proc = subprocess.Popen(
        ["node", "--test", f"--test-name-pattern={pattern}", str(SELFTEST)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        cwd=REPO, start_new_session=True)
    outcome = "pass"
    try:
        out, _ = proc.communicate(timeout=timeout)
        rc = proc.returncode
        if rc != 0:
            outcome = "fail"
    except subprocess.TimeoutExpired:
        outcome = "timeout"
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass
        try:
            out, _ = proc.communicate(timeout=15)
        except Exception:
            out = "<unreadable after killpg>"
        rc = -9
    dt = time.time() - t0
    # Reap probe check groups orphaned by a killed node process.
    strays = sleep60_pids() - baseline
    for pid in strays:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    with open(logf, "w") as f:
        f.write(f"# tag={tag} pattern={pattern} rc={rc} outcome={outcome} "
                f"duration={dt:.1f}s timeout={timeout}s\n"
                f"# strays_reaped={sorted(strays)}\n\n")
        f.write(out or "")
    ok = outcome == "pass"
    return ok, dt, str(logf), outcome


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=3)
    ap.add_argument("--load", action="store_true", default=False,
                    help="run under synthetic CPU+IO load")
    args = ap.parse_args()

    print(f"u5_incident — {args.iters} iters, load={'on' if args.load else 'off'}")

    load = start_load() if args.load else None
    try:
        repro = []
        for i in range(args.iters):
            ok, dt, logf, outcome = run_probe("incident probe", f"probe{i}")
            repro.append((ok, dt))
            print(f"  iter{i}: {outcome} {dt:.1f}s — full log {logf}")
        n_ok = sum(1 for ok, _ in repro if ok)
        check(f"incident probe x{args.iters}: outcomes recorded",
              True, "; ".join(f"{'pass' if ok else 'FAIL'}@{dt:.0f}s"
                              for ok, dt in repro))
        # Clean-sweep is reported as such, not as a proven fix. Any failure
        # leaves its FULL stdout+stderr in the printed log path.
        check("incident probe: every iteration clean (repro attempt)",
              n_ok == args.iters,
              f"{n_ok}/{args.iters} clean — failures keep full logs under "
              f"{LOG_DIR}")

        ok, dt, logf, outcome = run_probe("drains the proven group", "gate-held")
        check("gate-held stop test under same conditions", ok,
              f"{outcome} {dt:.1f}s — full log {logf}")
    finally:
        if load:
            stop_load(load)
            Path("/tmp/u5-incident-io").unlink(missing_ok=True)
            check("load: verified cleanup (no burners, no io file)",
                  verify_load_clean(), "")

    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("NOTE: a clean sweep means the incident was not reproduced under "
          "these conditions — remaining uncertainty must stay documented; "
          "it is not proof the original cause is fixed.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
