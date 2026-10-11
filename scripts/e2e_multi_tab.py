#!/usr/bin/env python3
"""E2E for multi-session tabs — the IDE-style tab strip over live sessions.

Serves dist-web and stubs the ACP websocket, like e2e_session_restore —
but with TWO agents configured, so tabs from different agents coexist.

The mock knows two loadable sessions on agent A (Alpha/Bravo)
# and one on agent B (Delta) plus a fresh
`session/new` per agent, and can push frames to a specific session's socket
later (`send_to`) — that's how background streaming and a background
permission request are driven.

Asserts:
  * opening two sessions puts two tabs on the strip; the inactive one is
    hidden but still mounted;
  * a background session/update keeps streaming into its (hidden) chat and
    marks the tab with the unread dot;
  * a background session/request_permission raises the "!" badge on THAT
    tab only — the dialog stays down until the tab is focused;
  * clicking a sidebar row for an already-open session focuses its tab
    instead of opening a duplicate;
  * a dropped transport turns the tab "disconnected"; clicking it
    reconnects and replays the session;
  * reload restores EVERY open tab (across agents), not just the active one;
  * closing all tabs lands on the welcome screen;
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_multi_tab.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
BASE = "http://127.0.0.1:25992/"

AGENT_A = "E2E Mock"
AGENT_B = "E2E Mock Two"

SID_NEW = "e2e-tab-new"      # `session/new` result (whichever agent asked)
SID_A = "e2e-tab-alpha"      # agent A's inventory
SID_B = "e2e-tab-bravo"      # agent A's inventory
SID_B2 = "e2e-tab-delta"     # agent B's inventory (distinct: per-agent socket)

MARK_NEW = "MARKER-NEW-SESSION"
MARK_ALPHA = "MARKER-ALPHA"
MARK_DELTA = "MARKER-DELTA"
BG_TEXT = "BG-STREAM-MARKER"
PERM_TITLE = "Run background tool"

results = []
page_errors = []

# sessionId -> ws socket that claimed it (via session/new or session/load).
claimed = {}


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def chunk(session_id, kind, content):
    return json.dumps({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": session_id,
                   "update": {"sessionUpdate": kind, "content": content}},
    })


def history(sid, tag, last_text):
    """A short user+assistant history; the last assistant text is the marker."""
    return [
        chunk(sid, "user_message_chunk",
              {"type": "text", "text": f"hello ({tag})"}),
        chunk(sid, "agent_message_chunk", {"type": "text", "text": last_text}),
    ]


def send_to(sid, obj):
    """Push a frame to the socket that claimed `sid`. Returns success."""
    ws = claimed.get(sid)
    if not ws:
        return False
    try:
        ws.send(json.dumps(obj) if isinstance(obj, dict) else obj)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"NOTE  send_to {sid} failed: {e}")
        return False


def acp_ws(ws):
    """Mock agent: handshake + new/list + short replays + prompt."""
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
                    "agentCapabilities": {
                        "loadSession": True,
                        "sessionCapabilities": {"list": {}},
                    },
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                claimed[SID_NEW] = ws
                result = {"sessionId": SID_NEW}
            elif method == "session/list":
                # Per-agent inventories — the socket's URL tells the agents
                # apart, so a SID claimed once stays unambiguous.
                is_b = str(getattr(ws, "url", "")).endswith(":25999/")
                stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                sessions = (
                    [{"sessionId": SID_B2, "title": "Delta",
                      "cwd": "/home/hermes/projects", "updatedAt": stamp}]
                    if is_b else
                    [{"sessionId": SID_A, "title": "Alpha",
                      "cwd": "/home/hermes/projects", "updatedAt": stamp},
                     {"sessionId": SID_B, "title": "Bravo",
                      "cwd": "/home/hermes/projects", "updatedAt": stamp}]
                )
                result = {"sessions": sessions}
            elif method == "session/load":
                sid = (req.get("params") or {}).get("sessionId")
                claimed[sid] = ws
                marker = {SID_A: MARK_ALPHA, SID_B2: MARK_DELTA,
                          SID_NEW: MARK_NEW}.get(sid, f"MARKER-{sid}")
                for note in history(sid, sid, marker):
                    ws.send(note)
                result = {}
            elif method == "session/prompt":
                sid = (req.get("params") or {}).get("sessionId") or SID_A
                ws.send(chunk(sid, "agent_message_chunk",
                              {"type": "text", "text": "PONG"}))
                result = {"stopReason": "end_turn"}
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
            "path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    """localStorage: two ws agents + telemetry off + a cwd for New session."""
    agents = {"agents": {
        AGENT_A: {"transport": "websocket", "url": "ws://127.0.0.1:25993/"},
        AGENT_B: {"transport": "websocket", "url": "ws://127.0.0.1:25999/"},
    }}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def poll_eval(page, expr, timeout=30.0, interval=0.15):
    """Evaluate `expr` until truthy (driver-side polling: replay renders
    saturate the main thread, so rAF-driven wait_for_function starves)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr):
            return True
        page.wait_for_timeout(int(interval * 1000))
    return page.evaluate(expr)


