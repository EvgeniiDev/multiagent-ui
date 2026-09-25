#!/usr/bin/env python3
"""E2E for session restore across a page reload (F5).

The bug: F5 dropped the user to the welcome screen — `sessions.json` kept
the session list, but the *pointer* to the open session (`currentSession`)
lived only in memory, so after reload nothing reconnected.

Serves dist-web on http://127.0.0.1:25987/ and stubs the ACP websocket: the
mock answers `initialize` (with `loadSession: True`), `session/new`, and
`session/load` for a known session id by replaying one user + one assistant
turn, so the test can prove the transcript comes back too.

Asserts:
  * connect to a session, reload -> the chat view is back (`.input-row`),
    not the welcome screen; the agent selector still shows the agent;
  * the replayed transcript is visible (the assistant's text);
  * explicit Disconnect, reload -> the welcome screen stays (no zombie
    auto-resume of a session the user closed);
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_session_restore.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
PORT = 25987
BASE = f"http://127.0.0.1:{PORT}/"

SID = "e2e-restore-session"
AGENT_NAME = "E2E Mock"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def chunk(session_id, kind, content):
    return json.dumps({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": session_id,
                   "update": {"sessionUpdate": kind, "content": content}},
    })


def acp_ws(ws):
    """Mock agent: handshake + new/load + one replayed history."""
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
                continue
            method = req["method"]
            if method == "initialize":
                result = {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": True},
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                result = {"sessionId": SID}
            elif method in ("session/list",):
                result = {"sessions": []}
            elif method == "session/load":
                for n in (
                    chunk(SID, "user_message_chunk",
                          {"type": "text", "text": "remember me"}),
                    chunk(SID, "agent_message_chunk",
                          {"type": "text", "text": "RESTORED-HISTORY-MARKER"}),
                ):
                    ws.send(n)
                result = {}
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
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    """localStorage: one ws agent + telemetry off + a cwd for New session."""
    agents = {"agents": {AGENT_NAME: {"transport": "websocket",
                                     "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def wire(page, tag):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        wire(page, "restore")
        page.goto(BASE, wait_until="load")

        # Fresh boot shows the welcome screen (nothing to restore yet).
        page.wait_for_selector(".welcome-screen", timeout=10000)
        check("fresh boot shows the welcome screen", True)

        # Connect a session like a user would.
        page.wait_for_selector(".new-session-btn:not([disabled])", timeout=10000)
        page.click(".new-session-btn")
        page.wait_for_selector(".input-row", timeout=15000)
        check("session connects before reload", True)

        # F5: the chat must come back by itself, with the replayed history.
        page.reload(wait_until="load")
        page.wait_for_selector(".input-row", timeout=15000)
        check("reload restores the chat view, not the welcome screen",
              page.locator(".welcome-screen").count() == 0)
        agent = page.eval_on_selector("#agent-select", "el => el.value")
        check("agent selection survives the reload",
              agent == AGENT_NAME, repr(agent))
        page.wait_for_function(
            "() => document.body.textContent.includes('RESTORED-HISTORY-MARKER')",
            timeout=10000,
        )
        check("replayed transcript visible after reload", True)
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:sessions.json') || '{}')")
        check("open-session pointer persisted",
              stored.get("currentSessionId") is not None,
              repr(stored.get("currentSessionId")))

        # Explicit Disconnect must NOT auto-resume on the next reload.
        page.click(".disconnect-btn")
        page.wait_for_selector(".welcome-screen", timeout=10000)
        page.reload(wait_until="load")
        page.wait_for_selector(".welcome-screen", timeout=10000)
        check("disconnect + reload stays on the welcome screen",
              page.locator(".input-row").count() == 0)
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:sessions.json') || '{}')")
        check("disconnect clears the persisted pointer",
              stored.get("currentSessionId") in (None, ""),
              repr(stored.get("currentSessionId")))

        ctx.close()
        browser.close()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
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


if __name__ == "__main__":
    main()
