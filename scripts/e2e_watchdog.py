#!/usr/bin/env python3
"""E2E for the W15 idle watchdog (server/acp-runner.mjs): lastOutputAt on the
claim, the idle tick inside the heartbeat loop, the «idle Nm — terminated»
ledger entry, and retry/blocked semantics on a watchdog kill.

Spins up its OWN state server (server/acp-state-server.mjs) on port 25962
with STATE_DIR=<worktree>/tmp-watchdog-test, a project inside it, and a role
whose `cli` is `node <stub>` — a script under our control that prints once
and then either hangs silently, chatters periodically, or exits fast.
Asserts:

  1. a child silent past `idleTimeoutMin` is SIGTERMed on the heartbeat
     tick: the ledger carries «idle Nm — terminated …, attempt X/Y», the
     kill counts as a failed attempt, retry follows maxRetries, and the
     exhausted card is flagged blocked; the claim (with its lastOutputAt
     stamp) is released on exit;
  2. a chatty child (a byte of any kind refreshes lastOutputAt) is never
     touched by the tick and exits 0;
  3. a normal fast stub is untouched by the tick;
  4. `idleTimeoutMin: 0` disables the watchdog — a hanging stub is left
     alone until the lease timeout kills it (`timeout`, no idle entries);
  5. the Roles UI form accepts and persists the field (4 -> "idle 4m",
     edit -> 0 -> "idle off", -1 -> validation error, a legacy role
     without the field shows the 15m default).

Usage:
    npm run build:web   # needed for leg 5 only
    ~/.hermes/tools-venv/bin/python scripts/e2e_watchdog.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _e2e_harness import STATE_SERVER, serve_state, serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "server" / "acp-runner.mjs"
DIST = ROOT / "dist-web"
STATE_DIR = ROOT / "tmp-watchdog-test"
STATE_PORT = 25962               # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
WEB_PORT = 25963                 # same policy for the Roles-UI leg
PROJ = STATE_DIR / "proj"

results = []
page_errors = []


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


def mk_card(cid, stage="dev", status="in_progress", project="p1", order=10):
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


def seed(board_cards, role_overrides=None):
    """Rewrite board.json + roles.json for a leg (claims/activity persist)."""
    role = {
        "id": "dev", "label": "Dev", "cli": "node",
        "args": [str(STATE_DIR / "stub-cli.mjs")],
        "promptFile": ".acp/roles/dev.md",
        "maxConcurrent": 1, "pollIntervalSec": 5,
        "timeoutMin": 0.4, "maxRetries": 1, "idleTimeoutMin": 15,
    }
    role.update(role_overrides or {})
    force_put("board.json", {"version": 2, "cards": board_cards})
    force_put("roles.json", {
        "version": 1, "roles": [role],
        "stageRoles": {"dev": "dev"},
    })


def runner_env(runner_id, env_extra=None):
    env = {**os.environ, "STATE_URL": STATE_URL,
           "ROOT_DIR": str(STATE_DIR),
           "RUNNER_ID": runner_id}
    env.update(env_extra or {})
    return env


def run_runner(*args, runner_id="e2e-watchdog", env_extra=None, timeout=120):
    return subprocess.run(
        ["node", str(RUNNER), *args], capture_output=True, text=True,
        timeout=timeout, env=runner_env(runner_id, env_extra), cwd=ROOT)


def start_runner(*args, runner_id="e2e-watchdog", env_extra=None):
    return subprocess.Popen(
        ["node", str(RUNNER), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
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


def card_entries(cid):
    return [e for e in activity_entries() if e.get("title") == f"E2E {cid}"]


def run_logs(cid):
    d = card_dir(cid)
    return sorted(d.glob("run-*.log")) if d.exists() else []


def write_stub():
    """The stub role CLI: `node stub-cli.mjs <role-args...> --prompt-file <b>`.

    Prints `SESSION: sess-<cardId>` up front (one burst of life), drops its
    pid into <cardDir>/child.pid, then — per env — chatters every
    STUB_CHATTER_SEC seconds (keeps lastOutputAt fresh), sleeps silently
    STUB_SLEEP_SEC seconds (a hang the watchdog should see), and exits
    STUB_EXIT.
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
        "const chatter = Number(env.STUB_CHATTER_SEC || 0);\n"
        "if (chatter > 0) {\n"
        "  setInterval(() => console.log(`tick ${Date.now()}`), chatter * 1000);\n"
        "}\n"
        "const sleepSec = Number(env.STUB_SLEEP_SEC || 0);\n"
        "if (sleepSec > 0) await new Promise((r) => setTimeout(r, sleepSec * 1000));\n"
        "process.exit(Number(env.STUB_EXIT || 0));\n")
    return stub


