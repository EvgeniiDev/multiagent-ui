#!/usr/bin/env python3
"""E2E for the W15 plan-queue: 03_checklist.md derivation + runner hint +
the card drawer's checkbox view.

Own state server (server/acp-state-server.mjs) on :25917 with
STATE_DIR=<worktree>/tmp-planqueue-test, a project inside it, and a dev
role whose `cli` is `node stub-cli.mjs` — the stub stands in for the
executor: with STUB_MARK=1 it checks the first open `- [ ]` item of
03_checklist.md; it always writes 04_impl_log.md and exits 0.

Runner legs (each `--once` is synchronous):

  1. first run on a card holding 02_plan.md -> 03_checklist.md derived,
     every item `- [ ]`, and 00_brief.md carries the continuation line
     naming the first open item;
  2. second run (STUB_MARK=1) -> the stub's `- [x]` lands on item 1;
  3. third run's brief names the NEXT open item — continuation, not
     restart — and the file was not regenerated over the stub's mark;
  4. a hand-edited checklist is respected byte-for-byte (no regeneration)
     and the brief names the hand-chosen first open item;
  5. all items checked -> no continuation line in the brief;
  6. a fresh card (no plan) gets no checklist and no hint; a malformed
     plan (no list items) yields no checklist file and no crash.

Panel leg: serves dist-web on :25997, stubs /api/fs/* against the real
artifact dir (dirs-only list, like the deployed bridge) and asserts the
card drawer renders the checklist with real checkboxes.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_planqueue.py

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

from playwright.sync_api import sync_playwright

from _e2e_harness import STATE_SERVER, serve_state, serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "server" / "acp-runner.mjs"
DIST = ROOT / "dist-web"
STATE_DIR = ROOT / "tmp-planqueue-test"
STATE_PORT = 25917               # preferred; harness falls back when busy
WEB_PORT = 25997                 # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
PROJ = STATE_DIR / "proj"
AGENT_PORT = 25993  # seeded ws agent -> bridge base http://127.0.0.1:25993 (stubbed)

HINT = "Продолжай с первого незакрытого пункта 03_checklist.md"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# State-server API (same protocol as the other runner suites)
# --------------------------------------------------------------------------

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


def mk_card(cid, stage="dev", status="in_progress", project="p1"):
    now = int(time.time() * 1000)
    return {
        "id": cid, "title": f"E2E {cid}", "description": "d",
        "project": project, "agent": "", "priority": "medium",
        "acceptance": "accepts X", "verification": "run Y",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": 10, "createdAt": now, "updatedAt": now,
    }


def seed_board(card_ids):
    force_put("board.json",
              {"version": 2, "cards": [mk_card(c) for c in card_ids]})


def seed_static_docs():
    now = int(time.time() * 1000)
    projects = {"version": 1,
                "projects": [{"id": "p1", "name": "P1",
                              "path": str(PROJ), "createdAt": now}],
                "activeProjectId": "all"}
    roles = {"version": 1,
             "roles": [{"id": "dev", "label": "Dev", "cli": "node",
                        "args": [str(STATE_DIR / "stub-cli.mjs")],
                        "promptFile": ".acp/roles/dev.md",
                        "maxConcurrent": 5, "pollIntervalSec": 5,
                        "timeoutMin": 5, "maxRetries": 1}],
             "stageRoles": {"dev": "dev"}}
    for name, doc in (("projects.json", projects), ("roles.json", roles),
                      ("claims.json", {"version": 1, "claims": {}, "attempts": {}}),
                      ("activity.json", {"entries": [], "usage": []})):
        status, _ = put_doc(name, doc, 0)
        assert status == 200, f"seed {name} -> {status}"


def run_once(mark=False):
    env = {**os.environ, "STATE_URL": STATE_URL, "ROOT_DIR": str(STATE_DIR),
           "RUNNER_ID": "e2e-runner", "STUB_MARK": "1" if mark else "0"}
    return subprocess.run(
        ["node", str(RUNNER), "--once"], capture_output=True, text=True,
        timeout=120, env=env, cwd=ROOT)


def card_dir(cid):
    return PROJ / ".acp" / "cards" / cid


def read(path):
    return path.read_text(encoding="utf-8") if path.exists() else None


def brief_of(cid):
    return read(card_dir(cid) / "00_brief.md")


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

PLAN = (
    "# Plan — queue card\n"
    "\n"
    "Intro prose that is not an item.\n"
    "\n"
    "1. design schema\n"
    "2. build drawer\n"
    "* wire e2e\n"
    "- final cleanup\n"
    "\n"
    "| col | table |\n"
    "| --- | ----- |\n"
    "\n"
    "STATUS: APPROVE\n"
)

EXPECTED_CHECKLIST = (
    "# Checklist — derived from 02_plan.md; the executor marks items [x]\n"
    "\n"
    "- [ ] design schema\n"
    "- [ ] build drawer\n"
    "- [ ] wire e2e\n"
    "- [ ] final cleanup\n"
)

HAND_EDIT = (
    "# Checklist — derived from 02_plan.md; the executor marks items [x]\n"
    "\n"
    "- [x] design schema\n"
    "- [x] build drawer\n"
    "- [ ] wire e2e (hand rewrite)\n"
    "- [ ] final cleanup\n"
    "- [ ] human extra step\n"
)

ALL_DONE = (
    "# Checklist — derived from 02_plan.md; the executor marks items [x]\n"
    "\n"
    "- [x] design schema\n"
    "- [x] build drawer\n"
    "- [x] wire e2e (hand rewrite)\n"
    "- [x] final cleanup\n"
    "- [x] human extra step\n"
)

MALFORMED_PLAN = (
    "# Plan — malformed card\n"
    "\n"
    "No list items at all — just headers and prose paragraphs.\n"
    "\n"
    "## Another header\n"
    "\n"
    "STATUS: APPROVE\n"
)


def write_stub():
    """The executor stub: marks the first open checklist item when
    STUB_MARK=1 (the executor's job — the runner never edits marks),
    then writes its verdict report and exits."""
    stub = STATE_DIR / "stub-cli.mjs"
    stub.write_text(
        "import { promises as fs } from 'node:fs';\n"
        "const arg = process.argv.slice(2).find((a) => /\\/[^\\s]*00_brief\\.md/.test(a)) || '';\n"
        "const m = /(\\/[^\\s]*)00_brief\\.md/.exec(arg);\n"
        "if (!m) { console.error('stub: no brief path in argv'); process.exit(64); }\n"
        "const cardDir = m[1];\n"
        "if (process.env.STUB_MARK === '1') {\n"
        "  try {\n"
        "    const p = `${cardDir}/03_checklist.md`;\n"
        "    const t = await fs.readFile(p, 'utf8');\n"
        "    const marked = t.replace(/^(\\s*[-*]\\s+)\\[ \\](\\s+.*)$/m, '$1[x]$2');\n"
        "    if (marked !== t) await fs.writeFile(p, marked);\n"
        "  } catch {}\n"
        "}\n"
        "await fs.writeFile(`${cardDir}/04_impl_log.md`, 'did the thing\\nSTATUS: DONE\\n');\n"
        "console.log('stub done');\n"
        "process.exit(0);\n")
    return stub


# --------------------------------------------------------------------------
# fs-bridge stub (mirrors e2e_card_pipeline): the deployed bridge lists
# directories only; reads give {path, bytes, content} or 404.
# --------------------------------------------------------------------------

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
        dirs = [
            {"name": n, "path": os.path.join(ap, n)}
            for n in sorted(os.listdir(ap))
            if os.path.isdir(os.path.join(ap, n))
        ]
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


def down_state(route):
    """Fail every :25900 call -> the panel falls back to localStorage."""
    route.fulfill(status=500, content_type="application/json",
                  body=json.dumps({"error": "state server down"}))


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


def ui_board_doc():
    now = int(time.time() * 1000)
    c = mk_card("card-plan-1")
    c.update({"title": "Queue card UI", "project": "p1",
              "createdAt": now, "updatedAt": now})
    return {"version": 2, "cards": [c]}


def seed_ui(context):
    pairs = [
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
        ("acp-ui:agents",
         {"agents": {"E2E Mock": {"transport": "websocket",
                                  "url": f"ws://127.0.0.1:{AGENT_PORT}/"}}}),
        ("acp-ui:projects.json",
         {"version": 1,
          "projects": [{"id": "p1", "name": "P1", "path": str(PROJ),
                        "createdAt": 1700000000000}],
          "activeProjectId": "all"}),
        ("acp-ui:board.json", ui_board_doc()),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


# --------------------------------------------------------------------------
# Runner legs
# --------------------------------------------------------------------------

def runner_legs():
    # ---- leg 1: derivation on the first run -----------------------------
    d = card_dir("card-plan-1")
    d.mkdir(parents=True)
    (d / "02_plan.md").write_text(PLAN, encoding="utf-8")
    seed_board(["card-plan-1"])

    proc = run_once(mark=False)  # derive only — the stub must not mark yet
    check("run1 once exits 0", proc.returncode == 0,
          proc.stderr.strip()[:200] or proc.stdout[:200])

    chk = d / "03_checklist.md"
    check("run1 derives 03_checklist.md", chk.exists())
    if chk.exists():
        text = chk.read_text(encoding="utf-8")
        check("run1 checklist: all items unchecked, verbatim texts",
              text == EXPECTED_CHECKLIST, text[:400].replace("\n", " | "))

    brief = brief_of("card-plan-1") or ""
    check("run1 brief carries the continuation line",
          HINT in brief, brief[:300].replace("\n", " | "))
    check("run1 brief names the first open item",
          re.search(re.escape(HINT) + r":\s*design schema", brief) is not None,
          brief[:300].replace("\n", " | "))

    # ---- leg 2: the stub (executor) marks item 1 -------------------------
    proc = run_once(mark=True)
    check("run2 once exits 0", proc.returncode == 0,
          proc.stderr.strip()[:200])
    text = chk.read_text(encoding="utf-8") if chk.exists() else ""
    check("run2 stub marked item 1, rest stay open",
          "- [x] design schema" in text and "- [ ] build drawer" in text
          and text.count("- [x]") == 1,
          text[:300].replace("\n", " | "))

    # ---- leg 3: continuation — the brief names the NEXT open item --------
    proc = run_once(mark=False)
    check("run3 once exits 0", proc.returncode == 0,
          proc.stderr.strip()[:200])
    brief = brief_of("card-plan-1") or ""
    check("run3 brief names the next open item (continuation, not restart)",
          re.search(re.escape(HINT) + r":\s*build drawer", brief) is not None,
          brief[:300].replace("\n", " | "))
    text = chk.read_text(encoding="utf-8") if chk.exists() else ""
    check("run3 did not regenerate over the stub's mark",
          "- [x] design schema" in text and "- [ ] build drawer" in text,
          text[:300].replace("\n", " | "))

    # ---- leg 4: a hand edit is the state — respected byte-for-byte -------
    chk.write_text(HAND_EDIT, encoding="utf-8")
    proc = run_once(mark=False)
    check("run4 once exits 0", proc.returncode == 0,
          proc.stderr.strip()[:200])
    text = chk.read_text(encoding="utf-8") if chk.exists() else ""
    check("run4 hand edit respected (no regeneration over user state)",
          text == HAND_EDIT, text[:400].replace("\n", " | "))
    brief = brief_of("card-plan-1") or ""
    check("run4 brief names the hand-chosen first open item",
          re.search(re.escape(HINT) + r":\s*wire e2e \(hand rewrite\)",
                    brief) is not None,
          brief[:300].replace("\n", " | "))

    # ---- leg 5: all done -> no continuation line --------------------------
    chk.write_text(ALL_DONE, encoding="utf-8")
    proc = run_once(mark=False)
    check("run5 once exits 0", proc.returncode == 0,
          proc.stderr.strip()[:200])
    brief = brief_of("card-plan-1") or ""
    check("run5 all checked -> no continuation line",
          HINT not in brief, brief[:300].replace("\n", " | "))
    text = chk.read_text(encoding="utf-8") if chk.exists() else ""
    check("run5 all-done file untouched",
          text == ALL_DONE, text[:300].replace("\n", " | "))

    # ---- leg 6: fresh card + malformed plan -------------------------------
    seed_board(["card-plan-1", "card-fresh", "card-malformed"])
    dm = card_dir("card-malformed")
    dm.mkdir(parents=True)
    (dm / "02_plan.md").write_text(MALFORMED_PLAN, encoding="utf-8")

    proc = run_once(mark=False)
    check("run6 once exits 0 (malformed plan is no crash)",
          proc.returncode == 0, proc.stderr.strip()[:200])

    brief_fresh = brief_of("card-fresh") or ""
    check("fresh card: brief written", bool(brief_fresh))
    check("fresh card: no continuation line",
          HINT not in brief_fresh,
          brief_fresh[:300].replace("\n", " | "))
    check("fresh card: no checklist derived (no plan)",
          not (card_dir("card-fresh") / "03_checklist.md").exists())

    check("malformed plan: no checklist file",
          not (dm / "03_checklist.md").exists())
    brief_mal = brief_of("card-malformed") or ""
    check("malformed plan: no continuation line",
          HINT not in brief_mal,
          brief_mal[:300].replace("\n", " | "))

    # Back to the two-items-done hand state for the drawer leg.
    chk.write_text(HAND_EDIT, encoding="utf-8")


# --------------------------------------------------------------------------
# Panel leg
# --------------------------------------------------------------------------

def panel_leg():
    global BASE
    server, BASE = serve_web(WEB_PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed_ui(ctx)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.on("dialog", lambda d: d.accept())
            page.route(re.compile(r":25900/"), down_state)
            page.route(re.compile(r"/api/fs/"), fs_api)
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)

            page.goto(BASE, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.click('button[aria-label="Board"]')
            page.wait_for_selector(".board-col", timeout=5000)

            page.locator(".board-card", has_text="Queue card UI").first.click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            dr = page.locator(".card-drawer")
            dr.locator('[data-testid="checklist"]').wait_for(timeout=8000)

            names = [s.strip() for s in dr.locator(
                '[data-testid="artifacts-list"] .art-name').all_inner_texts()]
            check("drawer artifact list includes 03_checklist.md",
                  "03_checklist.md" in names, ",".join(names))

            rows = dr.locator('[data-testid="checklist-items"] .check-row')
            check("drawer renders one row per checklist item",
                  rows.count() == 5, str(rows.count()))

            boxes = dr.locator(
                '[data-testid="checklist-items"] .check-box')
            checked = boxes.evaluate_all(
                "els => els.filter(e => e.checked).length")
            check("drawer checkboxes reflect the marks (2 of 5 checked)",
                  boxes.count() == 5 and checked == 2,
                  f"{checked}/{boxes.count()} checked")

            texts = [s.strip() for s in dr.locator(
                '[data-testid="checklist-items"] .check-text')
                .all_inner_texts()]
            check("drawer checklist texts verbatim (incl. hand edit)",
                  texts == ["design schema", "build drawer",
                            "wire e2e (hand rewrite)", "final cleanup",
                            "human extra step"],
                  ",".join(texts))

            disabled = boxes.evaluate_all(
                "els => els.every(e => e.disabled)")
            check("drawer checkboxes are read-only", bool(disabled))

            prog = dr.locator('[data-testid="checklist-progress"]')
            check("drawer shows progress 2/5",
                  prog.inner_text().strip() == "2/5", prog.inner_text())

            done_rows = dr.locator(
                '[data-testid="checklist-items"] .check-row.done')
            check("done rows carry the .done style",
                  done_rows.count() == 2, str(done_rows.count()))

            ctx.close()
            browser.close()
    finally:
        stop(server)


def main():
    global STATE_PORT, STATE_URL
    for path, what in ((STATE_SERVER, "state server"),
                       (RUNNER, "runner"),
                       (DIST / "index.html", "dist-web (run build:web)")):
        if not path.exists():
            print(f"FAIL  {path} missing — {what} not available")
            sys.exit(1)

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)
    PROJ.mkdir(parents=True)
    write_stub()

    state, STATE_PORT = serve_state(STATE_PORT, STATE_DIR)
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        seed_static_docs()
        runner_legs()
        panel_leg()
    finally:
        stop(state)
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
