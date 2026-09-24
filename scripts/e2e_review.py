#!/usr/bin/env python3
"""E2E for the review cycle (workstream d4ff5be5): severity findings, the
`agent_tested` gate, minor -> backlog sync, the round limit, and failure
atomicity.

Layout:
  * own state server (server/acp-state-server.mjs) on :25914 with
    STATE_DIR=<worktree>/tmp-review-test/state — the REAL board doc;
  * a project dir tmp-review-test/proj holding the card artifact dirs with
    review_findings.json files the reviewer would have written;
  * real `boardctl` CLI calls against that server for the gate/sync legs;
  * a test web bundle (VITE_STATE_URL=:25914) served on :25979 + playwright,
    with the host fs API stubbed from tmp-review-test/proj.

Asserts:
  * 1 critical + 1 major open -> the move to agent_tested is refused and the
    refusal names both severities with counts (move AND set paths);
  * after closing both -> the move succeeds; the open minor does not block;
  * the minor finding materialises exactly one backlog card linked to the
    source card; a second --sync does not duplicate it;
  * the round counter increments and the round limit flags the card
    `blocked` with a reason;
  * a failing run leaves the board document byte-identical;
  * the panel renders the counts (testid) and the drawer gate; the panel's
    own derived-state sync flags a limit-exceeded card;
  * `boardctl` — the second writer — is bound by the same gate.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_review.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from _e2e_harness import serve_state, serve_web, stop, wait_port

ROOT = Path(__file__).resolve().parent.parent
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
BOARDCTL = ROOT / "scripts" / "boardctl"
WORK = ROOT / "tmp-review-test"
STATE_DATA = WORK / "state"
PROJ = WORK / "proj"
DIST = WORK / "dist-web"
STATE_PORT = 25914               # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
WEB_PORT = 25979
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"       # rebased in leg_ui()
AGENT_PORT = 25978  # seeded ws agent -> bridge base http://127.0.0.1:25978 (stubbed)

PROJ_NAME = "review-proj"

C1 = "rev-c1-0001"  # gate card: crit+maj+min open, round 1
C2 = "rev-c2-0002"  # limit card: crit open, already at round 3
C3 = "rev-c3-0003"  # rounds card: crit+maj+min open, round 2 -> bumped to 3
C4 = "rev-c4-0004"  # clean card: no findings file
C5 = "rev-c5-0005"  # malformed findings file
C6 = "rev-c6-0006"  # panel-flag card: crit open at round 3, NOT pre-blocked

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


def board_file_bytes():
    p = STATE_DATA / "board.json.json"
    return p.read_bytes() if p.exists() else b""


def board_card(cid):
    doc, _ = get_doc("board.json")
    for c in (doc or {}).get("cards", []):
        if c.get("id") == cid:
            return c
    return None


def board_cards():
    doc, _ = get_doc("board.json")
    return (doc or {}).get("cards") or []


def boardctl(*args, expect=0):
    proc = subprocess.run(
        [sys.executable, str(BOARDCTL), *args],
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "BOARD_URL": STATE_URL}, cwd=str(PROJ))
    if expect is not None:
        assert proc.returncode == expect, (
            f"boardctl {' '.join(args)} -> rc={proc.returncode}\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}")
    return proc


def mk_card(cid, stage="reviewtest", status="in_progress"):
    now = int(time.time() * 1000)
    return {
        "id": cid, "title": f"E2E {cid}", "description": "d",
        "project": PROJ_NAME, "agent": "", "priority": "medium",
        "acceptance": "", "verification": "",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": 10, "createdAt": now, "updatedAt": now,
    }


def finding(fid, sev, text, where, rnd=1, status="open", closed=None):
    f = {"id": fid, "round": rnd, "severity": sev, "text": text,
         "where": where, "status": status}
    if closed is not None:
        f["closedInRound"] = closed
    return f


def write_findings(cid, doc=None, raw=None):
    d = PROJ / ".acp" / "cards" / cid
    d.mkdir(parents=True, exist_ok=True)
    p = d / "review_findings.json"
    if raw is not None:
        p.write_text(raw)
    else:
        p.write_text(json.dumps(doc, indent=2) + "\n")
    return p


def seed():
    """Board cards + registry + reviewer role (with review rules as data)."""
    cards = [
        dict(mk_card(C1), title="Review gate card"),
        dict(mk_card(C2), title="Limit flag card"),
        dict(mk_card(C3), title="Rounds card"),
        dict(mk_card(C4), title="Clean card"),
        dict(mk_card(C5), title="Malformed card"),
        dict(mk_card(C6), title="Panel flag card"),
    ]
    force_put("board.json", {"version": 2, "cards": cards})
    force_put("projects.json", {
        "version": 1,
        "projects": [{"id": "p-review", "name": PROJ_NAME, "path": str(PROJ),
                      "createdAt": 1700000000000}],
        "activeProjectId": "all",
    })
    force_put("roles.json", {
        "version": 1,
        "roles": [{
            "id": "reviewer", "label": "Reviewer", "cli": "hermes",
            "args": ["--model", "swe-2-max"],
            "promptFile": ".acp/roles/reviewer.md",
            "maxConcurrent": 1, "pollIntervalSec": 15,
            "timeoutMin": 30, "maxRetries": 1,
            "review": {
                "severities": ["critical", "major", "minor", "nit"],
                "blocking": ["critical", "major"],
                "backlog": ["minor", "nit"],
                "maxRounds": 3,
            },
        }],
        "stageRoles": {"reviewtest": "reviewer"},
    })
    # Findings files — the reviewer role's structured state on disk.
    write_findings(C1, {"version": 1, "round": 1, "findings": [
        finding("f-crit", "critical", "session token leaks to log", "src/auth.ts:88", 1),
        finding("f-maj", "major", "no retry on state PUT", "src/lib/kv.ts:40", 1),
        finding("f-min", "minor", "dead code path in sync", "src/sync.ts:12", 1),
    ]})
    write_findings(C2, {"version": 1, "round": 3, "findings": [
        finding("f-c2crit", "critical", "claim lease never released", "src/claims.ts:9", 3),
    ]})
    write_findings(C3, {"version": 1, "round": 2, "findings": [
        finding("f-c3crit", "critical", "board write loses cards on 409", "src/board.ts:200", 2),
        finding("f-c3maj", "major", "status not persisted", "src/board.ts:210", 2),
        finding("f-c3min", "minor", "stale comment", "src/board.ts:5", 2),
    ]})
    (PROJ / ".acp" / "cards" / C4).mkdir(parents=True, exist_ok=True)  # dir, no file
    write_findings(C5, raw="{ not json ]")
    write_findings(C6, {"version": 1, "round": 3, "findings": [
        finding("f-c6crit", "critical", "gate bypass via direct patch", "src/x.ts:1", 3),
    ]})


# --- fs bridge stub (mirrors the host bridge semantics) -----------------------

def scoped_abs(p):
    ap = os.path.abspath(p) if os.path.isabs(p) else os.path.abspath(
        os.path.join(str(PROJ), p))
    root = str(PROJ)
    inside = ap == root or ap.startswith(root + os.sep)
    return ap, inside


def fs_api(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    qs = urllib.parse.parse_qs(u.query)

    def out(code, obj):
        route.fulfill(
            status=code,
            content_type="application/json; charset=utf-8",
            headers={"Access-Control-Allow-Origin": "*"},
            body=json.dumps(obj),
        )

    if u.path == "/api/fs/root":
        return out(200, {"root": str(PROJ), "home": str(PROJ)})
    if u.path == "/api/fs/list":
        target = qs.get("path", [str(PROJ)])[0]
        ap, inside = scoped_abs(target)
        if not inside:
            return out(403, {"error": f"path outside root: {ap}"})
        if not os.path.isdir(ap):
            return out(500, {"error": f"ENOENT: no such file or directory, stat '{ap}'"})
        dirs = [{"name": n, "path": os.path.join(ap, n)}
                for n in sorted(os.listdir(ap))
                if os.path.isdir(os.path.join(ap, n))]
        return out(200, {"path": ap, "parent": os.path.dirname(ap),
                         "root": str(PROJ), "dirs": dirs})
    if u.path == "/api/fs/read":
        target = qs.get("path", [""])[0]
        if not target:
            return out(400, {"error": "path required"})
        ap, inside = scoped_abs(target)
        if not inside:
            return out(403, {"error": f"path outside root: {ap}"})
        if not os.path.exists(ap):
            return out(404, {"error": f"not found: {ap}"})
        if not os.path.isfile(ap):
            return out(400, {"error": f"not a file: {ap}"})
        data = Path(ap).read_bytes()
        if len(data) > 512 * 1024:
            return out(413, {"error": "file exceeds 524288 bytes"})
        if b"\x00" in data:
            return out(415, {"error": "binary file"})
        return out(200, {"path": ap, "bytes": len(data),
                         "content": data.decode("utf-8")})
    return out(404, {"error": "not found"})


def acp_ws(ws):
    def on_message(msg):
        try:
            req = json.loads(msg)
        except (TypeError, json.JSONDecodeError):
            return
        result = {}
        if req.get("method") == "initialize":
            result = {"agentInfo": {"name": "e2e-mock", "version": "0"}}
        elif req.get("method") == "session/new":
            result = {"sessionId": "e2e-new-session"}
        elif req.get("method") == "session/list":
            result = {"sessions": []}
        ws.send(json.dumps({"jsonrpc": "2.0", "id": req.get("id"),
                            "result": result}))
    ws.on_message(on_message)


# --- CLI legs ----------------------------------------------------------------

def leg_gate():
    proc = boardctl("review", C1, expect=0)
    check("review C1 shows round + counts + gate",
          "round 1 / 3" in proc.stdout
          and "critical 1" in proc.stdout and "major 1" in proc.stdout
          and "minor 1" in proc.stdout
          and "refuse agent_tested" in proc.stdout,
          proc.stdout.splitlines()[0] if proc.stdout else "")

    proc = boardctl("move", C1, "reviewtest", "agent_tested", expect=None)
    check("move -> agent_tested REFUSED with crit+maj named",
          proc.returncode != 0
          and "1 critical" in proc.stderr and "1 major" in proc.stderr,
          proc.stderr.strip()[:160])
    check("C1 status unchanged after refusal",
          (board_card(C1) or {}).get("status") == "in_progress")

    proc = boardctl("set", C1, "--status", "agent_tested", expect=None)
    check("set --status agent_tested REFUSED too",
          proc.returncode != 0
          and "1 critical" in proc.stderr and "1 major" in proc.stderr,
          proc.stderr.strip()[:160])

    proc = boardctl("move", C5, "reviewtest", "agent_tested", expect=None)
    check("malformed findings file fails the gate closed",
          proc.returncode != 0 and "unreadable" in proc.stderr,
          proc.stderr.strip()[:160])


def leg_sync_minor():
    _, rev0 = get_doc("board.json")
    proc = boardctl("review", C1, "--sync", expect=0)
    check("sync creates the minor's backlog card",
          "backlog +1" in proc.stdout and "f-min" in proc.stdout,
          proc.stdout.strip()[:160])
    cards = board_cards()
    children = [c for c in cards
                if c.get("stage") == "backlog"
                and any("f-min" in str(l.get("url")) for l in c.get("links", [])
                        if isinstance(l, dict))]
    check("exactly one backlog card for f-min", len(children) == 1,
          f"{len(children)} matching cards")
    child = children[0] if children else {}
    check("backlog card links to source + dependsOn",
          child.get("dependsOn") == [C1]
          and child.get("project") == PROJ_NAME
          and "[minor]" in (child.get("title") or ""))
    check("source card mirrors blocks += child",
          child.get("id") in ((board_card(C1) or {}).get("blocks") or []))
    _, rev1 = get_doc("board.json")
    check("sync bumped the board rev", rev1 == rev0 + 1, f"{rev0} -> {rev1}")

    proc = boardctl("review", C1, "--sync", expect=0)
    _, rev2 = get_doc("board.json")
    check("second sync is a no-op (idempotent, finding id is the key)",
          "nothing to change" in proc.stdout and rev2 == rev1,
          f"rev {rev1} -> {rev2}; out={proc.stdout.strip()[:80]}")
    cards = board_cards()
    n = sum(1 for c in cards
            if any("f-min" in str(l.get("url")) for l in c.get("links", [])
                   if isinstance(l, dict)))
    check("still exactly one f-min card after the second pass", n == 1)


def leg_close_and_move():
    proc = boardctl("review", C1, "--close", "f-crit", "--close", "f-maj",
                    expect=0)
    check("close both blockers", "f-crit closed" in proc.stdout
          and "f-maj closed" in proc.stdout, proc.stdout.strip()[:120])
    doc = json.loads((PROJ / ".acp" / "cards" / C1
                      / "review_findings.json").read_text())
    statuses = {f["id"]: f.get("status") for f in doc["findings"]}
    check("findings file says closed (+ closedInRound)",
          statuses.get("f-crit") == "closed" and statuses.get("f-maj") == "closed"
          and all(f.get("closedInRound") == 1 for f in doc["findings"]
                  if f["id"] in ("f-crit", "f-maj")))
    proc = boardctl("move", C1, "reviewtest", "agent_tested", expect=0)
    check("minor open -> move to agent_tested SUCCEEDS",
          proc.returncode == 0
          and (board_card(C1) or {}).get("status") == "agent_tested",
          proc.stdout.strip()[:120])


def leg_round_limit():
    proc = boardctl("review", C3, "--round", "3", expect=0)
    check("round counter records round 3", "round" in proc.stdout,
          proc.stdout.strip()[:120])
    proc = boardctl("review", C3, expect=0)
    check("review show sees the new round",
          "round 3 / 3" in proc.stdout, proc.stdout.splitlines()[0])

    proc = boardctl("review", C3, "--sync", expect=0)
    c3 = board_card(C3) or {}
    check("round limit + open blockers -> card flagged blocked",
          c3.get("blocked") is True
          and str(c3.get("blockedReason") or "").startswith("review:")
          and "round limit 3" in str(c3.get("blockedReason") or "")
          and "1 critical" in str(c3.get("blockedReason") or "")
          and "1 major" in str(c3.get("blockedReason") or ""),
          str(c3.get("blockedReason") or "")[:160])
    c3min_cards = [c for c in board_cards()
                   if any("f-c3min" in str(l.get("url"))
                          for l in c.get("links", []) if isinstance(l, dict))]
    check("C3's minor also became a backlog card", len(c3min_cards) == 1)

    proc = boardctl("review", C2, "--sync", expect=0)
    c2 = board_card(C2) or {}
    check("C2 (already at round 3) flagged blocked by sync",
          c2.get("blocked") is True
          and "round limit 3" in str(c2.get("blockedReason") or "")
          and "1 critical" in str(c2.get("blockedReason") or ""))


def leg_failures():
    """Rejected runs leave the board document byte-identical — validation
    precedes every write, same structural rule as pmgraph."""
    cases = [
        ("malformed findings", ["review", C5, "--sync"]),
        ("no findings file", ["review", C4, "--sync"]),
        ("close unknown fid", ["review", C1, "--close", "f-nope"]),
        ("bad round", ["review", C1, "--round", "0"]),
    ]
    for name, args in cases:
        snap = board_file_bytes()
        proc = boardctl(*args, expect=None)
        check(f"failure[{name}]: exit non-zero", proc.returncode != 0,
              f"rc={proc.returncode} {proc.stderr.strip()[:100]}")
        check(f"failure[{name}]: board byte-identical",
              board_file_bytes() == snap)

    # A clean card CAN move to agent_tested — no findings means nothing open.
    proc = boardctl("move", C4, "reviewtest", "agent_tested", expect=0)
    check("no findings file -> agent_tested allowed",
          (board_card(C4) or {}).get("status") == "agent_tested")


# --- UI leg ------------------------------------------------------------------

def leg_ui():
    from playwright.sync_api import sync_playwright

    build = subprocess.run(
        ["npx", "vite", "build", "--mode", "web", "--outDir", str(DIST)],
        capture_output=True, text=True, timeout=300, cwd=ROOT,
        env={**os.environ, "VITE_STATE_URL": STATE_URL},
    )
    check("ui: test web bundle builds", build.returncode == 0,
          build.stderr.strip()[-200:] if build.returncode else "")
    if build.returncode != 0:
        return

    global WEB_URL
    httpd, WEB_URL = serve_web(WEB_PORT, DIST)
    dialogs = []
    try:
        check("ui: web server up",
              wait_port(urllib.parse.urlparse(WEB_URL).port, 10))
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                ignore_https_errors=True,
                viewport={"width": 1440, "height": 900})
            context.add_init_script(
                "localStorage.setItem('acp-ui:agents', "
                + json.dumps(json.dumps({
                    "agents": {"E2E Mock": {
                        "transport": "websocket",
                        "url": f"ws://127.0.0.1:{AGENT_PORT}/"}}}))
                + ");")
            context.add_init_script(
                "localStorage.setItem('acp-ui:preferences.json', "
                + json.dumps(json.dumps({"telemetryEnabled": False})) + ");")
            page = context.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            page.route(re.compile(r"/api/fs/"), fs_api)
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)

            page.goto(WEB_URL, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.click('button[aria-label="Board"]')
            page.wait_for_selector(".board-col", timeout=8000)

            # --- severity counter on the card ------------------------------
            c3chip = page.locator(
                f'[data-card-id="{C3}"] [data-testid="review-findings"]')
            c3chip.wait_for(state="visible", timeout=10000)
            txt = c3chip.inner_text()
            check("ui: card chip renders counts + round (C3)",
                  "crit 1" in txt and "maj 1" in txt and "min 1" in txt
                  and "r3/3" in txt, txt)
            check("ui: blocker chip carries the danger class",
                  "has-blockers" in (c3chip.get_attribute("class") or ""))

            c1chip = page.locator(
                f'[data-card-id="{C1}"] [data-testid="review-findings"]')
            c1chip.wait_for(state="visible", timeout=8000)
            txt = c1chip.inner_text()
            check("ui: C1 chip — blockers closed, minor still open",
                  "crit 0" in txt and "maj 0" in txt and "min 1" in txt
                  and "r1/3" in txt, txt)
            check("ui: C1 status chip reached agent_tested",
                  page.locator(f'[data-card-id="{C1}"] .status-chip')
                  .inner_text() == "agent_tested")

            check("ui: clean card has no review chip",
                  page.locator(f'[data-card-id="{C4}"] '
                               '[data-testid="review-findings"]').count() == 0)

            # --- panel-side derived flag on C6 -----------------------------
            c6badge = page.locator(
                f'[data-card-id="{C6}"] [data-testid="card-blocked-badge"]')
            c6badge.wait_for(state="visible", timeout=10000)
            c6 = wait_for(lambda: (board_card(C6) or {}).get("blocked")
                          and board_card(C6), timeout=10)
            check("ui: panel flagged C6 blocked at the round limit",
                  bool(c6) and str(c6.get("blockedReason") or "").startswith(
                      "review:") and "1 critical" in str(
                          c6.get("blockedReason") or ""),
                  str((c6 or {}).get("blockedReason") or "")[:140])

            # --- backlog cards from minor findings --------------------------
            check("ui: backlog column shows the minor->backlog cards",
                  page.locator(".board-card", has_text="[minor]").count() >= 2,
                  str(page.locator(".board-card", has_text="[minor]").count()))

            # --- drawer: findings block ------------------------------------
            # (click by card id — the minor's backlog card carries the source
            # title in its description, so a text match hits two cards)
            page.locator(f'[data-card-id="{C3}"]').click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            dr = page.locator(".card-drawer")
            block = dr.locator('[data-testid="review-block"]')
            check("ui: drawer review block present", block.count() == 1)
            check("ui: drawer round token",
                  "round 3 / 3" in dr.locator(
                      '[data-testid="review-round"]').inner_text())
            counts = dr.locator('[data-testid="review-counts"]').inner_text()
            check("ui: drawer counts line",
                  "3 open" in counts and "critical 1" in counts
                  and "major 1" in counts and "minor 1" in counts, counts)
            gate = dr.locator('[data-testid="review-gate"]').inner_text()
            check("ui: drawer gate note names the open blockers",
                  "critical" in gate and "major" in gate, gate)
            rows = dr.locator('[data-testid="review-list"] .find-row')
            check("ui: findings list renders severity + text",
                  rows.count() == 3
                  and "board write loses cards" in rows.first.inner_text(),
                  str(rows.count()))
            reason_input = dr.locator('[data-field="blockedReason"]')
            check("ui: blocked reason field shows the review: mark",
                  "review: round limit 3" in (reason_input.input_value() or ""),
                  reason_input.input_value()[:120])
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            # --- the gate refuses inside the UI -----------------------------
            page.locator(f'[data-card-id="{C2}"]').click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            dr = page.locator(".card-drawer")
            sel = dr.locator('[data-field="status"]')
            check("ui: C2 drawer shows in_progress", sel.input_value() == "in_progress")
            sel.select_option("agent_tested")
            # The debounced flush fires ~400ms later and the refusal alert
            # lands as a playwright dialog — wait_for_timeout pumps the
            # playwright event loop so the handler actually runs.
            page.wait_for_timeout(1200)
            ok = wait_for(lambda: dialogs and dialogs[-1] or None, timeout=5)
            check("ui: drawer move to agent_tested REFUSED via alert",
                  bool(ok) and "critical" in ok, str(ok)[:160])
            check("ui: status select snaps back to in_progress",
                  sel.input_value() == "in_progress", sel.input_value())
            page.wait_for_timeout(800)  # debounce flush lands nothing
            check("ui: C2 still in_progress on the board",
                  (board_card(C2) or {}).get("status") == "in_progress")

            check("ui: zero pageerror events", len(page_errors) == 0,
                  "; ".join(page_errors[:3]) if page_errors else "")
            browser.close()
    finally:
        stop(httpd)


def main():
    global STATE_PORT, STATE_URL
    if WORK.exists():
        shutil.rmtree(WORK)
    STATE_DATA.mkdir(parents=True)
    PROJ.mkdir(parents=True)

    state, STATE_PORT = serve_state(STATE_PORT, STATE_DATA)
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        check("state server up", wait_port(STATE_PORT, 10))
        seed()
        leg_gate()
        leg_sync_minor()
        leg_close_and_move()
        leg_round_limit()
        leg_failures()
        leg_ui()
    finally:
        stop(state)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
