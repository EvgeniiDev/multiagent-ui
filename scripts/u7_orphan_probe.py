#!/usr/bin/env python3
"""u7_orphan_probe.py — listener-free proof of u7_run's group drain.

Cases (no services touched):
  A) leader exits nonzero while a `sleep` grandchild keeps the PGID —
     spawn() returns the leader's code AND the whole group is dead after.
  B) timeout — leader+grandchild in the group are drained via killpg.
  C) clean exit — drain is a harmless no-op (group already gone).

Prints PASS/FAIL lines; exit 0 only when all three hold.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import u7_run  # noqa: E402

FAILED = []


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {detail}", flush=True)
    if not cond:
        FAILED.append(name)


def spawn_capture(argv, timeout):
    """Like u7_run.spawn but captures stdout and returns (rc, pgid)."""
    p = subprocess.Popen(argv, start_new_session=True,
                         stdout=subprocess.PIPE, text=True)
    u7_run._pgid = p.pid
    pgid = p.pid
    try:
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        rc = "timeout"
    finally:
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        u7_run.drain_group()
    out = (p.stdout.read() or "").strip()
    return rc, pgid, out


def main() -> int:
    # A) leader exits 7, grandchild `sleep 300` outlives it in the group
    rc, pgid, out = spawn_capture(
        ["bash", "-c", "echo pgid=$$; sleep 300 & exit 7"], 30)
    check("A leader exit code preserved", rc == 7, f"rc={rc}")
    check("A orphan grandchild group drained", not u7_run.group_alive(pgid),
          f"pgid={pgid}")

    # B) timeout — leader sleeps forever with a grandchild too
    t0 = time.time()
    rc, pgid, out = spawn_capture(
        ["bash", "-c", "echo pgid=$$; sleep 300 & sleep 300"], 2)
    check("B timeout bounded", rc == "timeout" and time.time() - t0 < 30,
          f"rc={rc} dt={time.time() - t0:.1f}")
    check("B whole group drained after timeout",
          not u7_run.group_alive(pgid), f"pgid={pgid}")

    # C) clean exit — drain no-op
    rc, pgid, out = spawn_capture(["bash", "-c", "echo pgid=$$; exit 0"], 30)
    check("C clean exit rc=0", rc == 0, f"rc={rc}")
    check("C group already gone (drain no-op)",
          not u7_run.group_alive(pgid), f"pgid={pgid}")

    print("ALL PASS" if not FAILED else f"FAILURES: {FAILED}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
