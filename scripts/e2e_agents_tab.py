#!/usr/bin/env python3
"""E2E for the F9.9 Agents tab — "who is holding what, right now".

The panel reads the shared state documents through the same port the
runner writes them on (http://<host>:25900). That port is taken by the
host's real state service on this machine, so this suite runs its OWN
acp-state-server on 25912 (STATE_DIR=<worktree>/tmp-agents-tab-test) and
proxies the page's :25900 traffic to it with a playwright route — the
panel still speaks the real GET/PUT/rev protocol to a real server, and
the host service is never touched. The UI bundle is served on 25911.

Seeds roles.json (three executors: devin with roles dev+qa, codex with
review, pi with idle), board.json, activity.json (the dispatcher's `card`
rows) and claims.json (two live claims under dev and qa), then asserts:

  * every executor/role is listed — incl. slots-free and never-run roles;
  * the devin executor shows exactly `2/2` busy slots with both held
    card titles;
  * expiring one claim's lease drops it out of the busy count on its own
    (no manual refresh);
  * the review role's failed last run shows the error text; the idle
    role says "no activity yet";
  * Release drops one claim in claims.json + audits to activity.json and
    the view follows; Stop all releases the executor's claims the same
    way — and the UI says plainly that the panel cannot signal pids;
  * 390x844: no horizontal scroll and every control >= 44px.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_agents_tab.py
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
STATE_DIR = ROOT / "tmp-agents-tab-test"
UI_PORT = 25911
STATE_PORT = 25912
BASE = f"http://127.0.0.1:{UI_PORT}/"
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
MIN_TOUCH = 44.0
EPS = 0.6

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def port_free(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.3).close()
    except OSError:
        return True
    return False


def wait_port(port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def wait_for(page, fn, timeout=16.0, interval=0.4):
    """Poll `fn` until truthy. Sleeps via page.wait_for_timeout so the
    playwright dispatcher keeps running — a pure-python sleep loop starves
    the page's routed requests (state-server proxy calls), which freezes
    the app under test while the clock runs out."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        val = fn()
        if val:
            return val
        page.wait_for_timeout(int(interval * 1000))
    return fn()


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


def put_doc(name, data):
    _, rev = get_doc(name)
    status, body = api(f"/{name}", "PUT", {"data": data, "rev": rev})
    assert status == 200, f"put {name} -> {status} {body}"


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

TITLE_A = "AGT alpha card — held by dev"
TITLE_B = "AGT beta card — held by qa"
TITLE_G = "AGT gamma card — failed under review"


def mk_card(cid, title, stage, status, order=10):
    now = int(time.time() * 1000)
    return {
        "id": cid, "title": title, "description": "seeded agents-tab card",
        "project": "", "agent": "", "priority": "medium",
        "acceptance": "", "verification": "", "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": order, "createdAt": now, "updatedAt": now,
    }


def roles_doc():
    def role(rid, label, cli, maxc=1):
        return {
            "id": rid, "label": label, "cli": cli, "args": ["-p"],
            "promptFile": f".acp/roles/{rid}.md", "maxConcurrent": maxc,
            "pollIntervalSec": 5, "timeoutMin": 45, "maxRetries": 1,
        }
    return {
        "version": 1,
        "roles": [
            role("dev", "Developer", "devin"),
            role("qa", "QA gate", "devin"),
            role("review", "Reviewer", "codex"),
            role("idle", "Idle hands", "pi", maxc=2),
        ],
        "stageRoles": {
            "dev": "dev", "reviewtest": "qa", "plan": "review", "spec": "idle",
        },
    }


def board_doc():
    return {
        "version": 2,
        "cards": [
            mk_card("card-alpha", TITLE_A, "dev", "in_progress", 10),
            mk_card("card-beta", TITLE_B, "reviewtest", "in_progress", 20),
            mk_card("card-gamma", TITLE_G, "plan", "in_progress", 30),
        ],
    }


