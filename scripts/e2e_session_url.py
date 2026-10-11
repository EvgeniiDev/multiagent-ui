#!/usr/bin/env python3
"""E2E: the open session lives in the URL (?s=<agent>::<sessionId>).

Owner's ask, verbatim: "давай просто в урл писать id сессии и все".

Asserts on the real bundle + mock agent:
  * clicking a sidebar session writes `?s=<agent>::<sessionId>` (replaceState,
    no reload) BEFORE the resume completes;
  * when the resume FAILS (the mock refuses session/load with the
    already-open error), the URL STILL carries the clicked session;
  * reloading with `?s=...` in the address bar restores THAT chat (the mock
    replays a per-session marker), regardless of the stored pointer;
  * closing the open session (the session list's "+") clears `?s` from the URL;
  * zero pageerror events.
"""
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path.home() / "projects/acp-ui" / "scripts"))
from _e2e_harness import serve_web, stop  # noqa: E402

DIST = Path.home() / "projects/acp-ui" / "dist-web"
PORT = 25994
SID_A = "e2e-url-A"
SID_LOCKED = "e2e-url-locked"
AGENT_NAME = "E2E Mock"


def chunk(sid, kind, content):
    return json.dumps({"jsonrpc": "2.0", "method": "session/update",
                       "params": {"sessionId": sid,
                                  "update": {"sessionUpdate": kind, "content": content}}})


def acp_ws(ws):
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
            m = req["method"]
            if m == "initialize":
                result = {"protocolVersion": 1,
                          "agentCapabilities": {"loadSession": True,
                                                "sessionCapabilities": {"list": {}}},
                          "authMethods": [],
                          "agentInfo": {"name": "e2e-mock", "version": "0"}}
            elif m == "session/new":
                result = {"sessionId": SID_A}
            elif m == "session/list":
                now = int(time.time() * 1000)
                result = {"sessions": [
                    {"sessionId": SID_A, "cwd": "/home/hermes/projects",
                     "title": "URL session A", "updatedAt": now},
                    {"sessionId": SID_LOCKED, "cwd": "/home/hermes/projects",
                     "title": "Locked session (held elsewhere)", "updatedAt": now - 1000},
                ]}
            elif m == "session/load":
                sid = req["params"]["sessionId"]
                if sid == SID_LOCKED:
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"],
                                        "error": {"code": -32001,
                                                  "message": "session already open in another process (pid 1234)"}}))
                    return
                ws.send(chunk(sid, "user_message_chunk", {"type": "text", "text": "url probe question"}))
                ws.send(chunk(sid, "agent_message_chunk",
                              {"type": "text", "text": f"MARKER-{sid}"}))
                result = {}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    body = ({"root": "/home/hermes"} if "/api/fs/root" in route.request.url else
            {"path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
             "dirs": [{"name": "projects", "path": "/home/hermes/projects"}]})
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    agents = {"agents": {AGENT_NAME: {"transport": "websocket", "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")


def url_key(page):
    return page.evaluate("() => new URL(location.href).searchParams.get('s')")


def main():
    results = []

    def check(name, ok, extra=""):
        results.append((name, bool(ok)))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))

    server, base = serve_web(PORT, DIST)
    page_errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed(ctx)
            page = ctx.new_page()
            page.route(re.compile(r"/api/fs/"), fs_api)
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.goto(base, wait_until="load")
            page.wait_for_selector(".tab-new:not([disabled])", timeout=10000)
            page.click(".tab-new")
            page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
            page.click(".nsm-start")
            page.wait_for_selector(".input-row", timeout=15000)
            page.wait_for_selector(".session-row", timeout=10000)

            # 1. Click a sidebar session -> URL carries it.
            page.locator(".session-row", has_text="URL session A").first.click()
            page.wait_for_function(
                f"() => new URL(location.href).searchParams.get('s') === {json.dumps(f'{AGENT_NAME}::{SID_A}')}",
                timeout=10000)
            check("click writes ?s=<agent>::<sessionId>", True)
            check("the key is the sessionKey format",
                  url_key(page) == f"{AGENT_NAME}::{SID_A}", url_key(page))

            # 2. Click the LOCKED session -> resume fails, URL still flips.
            page.locator(".session-row", has_text="Locked session").first.click()
            page.wait_for_function(
                f"() => new URL(location.href).searchParams.get('s') === {json.dumps(f'{AGENT_NAME}::{SID_LOCKED}')}",
                timeout=10000)
            check("locked resume: URL still carries the clicked session",
                  url_key(page) == f"{AGENT_NAME}::{SID_LOCKED}", url_key(page))

            # 3. Reload with ?s=<locked> -> the URL keeps the user's choice even
            #    though the load is refused; the chat cannot come back (the agent
            #    holds it). With tabs, the failed tab stays open (its error is
            #    the retry surface — click the tab to reconnect) instead of
            #    dropping to the welcome screen — ?s STILL names the session.
            page.reload(wait_until="load")
            page.wait_for_selector(".error-banner", timeout=15000)
            check("locked reload: tab stays open with the lock error",
                  page.locator(".error-banner").count() == 1)
            check("locked reload: ?s still names the clicked session",
                  url_key(page) == f"{AGENT_NAME}::{SID_LOCKED}", url_key(page))

            # 4. Reload with a GOOD session in ?s -> its transcript replays.
            good = urllib.parse.quote(f"{AGENT_NAME}::{SID_A}")
            page.goto(f"{base}?s={good}", wait_until="load")
            page.wait_for_selector(".input-row", timeout=15000)
            page.wait_for_function(
                "() => document.body.textContent.includes('MARKER-e2e-url-A')", timeout=15000)
            check("reload with ?s=<good> replays THAT session's transcript", True)

            # 5. Closing every tab clears ?s. The Disconnect button is gone —
            #    under tabs the manual close is the strip's "×"; each close
            #    focuses a neighbour (the URL follows it), and the last tab
            #    clears the param entirely.
            for _ in range(10):
                if page.locator(".tab").count() == 0:
                    break
                page.locator(".tab").first.hover()
                page.locator(".tab .tab-close").first.click()
                page.wait_for_timeout(200)
            page.wait_for_function(
                "() => !new URL(location.href).searchParams.get('s')", timeout=15000)
            check("closing every tab clears ?s from the URL",
                  url_key(page) is None, repr(url_key(page)))
            page.wait_for_selector(".welcome-screen", timeout=10000)
            check("all tabs closed lands on the welcome screen", True)

            check("zero pageerror events", len(page_errors) == 0,
                  "; ".join(page_errors[:2]))
            ctx.close()
            browser.close()
    finally:
        stop(server)

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
