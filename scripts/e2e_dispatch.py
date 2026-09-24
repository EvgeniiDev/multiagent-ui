#!/usr/bin/env python3
"""E2E for the W8 dispatcher gaps (server/acp-runner.mjs): heartbeat,
lease-expiry sweep, maxRetries, stop cranks, audit fields.

Spins up its OWN state server (server/acp-state-server.mjs) on port 25908
with STATE_DIR=<worktree>/tmp-dispatch-test, a project inside it, and a role
whose `cli` is `node <stub>` — a script under our control that can sleep,
fail N times, and move its own card through the board API (the agent moves
the card; the runner never does). Asserts:

  1. role mismatch -> card not taken; matching role -> the stub moves it
     dev -> reviewtest and the board doc rev moves exactly once (the runner
     never moves cards);
  2. a run outliving its initial lease keeps it alive via heartbeat, and a
     second dispatcher still refuses the card;
  3. a SIGKILLed dispatcher + dead child -> expired claim is swept: claim
     dropped, card back to the stage it was claimed from, flagged blocked,
     and the ledger says so;
  4. maxRetries honoured: failing stub retried up to the cap then blocked,
     flaky-then-passing stub clears the counter, passing stub not retried;
  5. cancel <card> kills that card's child only + flags it blocked;
     cancel on a foreign claim refuses; stop-all releases only this
     dispatcher's claims and kills only its own children;
  6. ledger entries written by the dispatcher carry `role` + `sessionId`.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_dispatch.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _e2e_harness import STATE_SERVER, serve_state, stop

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "server" / "acp-runner.mjs"
STATE_DIR = ROOT / "tmp-dispatch-test"
STATE_PORT = 25908               # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
PROJ = STATE_DIR / "proj"

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def wait_for(fn, timeout=15.0, interval=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        val = fn()
        if val:
            return val
        time.sleep(interval)
    return fn()


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


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


def put_doc(name, data, rev):
    return api(f"/{name}", "PUT", {"data": data, "rev": rev})


def force_put(name, data):
    _, rev = get_doc(name)
    status, body = put_doc(name, data, rev)
    assert status == 200, f"put {name} -> {status} {body}"


def mk_card(cid, stage, status=None, project="p1", order=10):
    now = int(time.time() * 1000)
    return {
        "id": cid, "title": f"E2E {cid}", "description": "d",
        "project": project, "agent": "", "priority": "medium",
        "acceptance": "accepts X", "verification": "run Y",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": order, "createdAt": now, "updatedAt": now,
    }


def seed(board_cards, role_overrides=None, stage_roles=None):
    """Rewrite board.json + roles.json for a leg (claims/activity persist)."""
    role = {
        "id": "dev", "label": "Dev", "cli": "node",
        "args": [str(STATE_DIR / "stub-cli.mjs")],
        "promptFile": ".acp/roles/dev.md",
        "maxConcurrent": 2, "pollIntervalSec": 5,
        "timeoutMin": 0.5, "maxRetries": 1,
    }
    role.update(role_overrides or {})
    force_put("board.json", {"version": 2, "cards": board_cards})
    force_put("roles.json", {
        "version": 1, "roles": [role],
        "stageRoles": stage_roles if stage_roles is not None else {"dev": "dev"},
    })


def runner_env(runner_id, env_extra=None):
    env = {**os.environ, "STATE_URL": STATE_URL,
           "ROOT_DIR": str(STATE_DIR),
           "RUNNER_ID": runner_id,
           "STUB_MOVE_LOG": str(STATE_DIR / "moves.log")}
    env.update(env_extra or {})
    return env


def run_runner(*args, runner_id="e2e-runner", env_extra=None, timeout=120):
    return subprocess.run(
        ["node", str(RUNNER), *args], capture_output=True, text=True,
        timeout=timeout, env=runner_env(runner_id, env_extra), cwd=ROOT)


def serve_runner(runner_id, env_extra=None):
    return subprocess.Popen(
        ["node", str(RUNNER), "--serve"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=runner_env(runner_id, env_extra), cwd=ROOT)


def card_dir(card_id):
    return PROJ / ".acp" / "cards" / card_id


def claims_map():
    doc, _ = get_doc("claims.json")
    return (doc or {}).get("claims") or {}


def attempts_map():
    doc, _ = get_doc("claims.json")
    return (doc or {}).get("attempts") or {}


def board_card(cid):
    doc, _ = get_doc("board.json")
    for c in (doc or {}).get("cards", []):
        if c.get("id") == cid:
            return c
    return None


def activity_entries():
    doc, _ = get_doc("activity.json")
    return (doc or {}).get("entries") or []


def stop_serve(proc, timeout=10):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def write_stub():
    """The stub role CLI: `node stub-cli.mjs <role-args...> <promptLine>`.

    Controlled by env: prints `SESSION: sess-<cardId>` early, drops its pid
    into <cardDir>/child.pid, optionally moves its own card through the
    board API (STUB_MOVE), optionally fails the first STUB_FAIL_TIMES
    invocations (STUB_COUNT_FILE + STUB_FAIL_CODE), optionally sleeps
    (STUB_SLEEP_SEC) before exiting with STUB_EXIT.
    """
    stub = STATE_DIR / "stub-cli.mjs"
    stub.write_text(
        "import { promises as fs } from 'node:fs';\n"
        "const env = process.env;\n"
        "const arg = process.argv.slice(2).find((a) => /\\/[^\\s]*00_brief\\.md/.test(a)) || '';\n"
        "const m = /(\\/[^\\s]*)00_brief\\.md/.exec(arg);\n"
        "if (!m) { console.error('stub: no brief path in argv'); process.exit(64); }\n"
        "const cardDir = m[1];\n"
        "const cardId = cardDir.split('/').filter(Boolean).pop();\n"
        "console.log(`SESSION: sess-${cardId}`);\n"
        "await fs.mkdir(cardDir, { recursive: true });\n"
        "await fs.writeFile(`${cardDir}/child.pid`, String(process.pid));\n"
        "if (env.STUB_MOVE) {\n"
        "  for (let i = 0; i < 6; i++) {\n"
        "    const res = await fetch(`${env.STATE_URL}/api/state/board.json`);\n"
        "    const doc = await res.json();\n"
        "    const card = (doc.data.cards || []).find((c) => c.id === cardId);\n"
        "    if (card && card.stage !== env.STUB_MOVE) {\n"
        "      if (card.status) card.statusByStage = { ...(card.statusByStage || {}), [card.stage]: card.status };\n"
        "      card.stage = env.STUB_MOVE;\n"
        "      card.status = 'in_progress';\n"
        "      card.updatedAt = Date.now();\n"
        "    }\n"
        "    const put = await fetch(`${env.STATE_URL}/api/state/board.json`, {\n"
        "      method: 'PUT', headers: { 'content-type': 'application/json' },\n"
        "      body: JSON.stringify({ data: doc.data, rev: doc.rev }),\n"
        "    });\n"
        "    if (put.status === 200) break;\n"
        "    if (put.status !== 409) throw new Error(`board PUT -> ${put.status}`);\n"
        "    await new Promise((r) => setTimeout(r, 200));\n"
        "  }\n"
        "  await fs.appendFile(env.STUB_MOVE_LOG, `${cardId} -> ${env.STUB_MOVE}\\n`);\n"
        "}\n"
        "const failTimes = Number(env.STUB_FAIL_TIMES || 0);\n"
        "if (env.STUB_COUNT_FILE && failTimes > 0) {\n"
        "  let n = 0;\n"
        "  try { n = Number(await fs.readFile(env.STUB_COUNT_FILE, 'utf8')); } catch {}\n"
        "  n += 1;\n"
        "  await fs.writeFile(env.STUB_COUNT_FILE, String(n));\n"
        "  if (n <= failTimes) process.exit(Number(env.STUB_FAIL_CODE || 7));\n"
        "}\n"
        "await fs.writeFile(`${cardDir}/04_impl_log.md`, 'did the thing\\nSTATUS: DONE\\n');\n"
        "const sleepSec = Number(env.STUB_SLEEP_SEC || 0);\n"
        "if (sleepSec > 0) await new Promise((r) => setTimeout(r, sleepSec * 1000));\n"
        "process.exit(Number(env.STUB_EXIT || 0));\n")
    return stub


def main():
    global STATE_PORT, STATE_URL
    if not STATE_SERVER.exists():
        print(f"FAIL  {STATE_SERVER} missing")
        sys.exit(1)
    if not RUNNER.exists():
        print(f"FAIL  {RUNNER} missing")
        sys.exit(1)

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)
    PROJ.mkdir(parents=True)
    write_stub()

    strays = []  # child pids we may have to clean up
    serves = []

    state, STATE_PORT = serve_state(STATE_PORT, STATE_DIR)
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        now = int(time.time() * 1000)
        projects = {"version": 1,
                    "projects": [{"id": "p1", "name": "P1",
                                   "path": str(PROJ), "createdAt": now}],
                    "activeProjectId": "all"}
        for name, doc in (("projects.json", projects),
                          ("claims.json", {"version": 1, "claims": {}, "attempts": {}}),
                          ("activity.json", {"entries": [], "usage": []})):
            status, _ = put_doc(name, doc, 0)
            assert status == 200, f"seed {name} -> {status}"

        # ================= leg 1: role match + the agent moves the card ======
        seed([mk_card("card-spec", "spec", "in_progress"),
              mk_card("card-dev", "dev", "in_progress")],
             {"timeoutMin": 0.5, "maxRetries": 1})
        _, board_rev0 = get_doc("board.json")

        proc = run_runner("--once", env_extra={"STUB_MOVE": "reviewtest"})
        check("leg1 once exits 0", proc.returncode == 0, proc.stderr[:200])
        try:
            runs = json.loads(proc.stdout).get("runs", [])
        except ValueError:
            runs = None
        ran = sorted(r.get("card") for r in (runs or []) if r.get("exitCode") == 0)
        check("role mismatch: spec card not taken, dev card ran",
              ran == ["card-dev"], json.dumps(runs)[:300])
        check("role mismatch: no card dir for the spec card",
              not card_dir("card-spec").exists())

        spec_card = board_card("card-spec")
        dev_card = board_card("card-dev")
        check("matching role: stub moved dev card to reviewtest",
              dev_card is not None and dev_card.get("stage") == "reviewtest",
              json.dumps(dev_card)[:200])
        _, board_rev1 = get_doc("board.json")
        check("card moved exactly once (board rev +1, runner never moves)",
              board_rev1 == board_rev0 + 1, f"rev {board_rev0} -> {board_rev1}")
        check("spec card untouched (still spec, unclaimed)",
              spec_card is not None and spec_card.get("stage") == "spec"
              and "card-spec" not in claims_map())
        check("dev card claim released after run",
              "card-dev" not in claims_map())

        mine = [e for e in activity_entries()
                if e.get("agentName") == "e2e-runner:dev"]
        check("audit: claim/start/exit entries landed",
              any("claimed" in (e.get("detail") or "") for e in mine)
              and any("start" in (e.get("detail") or "") for e in mine)
              and any("exit=0" in (e.get("detail") or "") for e in mine),
              json.dumps(mine[-2:])[:300] if mine else "none")
        check("audit: entries carry role=dev and sessionId",
              all(e.get("role") == "dev" for e in mine)
              and any(e.get("sessionId") == "sess-card-dev" for e in mine),
              json.dumps(mine[-1])[:300] if mine else "none")

        # ================= leg 2: heartbeat keeps a long run alive ===========
        # timeoutMin doubles as the run's kill timeout, so the child cannot
        # outlive its own lease — what the heartbeat proves mid-run is that
        # leaseUntil keeps getting pushed out past its initial expiry.
        seed([mk_card("card-hb", "dev", "in_progress")],
             {"timeoutMin": 0.2, "maxRetries": 1})
        serve = serve_runner("disp-hb", {"STUB_SLEEP_SEC": "20"})
        serves.append(serve)
        claim = wait_for(lambda: claims_map().get("card-hb"), timeout=15)
        check("heartbeat: card claimed", bool(claim), json.dumps(claims_map())[:200])
        if claim:
            lease0 = int(claim.get("leaseUntil") or 0)
            hb_pid = int(claim.get("pid") or 0)
            strays.append(hb_pid)
            # First renewal lands ~5s in (tick = pollIntervalSec, floor 5s);
            # the run still has seconds to go at that point.
            time.sleep(6.5)
            claim2 = claims_map().get("card-hb") or {}
            now_ms = int(time.time() * 1000)
            check("heartbeat: lease renewed mid-run, past initial expiry",
                  int(claim2.get("leaseUntil") or 0) > lease0
                  and int(claim2.get("leaseUntil") or 0) > now_ms
                  and pid_alive(hb_pid),
                  f"{lease0} -> {claim2.get('leaseUntil')} now={now_ms}")

            proc = run_runner("--once", runner_id="disp-other")
            try:
                runs = json.loads(proc.stdout).get("runs", [])
            except ValueError:
                runs = None
            check("heartbeat: second dispatcher still refuses the card",
                  runs == [], proc.stdout[:300])

            gone = wait_for(lambda: "card-hb" not in claims_map(), timeout=20)
            check("heartbeat: run ended and claim released", bool(gone))
            stop_serve(serve)
            serves.remove(serve)
            exits = [e for e in activity_entries()
                     if "exit=" in (e.get("detail") or "")
                     and e.get("title") == "E2E card-hb"]
            check("heartbeat: exit entry carries role+sessionId",
                  bool(exits) and exits[-1].get("role") == "dev"
                  and exits[-1].get("sessionId") == "sess-card-hb",
                  json.dumps(exits[-1])[:200] if exits else "none")

        # ================= leg 3: dead dispatcher -> lease sweep =============
        seed([mk_card("card-exp", "dev", "in_progress")],
             {"timeoutMin": 0.1, "maxRetries": 1})
        serve = serve_runner("disp-x", {"STUB_SLEEP_SEC": "60",
                                        "STUB_MOVE": "reviewtest"})
        serves.append(serve)

        def exp_ready():
            c = claims_map().get("card-exp")
            card = board_card("card-exp")
            if c and c.get("pid") and card and card.get("stage") == "reviewtest":
                return c
            return None

        claim = wait_for(exp_ready, timeout=15)
        check("sweep setup: claimed and card moved by the stub",
              bool(claim), json.dumps(claim)[:200])
        if claim:
            child_pid = int(claim["pid"])
            strays.append(child_pid)
            serve.kill()  # SIGKILL the dispatcher mid-run — no cleanup
            try:
                os.kill(child_pid, signal.SIGKILL)  # the child died too
            except OSError:
                pass
            serve.wait(timeout=5)
            serves.remove(serve)
            # A SIGKILLed child can linger as a zombie for a moment; the
            # sweep only fires once the pid is really gone — wait for that
            # first, otherwise a racing --once could re-take the card.
            wait_for(lambda: not pid_alive(child_pid), timeout=10)

            def swept():
                card = board_card("card-exp")
                return ("card-exp" not in claims_map()
                        and card and card.get("blocked"))
            # The lease (~6s) must lapse first; poll --once sweeps.
            deadline = time.time() + 25
            ok = False
            while time.time() < deadline:
                run_runner("--once", runner_id="disp-y")
                if swept():
                    ok = True
                    break
                time.sleep(1.0)
            card = board_card("card-exp") or {}
            check("sweep: expired claim dropped and card flagged blocked", ok,
                  json.dumps(card)[:300])
            check("sweep: card returned to the stage it was claimed from",
                  card.get("stage") == "dev", card.get("stage", "?"))
            check("sweep: visible mark names the expiry",
                  "expired" in (card.get("blockedReason") or ""),
                  card.get("blockedReason", ""))
            sweep_entries = [e for e in activity_entries()
                             if "lease expired" in (e.get("detail") or "")]
            check("sweep: ledger entry with role+sessionId",
                  bool(sweep_entries)
                  and sweep_entries[-1].get("role") == "dev",
                  json.dumps(sweep_entries[-1])[:250] if sweep_entries else "none")

        # ================= leg 4: maxRetries =================================
        count_file = STATE_DIR / "flaky-count"
        count_file.write_text("0")

        seed([mk_card("card-retry", "dev", "in_progress")],
             {"timeoutMin": 0.5, "maxRetries": 3})
        proc = run_runner("--once", env_extra={"STUB_EXIT": "7"})
        check("retries: once exits 0", proc.returncode == 0, proc.stderr[:200])
        logs = sorted(card_dir("card-retry").glob("run-*.log")) \
            if card_dir("card-retry").exists() else []
        check("retries: failing stub ran maxRetries times",
              len(logs) == 3, ",".join(p.name for p in logs))
        check("retries: attempt counter persisted",
              attempts_map().get("card-retry") == 3,
              json.dumps(attempts_map()))
        card = board_card("card-retry") or {}
        check("retries: exhausted card flagged blocked with reason",
              card.get("blocked") is True
              and "maxRetries" in (card.get("blockedReason") or ""),
              json.dumps(card)[:250])
        exits = [e for e in activity_entries()
                 if e.get("title") == "E2E card-retry"
                 and "exit=" in (e.get("detail") or "")
                 and "attempt=" in (e.get("detail") or "")]
        marks = [(e.get("detail") or "").split("attempt=")[-1].split(" ")[0]
                 for e in exits]
        check("retries: attempt numbers in the ledger",
              marks[:3] == ["1/3", "2/3", "3/3"], json.dumps(marks))
        check("retries: retry entries audited",
              sum(1 for e in activity_entries()
                  if "retry" in (e.get("detail") or "")
                  and e.get("title") == "E2E card-retry") >= 2)

        seed([mk_card("card-flaky", "dev", "in_progress")],
             {"timeoutMin": 0.5, "maxRetries": 3})
        proc = run_runner("--once", env_extra={
            "STUB_FAIL_TIMES": "1", "STUB_COUNT_FILE": str(count_file),
            "STUB_FAIL_CODE": "7"})
        logs = sorted(card_dir("card-flaky").glob("run-*.log")) \
            if card_dir("card-flaky").exists() else []
        check("retries: flaky stub retried once then passed",
              len(logs) == 2, ",".join(p.name for p in logs))
        check("retries: successful retry clears the counter",
              attempts_map().get("card-flaky") is None,
              json.dumps(attempts_map()))
        card = board_card("card-flaky") or {}
        check("retries: flaky card not blocked",
              card.get("blocked") is not True, json.dumps(card)[:200])

        seed([mk_card("card-pass", "dev", "in_progress")],
             {"timeoutMin": 0.5, "maxRetries": 3})
        proc = run_runner("--once", env_extra={"STUB_EXIT": "0"})
        logs = sorted(card_dir("card-pass").glob("run-*.log")) \
            if card_dir("card-pass").exists() else []
        check("retries: passing stub is not retried",
              len(logs) == 1, ",".join(p.name for p in logs))
        check("retries: passing card keeps no counter and no flag",
              attempts_map().get("card-pass") is None
              and (board_card("card-pass") or {}).get("blocked") is not True)

        # ================= leg 5: cancel + stop-all ==========================
        seed([mk_card("card-c1", "dev", "in_progress", order=10),
              mk_card("card-c2", "dev", "in_progress", order=20),
              mk_card("card-foreign", "backlog")],
             {"timeoutMin": 1, "maxRetries": 1, "maxConcurrent": 2})
        sa = serve_runner("disp-a", {"STUB_SLEEP_SEC": "60"})
        sb = serve_runner("disp-b", {"STUB_SLEEP_SEC": "60"})
        serves += [sa, sb]

        def two_claims():
            cl = claims_map()
            a = cl.get("card-c1")
            b = cl.get("card-c2")
            if a and b and a.get("pid") and b.get("pid"):
                return cl
            return None

        cl = wait_for(two_claims, timeout=20)
        check("cranks setup: two dispatchers hold one card each",
              bool(cl), json.dumps(cl)[:300])
        if cl:
            owner = {cid: (cl[cid].get("runnerId") or "")
                     for cid in ("card-c1", "card-c2")}
            pids = {cid: int(cl[cid]["pid"]) for cid in ("card-c1", "card-c2")}
            strays += list(pids.values())
            a_card = "card-c1" if owner["card-c1"] == "disp-a" else "card-c2"
            b_card = "card-c2" if a_card == "card-c1" else "card-c1"

            # Foreign claim on the backlog card: a live sleep process whose
            # runnerPid is the TEST pid — if the runner skipped the runnerId
            # check it could kill it. It must not.
            foreign = subprocess.Popen(["sleep", "60"])
            strays.append(foreign.pid)
            claims_doc, rev = get_doc("claims.json")
            claims_doc.setdefault("claims", {})["card-foreign"] = {
                "agentName": "other-runner:dev", "sessionId": "sess-foreign",
                "leaseUntil": int(time.time() * 1000) + 600_000,
                "startedAt": int(time.time() * 1000),
                "claimedAt": int(time.time() * 1000),
                "pid": foreign.pid, "roleId": "dev",
                "runnerId": "other-runner", "runnerPid": os.getpid()}
            status, _ = put_doc("claims.json", claims_doc, rev)
            assert status == 200, f"plant foreign claim -> {status}"

            proc = run_runner("cancel", a_card, runner_id="disp-a")
            check("cancel exits 0 on an own claim",
                  proc.returncode == 0, proc.stderr[:200])
            check("cancel killed that card's child",
                  wait_for(lambda: not pid_alive(pids[a_card]), timeout=8),
                  f"pid={pids[a_card]}")
            check("cancel released that claim only",
                  a_card not in claims_map() and b_card in claims_map())
            check("cancel left the other child running",
                  pid_alive(pids[b_card]), f"pid={pids[b_card]}")
            card = board_card(a_card) or {}
            check("cancel flags the card blocked so it is not re-dispatched",
                  card.get("blocked") is True
                  and "cancel" in (card.get("blockedReason") or ""),
                  card.get("blockedReason", ""))

            proc = run_runner("cancel", b_card, runner_id="disp-a")
            check("cancel refuses a foreign claim (non-zero exit)",
                  proc.returncode != 0, f"rc={proc.returncode}")
            check("cancel refusal kills nothing",
                  pid_alive(pids[b_card]) and b_card in claims_map())

            proc = run_runner("cancel", "card-foreign", runner_id="disp-a")
            check("cancel refuses the planted foreign claim too",
                  proc.returncode != 0 and pid_alive(foreign.pid)
                  and "card-foreign" in claims_map())

            proc = run_runner("stop-all", runner_id="disp-b")
            check("stop-all exits 0", proc.returncode == 0, proc.stderr[:200])
            # The freed card is eligible again — kill both serves before
            # their next poll re-dispatches it under our assertions.
            for s in (sa, sb):
                s.kill()
                s.wait(timeout=5)
                serves.remove(s)
            check("stop-all released only this dispatcher's claims",
                  b_card not in claims_map()
                  and "card-foreign" in claims_map(),
                  json.dumps(claims_map())[:300])
            check("stop-all killed only this dispatcher's child",
                  wait_for(lambda: not pid_alive(pids[b_card]), timeout=8)
                  and pid_alive(foreign.pid),
                  f"own={pids[b_card]} foreign={foreign.pid}")
            card = board_card(b_card) or {}
            check("stop-all does not flag the released card",
                  card.get("blocked") is not True, json.dumps(card)[:200])

            cranks = [e for e in activity_entries()
                      if ("cancel" in (e.get("detail") or "")
                          or "stop-all" in (e.get("detail") or ""))
                      and str(e.get("agentName", "")).startswith("disp-")]
            check("cranks: cancel/stop-all audited with role+sessionId",
                  any("cancel" in (e.get("detail") or "") for e in cranks)
                  and any("stop-all" in (e.get("detail") or "") for e in cranks)
                  and all(e.get("role") == "dev" for e in cranks)
                  and any(e.get("sessionId") == f"sess-{a_card}"
                          for e in cranks),
                  json.dumps(cranks)[:400])

        # ================= leg 6: audit fields across the suite ==============
        disp = [e for e in activity_entries()
                if str(e.get("agentName", "")).startswith(("disp", "e2e"))]
        check("audit: every dispatcher entry carries a role field",
              bool(disp) and all("role" in e for e in disp),
              f"{len(disp)} entries")
        exit_entries = [e for e in disp if "exit=" in (e.get("detail") or "")]
        check("audit: exit entries carry the CLI's sessionId",
              bool(exit_entries)
              and all(str(e.get("sessionId", "")).startswith("sess-")
                      for e in exit_entries),
              json.dumps(exit_entries[-1])[:250] if exit_entries else "none")

    finally:
        for s in serves:
            try:
                s.kill()
            except OSError:
                pass
        for s in serves:
            try:
                s.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        for pid in strays:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        stop(state)
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
