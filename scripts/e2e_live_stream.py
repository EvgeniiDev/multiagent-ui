#!/usr/bin/env python3
"""E2E: the panel must show intermediate steps while the turn is running.

Reproduces the user's report — "in the console I see intermediate results, on the
site I don't". A mock agent (playwright WS route, no bridge needed) answers the
first prompt with a `tool_call` notification and NOTHING else: no assistant text at
all. A client that attaches tool calls only to an already-existing assistant
message drops that notification, so the transcript stays empty and the turn looks
like it produced nothing.

The mock never sleeps inside its handler — a blocking sleep there stalls the
playwright driver itself, which made an earlier version of this test measure
nothing. Text arrives on a SECOND prompt instead.

Assertions:
  1. turn 1: a tool-call chip is in the transcript while NO assistant text exists
     anywhere (the pre-text window, held open indefinitely);
  2. the chip is inside an assistant message and shows title + location;
  3. the same turn's `tool_call_update` flips that chip to completed;
  4. turn 2: assistant text lands normally;
  5. the intermediate step is still visible after the text arrives;
  6. zero pageerrors.

Usage:  npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_live_stream.py
"""
import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25986
BASE = f"http://127.0.0.1:{PORT}/"
REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-web"

page_errors: list[str] = []
checks: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


# --------------------------------------------------------------------------
# Mock agent: first prompt = intermediate step only, second prompt = text
# --------------------------------------------------------------------------

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
            if not isinstance(req, dict) or "method" not in req:
                continue
            method, rid = req["method"], req.get("id")
            sid = "e2e-mock-session"
            if method == "initialize":
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": 1, "agentCapabilities": {},
                    "authMethods": [], "agentInfo": {"name": "e2e-mock", "version": "0"}}}))
            elif method == "session/new":
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": sid}}))
            elif method == "session/prompt":
                text = ""
                for block in (req.get("params", {}).get("prompt") or []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        text += block.get("text", "")
                if "TEXT" in text.upper():
                    ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                        "params": {"sessionId": sid, "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "STUB-REPLY"}}}}))
                else:
                    # the intermediate step, and deliberately nothing else
                    ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                        "params": {"sessionId": sid, "update": {
                            "sessionUpdate": "tool_call", "toolCallId": "mock-tc-1",
                            "title": "read_file", "kind": "read", "status": "pending",
                            "locations": [{"path": "/etc/hostname"}]}}}))
                    ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                        "params": {"sessionId": sid, "update": {
                            "sessionUpdate": "tool_call_update", "toolCallId": "mock-tc-1",
                            "status": "completed", "title": "read_file"}}}))
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                    "result": {"stopReason": "end_turn"}}))
            else:
                if rid is not None:
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}))
    ws.on_message(on_message)


def fs_api(route):
    body = ({"root": "/home/hermes"} if "/api/fs/root" in route.request.url else
            {"path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
             "dirs": [{"name": "projects", "path": "/home/hermes/projects"}]})
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                      "url": "ws://127.0.0.1:25990/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")


def start_server():
    for _ in range(30):
        s = socket.socket()
        # SO_REUSEADDR: a socket left in TIME_WAIT by the previous run would
        # otherwise fail this availability probe for up to a minute while the
        # real server would have bound fine.
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", PORT))
            break
        except OSError:
            time.sleep(1)
        finally:
            s.close()
    else:
        print(f"FAIL  port {PORT} busy — refusing a stale server")
        sys.exit(1)
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT),
                             "--bind", "127.0.0.1"], cwd=str(DIST),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on {PORT}")
    sys.exit(1)


TRANSCRIPT = """() => {
  const msgs = [...document.querySelectorAll('.messages .message')];
  const assistant = msgs.filter(m => m.classList.contains('message-assistant'));
  const withText = assistant.filter(m => {
    const c = m.querySelector('.message-content');
    return c && c.textContent.trim().length > 0;
  });
  const chips = [...document.querySelectorAll('.messages .tool-call-inline')].map(c => ({
    text: c.textContent.trim(),
    cls: c.className,
    inAssistant: !!c.closest('.message-assistant'),
  }));
  return {
    total: msgs.length,
    assistantWithText: withText.length,
    text: withText.map(m => m.querySelector('.message-content').textContent.trim()).join('|'),
    chips,
    loading: !!document.querySelector('.loading-indicator'),
  };
}"""


def send(page, text):
    page.fill(".composer-box textarea", text)
    page.click(".send-btn")


def run_checks():
    proc = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed(ctx)
            page = ctx.new_page()
            page.route(re.compile(r"/api/fs/"), fs_api)
            # The host state server is live on :25900 and would restore the last
            # view (and the real board) into this context — cut it off so the run
            # starts from a clean welcome screen, like the older suites do.
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))

            page.goto(BASE, wait_until="load")
            page.wait_for_selector(".new-session-btn:not([disabled])", timeout=15000)
            page.click(".new-session-btn")
            page.wait_for_selector(".composer-box textarea", timeout=15000)
            page.wait_for_timeout(400)

            # --- turn 1: an intermediate step and NO text anywhere -----------
            send(page, "инструмент, без текста")
            page.wait_for_selector(".messages .tool-call-inline", timeout=10000)
            page.wait_for_timeout(150)   # let the completion flip render
            after_step = page.evaluate(TRANSCRIPT)

            check("turn 1: tool-call chip appears in the transcript",
                  bool(after_step["chips"]),
                  json.dumps(after_step["chips"], ensure_ascii=False)[:200])
            check("turn 1: chip appears with NO assistant text anywhere",
                  after_step["assistantWithText"] == 0,
                  f"assistant messages with text: {after_step['assistantWithText']}")
            check("turn 1: chip lives inside an assistant message",
                  all(c["inAssistant"] for c in after_step["chips"]),
                  json.dumps(after_step["chips"], ensure_ascii=False)[:200])
            check("turn 1: chip carries the tool title and location",
                  any("read_file" in c["text"] and "/etc/hostname" in c["text"]
                      for c in after_step["chips"]),
                  json.dumps(after_step["chips"], ensure_ascii=False)[:200])
            check("turn 1: tool_call_update flips the chip to completed",
                  any("tool-completed" in c["cls"] for c in after_step["chips"]),
                  json.dumps([c["cls"] for c in after_step["chips"]]))

            # --- turn 2: prose arrives, the step stays visible ---------------
            send(page, "TEXT please")
            page.wait_for_function(
                "() => document.querySelector('.messages').textContent.includes('STUB-REPLY')",
                timeout=10000)
            final = page.evaluate(TRANSCRIPT)
            check("turn 2: assistant text lands", "STUB-REPLY" in final["text"],
                  final["text"][:80])
            check("turn 2: the earlier intermediate step is still shown",
                  bool(final["chips"]), json.dumps(final["chips"], ensure_ascii=False)[:200])
            check("zero pageerrors", page_errors == [], repr(page_errors[:2]))
            browser.close()
    finally:
        proc.terminate()

    passed = sum(1 for ok, _, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} assertions passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    if not DIST.is_dir():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    sys.exit(run_checks())
