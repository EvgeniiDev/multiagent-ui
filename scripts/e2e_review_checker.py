#!/usr/bin/env python3
"""E2E for the review-checker pass (workstream: the review-checker role):
verdicts on blocking findings between review and the `agent_tested` gate.

Layout (mirrors e2e_review.py):
  * own state server (server/acp-state-server.mjs) on :25916 with
    STATE_DIR=<worktree>/tmp-checker-test/state — the REAL board doc;
  * a project dir tmp-checker-test/proj holding the card artifact dirs with
    review_findings.json (+ review_verdict.json) files;
  * real `boardctl` CLI calls — `review-check` is the checker's write path,
    `move`/`set` prove the gate is bound by the same contract as the panel;
  * a test web bundle (VITE_STATE_URL=:25916) served on :25981 + playwright,
    with the host fs API stubbed from tmp-checker-test/proj.

Asserts (the workstream's acceptance list):
  * false major + true critical: after the checker rejects the false one the
    gate still refuses and names the true critical;
  * after the checker confirms the critical and the finding is closed, the
    card passes to `agent_tested`;
  * a rejected finding stays in history — `boardctl review` annotates it,
    the drawer shows the badge + reason, the ledger records who checked;
  * a disputed finding is surfaced to the human (the Links tab's proposals
    list) and still blocks;
  * `boardctl review-check` with an unknown finding id exits non-zero;
  * a malformed verdict file fails closed (the gate keeps blocking), same
    as a malformed findings file;
  * a hand-written verdict file is honoured identically — the contract is
    the file, not the writer (CLI and UI paths agree).

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_review_checker.py

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
WORK = ROOT / "tmp-checker-test"
STATE_DATA = WORK / "state"
PROJ = WORK / "proj"
DIST = WORK / "dist-web"
STATE_PORT = 25916               # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
WEB_PORT = 25981
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"       # rebased in leg_ui()
AGENT_PORT = 25980  # seeded ws agent -> bridge base http://127.0.0.1:25980 (stubbed)

PROJ_NAME = "checker-proj"
CHECKER = "e2e-checker"

CK1 = "ck-1-gate01"   # false major + true critical + a minor, round 1
CK2 = "ck-2-disp02"   # one critical to be disputed
CK3 = "ck-3-badv03"   # critical open + malformed verdict file
CK4 = "ck-4-hand04"   # major open + hand-written (file-contract) rejected verdict

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


def board_card(cid):
    doc, _ = get_doc("board.json")
    for c in (doc or {}).get("cards", []):
        if c.get("id") == cid:
            return c
    return None


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


def review_check(cid, fid, verdict, reason, expect=0):
    return boardctl("review-check", cid, fid, verdict,
                    "--reason", reason, "--agent", CHECKER, expect=expect)


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


def write_verdicts(cid, doc=None, raw=None):
    d = PROJ / ".acp" / "cards" / cid
    d.mkdir(parents=True, exist_ok=True)
    p = d / "review_verdict.json"
    if raw is not None:
        p.write_text(raw)
    else:
        p.write_text(json.dumps(doc, indent=2) + "\n")
    return p


def read_verdicts(cid):
    p = PROJ / ".acp" / "cards" / cid / "review_verdict.json"
    return json.loads(p.read_text())


def seed():
    cards = [
        dict(mk_card(CK1), title="Checker gate card"),
        dict(mk_card(CK2), title="Disputed card"),
        dict(mk_card(CK3), title="Malformed verdicts card"),
        dict(mk_card(CK4), title="Hand-written verdicts card"),
    ]
    force_put("board.json", {"version": 2, "cards": cards})
    force_put("projects.json", {
        "version": 1,
        "projects": [{"id": "p-checker", "name": PROJ_NAME, "path": str(PROJ),
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
        }, {
            "id": "review-checker", "label": "Review checker", "cli": "hermes",
            "args": ["--model", "swe-2-max"],
            "promptFile": ".acp/roles/review-checker.md",
            "maxConcurrent": 1, "pollIntervalSec": 15,
            "timeoutMin": 20, "maxRetries": 1,
        }],
        "stageRoles": {"reviewtest": "reviewer"},
    })
    write_findings(CK1, {"version": 1, "round": 1, "findings": [
        finding("f-falsemaj", "major", "no retry on state PUT",
                "src/lib/kv.ts:40", 1),
        finding("f-truecrit", "critical", "session token leaks to log",
                "src/auth.ts:88", 1),
        finding("f-min", "minor", "dead code path in sync",
                "src/sync.ts:12", 1),
    ]})
    write_findings(CK2, {"version": 1, "round": 1, "findings": [
        finding("f-dis", "critical", "board write races the state PUT",
                "src/lib/kv.ts:77", 1),
    ]})
    write_findings(CK3, {"version": 1, "round": 1, "findings": [
        finding("f-mcrit", "critical", "claim lease never released",
                "src/claims.ts:9", 1),
    ]})
    write_verdicts(CK3, raw="{ not json ]")
    write_findings(CK4, {"version": 1, "round": 1, "findings": [
        finding("f-hand", "major", "status not persisted",
                "src/board.ts:210", 1),
    ]})
    # The file contract, written by hand — an agent that produced
    # review_verdict.json without boardctl must be honoured identically.
    write_verdicts(CK4, {"version": 1, "verdicts": [{
        "findingId": "f-hand", "verdict": "rejected",
        "reason": "status is persisted via scheduleSave",
        "checker": "file-first-checker", "at": 1700000001000,
    }]})


# --- fs bridge stub (same seam as e2e_review) ---------------------------------

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


# --- CLI legs -----------------------------------------------------------------

def leg_reject_false_major():
    """The false major is rejected; the gate still refuses on the true
    critical and names it."""
    proc = review_check(CK1, "f-falsemaj", "rejected",
                        "kv.ts:41 already retries the PUT on 409")
    check("review-check rejected: verdict recorded, gate named",
          "f-falsemaj → rejected" in proc.stdout
          and "refuse agent_tested" in proc.stdout
          and "1 critical" in proc.stdout,
          proc.stdout.strip()[:160])

    vdoc = read_verdicts(CK1)
    entry = next((v for v in vdoc.get("verdicts", [])
                  if v.get("findingId") == "f-falsemaj"), None)
    check("verdict file holds the rejected entry with reason + checker",
          bool(entry) and entry.get("verdict") == "rejected"
          and entry.get("checker") == CHECKER
          and "retries" in str(entry.get("reason")),
          json.dumps(entry)[:160] if entry else "no entry")

    proc = boardctl("move", CK1, "reviewtest", "agent_tested", expect=None)
    check("rejecting the false major: gate STILL refuses, names the critical",
          proc.returncode != 0
          and "1 critical" in proc.stderr
          and "1 major" not in proc.stderr,
          proc.stderr.strip()[:160])
    check("CK1 status unchanged after refusal",
          (board_card(CK1) or {}).get("status") == "in_progress")


def leg_confirm_then_fix():
    """Confirm the true critical (still gating while open), then the fix
    lands (--close) and the card passes."""
    proc = review_check(CK1, "f-truecrit", "confirmed",
                        "verified: token is printed at auth.ts:88")
    check("review-check confirmed lands",
          "f-truecrit → confirmed" in proc.stdout
          and "refuse agent_tested" in proc.stdout,
          proc.stdout.strip()[:160])

    proc = boardctl("move", CK1, "reviewtest", "agent_tested", expect=None)
    check("confirmed critical still gates while open",
          proc.returncode != 0 and "1 critical" in proc.stderr,
          proc.stderr.strip()[:160])

    proc = boardctl("review", CK1, "--close", "f-truecrit", expect=0)
    check("the fix closes the true finding", "f-truecrit closed" in proc.stdout,
          proc.stdout.strip()[:120])
    proc = boardctl("move", CK1, "reviewtest", "agent_tested", expect=0)
    check("rejected major + closed critical + open minor -> agent_tested",
          proc.returncode == 0
          and (board_card(CK1) or {}).get("status") == "agent_tested",
          proc.stdout.strip()[:120])


def leg_rejected_history():
    """The rejected finding stays visible with reason and checker name —
    `boardctl review` row and the activity ledger entry."""
    proc = boardctl("review", CK1, expect=0)
    check("review show keeps the rejected finding with verdict + reason",
          "f-falsemaj" in proc.stdout
          and "rejected by e2e-checker" in proc.stdout
          and "retries" in proc.stdout,
          [l for l in proc.stdout.splitlines() if "f-falsemaj" in l][:1])

    doc, _ = get_doc("activity.json")
    rows = [e for e in (doc or {}).get("entries", [])
            if e.get("role") == "review-checker"]
    rej = [e for e in rows
           if "f-falsemaj" in str(e.get("detail")) and "rejected" in str(e.get("detail"))]
    conf = [e for e in rows
            if "f-truecrit" in str(e.get("detail")) and "confirmed" in str(e.get("detail"))]
    check("ledger holds review-checker rows for the verdicts",
          len(rows) >= 2 and bool(rej) and bool(conf),
          f"{len(rows)} checker rows")
    check("rejection ledger row carries the reason and the checker's name",
          bool(rej) and rej[0].get("agentName") == CHECKER
          and "retries" in str(rej[0].get("detail")),
          (rej[0].get("detail") if rej else "")[:140])


def leg_disputed():
    """Disputed blocks AND is surfaced to the human (the `proposed:` row
    the Links tab renders); the ledger row carries the checker's reason."""
    proc = review_check(CK2, "f-dis", "disputed",
                        "race exists on paper, no repro path found")
    check("review-check disputed lands",
          "f-dis → disputed" in proc.stdout, proc.stdout.strip()[:120])
    proc = boardctl("move", CK2, "reviewtest", "agent_tested", expect=None)
    check("disputed still blocks the gate",
          proc.returncode != 0 and "1 critical" in proc.stderr,
          proc.stderr.strip()[:160])
    doc, _ = get_doc("activity.json")
    rows = [e for e in (doc or {}).get("entries", [])
            if e.get("role") == "review-checker"
            and str(e.get("detail") or "").startswith("proposed:")
            and "f-dis" in str(e.get("detail"))]
    check("disputed verdict surfaced as a `proposed:` ledger row for a human",
          len(rows) == 1 and rows[0].get("agentName") == CHECKER
          and "no repro" in str(rows[0].get("detail")),
          (rows[0].get("detail") if rows else "")[:140])