def tab_count(page):
    return page.locator(".tab").count()


def click_session(page, title):
    page.locator(".session-row", has_text=title).first.click()


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        page.route(re.compile(r"/api/fs/"), fs_api)
        # No state server in this harness — without the abort the probe
        # would reach a real one on this host and the panel would read (and
        # mirror-write) ITS sessions doc instead of the seeded localStorage.
        page.route(re.compile(r":25900/"), lambda r: r.abort())
        page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
        page.on("pageerror", lambda exc: page_errors.append(exc))
        server = None
        try:
            server, base = serve_web(25992, DIST)
            page.goto(base, wait_until="load")

            # --- Two tabs on agent A -------------------------------------
            page.wait_for_selector(".tab-new:not([disabled])", timeout=10000)
            page.click(".tab-new")
            page.wait_for_selector("#nsm-agent", timeout=5000)
            page.select_option("#nsm-agent", AGENT_A)
            page.click(".nsm-start")
            page.wait_for_selector(".input-row:visible", timeout=15000)
            check("first tab opens a fresh session", tab_count(page) == 1,
                  f"tabs={tab_count(page)}")

            page.wait_for_selector(".session-row", timeout=10000)
            click_session(page, "Alpha")
            page.wait_for_function(
                "() => document.body.textContent.includes('%s')" % MARK_ALPHA,
                timeout=15000)
            check("two sessions live in two tabs", tab_count(page) == 2,
                  f"tabs={tab_count(page)}")
            check("the opened session became the active tab",
                  page.locator(".tab.active").inner_text().find("Alpha") >= 0,
                  page.locator(".tab.active").inner_text())

            # --- A third tab on a DIFFERENT agent -------------------------
            # The sidebar lists all agents merged — a refresh pulls every
            # agent's inventory, which is how agent B's Delta row arrives.
            page.click(".list-refresh")
            click_session(page, "Delta")
            page.wait_for_function(
                "() => document.body.textContent.includes('%s')" % MARK_DELTA,
                timeout=15000)
            check("a third tab on another agent", tab_count(page) == 3,
                  f"tabs={tab_count(page)}")
            check("multi-agent strip shows the agent suffix",
                  page.locator(".tab .tab-agent").count() == 3,
                  f"{page.locator('.tab .tab-agent').count()} suffixes")

            # --- Background streaming + unread dot -------------------------
            # The Alpha tab (agent A) is backgrounded; push a chunk on ITS
            # socket — it must append into the hidden chat and light the dot.
            active_title = page.locator(".tab.active").inner_text()
            ok = send_to(SID_A, json.loads(
                chunk(SID_A, "agent_message_chunk",
                      {"type": "text", "text": BG_TEXT})))
            check("background chunk delivered to its socket", ok)
            poll_eval(page,
                      "document.body.textContent.includes('%s')" % BG_TEXT,
                      timeout=10.0)
            page.wait_for_timeout(200)
            bg_tab = page.locator(".tab", has_text="Alpha").first
            check("background streaming lands in the hidden transcript",
                  page.evaluate(
                      "document.body.textContent.includes('%s')" % BG_TEXT))
            check("unread dot on the background tab",
                  bg_tab.locator(".tab-dot").count() == 1,
                  f"dots={bg_tab.locator('.tab-dot').count()}")
            check("active tab got no unread dot",
                  page.locator(".tab.active .tab-dot").count() == 0)

            # --- Permission on a BACKGROUND tab ----------------------------
            # The "!" badge lands on the owning tab; the dialog itself only
            # appears when that tab is focused (it's the active runtime's
            # modal), so a background request must not yank focus.
            send_to(SID_A, {
                "jsonrpc": "2.0", "id": 9100,
                "method": "session/request_permission",
                "params": {
                    "sessionId": SID_A,
                    "toolCall": {"toolCallId": "tc-bg", "title": PERM_TITLE,
                                 "kind": "execute", "status": "pending"},
                    "options": [
                        {"optionId": "allow-bg", "name": "Allow once",
                         "kind": "allow_once"},
                        {"optionId": "reject-bg", "name": "Reject",
                         "kind": "reject_once"},
                    ]}})
            page.wait_for_timeout(300)
            check("'!' permission badge on the background tab",
                  bg_tab.locator(".tab-badge.perm").count() == 1,
                  f"badges={bg_tab.locator('.tab-badge.perm').count()}")
            check("permission dialog stays down while another tab is active",
                  page.locator(".permission-dialog").count() == 0)
            check("focus stayed on the Delta tab",
                  "Delta" in page.locator(".tab.active").inner_text(),
                  page.locator(".tab.active").inner_text())

            bg_tab.click()
            page.wait_for_selector(".permission-dialog", timeout=10000)
            check("focusing the tab surfaces its permission dialog", True)
            page.locator(".permission-dialog .option-allow").first.click()
            page.wait_for_timeout(300)
            check("answering the dialog clears it and the badge",
                  page.locator(".permission-dialog").count() == 0
                  and bg_tab.locator(".tab-badge.perm").count() == 0)

            # --- Sidebar click on an open session focuses, no dup ----------
            # The merged list always shows agent A's rows — click Alpha.
            click_session(page, "Alpha")
            page.wait_for_timeout(300)
            check("clicking an open session keeps a single tab",
                  tab_count(page) == 3, f"tabs={tab_count(page)}")
            check("clicking an open session focuses its tab",
                  "Alpha" in page.locator(".tab.active").inner_text(),
                  page.locator(".tab.active").inner_text())

            # --- Dropped transport -> click the tab to reconnect -----------
            # Closing the routed socket server-side is the honest drop: the
            # page's WebSocket goes through onclose -> the runtime flags the
            # tab disconnected. Clicking it must resume the session.
            ws_alpha = claimed.get(SID_A)
            if ws_alpha is not None:
                try:
                    ws_alpha.close()
                except Exception as e:  # noqa: BLE001
                    print(f"NOTE  closing alpha socket: {e}")
            page.wait_for_timeout(500)
            dead = page.locator(".tab", has_text="Alpha").first
            check("dropped socket marks the tab disconnected",
                  dead.evaluate("el => el.classList.contains('disconnected')"),
                  dead.get_attribute("class"))
            dead.click()
            poll_eval(page,
                      "(() => { const t = [...document.querySelectorAll('.tab')]"
                      ".find(e => e.textContent.includes('Alpha'));"
                      "  return t && !t.classList.contains('disconnected'); })()",
                      timeout=20.0)
            check("clicking the dead tab reconnects it",
                  page.evaluate(
                      "(() => { const t = [...document.querySelectorAll('.tab')]"
                      ".find(e => e.textContent.includes('Alpha'));"
                      "  return t && !t.classList.contains('disconnected'); })()"))

            # --- Reload restores EVERY tab ---------------------------------
            active_before = page.locator(".tab.active").inner_text()
            page.reload(wait_until="load")
            page.wait_for_selector(".tab", timeout=15000)
            page.wait_for_function(
                "() => document.querySelectorAll('.tab').length === 3",
                timeout=15000)
            check("reload restores all three tabs", tab_count(page) == 3,
                  f"tabs={tab_count(page)}")
            poll_eval(page,
                      "(() => { const f = [...document.querySelectorAll("
                      "'.messages-container')].find(e => e.offsetParent !== null);"
                      "  return f && f.textContent.trim().length > 0; })()",
                      timeout=20.0)
            check("the restored active tab replayed its transcript",
                  page.evaluate(
                      "document.body.textContent.includes('%s') || "
                      "document.body.textContent.includes('%s') || "
                      "document.body.textContent.includes('%s')"
                      % (MARK_ALPHA, MARK_DELTA, MARK_NEW)))

            # --- Closing everything lands on the welcome screen ------------
            for _ in range(10):
                if tab_count(page) == 0:
                    break
                page.locator(".tab").first.hover()
                page.locator(".tab .tab-close").first.click()
                page.wait_for_timeout(250)
            page.wait_for_selector(".welcome-screen", timeout=10000)
            check("closing every tab lands on the welcome screen",
                  tab_count(page) == 0)

            check("zero pageerror events", len(page_errors) == 0,
                  "; ".join(str(e) for e in page_errors[:2]))
        finally:
            browser.close()
            if server:
                stop(server)

    failed = [n for n, ok, *_ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    sys.exit(1 if failed else 0)


def main():
    run_checks()


if __name__ == "__main__":
    main()
