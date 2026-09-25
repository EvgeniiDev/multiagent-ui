#!/usr/bin/env python3
"""E2E for the pm self-wakeup (server/acp-pm-wakeup.mjs).

Own state server on :25918 (STATE_DIR=<worktree>/tmp-pm-wakeup-test/state),
a scratch project at tmp-pm-wakeup-test/proj, run artefacts under
tmp-pm-wakeup-test/wakeup (PM_WAKEUP_DIR — the real default is the repo's
.acp/pm/wakeup). The pm role's `cli` is a stub that behaves like a real
role run: it reads the --prompt-file brief, does a REAL `pmgraph apply`
(with a minimal plan — mirror repair + derived blocked are the tool's own
arithmetic), and writes the report file the brief names.

Legs:

  1. fire    — a changed board + no pm history -> the role runs with no
               card and no stage binding: ledger gains kind:'pm' rows with
               role:'pm' (wakeup start/end + pmgraph's applied/run rows),
               the board gains exactly the safe-set changes, claims stay
               empty (nothing was claimed — this was not a card run);
  2. idle    — same board again -> skipped 'unchanged', zero new ledger
               rows (the quiet-night property);
  3. settle  — a fresh board write inside PM_QUIET_MIN -> 'settling' skip;
               quiet window off -> the run fires on the same change;
  4. claim   — a live pm claim -> 'pm-claim-live' skip even on a changed
               board; an expired claim -> the run fires;
  5. failure — stub exits 3 -> wrapper exits non-zero, the end row still
               lands (exit=3), the board doc is byte-identical, and the
               consumed hash means the NEXT tick does not hammer a retry;
  6. no-role — roles.json without 'pm' -> exit 2 + ONE ledger row, then
               silence (hash consumed) until the role appears;
  7. force   — --force runs even on an unchanged board;
  8. slot    — pm-wakeup.json running=<live pid> -> 'running' skip.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_pm_wakeup.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _e2e_harness import serve_state, stop, wait_port

ROOT = Path(__file__).resolve().parent.parent
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
WAKEUP = ROOT / "server" / "acp-pm-wakeup.mjs"
PM_ROLE = ROOT / ".acp" / "roles" / "pm.md"
WORK = ROOT / "tmp-pm-wakeup-test"
STATE_DATA = WORK / "state"
PROJ = WORK / "proj"
WAKE_DIR = WORK / "wakeup"
STUB = WORK / "stub_pm.py"

STATE_PORT = 25918               # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        STATE_URL + "/api/state" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def get_doc(name):
    status, body = api(f"/{name}")
    if status == 200:
        return body.get("data"), body.get("rev", 0)
    return None, 0


def force_put(name, data):
    _, rev = get_doc(name)
    status, body = api(f"/{name}", "PUT", {"data": data, "rev": rev})
    assert status == 200, f"put {name} -> {status} {body}"


def board_file_bytes():
    p = STATE_DATA / "board.json.json"
    return p.read_bytes() if p.exists() else b""


def activity_entries():
    doc, _ = get_doc("activity.json")
    return (doc or {}).get("entries") or []


def wakeup_doc():
    doc, _ = get_doc("pm-wakeup.json")
    return doc or {}


def wakeup(extra_env=None, force=False):
    env = dict(os.environ)
    env.update({
        "STATE_URL": STATE_URL,
        "PM_WAKEUP_DIR": str(WAKE_DIR),
        "PM_QUIET_MIN": "0",
        "STUB_PROJ": str(PROJ),
    })
    env.update(extra_env or {})
    cmd = ["node", str(WAKEUP)] + (["--force"] if force else [])
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          timeout=120, cwd=ROOT, env=env)
    last = (proc.stdout.strip().splitlines() or [""])[-1]
    try:
        payload = json.loads(last)
    except ValueError:
        payload = {"unparsed": last}
    return proc, payload


def mk_card(cid, title, stage="dev", status="in_progress", **kw):
    now = int(time.time() * 1000)
    card = {
        "id": cid, "title": title, "description": "",
        "project": "wakeup-proj", "agent": "", "priority": "medium",
        "acceptance": "", "verification": "",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": 10, "createdAt": now, "updatedAt": now,
    }
    card.update(kw)
    return card


A, B, C = "wk-aaaa", "wk-bbbb", "wk-cccc"


def seed_docs():
    cards = [
        mk_card(A, "Wakeup card A", dependsOn=[B]),   # unmirrored dep
        mk_card(B, "Wakeup card B"),
        mk_card(C, "Wakeup card C"),
    ]
    force_put("board.json", {"version": 2, "cards": cards})
    force_put("projects.json", {
        "version": 1,
        "projects": [{"id": "wk-e2e", "name": "wakeup-proj",
                      "path": str(PROJ),
                      "createdAt": int(time.time() * 1000)}],
        "activeProjectId": "wk-e2e",
    })
    force_put("roles.json", {"version": 1, "roles": [pm_role()],
                             "stageRoles": {}})
    return {c["id"]: c for c in cards}


def pm_role():
    return {
        "id": "pm",
        "label": "PM (stub)",
        "cli": sys.executable,
        "args": [str(STUB)],
        "promptFile": str(PM_ROLE),
        "maxConcurrent": 1,
        "pollIntervalSec": 15,
        "timeoutMin": 5,
        "maxRetries": 1,
    }


STUB_SRC = '''#!/usr/bin/env python3
"""Stub pm role CLI: --prompt-file in, real pmgraph apply, report out."""
import json
import os
import subprocess
import sys
from pathlib import Path


def main():
    args = sys.argv[1:]
    pf = args[args.index("--prompt-file") + 1] if "--prompt-file" in args else ""
    brief = Path(pf).read_text(encoding="utf-8") if pf else ""
    first = brief.splitlines()[0] if brief else "(no brief)"
    print(f"stub-pm: {pf} -> {first}")
    forced = os.environ.get("STUB_EXIT")
    if forced:
        print(f"stub-pm: forced exit {forced}")
        return int(forced)
    run_dir = Path(os.environ["PM_WAKEUP_RUN_DIR"])
    plan = run_dir / "plan.json"
    plan.write_text(json.dumps(
        {"findings": [], "actions": [], "proposals": []}))
    url = os.environ.get("BOARD_URL", "http://127.0.0.1:25900")
    r = subprocess.run(
        [sys.executable, "scripts/pmgraph", "--url", url, "apply",
         "--plan", str(plan), "--all",
         "--project-path", os.environ.get("STUB_PROJ", os.getcwd()),
         "--session", os.environ.get("SESSION_ID", "pmwake-stub")],
        capture_output=True, text=True, cwd=os.getcwd())
    print(r.stdout)
    if r.stderr.strip():
        print(r.stderr, file=sys.stderr)
    ok = r.returncode == 0
    (run_dir / "pm-report.md").write_text(
        "# pm auto report\\n\\n"
        + ("STATUS: DONE\\n" if ok else "STATUS: BLOCKED\\n"),
        encoding="utf-8")
    return 0 if ok else r.returncode


if __name__ == "__main__":
    sys.exit(main())
'''


def card(cid):
    doc, _ = get_doc("board.json")
    for c in (doc or {}).get("cards", []):
        if c.get("id") == cid:
            return c
    return None


def pm_rows(prefix=None):
    return [e for e in activity_entries() if e.get("role") == "pm"
            and (prefix is None
                 or (e.get("detail") or "").startswith(prefix))]


def touch_board(title):
    """A content change that pmgraph will not revert (title of card C)."""
    doc, _ = get_doc("board.json")
    cards = doc.get("cards", [])
    for c in cards:
        if c.get("id") == C:
            c["title"] = title
            c["updatedAt"] = int(time.time() * 1000)
    force_put("board.json", {"version": 2, "cards": cards})


# --- legs --------------------------------------------------------------------


def leg_fire(seeded):
    proc, out = wakeup()
    check("fire: wakeup exits 0", proc.returncode == 0,
          f"rc={proc.returncode} err={proc.stderr.strip()[:160]}")
    check("fire: stdout reports the run", bool(out.get("ran")),
          json.dumps(out)[:120])
    session = out.get("ran") or "pmwake-missing"

    rows = pm_rows()
    check("fire: ledger rows carry role pm",
          len(rows) >= 3, f"{len(rows)} pm rows")
    check("fire: wakeup start row names scope + cmd",
          any((e.get("detail") or "").startswith("wakeup start: scope=*")
              and "cmd:" in e.get("detail", "") for e in rows))
    check("fire: wakeup end row: exit=0 + verdict DONE",
          any(e.get("sessionId") == session
              and "exit=0" in (e.get("detail") or "")
              and "verdict: DONE" in (e.get("detail") or "")
              for e in rows),
          json.dumps([e.get("detail") for e in rows][-3:])[:240])
    check("fire: pmgraph's own run row shares the session",
          any(e.get("kind") == "pm"
              and (e.get("detail") or "").startswith(f"run {session}:")
              for e in rows))

    run_dir = WAKE_DIR / session
    check("fire: artefacts — brief, run.log, report",
          (run_dir / "brief.md").is_file()
          and (run_dir / "run.log").is_file()
          and (run_dir / "pm-report.md").is_file(),
          str(run_dir))
    brief = (run_dir / "brief.md").read_text()
    check("fire: brief declares the no-card scope + report path",
          "--all" in brief and "pm-report.md" in brief,
          brief.splitlines()[0] if brief else "empty")
    log = (run_dir / "run.log").read_text()
    check("fire: run.log captured the child's stdout",
          "stub-pm:" in log, log.strip()[:120])

    check("fire: mirror repaired — B.blocks += A",
          A in (card(B) or {}).get("blocks", []))
    a = card(A) or {}
    check("fire: A pm-blocked on the unfinished dep",
          a.get("blocked") is True
          and (a.get("blockedReason") or "") == f"pm: blocked by {B[:8]}",
          a.get("blockedReason") or "")
    check("fire: untouched card C byte-identical",
          card(C) == seeded[C])
    check("fire: no card was claimed (not a card run)",
          (get_doc("claims.json")[0] or {}).get("claims", {}) == {})
    check("fire: stage never moved",
          (card(A) or {}).get("stage") == "dev")

    doc = wakeup_doc()
    check("fire: wakeup doc — slot released, hash + session kept",
          doc.get("running") in (None, {})
          and doc.get("lastSession") == session
          and doc.get("lastExit") == 0
          and bool(doc.get("lastBoardHash")),
          json.dumps(doc)[:200])


def leg_idle():
    before = len(activity_entries())
    proc, out = wakeup()
    check("idle: second tick skips 'unchanged'",
          proc.returncode == 0 and out.get("skipped") == "unchanged",
          json.dumps(out)[:120])
    check("idle: zero new ledger rows",
          len(activity_entries()) == before,
          f"{len(activity_entries()) - before} new rows")


def leg_settle():
    touch_board("Wakeup card C — edited")
    before = len(activity_entries())
    proc, out = wakeup(extra_env={"PM_QUIET_MIN": "60"})
    check("settle: fresh edit inside quiet window skips",
          proc.returncode == 0 and out.get("skipped") == "settling",
          json.dumps(out)[:120])
    check("settle: skip wrote no ledger rows",
          len(activity_entries()) == before)

    proc, out = wakeup()
    check("settle: quiet window off — the pending change fires",
          proc.returncode == 0 and bool(out.get("ran")),
          json.dumps(out)[:120])
    check("settle: the run landed in the ledger",
          len(pm_rows("wakeup start")) >= 2)


def leg_claim_gate():
    touch_board("Wakeup card C — again")
    now = int(time.time() * 1000)
    # A live pm claim (as acp-runner would write it).
    force_put("claims.json", {"version": 1, "claims": {A: {
        "agentName": "host-runner:pm", "sessionId": "manual-1",
        "leaseUntil": now + 600_000, "startedAt": now, "claimedAt": now,
        "pid": os.getpid(), "roleId": "pm", "runnerId": "host-runner",
        "runnerPid": os.getpid(), "stage": "dev"}}, "attempts": {}})
    before = len(activity_entries())
    proc, out = wakeup()
    check("claim: live pm claim defers the auto-run",
          proc.returncode == 0 and out.get("skipped") == "pm-claim-live",
          json.dumps(out)[:120])
    check("claim: deferral wrote no ledger rows",
          len(activity_entries()) == before)

    # Lease lapsed and the pid is dead -> the claim is stale, run fires.
    force_put("claims.json", {"version": 1, "claims": {A: {
        "agentName": "host-runner:pm", "sessionId": "manual-1",
        "leaseUntil": now - 1000, "startedAt": now - 700_000,
        "claimedAt": now - 700_000, "pid": 99999999, "roleId": "pm",
        "runnerId": "host-runner", "runnerPid": 99999999,
        "stage": "dev"}}, "attempts": {}})
    proc, out = wakeup()
    check("claim: expired claim does not block",
          proc.returncode == 0 and bool(out.get("ran")),
          json.dumps(out)[:120])


def leg_failure():
    touch_board("Wakeup card C — third edit")
    snap = board_file_bytes()
    before = len(activity_entries())
    proc, out = wakeup(extra_env={"STUB_EXIT": "3"})
    check("failure: wrapper exits non-zero on child failure",
          proc.returncode != 0 and out.get("exit") == 3,
          f"rc={proc.returncode} out={json.dumps(out)[:120]}")
    check("failure: end row still audited (exit=3)",
          any("exit=3" in (e.get("detail") or "")
              for e in activity_entries()[before:]
              if e.get("role") == "pm"))
    check("failure: board doc byte-identical",
          board_file_bytes() == snap)

    before = len(activity_entries())
    proc, out = wakeup()
    check("failure: next tick does not hammer — 'unchanged' skip",
          proc.returncode == 0 and out.get("skipped") == "unchanged",
          json.dumps(out)[:120])
    check("failure: no retry rows", len(activity_entries()) == before)


def leg_no_role():
    touch_board("Wakeup card C — fourth edit")
    force_put("roles.json", {"version": 1, "roles": [], "stageRoles": {}})
    before = len(activity_entries())
    proc, out = wakeup()
    check("no-role: exit 2 + 'no-role' payload",
          proc.returncode == 2 and out.get("skipped") == "no-role",
          f"rc={proc.returncode} out={json.dumps(out)[:120]}")
    new = activity_entries()[before:]
    check("no-role: exactly one honest ledger row",
          len([e for e in new if e.get("role") == "pm"
               and "not in roles.json" in (e.get("detail") or "")]) == 1,
          json.dumps([e.get("detail") for e in new])[:160])

    before = len(activity_entries())
    proc, out = wakeup()
    check("no-role: next tick silent (change already consumed)",
          proc.returncode == 0 and out.get("skipped") == "unchanged"
          and len(activity_entries()) == before,
          json.dumps(out)[:120])

    force_put("roles.json", {"version": 1, "roles": [pm_role()],
                             "stageRoles": {}})
    touch_board("Wakeup card C — fifth edit")
    proc, out = wakeup()
    check("no-role: role restored + board moved -> fires",
          proc.returncode == 0 and bool(out.get("ran")),
          json.dumps(out)[:120])


def leg_force_and_slot():
    proc, out = wakeup(force=True)
    check("force: --force runs on an unchanged board",
          proc.returncode == 0 and bool(out.get("ran")),
          json.dumps(out)[:120])

    doc = wakeup_doc()
    _, rev = get_doc("pm-wakeup.json")
    doc["running"] = {"pid": os.getpid(), "at": int(time.time() * 1000),
                      "session": "pmwake-fake"}
    status, body = api("/pm-wakeup.json", "PUT", {"data": doc, "rev": rev})
    check("slot: test seeds a live running slot", status == 200,
          f"{status} {body}")
    proc, out = wakeup(force=True)
    check("slot: live slot beats even --force",
          proc.returncode == 0 and out.get("skipped") == "running"
          and out.get("session") == "pmwake-fake",
          json.dumps(out)[:120])


def main():
    global STATE_PORT, STATE_URL
    if WORK.exists():
        shutil.rmtree(WORK)
    STATE_DATA.mkdir(parents=True)
    PROJ.mkdir(parents=True)
    STUB.write_text(STUB_SRC)

    state, STATE_PORT = serve_state(STATE_PORT, STATE_DATA)
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        check("state server up", wait_port(STATE_PORT, 10))
        seeded = seed_docs()
        leg_fire(seeded)
        leg_idle()
        leg_settle()
        leg_claim_gate()
        leg_failure()
        leg_no_role()
        leg_force_and_slot()
    finally:
        stop(state)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
