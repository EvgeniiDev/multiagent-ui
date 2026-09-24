#!/usr/bin/env python3
"""E2E for the Projects-view UX fixes (cc/ux workstream).

Defect A — a clicked project row used to mount .project-detail as the LAST
child of the scrolling list, so on any list longer than the viewport the
click produced no visible change. This suite seeds 26 synthetic sessions with
distinct `cwd` values into the sessions KV document so the list is long
without needing a live agent, then asserts:

  * 1440x900 — clicking row 20 renders the detail pane INSIDE the viewport
    (bounding_box().y < window.innerHeight) showing that project's path;
  * 390x844  — the same click inlines the detail immediately after the
    clicked row in DOM order (previousElementSibling) and scrolled into view;
  * the selected row carries .open + aria-current="true";
  * "New session" works with NO project selected (Projects header) and the
    same control exists in the Chat view header — the ACP handshake is
    answered by a mocked WebSocket (page.route_web_socket);
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_projects_ux.py

The script serves dist-web itself on http://127.0.0.1:25989/ and writes
docs/ux-projects-{1440x900,1024x768,390x844}.png + docs/ux-newsession-1440x900.png.
Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
PORT = 25989
BASE = f"http://127.0.0.1:{PORT}/"
N_PROJECTS = 26
CLICK_INDEX = 19  # row 20 of 26 — comfortably below the fold

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API (same technique as
# e2e_white_text.py — proven against this build).
# --------------------------------------------------------------------------

def acp_ws(ws):
    """Answer the app's ACP JSON-RPC as a minimal agent (no real server)."""
    def on_message(message):
        for line in str(message).split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                continue
            if not isinstance(req, dict) or "method" not in req or req.get("id") is None:
                continue  # notification (e.g. $/ping heartbeat)
            method = req["method"]
            if method == "initialize":
                result = {
                    "protocolVersion": 1,
                    "agentCapabilities": {},
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                result = {"sessionId": "e2e-mock-session"}
            elif method in ("session/list", "session/load"):
                result = {"sessions": []}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker."""
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    else:
        body = {
            "path": "/home/hermes",
            "parent": "/home",
            "root": "/home/hermes",
            "dirs": [{"name": "acp-ui-cc-ux", "path": "/home/hermes/acp-ui-cc-ux"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    """localStorage: two ws agents, telemetry off, a projects REGISTRY of
    N_PROJECTS entries plus a matching session each (the Projects view lists
    registered projects; sessions attach by longest-prefix cwd ownership)
    so the list is longer than any viewport.

    Guarded (`if (!localStorage.getItem ...)`) so a reload mid-test keeps the
    app's own persisted state rather than re-seeding over it.
    """
    agents = {
        "agents": {
            "E2E Mock": {"transport": "websocket", "url": "ws://127.0.0.1:25993/"},
            "E2E Mock B": {"transport": "websocket", "url": "ws://127.0.0.1:25994/"},
        }
    }
    prefs = {"telemetryEnabled": False}
    now = int(time.time() * 1000)
    registry = {
        "version": 1,
        "projects": [
            {
                "id": f"proj-{i:02d}",
                "name": f"proj-{i:02d}",
                "path": f"/home/hermes/projects/proj-{i:02d}",
                "createdAt": now - i * 60_000,
            }
            for i in range(N_PROJECTS)
        ],
        "activeProjectId": "all",
    }
    sessions = {
        "sessions": [
            {
                "id": f"saved-{i:02d}",
                "agentName": "E2E Mock" if i % 2 == 0 else "E2E Mock B",
                "sessionId": f"sess-e2e-{i:02d}",
                "title": f"session in proj-{i:02d}",
                "lastUpdated": now - i * 3600_000,
                "cwd": f"/home/hermes/projects/proj-{i:02d}",
                "supportsLoadSession": True,
                "origin": "agent",
            }
            for i in range(N_PROJECTS)
        ]
    }
    for key, val in (
        ("acp-ui:agents", agents),
        ("acp-ui:preferences.json", prefs),
        ("acp-ui:projects.json", registry),
        ("acp-ui:sessions.json", sessions),
    ):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def goto_projects(page):
    page.click('.rail-btn[aria-label="Projects"]')
    page.wait_for_selector(".project-row", timeout=10000)


def detail_box(page):
    """Bounding box of .project-detail relative to the viewport."""
    return page.evaluate(
        """() => {
          const el = document.querySelector('.project-detail');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { y: r.y, h: r.height, vh: window.innerHeight };
        }"""
    )


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        run_checks()
    finally:
        stop(server)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---------------- 1440x900: two-pane layout ----------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.route(re.compile(r"/api/fs/"), fs_api)
        page.route(re.compile(r":25900/"), lambda r: r.abort())
        page.route_web_socket(re.compile(r"^wss?://"), acp_ws)

        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)

        # The seed survives a reload (guarded init script), the list stays long.
        page.reload(wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)
        goto_projects(page)

        rows = page.locator(".project-row")
        check("seeded long project list", rows.count() >= 25, f"{rows.count()} rows")

        # --- Defect B, entry point 1: Projects header "New session" with NO
        # project selected yet (nothing has been clicked). ---
        page.click(".head-controls .new-session-cta")
        page.wait_for_selector(".ns-dialog", timeout=5000)
        check("Projects header New session opens dialog (no project selected)", True)
        agent_opts = page.eval_on_selector_all(
            "#ns-agent option", "els => els.map(e => e.value)"
        )
        check("dialog offers the configured agents",
              "E2E Mock" in agent_opts and "E2E Mock B" in agent_opts,
              ",".join(agent_opts))
        page.screenshot(path=str(SHOTS / "ux-newsession-1440x900.png"))

        # Confirm with an explicit cwd -> createSession -> Chat view.
        page.fill(".ns-dialog .cwd-input", "/home/hermes/projects/proj-00")
        page.click(".ns-dialog .ns-confirm")
        page.wait_for_selector(".chat-view", timeout=15000)
        check("dialog confirm creates session and lands on Chat", True)
        check("dialog closes after confirm",
              page.locator(".ns-dialog").count() == 0)

        # --- Defect B, entry point 2: persistent Chat-header control. ---
        check("chat header has a New session control",
              page.locator(".chat-header .chat-new-session").count() == 1)
        page.click(".chat-header .chat-new-session")
        page.wait_for_selector(".ns-dialog", timeout=5000)
        check("chat header control opens the same dialog", True)
        page.click(".ns-dialog .ns-cancel")
        page.wait_for_selector(".ns-dialog", state="detached", timeout=5000)

        # --- Defect A: click a row far down the list. ---
        goto_projects(page)
        row = page.locator(".project-row").nth(CLICK_INDEX)
        clicked_path = row.locator(".project-path").inner_text().strip()
        row.click()
        page.wait_for_selector(".project-detail", timeout=5000)

        box = detail_box(page)
        check("1440: detail pane inside viewport after click",
              box is not None and 0 <= box["y"] < box["vh"],
              f"y={box and round(box['y'])} vh={box and box['vh']}")
        detail_path = page.locator(".project-detail .detail-path").inner_text().strip()
        check("1440: detail shows the clicked project's path",
              detail_path == clicked_path, f"{detail_path!r} vs {clicked_path!r}")

        open_row = page.locator(".project-row.open")
        check("selected row carries .open", open_row.count() == 1)
        check("selected row has aria-current='true'",
              open_row.get_attribute("aria-current") == "true")
        sel_style = page.evaluate(
            """() => { const el = document.querySelector('.project-row.open');
                      const cs = getComputedStyle(el);
                      return { bg: cs.backgroundColor, shadow: cs.boxShadow }; }"""
        )
        check("selected row is unmistakable (tint bg + accent bar)",
              sel_style["bg"] != "rgba(0, 0, 0, 0)" and "inset" in sel_style["shadow"],
              f"bg={sel_style['bg']} shadow={sel_style['shadow'][:60]}")

        page.screenshot(path=str(SHOTS / "ux-projects-1440x900.png"))

        # ---------------- 1024x768: still two-pane ----------------
        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(300)
        box = detail_box(page)
        check("1024: detail pane still inside viewport",
              box is not None and 0 <= box["y"] < box["vh"],
              f"y={box and round(box['y'])} vh={box and box['vh']}")
        page.screenshot(path=str(SHOTS / "ux-projects-1024x768.png"))
        ctx.close()

        # ---------------- 390x844: inline detail under the row ----------------
        phone = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 390, "height": 844})
        seed(phone)
        p2 = phone.new_page()
        p2.on("pageerror", lambda exc: page_errors.append(str(exc)))
        p2.route(re.compile(r"/api/fs/"), fs_api)
        p2.route(re.compile(r":25900/"), lambda r: r.abort())
        p2.route_web_socket(re.compile(r"^wss?://"), acp_ws)
        p2.goto(BASE, wait_until="load")
        p2.wait_for_selector(".view-rail", timeout=10000)
        goto_projects(p2)

        row = p2.locator(".project-row").nth(CLICK_INDEX)
        clicked_path_phone = row.locator(".project-name").inner_text().strip()
        row.click()
        p2.wait_for_selector(".project-inline-detail .project-detail", timeout=5000)

        # DOM order: the detail's <li> is the clicked row's next sibling.
        rel = p2.evaluate(
            """(idx) => {
              const rows = document.querySelectorAll('ul.project-list > li.project-row');
              const clicked = rows[idx];
              const detailLi = document.querySelector('li.project-inline-detail');
              if (!clicked || !detailLi) return { found: false };
              return {
                found: true,
                nextIsDetail: clicked.nextElementSibling === detailLi,
                follows: !!(clicked.compareDocumentPosition(detailLi)
                            & Node.DOCUMENT_POSITION_FOLLOWING),
              };
            }""",
            CLICK_INDEX,
        )
        check("390: detail rendered immediately after the clicked row",
              rel.get("found") and rel["nextIsDetail"] and rel["follows"],
              str(rel))

        box = detail_box(p2)
        check("390: inline detail inside viewport after scrollIntoView",
              box is not None and 0 <= box["y"] < box["vh"],
              f"y={box and round(box['y'])} vh={box and box['vh']}")
        detail_name = p2.locator(".project-detail h3").inner_text().strip()
        check("390: inline detail shows the clicked project",
              detail_name == clicked_path_phone,
              f"{detail_name!r} vs {clicked_path_phone!r}")
        check("390: exactly one .project-detail in DOM",
              p2.locator(".project-detail").count() == 1)
        check("390: selected row still marked",
              p2.locator(".project-row.open[aria-current='true']").count() == 1)
        p2.screenshot(path=str(SHOTS / "ux-projects-390x844.png"))
        phone.close()

        browser.close()


if __name__ == "__main__":
    main()
