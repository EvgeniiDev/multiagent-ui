#!/usr/bin/env python3
"""E2E for the W2 workstream: global project scope selector + session scoping.

Runs against the real web build served on http://127.0.0.1:25987/ and asserts:

  * clean profile — the header selector shows `All` + the auto-provisioned
    `Common` project;
  * seeded registry — `All` + Common + Alpha + Beta; the agent's session
    inventory is served by a mocked ACP websocket (`session/list`), so the
    sidebar populates through the real sync path;
  * selecting a project filters the sidebar to sessions whose cwd lies inside
    the project path (sessions fixture: two inside Alpha, one inside Beta,
    one loose inside Common's path, one outside every project);
  * `All` shows everything and marks the outside session `unassigned`;
  * the selection survives a page reload (persisted in projects.json);
  * the Projects view obeys the selector — scoped list shows only that
    project and the detail pane follows it;
  * the Projects-header "New session" dialog prefills the scoped project's
    path (empty at All);
  * `.welcome-screen` exposes the same dialog with no connection at all and
    confirming it lands on the chat view;
  * zero `pageerror` events, at 1440x900 and 390x844.

NOTE: the registry is exercised through `src/features/scope/registry.ts`,
which currently resolves to the contract-faithful stub
(`__local-projects-stub.ts`) — W1's `src/stores/projects.ts` lands separately.
The stub shares the same Pinia id and KV document shape
(`acp-ui:projects.json` = `{version, projects, activeProjectId}`), so these
assertions transfer to the real store unchanged.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_project_scope.py

Screenshots land in docs/scope-{1440x900,1024x768,390x844}.png.
Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
PORT = 25987
BASE = f"http://127.0.0.1:{PORT}/"

ALPHA_PATH = "/home/hermes/projects/alpha"
BETA_PATH = "/home/hermes/projects/beta"
COMMON_PATH = "/home/hermes/projects"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

# session/list payload the mocked agent serves — the sidebar's whole
# inventory arrives over the wire, exactly like production.
def session_infos():
    now = int(time.time() * 1000)
    def iso(ms):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))
    return [
        {"sessionId": "sess-alpha-1", "cwd": ALPHA_PATH,
         "title": "alpha one", "updatedAt": iso(now - 3600_000)},
        {"sessionId": "sess-alpha-2", "cwd": ALPHA_PATH + "/sub",
         "title": "alpha two", "updatedAt": iso(now - 2 * 3600_000)},
        {"sessionId": "sess-beta-1", "cwd": BETA_PATH,
         "title": "beta one", "updatedAt": iso(now - 3 * 3600_000)},
        # Inside Common's path but inside no narrower project -> Common's own.
        {"sessionId": "sess-loose-1", "cwd": COMMON_PATH + "/loose",
         "title": "loose work", "updatedAt": iso(now - 4 * 3600_000)},
        # Outside every registered project -> unassigned, All-mode only.
        {"sessionId": "sess-orphan-1", "cwd": "/opt/outside",
         "title": "orphan job", "updatedAt": iso(now - 5 * 3600_000)},
    ]


REGISTRY = {
    "version": 1,
    "projects": [
        {"id": "p-common", "name": "Common", "path": COMMON_PATH,
         "createdAt": 1700000000000},
        {"id": "p-alpha", "name": "Alpha", "path": ALPHA_PATH,
         "createdAt": 1700000001000},
        {"id": "p-beta", "name": "Beta", "path": BETA_PATH,
         "createdAt": 1700000002000},
    ],
    "activeProjectId": "all",
}


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
                    "agentCapabilities": {
                        "loadSession": True,
                        "sessionCapabilities": {"list": {}},
                    },
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                result = {"sessionId": "e2e-new-session"}
            elif method == "session/list":
                result = {"sessions": session_infos()}
            elif method == "session/load":
                result = {}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker."""
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    elif "/api/fs/mkdir" in route.request.url:
        body = {"path": "/home/hermes/projects", "created": True}
    else:
        body = {
            "path": "/home/hermes",
            "parent": "/home",
            "root": "/home/hermes",
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context, with_registry=True):
    """localStorage: one ws agent + telemetry off (+ the projects registry).

    Guarded (`if (!localStorage.getItem ...)`) so a reload mid-test keeps the
    app's own persisted state rather than re-seeding over it — the scope
    persistence assertion depends on that.
    """
    agents = {
        "agents": {
            "E2E Mock": {"transport": "websocket", "url": "ws://127.0.0.1:25993/"},
        }
    }
    pairs = [
        ("acp-ui:agents", agents),
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
    ]
    if with_registry:
        pairs.append(("acp-ui:projects.json", REGISTRY))
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def wire(page):
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)


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


