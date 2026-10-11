#!/usr/bin/env python3
"""E2E for the per-agent default session mode (Devin -> bypass).

Serves dist-web itself and mocks the ACP agent via ``page.route_web_socket``
(same shape as scripts/e2e_auto_approve.py). The client side under test is
``sessionRuntime.create()`` -> ``applyDefaultMode()`` plus the web-config
backfill in ``host/index.ts`` — the stored agents entry deliberately omits
``defaultMode`` exactly like a config saved before the field existed.

Scenarios (one browser, fresh context each):
  A. "Devin" stored WITHOUT defaultMode -> backfill adds 'bypass'; the mock
     advertises accept-edits+bypass -> client sends session/set_mode bypass
     and the picker reads "Bypass Permissions".
  B. Non-Devin agent -> no session/set_mode leaves the client at all.
  C. "Devin" but the mock does NOT advertise bypass -> no set_mode, no error.
  D. "Devin" + mock fails session/set_mode but offers a mode config select
     -> client falls back to session/set_config_option(configId='mode').

Zero pageerror events. Exits non-zero on any failure.
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
PORT = 25988
BASE = f"http://127.0.0.1:{PORT}/"

results: list[tuple[str, bool, str]] = []
page_errors: list[str] = []

# Requests the client sent to the mock, keyed by scenario tag:
#   SET_CALLS[tag] == [{"method": "session/set_mode", "params": {...}}, ...]
SET_CALLS: dict[str, list[dict]] = {}


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""), flush=True)


MODES = {
    "currentModeId": "accept-edits",
    "availableModes": [
        {"id": "accept-edits", "name": "Code"},
        {"id": "bypass", "name": "Bypass Permissions"},
    ],
}
MODES_NO_BYPASS = {
    "currentModeId": "accept-edits",
    "availableModes": [{"id": "accept-edits", "name": "Code"}],
}
CONFIG_OPTIONS = [
    {"id": "mode", "name": "Session Mode", "category": "mode", "type": "select",
     "currentValue": "accept-edits",
     "options": [
         {"value": "accept-edits", "name": "Code"},
         {"value": "bypass", "name": "Bypass Permissions"},
     ]},
]


def make_acp_ws(tag: str, modes: dict | None, fail_set_mode: bool = False):
    """Mock agent: answers initialize/session/new and records any
    session/set_mode + session/set_config_option the client sends."""
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
                if "method" not in req or req.get("id") is None:
                    continue  # response or notification (e.g. $/ping)
                method, rid = req["method"], req["id"]
                if method == "initialize":
                    send({"jsonrpc": "2.0", "id": rid, "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {},
                        "authMethods": [],
                        "agentInfo": {"name": "e2e-mock", "version": "0"}}})
                elif method == "session/new":
                    result = {"sessionId": f"e2e-mode-{tag}"}
                    if modes is not None:
                        result["modes"] = modes
                    if fail_set_mode:
                        result["configOptions"] = CONFIG_OPTIONS
                    send({"jsonrpc": "2.0", "id": rid, "result": result})
                elif method == "session/set_mode":
                    SET_CALLS.setdefault(tag, []).append(
                        {"method": method, "params": req.get("params", {})})
                    if fail_set_mode:
                        send({"jsonrpc": "2.0", "id": rid, "error": {
                            "code": -32601, "message": "set_mode unsupported"}})
                    else:
                        send({"jsonrpc": "2.0", "id": rid, "result": {}})
                elif method == "session/set_config_option":
                    SET_CALLS.setdefault(tag, []).append(
                        {"method": method, "params": req.get("params", {})})
                    send({"jsonrpc": "2.0", "id": rid, "result": {
                        "configOptions": CONFIG_OPTIONS}})
                elif method in ("session/list", "session/load"):
                    send({"jsonrpc": "2.0", "id": rid, "result": {"sessions": []}})
                else:
                    send({"jsonrpc": "2.0", "id": rid, "result": {}})
        ws.on_message(on_message)
    return acp_ws


def seed(context, agents: dict):
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def open_chat(page, tag, modes, fail_set_mode=False):
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), make_acp_ws(tag, modes, fail_set_mode))
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".tab-new:not([disabled])", timeout=15000)
    page.click(".tab-new")
    page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
    page.click(".nsm-start")
    page.wait_for_selector(".input-row", timeout=15000)
    page.wait_for_function("() => !!window.__session", timeout=15000)


def wait_calls(tag, pred, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        calls = SET_CALLS.get(tag) or []
        if pred(calls):
            return calls
        time.sleep(0.1)
    return SET_CALLS.get(tag) or []


def run_checks():
    ws_url = "ws://127.0.0.1:25994/"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---- A: Devin w/o stored defaultMode -> bypass via session/set_mode ----
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        # The stored entry intentionally lacks defaultMode — this is the
        # pre-upgrade config shape the backfill must repair.
        seed(ctx, {"agents": {"Devin": {"transport": "websocket", "url": ws_url}}})
        page = ctx.new_page()
        open_chat(page, "devin", MODES)
        calls = wait_calls("devin", lambda c: any(
            x["method"] == "session/set_mode" for x in c))
        mode_calls = [x for x in calls if x["method"] == "session/set_mode"]
        check("A: client sent session/set_mode", len(mode_calls) == 1,
              repr(calls)[:200])
        check("A: set_mode asks for bypass",
              bool(mode_calls) and mode_calls[0]["params"].get("modeId") == "bypass",
              repr(mode_calls)[:200])
        page.wait_for_timeout(300)
        name = page.locator(".mode-picker .mode-name").first
        check("A: picker shows Bypass Permissions",
              name.count() == 1 and "Bypass" in (name.text_content() or ""),
              name.text_content() if name.count() else "<no picker>")
        ctx.close()

        # ---- B: another agent -> no mode request at all ----
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx, {"agents": {"E2E Mock": {"transport": "websocket", "url": ws_url}}})
        page = ctx.new_page()
        open_chat(page, "other", MODES)
        page.wait_for_timeout(600)
        check("B: no defaultMode -> client stays silent",
              not SET_CALLS.get("other"), repr(SET_CALLS.get("other"))[:200])
        ctx.close()

        # ---- C: Devin but bypass not advertised -> nothing forced ----
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx, {"agents": {"Devin": {"transport": "websocket", "url": ws_url}}})
        page = ctx.new_page()
        open_chat(page, "nobypass", MODES_NO_BYPASS)
        page.wait_for_timeout(600)
        check("C: bypass not advertised -> no set_mode",
              not SET_CALLS.get("nobypass"), repr(SET_CALLS.get("nobypass"))[:200])
        ctx.close()

        # ---- D: set_mode refused -> session/set_config_option fallback ----
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx, {"agents": {"Devin": {"transport": "websocket", "url": ws_url}}})
        page = ctx.new_page()
        open_chat(page, "fallback", MODES, fail_set_mode=True)
        calls = wait_calls("fallback", lambda c: any(
            x["method"] == "session/set_config_option" for x in c))
        cfg = [x for x in calls if x["method"] == "session/set_config_option"]
        check("D: set_mode refused -> set_config_option fallback",
              bool(cfg) and cfg[0]["params"].get("configId") == "mode"
              and cfg[0]["params"].get("value") == "bypass",
              repr(calls)[:220])
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