def live_claim(cid, role, sess, stage, lease_ms=600_000):
    now = int(time.time() * 1000)
    return {
        "agentName": f"e2e-runner:{role}", "sessionId": sess,
        "leaseUntil": now + lease_ms, "startedAt": now - 60_000,
        "claimedAt": now - 60_000, "pid": os.getpid(),
        "roleId": role, "runnerId": "e2e-runner",
        "runnerPid": os.getpid(), "stage": stage,
        "hbAt": now,
    }


def claims_doc(alpha=True, beta=True, beta_lease=600_000):
    claims = {}
    if alpha:
        claims["card-alpha"] = live_claim("card-alpha", "dev", "sess-alpha", "dev")
    if beta:
        claims["card-beta"] = live_claim("card-beta", "qa", "sess-beta", "reviewtest", beta_lease)
    return {"version": 1, "claims": claims, "attempts": {}}


def activity_doc():
    now = int(time.time() * 1000)

    def entry(i, ago_ms, role, title, detail, sess=""):
        return {
            "id": f"agt-{i}", "at": now - ago_ms, "kind": "card",
            "agentName": f"e2e-runner:{role}", "title": title,
            "detail": detail, "role": role, "sessionId": sess,
        }

    return {
        "entries": [
            entry(1, 55_000, "dev", TITLE_A,
                  "claimed card-alpha lease=45m role=dev", "sess-alpha"),
            entry(2, 50_000, "dev", TITLE_A,
                  "start card-alpha attempt=1/1 pid=4242 cmd: devin -p",
                  "sess-alpha"),
            entry(3, 45_000, "qa", TITLE_B,
                  "claimed card-beta lease=45m role=qa", "sess-beta"),
            entry(4, 40_000, "qa", TITLE_B,
                  "start card-beta attempt=1/1 pid=4243 cmd: devin -p",
                  "sess-beta"),
            entry(5, 600_000, "review", TITLE_G,
                  "claimed card-gamma lease=45m role=review", "sess-gamma"),
            entry(6, 590_000, "review", TITLE_G,
                  "start card-gamma attempt=1/1 pid=4244 cmd: codex exec",
                  "sess-gamma"),
            entry(7, 580_000, "review", TITLE_G,
                  "cmd: codex exec exit=7 dur=9s attempt=1/1 finished "
                  "verdict: none log: run-1.log role=review session=sess-gamma",
                  "sess-gamma"),
        ],
        "usage": [],
    }


def seed_docs():
    put_doc("roles.json", roles_doc())
    put_doc("board.json", board_doc())
    put_doc("claims.json", claims_doc())
    put_doc("activity.json", activity_doc())
    put_doc("projects.json",
            {"version": 1, "projects": [], "activeProjectId": "all"})


def proxy_state(route):
    """Forward the page's :25900 calls to this suite's own state server."""
    url = re.sub(r":25900", f":{STATE_PORT}", route.request.url, count=1)
    resp = route.fetch(url=url)
    route.fulfill(response=resp)


def claims_map():
    doc, _ = get_doc("claims.json")
    return (doc or {}).get("claims") or {}


def activity_entries():
    doc, _ = get_doc("activity.json")
    return (doc or {}).get("entries") or []


def open_agents_tab(page):
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".view-rail", timeout=15000)
    page.click('.rail-btn[aria-label="Board"]')
    page.wait_for_selector(".tab-bar", timeout=10000)
    page.get_by_role("tab", name="Agents", exact=True).click()
    page.wait_for_selector('[data-testid="exec-row"]', timeout=15000)


def exec_slots(page, cli):
    loc = page.locator(
        f'[data-exec="{cli}"] [data-testid="exec-slots"]')
    return loc.inner_text().strip() if loc.count() else None


def held_titles(page, cli):
    return page.locator(
        f'[data-exec="{cli}"] [data-testid="held-card"] .held-title'
    ).all_inner_texts()


