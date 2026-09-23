#!/usr/bin/env python3
"""E2E for the card-as-pipeline view (W6-A), against the real web build.

Serves `dist-web/` itself on http://127.0.0.1:25988/ and stubs the host
bridge with `page.route` on `/api/fs/` — the stub mirrors the deployed
bridge exactly: `list` answers dirs only (no `files` array), `read` gives
`{path, bytes, content}` or 404, `write` persists under the fixture root.
Test data lives inside the worktree at `./tmp-pipeline-test/` (the seeded
registry project points there), never in /tmp or ~/.hermes.

Asserted:

  * the Artifacts block on the card drawer lists the probed files and a
    click opens read-only content;
  * the STATUS badge shows the token from `05_review_r1.md` (drawer badge
    + kanban card chip);
  * `proposeTransition` matches the table — all six cases exercised as a
    unit call in the browser via `window.__pipeline`, plus three driven
    through the Apply button (move, in-stage status, blocked flag);
  * `CHANGES_REQUIRED` proposes a step back, `BLOCKED` the flag + reason;
  * Refresh re-reads the dir (a rewritten token changes the proposal);
  * an empty card dir shows a readable empty state, a missing dir too;
  * the bridge stub answers `write`;
  * zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_card_pipeline.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
TESTDATA = ROOT / "tmp-pipeline-test"
PORT = 25988
BASE = f"http://127.0.0.1:{PORT}/"
AGENT_PORT = 25993  # seeded ws agent -> bridge base http://127.0.0.1:25993 (stubbed)

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures — the prepared artifact dirs, inside the worktree
# --------------------------------------------------------------------------

def write_fixtures():
    if TESTDATA.exists():
        shutil.rmtree(TESTDATA)
    (TESTDATA / ".acp" / "cards").mkdir(parents=True)

    def put(card_id, name, text):
        d = TESTDATA / ".acp" / "cards" / card_id
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text, encoding="utf-8")

    # c-spec: spec stage, spec approved
    put("c-spec", "00_brief.md",
        "# Brief\n\nCard c-spec — prove the pipeline view.\n")
    put("c-spec", "01_spec.md",
        "# Spec\n\n- list artifacts on the card\n- read the STATUS token\n\n"
        "STATUS: APPROVE\n")

    # c-plan: plan stage, plan review approved
    put("c-plan", "02_plan.md",
        "# Plan\n\n1. store  2. drawer  3. e2e\n\nSTATUS: APPROVE\n")
    put("c-plan", "03_plan_review.md",
        "# Plan review\n\nNo critical findings.\n\nSTATUS: APPROVE\n")

    # c-dev: dev stage, impl log asks for changes -> back to plan
    put("c-dev", "04_impl_log.md",
        "# Impl log\n\nSection A landed; section B needs the plan reworked.\n\n"
        "STATUS: CHANGES_REQUIRED\n")

    # c-rt: reviewtest — every prior artifact, impl log WITHOUT a token so
    # the badge provably reads 05_review_r1.md; plus a runner log.
    put("c-rt", "00_brief.md", "# Brief\n\nCard c-rt.\n")
    put("c-rt", "01_spec.md", "# Spec\n\nscope\n\nSTATUS: APPROVE\n")
    put("c-rt", "02_plan.md", "# Plan\n\nsteps\n\nSTATUS: APPROVE\n")
    put("c-rt", "03_plan_review.md", "# Plan review\n\nclean\n\nSTATUS: APPROVE\n")
    put("c-rt", "04_impl_log.md",
        "# Impl log\n\nAll sections implemented; see review round 1.\n")
    put("c-rt", "05_review_r1.md",
        "# Review r1\n\n| Type | Item | Evidence |\n|---|---|---|\n"
        "| nit | naming | l.42 |\n\nAll critical/major closed.\n\nSTATUS: DONE\n")
    put("c-rt", "run-1.log",
        "runner: spawn dev\nrunner: exit 0 in 41s\n")

    # c-blocked: dev stage, impl log blocked with a reason on the token line
    put("c-blocked", "04_impl_log.md",
        "# Impl log\n\nCannot proceed.\n\n"
        "STATUS: BLOCKED — reviewer cli missing on host\n")

    # c-empty: dir exists but holds nothing
    (TESTDATA / ".acp" / "cards" / "c-empty").mkdir(parents=True)

    # c-nodir: project resolves but no card dir was ever created
    # (nothing on disk)


def board_doc():
    now = int(time.time() * 1000)

    def card(cid, title, stage, status, project="Pipe"):
        return {
            "id": cid, "title": title, "description": "seeded w6 card",
            "project": project, "agent": "", "priority": "medium",
            "acceptance": "", "verification": "", "links": [], "session": None,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
            "stage": stage, "status": status, "statusByStage": {},
            "order": 10, "createdAt": now, "updatedAt": now,
        }

    return {
        "version": 2,
        "cards": [
            card("c-rt", "W6 reviewtest card", "reviewtest", "in_progress"),
            card("c-spec", "W6 spec card", "spec", "in_progress"),
            card("c-plan", "W6 plan card", "plan", "in_progress"),
            card("c-dev", "W6 dev card", "dev", "in_progress"),
            card("c-blocked", "W6 blocked card", "dev", "in_progress"),
            card("c-empty", "W6 empty card", "spec", "in_progress"),
            card("c-nodir", "W6 missing-dir card", "spec", "in_progress"),
            card("c-ghost", "W6 no-project card", "spec", "in_progress",
                 project="ghost"),
        ],
    }


REGISTRY = {
    "version": 1,
    "projects": [
        {"id": "p-pipe", "name": "Pipe", "path": str(TESTDATA),
         "createdAt": 1700000000000},
    ],
    "activeProjectId": "all",
}

AGENTS = {
    "agents": {
        "E2E Mock": {"transport": "websocket", "url": f"ws://127.0.0.1:{AGENT_PORT}/"},
    }
}


def seed(context):
    pairs = [
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
        ("acp-ui:agents", AGENTS),
        ("acp-ui:projects.json", REGISTRY),
        ("acp-ui:board.json", board_doc()),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


# --------------------------------------------------------------------------
# Bridge stub — mirrors deploy/~/.hermes acp-ws-bridge.mjs semantics
# --------------------------------------------------------------------------

def scoped_abs(p):
    """Resolve like the bridge: abs stays abs, rel joins the root; the
    answer must stay inside TEST_ROOT."""
    ap = os.path.abspath(p) if os.path.isabs(p) else os.path.abspath(
        os.path.join(str(TESTDATA), p))
    root = str(TESTDATA)
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
        return out(200, {"root": str(TESTDATA), "home": str(TESTDATA)})

    if u.path == "/api/fs/list":
        target = qs.get("path", [str(TESTDATA)])[0]
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
                         "root": str(TESTDATA), "dirs": dirs})

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

    if u.path == "/api/fs/write" and req.method.upper() == "POST":
        try:
            body = json.loads(req.post_data or "{}")
        except json.JSONDecodeError:
            body = {}
        target = body.get("path", "")
        ap, inside = scoped_abs(target)
        if not inside:
            return out(403, {"error": f"path outside root: {ap}"})
        existed = os.path.exists(ap)
        Path(ap).parent.mkdir(parents=True, exist_ok=True)
        Path(ap).write_text(body.get("content", ""), encoding="utf-8")
        size = os.path.getsize(ap)
        return out(200, {"path": ap, "created": not existed, "bytes": size})

    return out(404, {"error": "not found"})


def down_state(route):
    """Fail every state-server call -> the panel falls back to localStorage,
    so the test never touches ~/.hermes/acp-ui-state."""
    route.fulfill(status=500, content_type="application/json",
                  body=json.dumps({"error": "state server down"}))


def acp_ws(ws):
    """Minimal ACP-side websocket stub — the board never dials it, but a
    stray connect gets a syntactically valid answer instead of a wedge."""
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


def start_server():
    try:
        socket.create_connection(("127.0.0.1", PORT), 0.3).close()
    except OSError:
        pass
    else:
        print(f"FAIL  port {PORT} already in use — refusing to test a stale server")
        sys.exit(1)
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on port {PORT}")
    sys.exit(1)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def open_card(page, title):
    page.locator(".board-card", has_text=title).first.click()
    page.wait_for_selector(".card-drawer", timeout=5000)


def close_drawer(page):
    page.locator(".drawer-close").click()
    page.wait_for_timeout(150)


def drawer(page):
    return page.locator(".card-drawer")


def card_chip(page, cid):
    return page.locator(f'[data-card-id="{cid}"] [data-testid="card-status-token"]')


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    write_fixtures()
    server = start_server()
    try:
        run_checks()
    finally:
        server.terminate()
        server.wait(timeout=5)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
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

        # ---------------- kanban STATUS chip ------------------------------
        chip = card_chip(page, "c-rt")
        chip.wait_for(state="visible", timeout=8000)
        check("kanban card carries the STATUS chip", chip.count() == 1)
        check("kanban chip shows the 05_review_r1 token",
              chip.inner_text() == "DONE", chip.inner_text())

        # ---------------- drawer: artifact list + viewer -------------------
        open_card(page, "W6 reviewtest card")
        dr = drawer(page)
        dr.locator('[data-testid="artifacts-list"]').wait_for(timeout=8000)
        names = [s.strip() for s in dr.locator(
            '[data-testid="artifacts-list"] .art-name').all_inner_texts()]
        check("artifact list shows the pipeline files",
              names == ["00_brief.md", "01_spec.md", "02_plan.md",
                        "03_plan_review.md", "04_impl_log.md",
                        "05_review_r1.md", "run-1.log"],
              ",".join(names))

        badge = dr.locator('[data-testid="status-token"]')
        check("drawer badge shows STATUS: DONE",
              badge.inner_text() == "STATUS: DONE", badge.inner_text())
        check("drawer badge names 05_review_r1.md as the source",
              "05_review_r1.md" in (badge.get_attribute("title") or ""),
              str(badge.get_attribute("title")))
        row_toks = [s.strip() for s in dr.locator(
            '[data-testid="artifacts-list"] .art-tok').all_inner_texts()]
        check("per-file token chips render", row_toks.count("DONE") == 1,
              ",".join(row_toks))

        dr.locator(".art-row", has_text="05_review_r1.md").click()
        view = dr.locator('[data-testid="artifact-view"]')
        view.wait_for(timeout=5000)
        check("artifact opens read-only content",
              "Review r1" in view.inner_text()
              and "STATUS: DONE" in view.inner_text())
        check("viewer is a pre (no markdown render)",
              view.evaluate("el => el.tagName") == "PRE")

        # ---------------- unit-call: the whole transition table ------------
        cases = page.evaluate("""() => {
          const f = window.__pipeline.proposeTransition;
          return [
            f('spec', null, 'APPROVE'),
            f('plan', null, 'APPROVE'),
            f('dev', null, 'DONE'),
            f('reviewtest', 1, 'DONE'),
            f('plan', null, 'CHANGES_REQUIRED'),
            f('dev', null, 'CHANGES_REQUIRED'),
            f('reviewtest', 2, 'CHANGES_REQUIRED'),
            f('dev', null, 'BLOCKED', 'reviewer cli missing on host'),
            f('spec', null, 'DONE'),
            f('backlog', null, 'APPROVE'),
            f('spec', null, null),
          ];
        }""")

        def kind(i):
            return cases[i].get("kind")

        check("unit: spec+APPROVE -> move plan",
              kind(0) == "move" and cases[0].get("to") == "plan",
              json.dumps(cases[0]))
        check("unit: plan+APPROVE -> move dev",
              kind(1) == "move" and cases[1].get("to") == "dev",
              json.dumps(cases[1]))
        check("unit: dev+DONE -> move reviewtest",
              kind(2) == "move" and cases[2].get("to") == "reviewtest",
              json.dumps(cases[2]))
        check("unit: reviewtest+DONE -> status agent_tested",
              kind(3) == "status" and cases[3].get("status") == "agent_tested",
              json.dumps(cases[3]))
        check("unit: plan+CHANGES_REQUIRED -> back to spec",
              kind(4) == "move" and cases[4].get("to") == "spec",
              json.dumps(cases[4]))
        check("unit: dev+CHANGES_REQUIRED -> back to plan",
              kind(5) == "move" and cases[5].get("to") == "plan",
              json.dumps(cases[5]))
        check("unit: reviewtest+CHANGES_REQUIRED -> back to dev",
              kind(6) == "move" and cases[6].get("to") == "dev",
              json.dumps(cases[6]))
        check("unit: BLOCKED -> flag with reason from the token line",
              kind(7) == "flag" and cases[7].get("flag") == "blocked"
              and cases[7].get("reason") == "reviewer cli missing on host",
              json.dumps(cases[7]))
        check("unit: spec+DONE -> none",
              kind(8) == "none", json.dumps(cases[8]))
        check("unit: backlog+APPROVE -> none",
              kind(9) == "none", json.dumps(cases[9]))
        check("unit: no token -> none",
              kind(10) == "none", json.dumps(cases[10]))

        tok = page.evaluate(
            "() => window.__pipeline.parseStatusToken("
            "'body\\nSTATUS: BLOCKED — waiting on creds\\n')")
        check("unit: parseStatusToken splits token + reason",
              tok.get("token") == "BLOCKED" and tok.get("detail") == "waiting on creds",
              json.dumps(tok))
        notok = page.evaluate(
            "() => window.__pipeline.parseStatusToken('body\\nno token here\\n')")
        check("unit: non-token last line -> null", notok is None, str(notok))

        # ---------------- Apply: reviewtest+DONE -> agent_tested -----------
        prop = dr.locator('[data-testid="transition-proposal"]')
        check("reviewtest card proposes the token transition",
              prop.count() == 1 and "agent_tested" in prop.inner_text(),
              prop.inner_text() if prop.count() else "none")
        dr.locator('[data-testid="apply-transition"]').click()
        page.wait_for_timeout(300)
        chip_txt = page.locator(
            '[data-col="reviewtest"] .board-card .status-chip').first.inner_text()
        check("Apply sets the card status to agent_tested",
              chip_txt == "agent_tested", chip_txt)

        # ---------------- Refresh re-reads the dir --------------------------
        r1 = TESTDATA / ".acp" / "cards" / "c-rt" / "05_review_r1.md"
        r1.write_text(
            "# Review r1\n\nreopened: two majors still open.\n\n"
            "STATUS: CHANGES_REQUIRED\n",
            encoding="utf-8")
        dr.locator('[data-testid="artifacts-refresh"]').click()
        page.wait_for_selector(
            '[data-testid="status-token"].tok-changes_required', timeout=8000)
        check("Refresh picks up the rewritten token",
              dr.locator('[data-testid="status-token"]').inner_text()
              == "STATUS: CHANGES_REQUIRED")
        prop2 = dr.locator('[data-testid="transition-proposal"]')
        check("CHANGES_REQUIRED proposes a step back to Dev",
              prop2.count() == 1 and "Dev" in prop2.inner_text(),
              prop2.inner_text() if prop2.count() else "none")
        dr.locator('[data-testid="apply-transition"]').click()
        page.wait_for_timeout(300)
        check("Apply moves the card back to dev",
              page.locator('[data-col="dev"] .board-card',
                           has_text="W6 reviewtest card").count() == 1)
        close_drawer(page)

        # ---------------- Apply: spec+APPROVE -> plan -----------------------
        open_card(page, "W6 spec card")
        dr = drawer(page)
        dr.locator('[data-testid="transition-proposal"]').wait_for(timeout=8000)
        dr.locator('[data-testid="apply-transition"]').click()
        page.wait_for_timeout(300)
        check("Apply moves spec card to plan",
              page.locator('[data-col="plan"] .board-card',
                           has_text="W6 spec card").count() == 1)
        close_drawer(page)

        # ---------------- Apply: BLOCKED -> flag + reason -------------------
        open_card(page, "W6 blocked card")
        dr = drawer(page)
        dr.locator('[data-testid="artifacts-list"]').wait_for(timeout=8000)
        check("blocked card badge shows BLOCKED",
              dr.locator('[data-testid="status-token"]').inner_text()
              == "STATUS: BLOCKED")
        prop3 = dr.locator('[data-testid="transition-proposal"]')
        check("BLOCKED proposes the flag with its reason",
              prop3.count() == 1
              and "blocked" in prop3.inner_text()
              and "reviewer cli missing on host" in prop3.inner_text(),
              prop3.inner_text() if prop3.count() else "none")
        dr.locator('[data-testid="apply-transition"]').click()
        page.wait_for_timeout(300)
        blocked_card = page.locator(".board-card", has_text="W6 blocked card")
        check("Apply sets the blocked flag on the card",
              blocked_card.locator(".meta-chip.flag.blocked").count() == 1)
        reason = dr.locator('[data-field="blockedReason"]').input_value()
        check("blocked reason lands in the card field",
              reason == "reviewer cli missing on host", reason)
        close_drawer(page)

        # ---------------- CHANGES_REQUIRED via UI (dev -> plan) -------------
        open_card(page, "W6 dev card")
        dr = drawer(page)
        prop4 = dr.locator('[data-testid="transition-proposal"]')
        prop4.wait_for(state="visible", timeout=8000)
        check("dev card proposes the back-step to Plan",
              "Plan" in prop4.inner_text(), prop4.inner_text())
        dr.locator('[data-testid="apply-transition"]').click()
        page.wait_for_timeout(300)
        check("Apply moves dev card back to plan",
              page.locator('[data-col="plan"] .board-card',
                           has_text="W6 dev card").count() == 1)
        close_drawer(page)

        # ---------------- empty / missing / unassigned ----------------------
        open_card(page, "W6 empty card")
        dr = drawer(page)
        dr.locator('[data-testid="artifacts-empty"]').wait_for(timeout=8000)
        check("empty dir gives a readable empty state",
              "No artifacts" in dr.locator(
                  '[data-testid="artifacts-empty"]').inner_text())
        check("empty state: no bogus badge token",
              dr.locator('[data-testid="status-token"]').inner_text()
              == "STATUS: —")
        close_drawer(page)

        open_card(page, "W6 missing-dir card")
        dr = drawer(page)
        dr.locator('[data-testid="artifacts-empty"]').wait_for(timeout=8000)
        check("missing dir also gives the empty state",
              "No artifacts" in dr.locator(
                  '[data-testid="artifacts-empty"]').inner_text())
        check("missing dir raises no error banner",
              dr.locator('[data-testid="artifacts-error"]').count() == 0)
        close_drawer(page)

        open_card(page, "W6 no-project card")
        dr = drawer(page)
        check("unassigned project shows the no-project note",
              dr.locator('[data-testid="artifacts-noproject"]').count() == 1)
        close_drawer(page)

        # ---------------- bridge stub answers write -------------------------
        wr = page.evaluate(
            "async (path) => {"
            f"  const r = await fetch('http://127.0.0.1:{AGENT_PORT}/api/fs/write', {{"
            "    method: 'POST', headers: {'Content-Type': 'application/json'},"
            "    body: JSON.stringify({path, content: 'e2e write check\\n'}),"
            "  });"
            "  return {status: r.status, body: await r.json()};"
            "}",
            f"{TESTDATA}/.acp/cards/c-spec/run-9.log",
        )
        check("bridge stub answers write", wr.get("status") == 200
              and wr.get("body", {}).get("bytes") == len("e2e write check\n"),
              json.dumps(wr))
        check("written file lands inside the worktree",
              (TESTDATA / ".acp" / "cards" / "c-spec" / "run-9.log")
              .read_text() == "e2e write check\n")

        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