def leg_unknown_fid():
    proc = boardctl("review-check", CK1, "f-nope", "confirmed",
                    "--reason", "nothing", "--agent", CHECKER, expect=None)
    check("review-check with an unknown finding id exits non-zero",
          proc.returncode != 0 and "f-nope" in proc.stderr,
          f"rc={proc.returncode} {proc.stderr.strip()[:100]}")
    proc = boardctl("review-check", CK1, "f-min", "bogusword",
                    "--reason", "x", expect=None)
    check("review-check rejects a verdict outside the vocabulary",
          proc.returncode != 0,
          f"rc={proc.returncode}")


def leg_malformed_verdicts():
    """A malformed verdict file fails closed, same as a malformed findings
    file: rejections cannot be verified, every open blocker still gates."""
    proc = boardctl("move", CK3, "reviewtest", "agent_tested", expect=None)
    check("malformed verdict file: gate fails closed, names the critical",
          proc.returncode != 0 and "1 critical" in proc.stderr
          and "verdicts" in proc.stderr,
          proc.stderr.strip()[:180])
    proc = boardctl("review-check", CK3, "f-mcrit", "rejected",
                    "--reason", "false", "--agent", CHECKER, expect=None)
    check("review-check refuses to append onto a malformed verdict file",
          proc.returncode != 0 and "unreadable" in proc.stderr,
          proc.stderr.strip()[:140])