def controls(scope_sel, page):
    return page.evaluate(
        """(scope) => {
          const root = document.querySelector(scope);
          if (!root) return null;
          return [...root.querySelectorAll('button, input, select, textarea')]
            .map(el => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              return {
                tag: el.tagName.toLowerCase(),
                label: (el.getAttribute('aria-label') || el.textContent || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, 24),
                h: r.height,
                shown: r.width > 0 && r.height > 0 &&
                       cs.display !== 'none' && cs.visibility !== 'hidden',
              };
            })
            .filter(i => i.shown);
        }""",
        scope_sel,
    )


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        return 1
    if not STATE_SERVER.exists():
        print(f"FAIL  {STATE_SERVER} missing")
        return 1
    for p in (UI_PORT, STATE_PORT):
        if not port_free(p):
            print(f"FAIL  port {p} in use — refusing a stale server")
            return 1

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)

    state = subprocess.Popen(
        ["node", str(STATE_SERVER)],
        env={**os.environ,
             "STATE_DIR": str(STATE_DIR), "PORT": str(STATE_PORT)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ui = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(UI_PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(STATE_PORT) or not wait_port(UI_PORT):
            print("FAIL  servers did not start")
            return 1
        seed_docs()

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), proxy_state)
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.on("dialog", lambda d: d.accept())

            # ------------- leg 1: inventory ------------------------------
            open_agents_tab(page)

            execs = page.locator('[data-testid="exec-row"]')
            exec_ids = execs.evaluate_all(
                "els => els.map(e => e.getAttribute('data-exec'))")
            check("every executor is listed (devin, codex, pi)",
                  sorted(exec_ids) == ["codex", "devin", "pi"], str(exec_ids))

            roles = page.locator('[data-testid="role-row"]')
            role_ids = roles.evaluate_all(
                "els => els.map(e => e.getAttribute('data-role'))")
            check("every role is listed incl. never-run (dev, qa, review, idle)",
                  sorted(role_ids) == ["dev", "idle", "qa", "review"],
                  str(role_ids))

            check("devin shows exactly 2/2 busy slots",
                  exec_slots(page, "devin") == "2/2",
                  exec_slots(page, "devin") or "none")
            titles = held_titles(page, "devin")
            check("devin holds both card titles",
                  TITLE_A in titles and TITLE_B in titles, str(titles))

            idle_last = page.locator(
                '[data-role="idle"] [data-testid="role-no-activity"]')
            check("idle role says no activity yet",
                  idle_last.count() == 1
                  and "no activity yet" in idle_last.inner_text().lower())

            rev_last = page.locator('[data-role="review"] [data-testid="role-last"]')
            check("review role shows the failed last run",
                  rev_last.count() == 1
                  and "bad" in (rev_last.get_attribute("class") or "")
                  and "exit=7" in rev_last.inner_text(),
                  rev_last.inner_text() if rev_last.count() else "none")
            check("review slot stays free while showing the error",
                  page.locator('[data-role="review"] [data-testid="role-slots"]')
                  .inner_text().strip() == "0/1")

            dev_last = page.locator('[data-role="dev"] [data-testid="role-last"]')
            check("dev's live run is not shown as an error",
                  dev_last.count() == 1
                  and "bad" not in (dev_last.get_attribute("class") or ""))

            # ------------- leg 2: lease expiry drops a slot ---------------
            put_doc("claims.json", claims_doc(beta_lease=-5_000))
            gone = wait_for(page,
                            lambda: exec_slots(page, "devin") == "1/2"
                            and TITLE_B not in held_titles(page, "devin"))
            check("expired lease stops counting busy on its own",
                  bool(gone),
                  f"slots={exec_slots(page, 'devin')} titles={held_titles(page, 'devin')}")

            # ------------- leg 3: release one claim -----------------------
            page.locator('[data-role="dev"] [data-testid="release-btn"]').click()
            freed = wait_for(page, lambda: "card-alpha" not in claims_map())
            check("release drops the claim in claims.json", bool(freed),
                  json.dumps(claims_map())[:200])
            check("view follows the release (0/2, title gone)",
                  bool(wait_for(page,
                                lambda: exec_slots(page, "devin") == "0/2"
                                and TITLE_A not in held_titles(page, "devin"))),
                  f"slots={exec_slots(page, 'devin')}")
            rel = wait_for(page, lambda: [e for e in activity_entries()
                                          if "claim released by panel"
                                          in (e.get("detail") or "")])
            check("release audited to activity.json with the role",
                  bool(rel) and rel[-1].get("role") == "dev",
                  json.dumps(rel[-1])[:250] if rel else "none")
            note = page.locator('[data-exec="devin"] [data-testid="ctl-note"]')
            check("release note admits the pid is not signalled",
                  note.count() == 1 and "cannot signal" in note.inner_text(),
                  note.inner_text() if note.count() else "no note")

            # ------------- leg 4: stop-all for one executor ---------------
            put_doc("claims.json", claims_doc())
            back = wait_for(page, lambda: exec_slots(page, "devin") == "2/2")
            check("re-seeded claims show up as 2/2 again", bool(back),
                  exec_slots(page, "devin") or "none")

            page.locator('[data-exec="devin"] [data-testid="stop-exec"]').click()
            stopped = wait_for(page, lambda: claims_map() == {})
            check("stop-all releases the executor's claims in the doc",
                  bool(stopped), json.dumps(claims_map())[:200])
            check("view follows stop-all (0/2, no held cards)",
                  bool(wait_for(page,
                                lambda: exec_slots(page, "devin") == "0/2"
                                and held_titles(page, "devin") == [])))
            stop_entries = wait_for(page, lambda: [e for e in activity_entries()
                                                   if "stop-all card=" in (e.get("detail") or "")])
            check("stop-all audited per claim with roles",
                  bool(stop_entries) and len(stop_entries) == 2
                  and sorted(e.get("role") for e in stop_entries) == ["dev", "qa"],
                  json.dumps(stop_entries)[:300] if stop_entries else "none")
            check("stop note admits the panel cannot kill",
                  "cannot signal" in note.inner_text()
                  or "cannot kill" in note.inner_text(),
                  note.inner_text() if note.count() else "no note")

            # ------------- leg 5: 390 px ----------------------------------
            put_doc("claims.json", claims_doc())
            phone = browser.new_context(
                ignore_https_errors=True, viewport={"width": 390, "height": 844})
            pp = phone.new_page()
            pp.route(re.compile(r":25900/"), proxy_state)
            pp.on("pageerror", lambda exc: page_errors.append(str(exc)))
            open_agents_tab(pp)
            check("agents@390: devin shows 2/2",
                  bool(wait_for(pp, lambda: exec_slots(pp, "devin") == "2/2")),
                  exec_slots(pp, "devin") or "none")

            hscroll = pp.evaluate(
                "() => document.documentElement.scrollWidth - window.innerWidth")
            check("agents@390: no page-level horizontal scroll",
                  hscroll <= 1, f"{hscroll}px")

            items = controls(".agents-tab", pp) or []
            short = [i for i in items if i["h"] < MIN_TOUCH - EPS]
            check(f"agents@390: all {len(items)} tab controls >= 44px",
                  bool(items) and not short,
                  "; ".join(f'{i["tag"]} "{i["label"]}"={i["h"]:.0f}px'
                            for i in short) or "ok")
            pane_items = controls(".view-pane", pp) or []
            short_pane = [i for i in pane_items if i["h"] < MIN_TOUCH - EPS]
            check(f"agents@390: all {len(pane_items)} pane controls >= 44px",
                  bool(pane_items) and not short_pane,
                  "; ".join(f'{i["tag"]} "{i["label"]}"={i["h"]:.0f}px'
                            for i in short_pane) or "ok")
            pp.screenshot(path=str(ROOT / "docs" / "agents-tab-390x844.png"))
            phone.close()
            ctx.close()
            browser.close()
    finally:
        ui.terminate()
        state.terminate()
        for proc in (ui, state):
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
