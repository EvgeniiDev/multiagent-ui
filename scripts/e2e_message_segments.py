#!/usr/bin/env python3
"""E2E: assistant parts keep their arrival order — no glued narration.

Reproduces the user's report — narration blocks sent between tool calls were
concatenated into one markdown blob with zero separator ("env.Заодно"), and
the tool chips always rendered above all the text regardless of where they
actually ran.

The mock agent answers the prompt with:
  text "First block." → tool_call (pending→completed) → text "Second block."
  → plan update → text "Third block."

Assertions:
  1. the assistant message's .message-parts holds FIVE ordered children:
     text, chip, text, plan card, text — not one blob;
  2. the first text part does NOT contain the second block (no gluing);
  3. the chip sits between the two text parts, not above both;
  4. the plan card renders its entry with a status glyph;
  5. zero pageerrors.

Usage:  npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_message_segments.py
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

PORT = 25987
REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-web"

page_errors: list[str] = []
checks: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


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
                def upd(update):
                    ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                                        "params": {"sessionId": sid, "update": update}}))
                # Note: no trailing whitespace — the glue reproduced exactly
                # when a post-tool block started mid-sentence-tight like this.
                upd({"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "text", "text": "First block."}})
                upd({"sessionUpdate": "tool_call", "toolCallId": "mock-tc-1",
                     "title": "run ls", "kind": "execute", "status": "pending"})
                upd({"sessionUpdate": "tool_call_update", "toolCallId": "mock-tc-1",
                     "status": "completed"})
                upd({"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "text", "text": "Second block."}})
                upd({"sessionUpdate": "plan", "entries": [
                    {"content": "ship the fix", "priority": "high", "status": "in_progress"},
                    {"content": "regression test", "priority": "medium", "status": "pending"}]})
                upd({"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "text", "text": "Third block."}})
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


# Ordered children of the assistant message's parts stack.
PARTS = """() => {
  const msg = [...document.querySelectorAll('.messages .message-assistant')].at(-1);
  if (!msg) return null;
  const parts = msg.querySelector('.message-parts');
  if (!parts) return { children: [] };
  return {
    children: [...parts.children].map(el => {
      if (el.classList.contains('message-content')) return 'text:' + el.textContent.trim();
      const chip = el.querySelector('.tool-call-inline');
      if (chip) return 'tool:' + chip.textContent.trim() + '|' + chip.className;
      if (el.classList.contains('plan-card'))
        return 'plan:' + [...el.querySelectorAll('.plan-entry')].map(e => e.textContent.trim()).join(';');
      return el.className;
    }),
  };
}"""


def send(page, text):
    page.fill(".composer-box textarea", text)
    page.click(".send-btn")


def run_checks():
    proc, base = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed(ctx)
            page = ctx.new_page()
            page.route(re.compile(r"/api/fs/"), fs_api)
            # The host state server is live on :25900 and would restore the last
            # view into this context — cut it off for a clean welcome screen.
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))

            page.goto(base, wait_until="load")
            page.wait_for_selector(".tab-new:not([disabled])", timeout=15000)
            page.click(".tab-new")
            page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
            page.click(".nsm-start")
            page.wait_for_selector(".composer-box textarea", timeout=15000)
            page.wait_for_timeout(400)

            send(page, "go")
            page.wait_for_function(
                "() => document.querySelector('.messages').textContent.includes('Third block.')",
                timeout=10000)
            page.wait_for_timeout(150)

            parts = page.evaluate(PARTS)
            kinds = [c.split(":")[0] for c in (parts or {}).get("children", [])]
            print("parts:", json.dumps(parts, ensure_ascii=False)[:400])

            check("five ordered parts: text, tool, text, plan, text",
                  kinds == ["text", "tool", "text", "plan", "text"],
                  json.dumps(kinds))
            check("first text part is NOT glued to the second",
                  parts is not None and parts["children"][0] == "text:First block.",
                  (parts or {}).get("children", ["<none>"])[0][:120])
            check("chip sits between the text blocks, completed",
                  any(c.startswith("tool:") and "run ls" in c and "tool-completed" in c
                      for c in (parts or {}).get("children", [])),
                  json.dumps(kinds))
            check("plan card renders its entries",
                  any(c.startswith("plan:") and "ship the fix" in c and "regression test" in c
                      for c in (parts or {}).get("children", [])),
                  json.dumps(kinds))
            check("zero pageerrors", page_errors == [], repr(page_errors[:2]))
            browser.close()
    finally:
        stop(proc)

    passed = sum(1 for ok, _, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} assertions passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    if not DIST.is_dir():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    sys.exit(run_checks())