def leg_file_contract():
    """CK4's verdict file was hand-written (the agent path): the gate
    honours it identically — the contract is the file, not the writer."""
    proc = boardctl("move", CK4, "reviewtest", "agent_tested", expect=0)
    check("hand-written rejected verdict clears the gate too",
          proc.returncode == 0
          and (board_card(CK4) or {}).get("status") == "agent_tested",
          proc.stdout.strip()[:120])


# --- UI leg -------------------------------------------------------------------

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

            # --- CK1: rejected major still shown, nothing gating left ------
            c1chip = page.locator(
                f'[data-card-id="{CK1}"] [data-testid="review-findings"]')
            c1chip.wait_for(state="visible", timeout=10000)
            txt = c1chip.inner_text()
            check("ui: CK1 chip keeps the rejected major in the counts",
                  "maj 1" in txt and "rej 1" in txt, txt)
            check("ui: CK1 chip not tinted as blocked (nothing still gates)",
                  "has-blockers" not in (c1chip.get_attribute("class") or ""))
            check("ui: CK1 reached agent_tested",
                  page.locator(f'[data-card-id="{CK1}"] .status-chip')
                  .inner_text() == "agent_tested")

            # --- CK2: disputed still gates ----------------------------------
            c2chip = page.locator(
                f'[data-card-id="{CK2}"] [data-testid="review-findings"]')
            c2chip.wait_for(state="visible", timeout=8000)
            check("ui: CK2 chip still tinted blocked (disputed gates)",
                  "has-blockers" in (c2chip.get_attribute("class") or ""),
                  c2chip.get_attribute("class") or "")

            # --- CK3: malformed verdicts -> tinted + gate note ---------------
            c3chip = page.locator(
                f'[data-card-id="{CK3}"] [data-testid="review-findings"]')
            c3chip.wait_for(state="visible", timeout=8000)
            check("ui: CK3 chip still tinted blocked (verdicts unreadable)",
                  "has-blockers" in (c3chip.get_attribute("class") or ""))

            # --- drawer CK1: verdict badges + rejection reason --------------
            page.locator(f'[data-card-id="{CK1}"]').click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            dr = page.locator(".card-drawer")
            rows = dr.locator('[data-testid="review-list"] .find-row')
            check("ui: drawer lists all three CK1 findings", rows.count() == 3,
                  str(rows.count()))
            rej_badge = dr.locator('.find-verd[data-verdict="rejected"]')
            conf_badge = dr.locator('.find-verd[data-verdict="confirmed"]')
            check("ui: rejected + confirmed verdict badges render",
                  rej_badge.count() == 1 and conf_badge.count() == 1,
                  f"rej={rej_badge.count()} conf={conf_badge.count()}")
            title = rej_badge.get_attribute("title") or ""
            check("ui: rejected badge carries the reason + checker name",
                  CHECKER in title and "retries" in title, title)
            rej_row = dr.locator(".find-row", has_text="no retry on state PUT")
            check("ui: rejected finding row stays visible (history kept)",
                  rej_row.count() == 1
                  and "find-rejected" in (rej_row.get_attribute("class") or ""))
            check("ui: CK1 gate note clear — nothing still gates",
                  dr.locator('[data-testid="review-gate"]').count() == 0)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            # --- drawer CK3: gate fails closed on malformed verdicts --------
            page.locator(f'[data-card-id="{CK3}"]').click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            dr = page.locator(".card-drawer")
            gate = dr.locator('[data-testid="review-gate"]')
            gate.wait_for(state="visible", timeout=8000)
            gtxt = gate.inner_text()
            check("ui: CK3 gate note names critical + unreadable verdicts",
                  "critical" in gtxt and "verdicts unreadable" in gtxt, gtxt)
            sel = dr.locator('[data-field="status"]')
            sel.select_option("agent_tested")
            page.wait_for_timeout(1200)
            ok = wait_for(lambda: dialogs and dialogs[-1] or None, timeout=5)
            check("ui: CK3 drawer move to agent_tested REFUSED via alert",
                  bool(ok) and "critical" in ok, str(ok)[:160])
            check("ui: CK3 status snaps back",
                  sel.input_value() == "in_progress", sel.input_value())
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            # --- Links tab: disputed verdict in the proposals list -----------
            page.click('.tab-bar button:has-text("Links")')
            page.wait_for_selector('[data-testid="pm-proposals"]', timeout=8000)
            section = page.locator('[data-testid="pm-proposals"]')
            prop_rows = section.locator(".lnk-row.proposed")
            check("ui: proposals list shows the disputed verdict row",
                  prop_rows.count() >= 1
                  and "f-dis" in prop_rows.first.inner_text()
                  and "no repro" in prop_rows.first.inner_text(),
                  prop_rows.first.inner_text()[:160] if prop_rows.count() else "none")

            # --- Events tab: the checker's ledger rows ------------------------
            page.click('.tab-bar button:has-text("Events")')
            page.wait_for_selector(".event-list", timeout=8000)
            ev = page.locator(".event-list .event-row", has_text=CHECKER)
            check("ui: events list shows the review-checker rows",
                  ev.count() >= 3, str(ev.count()))
            check("ui: an event row carries the rejection detail",
                  ev.first.inner_text().find("f-falsemaj") >= 0
                  or page.locator(".event-row", has_text="f-falsemaj").count() >= 1)

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
        leg_reject_false_major()
        leg_confirm_then_fix()
        leg_rejected_history()
        leg_disputed()
        leg_unknown_fid()
        leg_malformed_verdicts()
        leg_file_contract()
        leg_ui()
    finally:
        stop(state)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
