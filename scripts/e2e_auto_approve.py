#!/usr/bin/env python3
"""E2E for the autonomous run (W6-B): auto-approve without dialogs + audit.

Serves dist-web itself on http://127.0.0.1:25989/, mocks the ACP agent via
``page.route_web_socket`` (same shape as scripts/e2e_composer.py). The mock
sends ``session/request_permission`` as an agent->client JSON-RPC request and
waits for the client's response; the client side under test is
``src/stores/session.ts`` (autonomous flag, timeout) + the activity ledger.

The mock handler NEVER blocks (no sleep): the timeout case is modelled by
shortening the real timeout constant through the store's own
``setPermissionTimeout()`` action — the same code path production uses.

Scenarios (three fresh contexts, one browser):
  A. autonomous: flag on via ``__session.setAutonomous(true)`` before the
     agent asks. Expect: NO ``.permission-dialog`` in the DOM, the mock
     receives the allow-once optionId, the ledger has a ``permission``
     entry whose detail carries ``auto-approve: autonomous run``, the
     ``.auto-badge`` shows in the chat header.
  B. manual: flag off. Expect: ``.permission-dialog`` appears with a
     time-limit line (``Ответ нужен в течение N с``), clicking the first
     allow button answers the agent with that optionId.
  C. timeout: flag off, timeout shortened to ~1500 ms via
     ``__session.setPermissionTimeout(1500)``. Expect: the dialog closes
     by itself, the mock receives a ``cancelled`` outcome, the ledger has
     a ``permission`` entry whose detail carries ``timed out``.

Zero pageerror events. Test data lives inside the worktree
(./tmp-approve-test). Exits non-zero on any failure.
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
PORT = 25989
BASE = f"http://127.0.0.1:{PORT}/"

results: list[tuple[str, bool, str]] = []
page_errors: list[str] = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""), flush=True)


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API (same shape as e2e_composer).
# --------------------------------------------------------------------------

# Captured client answers, keyed by scenario tag.
ANSWERS: dict[str, list[dict]] = {}


def make_acp_ws(tag: str, mode: str):
    """Mock agent.

    mode 'auto'   — on prompt "ASK", send session/request_permission with an
                    allow_once + reject_once option and await the answer.
    mode 'manual' — on prompt "ASK", send the same request and await a human.
    mode 'silent' — on prompt "ASK", send the same request and never answer
                    back; client timeout (shortened via the store) must fire.
    No sleeps anywhere in the handler: every reply is sent synchronously.
    """
    def acp_ws(ws):
        def send(obj):
            ws.send(json.dumps(obj))

        def on_message(message):
            for line in str(message).split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(req, dict):
                    continue
                # Client answers to our permission request (result, same id).
                if "method" not in req and req.get("id") is not None:
                    ANSWERS.setdefault(tag, []).append(req)
                    continue
                if "method" not in req or req.get("id") is None:
                    continue  # notification (e.g. $/ping heartbeat)
                method, rid = req["method"], req["id"]
                if method == "initialize":
                    send({"jsonrpc": "2.0", "id": rid, "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {},
                        "authMethods": [],
                        "agentInfo": {"name": "e2e-mock", "version": "0"}}})
                elif method == "session/new":
                    send({"jsonrpc": "2.0", "id": rid, "result": {
                        "sessionId": "e2e-approve-session"}})
                elif method in ("session/list", "session/load"):
                    send({"jsonrpc": "2.0", "id": rid, "result": {"sessions": []}})
                elif method == "session/prompt":
                    text = ""
                    for block in (req.get("params", {}).get("prompt") or []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            text += block.get("text", "")
                    if "ASK" in text.upper() and mode in ("auto", "manual", "silent"):
                        send({"jsonrpc": "2.0", "id": 9001, "method": "session/request_permission",
                              "params": {
                                  "sessionId": "e2e-approve-session",
                                  "toolCall": {
                                      "toolCallId": f"tc-{tag}",
                                      "title": f"Run approved tool ({tag})",
                                      "kind": "execute",
                                      "status": "pending",
                                  },
                                  "options": [
                                      {"optionId": f"allow-{tag}", "name": "Allow once",
                                       "kind": "allow_once"},
                                      {"optionId": f"reject-{tag}", "name": "Reject",
                                       "kind": "reject_once"},
                                  ]}})
                    send({"jsonrpc": "2.0", "id": rid,
                          "result": {"stopReason": "end_turn"}})
                else:
                    if rid is not None:
                        send({"jsonrpc": "2.0", "id": rid, "result": {}})
        ws.on_message(on_message)
    return acp_ws


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
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                    "url": "ws://127.0.0.1:25994/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def open_chat(page, tag, mode):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), make_acp_ws(tag, mode))
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".tab-new:not([disabled])", timeout=15000)
    page.click(".tab-new")
    page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
    page.click(".nsm-start")
    page.wait_for_selector(".input-row", timeout=15000)
    page.wait_for_function("() => !!window.__session", timeout=15000)
    page.wait_for_timeout(300)


def ask(page):
    page.fill(".composer-box textarea", "ASK permission please")
    page.click(".send-btn")


def ledger_kinds(page):
    """All activity entries newest-first: [{kind, title, detail}]."""
    return page.evaluate(
        """() => window.__activity.recent(200).map(e => (
          { kind: e.kind, title: e.title || '', detail: e.detail || '' }))""")


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---------------- A: autonomous auto-approve ----------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "auto", "auto")
        page.evaluate("() => window.__session.setAutonomous(true)")
        page.wait_for_timeout(200)
        ask(page)
        # The agent answers immediately: poll the captured WS answers.
        for _ in range(100):
            if ANSWERS.get("auto"):
                break
            time.sleep(0.1)
        ans = (ANSWERS.get("auto") or [None])[0]
        outcome = (ans or {}).get("result", {}).get("outcome", {})
        check("auto: agent receives an answer", ans is not None, repr(ans)[:160])
        check("auto: answer selects the allow-once option",
              outcome.get("outcome") == "selected"
              and outcome.get("optionId") == "allow-auto",
              repr(outcome)[:160])
        check("auto: no .permission-dialog in the DOM",
              page.locator(".permission-dialog").count() == 0)
        check("auto: chat header shows the auto badge",
              page.locator(".auto-badge").count() == 1
              and "auto" in (page.locator(".auto-badge").first.text_content() or ""),
              page.locator(".auto-badge").first.text_content() or "<missing>")
        kinds = ledger_kinds(page)
        perm = [e for e in kinds if e["kind"] == "permission"]
        check("auto: ledger has a permission entry", len(perm) >= 1,
              json.dumps(perm[:1], ensure_ascii=False)[:220])
        check("auto: entry says what/why (title + auto-approve)",
              any("Run approved tool (auto)" in e["title"]
                  and "auto-approve: autonomous run" in e["detail"]
                  and "allow-auto" in e["detail"] for e in perm),
              json.dumps(perm[:1], ensure_ascii=False)[:220])
        ctx.close()

        # ---------------- B: manual dialog + human answer ----------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "manual", "manual")
        ask(page)
        page.wait_for_selector(".permission-dialog", timeout=10000)
        check("manual: dialog appears", page.locator(".permission-dialog").count() == 1)
        line = page.locator(".permission-dialog .timeout-line").first.text_content() or ""
        check("manual: dialog says the answer is time-limited",
              "Ответ нужен в течение" in line and "с" in line, line.strip()[:90])
        page.locator(".permission-dialog .option-allow").first.click()
        for _ in range(100):
            if ANSWERS.get("manual"):
                break
            time.sleep(0.1)
        ans = (ANSWERS.get("manual") or [None])[0]
        outcome = (ans or {}).get("result", {}).get("outcome", {})
        check("manual: human answer reaches the agent",
              outcome.get("outcome") == "selected"
              and outcome.get("optionId") == "allow-manual",
              repr(outcome)[:160])
        page.wait_for_timeout(300)
        check("manual: dialog closes after the answer",
              page.locator(".permission-dialog").count() == 0)
        ctx.close()

        # ---------------- C: timeout closes an ignored request ----------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "timeout", "silent")
        # Shorten the REAL timeout through the store's own action — the same
        # path production uses. No sleeps in the WS mock handler.
        page.evaluate("() => window.__session.setPermissionTimeout(1500)")
        ask(page)
        page.wait_for_selector(".permission-dialog", timeout=10000)
        check("timeout: dialog appears first", page.locator(".permission-dialog").count() == 1)
        page.wait_for_selector(".permission-dialog", state="detached", timeout=10000)
        check("timeout: dialog closes by itself", True)
        for _ in range(100):
            if ANSWERS.get("timeout"):
                break
            time.sleep(0.1)
        ans = (ANSWERS.get("timeout") or [None])[0]
        outcome = (ans or {}).get("result", {}).get("outcome", {})
        check("timeout: agent receives a cancelled outcome",
              outcome.get("outcome") == "cancelled", repr(outcome)[:160])
        kinds = ledger_kinds(page)
        perm = [e for e in kinds if e["kind"] == "permission"]
        check("timeout: ledger records the timeout",
              any("timed out" in e["detail"] for e in perm),
              json.dumps(perm[:1], ensure_ascii=False)[:220])
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