# ---------------------------------------------------------------------------
# Leg 5: the Roles UI form (needs dist-web + playwright; runs last so the
# runner legs are unaffected when the browser stack is unavailable).
# ---------------------------------------------------------------------------

def leg_roles_ui():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        check("roles UI: playwright importable", False,
              "playwright missing — the form assertions were not run")
        return

    def down_state(route):
        route.fulfill(status=500, content_type="application/json",
                      body=json.dumps({"error": "state server down"}))

    def read_roles_doc(page):
        raw = page.evaluate(
            "() => localStorage.getItem('acp-ui:roles.json')")
        doc = json.loads(raw or '{}')
        # Tolerate a double-encoded value (defensive; a healthy store writes
        # the plain object).
        if isinstance(doc, str):
            doc = json.loads(doc)
        return doc if isinstance(doc, dict) else {}

    web, base = serve_web(WEB_PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1440, "height": 900}
            )
            ctx.add_init_script(
                "if (!localStorage.getItem('acp-ui:preferences.json'))"
                " localStorage.setItem('acp-ui:preferences.json',"
                f" {json.dumps(json.dumps({'telemetryEnabled': False}))});"
            )
            # A legacy role persisted BEFORE the field existed — sanitize
            # must give it the 15m default on load. Seeded exactly like
            # e2e_roles: the localStorage value is the doc's plain JSON.
            legacy_doc = {
                "version": 1, "stageRoles": {},
                "roles": [{
                    "id": "legacy", "label": "Legacy", "cli": "devin",
                    "args": [], "promptFile": ".acp/roles/legacy.md",
                    "maxConcurrent": 1, "pollIntervalSec": 15,
                    "timeoutMin": 45, "maxRetries": 1}],
            }
            ctx.add_init_script(
                "if (!localStorage.getItem('acp-ui:roles.json'))"
                " localStorage.setItem('acp-ui:roles.json',"
                f" {json.dumps(json.dumps(legacy_doc))});"
            )
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.route(re.compile(r":25900/"), down_state)

            page.goto(base, wait_until="load")
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Settings").first.click()
            page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)
            section = page.get_by_test_id("settings-roles")

            legacy_row = section.get_by_test_id("role-legacy")
            check("roles UI: legacy role sanitized to the 15m default",
                  legacy_row.count() == 1 and "idle 15m" in legacy_row.inner_text(),
                  legacy_row.inner_text()[:200] if legacy_row.count() else "no row")

            section.get_by_test_id("roles-add-toggle").click()
            section.get_by_test_id("role-id").fill("wd")
            section.get_by_test_id("role-label").fill("Watchdog")
            section.get_by_test_id("role-cli").select_option("devin")
            section.get_by_test_id("role-prompt").fill(".acp/roles/wd.md")
            section.get_by_test_id("role-idle").fill("4")
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(300)
            check("roles UI: role with idleTimeoutMin=4 added",
                  section.get_by_test_id("role-wd").count() == 1)
            wd_row = section.get_by_test_id("role-wd")
            check("roles UI: limits line shows 'idle 4m'",
                  "idle 4m" in wd_row.inner_text(),
                  wd_row.inner_text()[:200] if wd_row.count() else "no row")
            page.wait_for_timeout(800)  # debounced save
            doc = read_roles_doc(page)
            wds = [r for r in doc.get("roles", []) if r.get("id") == "wd"]
            check("roles UI: idleTimeoutMin persisted as 4",
                  len(wds) == 1 and wds[0].get("idleTimeoutMin") == 4,
                  json.dumps(wds[0])[:200] if wds else json.dumps(doc)[:200])

            # Edit -> 0 disables and persists.
            section.get_by_test_id("role-edit-wd").click()
            section.get_by_test_id("role-idle").fill("0")
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(300)
            check("roles UI: limits line shows 'idle off' after edit",
                  "idle off" in section.get_by_test_id("role-wd").inner_text())
            page.wait_for_timeout(800)
            doc = read_roles_doc(page)
            wds = [r for r in doc.get("roles", []) if r.get("id") == "wd"]
            check("roles UI: idleTimeoutMin=0 persisted",
                  len(wds) == 1 and wds[0].get("idleTimeoutMin") == 0,
                  json.dumps(wds[0])[:200] if wds else "gone")

            # A negative value is rejected with a visible error.
            section.get_by_test_id("role-edit-wd").click()
            section.get_by_test_id("role-idle").fill("-1")
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            err = section.get_by_test_id("roles-error")
            check("roles UI: idleTimeoutMin < 0 rejected",
                  err.count() == 1 and "idleTimeoutMin" in err.inner_text(),
                  err.inner_text() if err.count() else "no error")
            section.get_by_test_id("role-cancel").click()

            ctx.close()
            browser.close()
    finally:
        stop(web)


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

    strays = []

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

        # ============== leg 1: silent child -> watchdog kill -> retry ======
        # idleTimeoutMin 0.05 = 3s: the first heartbeat tick (5s) sees the
        # child already over threshold and takes the SIGTERM path. Two
        # attempts -> both die the same way -> maxRetries exhausted.
        seed([mk_card("card-idle")],
             {"idleTimeoutMin": 0.05, "timeoutMin": 0.4, "maxRetries": 2})
        proc = start_runner("--once", env_extra={"STUB_SLEEP_SEC": "300"})
        try:
            claim = wait_for(lambda: claims_map().get("card-idle"), timeout=15)
            check("idle: card claimed", bool(claim), json.dumps(claims_map())[:200])
            if claim:
                strays.append(int(claim.get("pid") or 0))
                check("idle: claim carries lastOutputAt + startedAt",
                      bool(claim.get("lastOutputAt")) and bool(claim.get("startedAt")),
                      json.dumps({k: claim.get(k) for k in
                                  ("startedAt", "lastOutputAt", "pid")}))
            # Two attempts killed on the tick (~5s each) + bookkeeping.
            released = wait_for(lambda: "card-idle" not in claims_map(), timeout=60)
            out, err = proc.communicate(timeout=30)
            check("idle: --once exits 0", proc.returncode == 0,
                  (err or "")[:200])
            check("idle: claim released after the run", bool(released))
            check("idle: two run logs (one per attempt)",
                  len(run_logs("card-idle")) == 2,
                  ",".join(p.name for p in run_logs("card-idle")))

            kills = [e for e in card_entries("card-idle")
                     if re.search(r"idle [\d.]+m — terminated", e.get("detail") or "")]
            check("idle: ledger carries «idle Nm — terminated» for both attempts",
                  len(kills) == 2
                  and any("attempt 1/2" in (e.get("detail") or "") for e in kills)
                  and any("attempt 2/2" in (e.get("detail") or "") for e in kills),
                  json.dumps([e.get("detail") for e in kills])[:400])
            check("idle: kill entries carry role + sessionId",
                  bool(kills) and all(e.get("role") == "dev" for e in kills)
                  and all(e.get("sessionId") == "sess-card-idle" for e in kills),
                  json.dumps(kills[-1])[:250] if kills else "none")
            exits = [e for e in card_entries("card-idle")
                     if "idle-terminated" in (e.get("detail") or "")]
            check("idle: exit entries marked idle-terminated",
                  len(exits) == 2,
                  json.dumps([e.get("detail") for e in exits])[:300])
            check("idle: watchdog kill counts as a failed attempt",
                  attempts_map().get("card-idle") == 2,
                  json.dumps(attempts_map()))
            card = board_card("card-idle") or {}
            check("idle: maxRetries exhausted -> card flagged blocked",
                  card.get("blocked") is True
                  and "maxRetries" in (card.get("blockedReason") or ""),
                  json.dumps(card)[:250])
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

        # ============== leg 2: chatty child stays fresh ===================
        seed([mk_card("card-chatty")],
             {"idleTimeoutMin": 0.05, "timeoutMin": 0.4, "maxRetries": 1})
        proc = run_runner("--once", env_extra={
            "STUB_SLEEP_SEC": "12", "STUB_CHATTER_SEC": "1"})
        check("chatty: --once exits 0", proc.returncode == 0,
              proc.stderr[:200])
        try:
            runs = json.loads(proc.stdout).get("runs", [])
        except ValueError:
            runs = None
        check("chatty: run finished clean (exit 0)",
              bool(runs) and runs[0].get("exitCode") == 0,
              json.dumps(runs)[:200])
        chatty = card_entries("card-chatty")
        check("chatty: no watchdog kill while output flows",
              not any("terminated" in (e.get("detail") or "") for e in chatty),
              json.dumps([e.get("detail") for e in chatty])[:300])

        # ============== leg 3: fast stub untouched ========================
        seed([mk_card("card-fast")],
             {"idleTimeoutMin": 0.05, "timeoutMin": 0.4, "maxRetries": 1})
        proc = run_runner("--once", env_extra={"STUB_EXIT": "0"})
        check("fast: --once exits 0", proc.returncode == 0, proc.stderr[:200])
        check("fast: single run log", len(run_logs("card-fast")) == 1,
              ",".join(p.name for p in run_logs("card-fast")))
        fast = card_entries("card-fast")
        check("fast: exit=0 finished, no idle entries",
              any("exit=0" in (e.get("detail") or "") for e in fast)
              and not any("terminated" in (e.get("detail") or "") for e in fast),
              json.dumps([e.get("detail") for e in fast])[:300])
        check("fast: no attempts counter, card not blocked",
              attempts_map().get("card-fast") is None
              and (board_card("card-fast") or {}).get("blocked") is not True)

        # ============== leg 4: idleTimeoutMin 0 disables ==================
        # The hang outlives the (tiny) lease: the timeout path kills it,
        # not the watchdog — one failed attempt, maxRetries=1 -> blocked.
        seed([mk_card("card-off")],
             {"idleTimeoutMin": 0, "timeoutMin": 0.15, "maxRetries": 1})
        proc = start_runner("--once", env_extra={"STUB_SLEEP_SEC": "300"})
        try:
            claim = wait_for(lambda: claims_map().get("card-off"), timeout=15)
            check("off: card claimed", bool(claim), json.dumps(claims_map())[:200])
            if claim:
                strays.append(int(claim.get("pid") or 0))
            released = wait_for(lambda: "card-off" not in claims_map(),
                                timeout=40)
            out, err = proc.communicate(timeout=30)
            check("off: --once exits 0", proc.returncode == 0,
                  (err or "")[:200])
            check("off: hang left to the lease timeout, claim released",
                  bool(released))
            offs = card_entries("card-off")
            check("off: NO watchdog kill entries",
                  not any(re.search(r"idle [\d.]+m — terminated",
                                    e.get("detail") or "") for e in offs),
                  json.dumps([e.get("detail") for e in offs])[:300])
            check("off: exit marked 'timeout' (the lease path, not idle)",
                  any(re.search(r"exit=\d+.*\btimeout\b", e.get("detail") or "")
                      and "idle-terminated" not in (e.get("detail") or "")
                      for e in offs),
                  json.dumps([e.get("detail") for e in offs
                              if "exit=" in (e.get("detail") or "")])[:300])
            check("off: single run log (no retry past maxRetries=1)",
                  len(run_logs("card-off")) == 1,
                  ",".join(p.name for p in run_logs("card-off")))
            card = board_card("card-off") or {}
            check("off: the timeout failure still flags blocked",
                  card.get("blocked") is True,
                  json.dumps(card)[:200])
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

        # ============== leg 5: the Roles UI form ==========================
        if (DIST / "index.html").exists():
            leg_roles_ui()
        else:
            check("roles UI: dist-web present", False,
                  f"{DIST} missing — run `npm run build:web`; "
                  "form assertions not run")

    finally:
        for pid in strays:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        stop(state)
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