def scope_options(page):
    return page.eval_on_selector_all(
        ".scope-select option", "els => els.map(e => e.textContent.trim())"
    )


def scope_value(page):
    return page.eval_on_selector(".scope-select", "el => el.value")


def session_titles(page):
    return sorted(
        page.eval_on_selector_all(
            ".session-row .row-title", "els => els.map(e => e.textContent.trim())"
        )
    )


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
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

        # ---------------- clean profile: All + auto-provisioned Common ------
        clean = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 1440, "height": 900})
        seed(clean, with_registry=False)
        cp = clean.new_page()
        wire(cp)
        cp.goto(BASE, wait_until="load")
        cp.wait_for_selector(".scope-select", timeout=10000)
        cp.wait_for_timeout(400)  # initProjectsStore + render
        check("clean profile: selector shows All + auto-provisioned Common",
              scope_options(cp) == ["All", "Common"], ",".join(scope_options(cp)))
        clean.close()

        # ---------------- 1440x900: seeded registry -------------------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        wire(page)
        page.on("dialog", lambda d: d.accept())

        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".scope-select", timeout=10000)
        # The sole configured agent auto-selects and its mocked session/list
        # populates the sidebar through the real sync path.
        page.wait_for_selector(".session-row", timeout=10000)

        check("selector lists All + every registered project",
              scope_options(page) == ["All", "Common", "Alpha", "Beta"],
              ",".join(scope_options(page)))
        check("All scope: sidebar shows every session",
              session_titles(page) ==
              ["alpha one", "alpha two", "beta one", "loose work", "orphan job"],
              ",".join(session_titles(page)))

        # --- filter by Alpha ---
        page.select_option(".scope-select", label="Alpha")
        page.wait_for_timeout(250)
        check("Alpha scope: only Alpha sessions in sidebar",
              session_titles(page) == ["alpha one", "alpha two"],
              ",".join(session_titles(page)))
        page.screenshot(path=str(SHOTS / "scope-1440x900.png"))

        # --- back to All: unassigned mark ---
        page.select_option(".scope-select", label="All")
        page.wait_for_timeout(250)
        orphan = page.locator(".session-row", has_text="orphan job")
        check("All scope: outside session carries 'unassigned' tag",
              orphan.locator(".row-tag").count() == 1 and
              orphan.locator(".row-tag").text_content().strip() == "unassigned")
        check("All scope: exactly one unassigned row (Common loose is assigned)",
              page.locator(".session-row .row-tag").count() == 1)

        # --- persistence across reload ---
        page.select_option(".scope-select", label="Beta")
        page.wait_for_timeout(300)
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:projects.json')).activeProjectId"
        )
        check("scope persisted into projects.json", stored == "p-beta", str(stored))
        page.reload(wait_until="load")
        page.wait_for_selector(".session-row", timeout=10000)
        check("scope survives reload", scope_value(page) == "p-beta",
              scope_value(page))
        check("reloaded Beta scope still filters sessions",
              session_titles(page) == ["beta one"],
              ",".join(session_titles(page)))
        page.select_option(".scope-select", label="All")
        page.wait_for_timeout(200)

        # --- Projects view obeys the selector ---
        page.click('.rail-btn[aria-label="Projects"]')
        page.wait_for_selector(".project-row", timeout=10000)
        names = page.eval_on_selector_all(
            ".project-row .project-name", "els => els.map(e => e.textContent.trim())"
        )
        check("Projects at All lists the registry (Common, Alpha, Beta)",
              sorted(names) == ["Alpha", "Beta", "Common"], ",".join(names))

        page.select_option(".scope-select", label="Alpha")
        page.wait_for_timeout(250)
        check("Projects scoped: list shows only Alpha",
              page.locator(".project-row").count() == 1 and
              page.locator(".project-row .project-name").inner_text() == "Alpha")
        detail = page.locator(".project-detail")
        check("Projects scoped: detail shows Alpha without a click",
              detail.count() == 1 and
              detail.locator("h3").inner_text() == "Alpha" and
              detail.locator(".detail-path").inner_text().strip() == ALPHA_PATH)
        check("Projects scoped: detail lists Alpha's two sessions",
              detail.locator(".detail-session").count() == 2,
              f"{detail.locator('.detail-session').count()} rows")

        # --- New session prefills the scoped project path ---
        page.click(".head-controls .new-session-cta")
        page.wait_for_selector(".ns-dialog", timeout=5000)
        cwd_val = page.eval_on_selector(".ns-dialog .cwd-input", "el => el.value")
        check("New session dialog prefills scoped project path",
              cwd_val == ALPHA_PATH, repr(cwd_val))
        page.click(".ns-dialog .ns-cancel")
        page.wait_for_selector(".ns-dialog", state="detached", timeout=5000)

        page.select_option(".scope-select", label="All")
        page.wait_for_timeout(200)
        page.click(".head-controls .new-session-cta")
        page.wait_for_selector(".ns-dialog", timeout=5000)
        cwd_val = page.eval_on_selector(".ns-dialog .cwd-input", "el => el.value")
        check("New session dialog at All keeps cwd empty (as before)",
              cwd_val == "", repr(cwd_val))
        page.click(".ns-dialog .ns-cancel")
        page.wait_for_selector(".ns-dialog", state="detached", timeout=5000)

        # --- welcome screen: session start without a connection ---
        page.click('.rail-btn[aria-label="Chat"]')
        page.wait_for_selector(".welcome-screen", timeout=5000)
        page.click(".welcome-new-session")
        page.wait_for_selector(".ns-dialog", timeout=5000)
        check("welcome screen offers New session with no connection", True)
        page.fill(".ns-dialog .cwd-input", ALPHA_PATH)
        page.click(".ns-dialog .ns-confirm")
        page.wait_for_selector(".chat-view", timeout=15000)
        check("welcome New session starts a session and lands on Chat", True)
        check("dialog closes after confirm",
              page.locator(".ns-dialog").count() == 0)

        # 1024x768 screenshot — same page, desktop density.
        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "scope-1024x768.png"))
        ctx.close()

        # ---------------- 390x844: phone layout -----------------------------
        phone = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 390, "height": 844})
        seed(phone)
        p2 = phone.new_page()
        wire(p2)
        p2.goto(BASE, wait_until="load")
        p2.wait_for_selector(".scope-select", timeout=10000)
        sel_h = p2.evaluate(
            "() => document.querySelector('.scope-select').getBoundingClientRect().height"
        )
        check("390: scope select is a full-height touch target",
              sel_h >= 44 - 0.6, f"{sel_h:.0f}px")

        p2.select_option(".scope-select", label="Alpha")
        p2.wait_for_timeout(250)
        # Sidebar is a drawer on narrow viewports — open it via the hamburger.
        p2.click(".mobile-hamburger")
        p2.wait_for_selector(".sidebar .session-row", timeout=10000)
        check("390: drawer session list filtered to Alpha",
              sorted(p2.eval_on_selector_all(
                  ".sidebar .session-row .row-title",
                  "els => els.map(e => e.textContent.trim())")) ==
              ["alpha one", "alpha two"])
        p2.screenshot(path=str(SHOTS / "scope-390x844.png"))
        p2.mouse.click(370, 400)  # dismiss via the backdrop
        p2.wait_for_timeout(300)

        # Scoped Projects view on the phone: one row + inline detail.
        p2.click('.rail-btn[aria-label="Projects"]')
        p2.wait_for_selector(".project-row", timeout=10000)
        check("390: Projects scoped to Alpha shows one row",
              p2.locator(".project-row").count() == 1)
        check("390: inline detail mounts under the scoped row",
              p2.locator(".project-inline-detail .project-detail").count() == 1)
        phone.close()

        browser.close()


if __name__ == "__main__":
    main()
