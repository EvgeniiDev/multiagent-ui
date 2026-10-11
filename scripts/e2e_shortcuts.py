#!/usr/bin/env python3
"""E2E for the W14 view-switch shortcuts (single keydown owner).

Serves `dist-web/` itself on http://127.0.0.1:25980/ and asserts, on a real
page with the live :25900 state server aborted (the panel falls back to
localStorage — nothing is written to ~/.hermes):

  * each bare digit 1..4 switches the view EXACTLY ONCE — the target view's
    rail button + pane render, no second/wrong view activates, and the
    persisted preferences doc is written exactly once per keypress (two
    handlers firing would persist twice);
  * the shortcuts fire when focus sits on a rail button or an ordinary
    (non-field) button;
  * typing digits inside fields never switches the view: the Projects
    filter, the Board card search, a Board filter <select>, the composer
    textarea (over a mocked ACP session), a role number input
    (type="number" still fires keydown) and a role text input;
  * the guard does not depend on which element was focused first — a
    field -> button -> field focus sequence guards/switches the same as
    button -> field -> button;
  * zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_shortcuts.py

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
PORT = 25980
BASE = f"http://127.0.0.1:{PORT}/"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def seed(context):
    """localStorage: one ws agent, telemetry off, a project, one board card."""
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                    "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    registry = {"version": 1,
                "projects": [{"id": "p-common", "name": "Common",
                              "path": "/home/hermes/projects",
                              "createdAt": 1700000000000}],
                "activeProjectId": "all"}
    now = int(time.time() * 1000)
    board = {"version": 2, "cards": [
        {"id": "w14-card", "title": "W14 seeded card", "description": "",
         "project": "", "agent": "", "priority": "medium",
         "acceptance": "", "verification": "", "links": [], "session": None,
         "blocked": False, "blockedReason": "", "cancelled": False,
         "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
         "stage": "backlog", "status": None, "statusByStage": {},
         "order": 10, "createdAt": now, "updatedAt": now},
    ]}
    for key, val in (("acp-ui:agents", agents),
                     ("acp-ui:preferences.json", prefs),
                     ("acp-ui:projects.json", registry),
                     ("acp-ui:board.json", board)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )
    # Persist-write counter: each ui.setView() ends in exactly one
    # localStorage.setItem('acp-ui:preferences.json', ...). A second keydown
    # owner would fire setView twice -> two writes per keypress.
    context.add_init_script(
        "window.__prefWrites = 0;"
        "const __set = Storage.prototype.setItem;"
        "Storage.prototype.setItem = function(k, v) {"
        "  if (k === 'acp-ui:preferences.json') window.__prefWrites++;"
        "  return __set.call(this, k, v);"
        "};"
    )


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
                continue
            method = req["method"]
            if method == "initialize":
                result = {"protocolVersion": 1, "agentCapabilities": {},
                          "authMethods": [],
                          "agentInfo": {"name": "e2e-mock", "version": "0"}}
            elif method == "session/new":
                result = {"sessionId": "w14-session"}
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
        body = {"path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
                "dirs": [{"name": "projects", "path": "/home/hermes/projects"}]}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def port_has_listener(port):
    """A port is busy only if the kernel shows a LISTEN socket — a leftover
    TIME_WAIT is free. Ask `ss`, never bind()-probe."""
    try:
        out = subprocess.run(["ss", "-ltn"], capture_output=True,
                             text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[3].rsplit(":", 1)[-1] == str(port):
            return True
    return False


def start_server():
    if port_has_listener(PORT):
        print(f"FAIL  port {PORT} already has a listener — refusing to test "
              f"a stale server")
        sys.exit(1)
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on port {PORT}")
    sys.exit(1)


# --------------------------------------------------------------------------
# Page helpers
# --------------------------------------------------------------------------

def active_label(page):
    el = page.query_selector(".rail-btn.active")
    return el.get_attribute("aria-label") if el else None


def active_pane(page):
    """Which view is actually mounted in .main-content (not just the rail)."""
    return page.evaluate(
        """() => {
          if (document.querySelector('.welcome-screen')
              || document.querySelector('.composer-box')) return 'chat';
          if (document.querySelector('[data-testid="dashboard"]')) return 'dashboard';
          if (document.querySelector('.board-col, .col-switcher, .board-filters'))
            return 'board';
          if (document.querySelector('.view-pane .search')) return 'projects';
          const h2 = document.querySelector('.view-pane .pane-head h2, .main-content h2');
          return h2 ? 'pane:' + h2.textContent.trim() : 'none';
        }"""
    )


def pref_writes(page):
    return page.evaluate("() => window.__prefWrites")


def reset_writes(page):
    page.evaluate("() => { window.__prefWrites = 0; }")


def dump_section(page):
    """What the rail + pane actually show — printed when an assertion fails."""
    return page.evaluate(
        """() => ({
          active: [...document.querySelectorAll('.rail-btn')]
            .map(b => b.getAttribute('aria-label') + (b.classList.contains('active') ? '*' : '')),
          focused: document.activeElement ? document.activeElement.tagName
            + '.' + document.activeElement.className : 'none',
          pane: (document.querySelector('.main-content')?.innerText || '').slice(0, 120),
        })"""
    )


def press_digit(page, digit):
    """Press a bare digit on whatever currently has focus."""
    page.keyboard.press(digit)
    page.wait_for_timeout(350)


def expect_view(page, digit, label, writes=1, focus_sel=None):
    """A digit keypress lands on the target view exactly once.

    Focus is made deterministic first: `focus_sel` (a button/rail selector)
    gets .focus(), otherwise any field is blurred to <body>."""
    if focus_sel:
        page.eval_on_selector(focus_sel, "el => el.focus()")
    else:
        page.evaluate("() => { if (document.activeElement)"
                      " document.activeElement.blur(); }")
    page.wait_for_timeout(60)
    reset_writes(page)
    press_digit(page, digit)
    label_ok = active_label(page) == label
    actives = page.locator(".rail-btn.active").count()
    pane = active_pane(page)
    got = pref_writes(page)
    check(f"'{digit}' activates {label} on the rail",
          label_ok and actives == 1,
          f"active={active_label(page)} actives={actives} {dump_section(page)}"
          if not (label_ok and actives == 1) else "")
    check(f"'{digit}' mounts the {label} pane (no wrong view)",
          pane == label.lower(), f"pane={pane}")
    check(f"'{digit}' persists the view exactly once",
          got == writes, f"prefWrites={got}")


def expect_guarded(page, name, digit, stay_label, focus_fn, value_sel=None):
    """Typing a digit inside a field leaves the view untouched."""
    focus_fn()
    reset_writes(page)
    page.keyboard.type(digit)
    page.wait_for_timeout(350)
    label_now = active_label(page)
    got = pref_writes(page)
    extra = ""
    if label_now != stay_label or got != 0:
        extra = f"active={label_now} prefWrites={got} {dump_section(page)}"
    check(f"digit '{digit}' in {name} keeps {stay_label}",
          label_now == stay_label and got == 0, extra)
    if value_sel:
        val = page.eval_on_selector(value_sel, "el => el.value")
        check(f"digit '{digit}' actually landed in {name}",
              digit in val, f"value={val!r}")


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed(ctx)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            # The live state server must never see this page: every :25900
            # call is aborted so the panel uses localStorage only.
            page.route(re.compile(r":25900/"), lambda route: route.abort())
            page.route(re.compile(r"/api/fs/"), fs_api)
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)

            page.goto(BASE, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.wait_for_timeout(600)
            check("booted on the Chat view",
                  active_label(page) == "Chat" and active_pane(page) == "chat",
                  f"active={active_label(page)} pane={active_pane(page)}")

            # bindShortcuts runs at the tail of the onMounted init chain;
            # probe with '2' presses until the rail reacts (bounded) instead
            # of trusting a fixed sleep.
            bound = False
            deadline = time.time() + 15
            while time.time() < deadline and not bound:
                page.keyboard.press("2")
                page.wait_for_timeout(250)
                bound = active_label(page) == "Projects"
            check("view shortcuts bound (probe '2' reached Projects)", bound,
                  f"active={active_label(page)} {dump_section(page)}"
                  if not bound else "")

            # ---- every digit switches exactly once -----------------------
            # Order visits each view from a different predecessor.
            expect_view(page, "2", "Projects")
            expect_view(page, "3", "Board")
            expect_view(page, "4", "Dashboard")
            expect_view(page, "1", "Chat")

            # ---- focus on a rail button ----------------------------------
            page.click('.rail-btn[aria-label="Projects"]')
            page.wait_for_timeout(250)
            check("rail click focused a rail button",
                  page.evaluate("() => document.activeElement"
                                " && document.activeElement.classList"
                                " && document.activeElement.classList.contains('rail-btn')"))
            expect_view(page, "3", "Board",
                        focus_sel='.rail-btn[aria-label="Projects"]')

            # ---- focus on an ordinary (non-field) button ------------------
            expect_view(page, "2", "Projects", focus_sel=".scope-icon-btn")

            # ---- guards: typing digits in fields never switches ----------
            # Projects filter (the case the existing shell suite asserts).
            expect_guarded(page, "the Projects filter", "3", "Projects",
                           lambda: page.click(".view-pane .search"),
                           value_sel=".view-pane .search")

            # Back to Board, then the card search + a filter <select>.
            expect_view(page, "3", "Board")
            expect_guarded(page, "the card search", "1", "Board",
                           lambda: page.click(".f-search"),
                           value_sel=".f-search")
            expect_guarded(page, "a board filter <select>", "2", "Board",
                           lambda: page.eval_on_selector(
                               ".f-select", "el => el.focus()"))

            # Focus order A: field -> button -> field must behave the same.
            expect_view(page, "2", "Projects")
            expect_guarded(page, "the Projects filter (order A)", "4",
                           "Projects", lambda: page.click(".view-pane .search"))
            expect_view(page, "4", "Dashboard", focus_sel=".scope-icon-btn")

            # Focus order B: button -> field -> button must behave the same.
            expect_view(page, "3", "Board")
            expect_guarded(page, "the card search (order B)", "1", "Board",
                           lambda: page.click(".f-search"))
            expect_view(page, "1", "Chat", focus_sel=".scope-icon-btn")

            # ---- composer (needs a connected session) ---------------------
            page.wait_for_selector(".tab-new:not([disabled])",
                                   timeout=10000)
            page.click(".tab-new")
            page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
            page.click(".nsm-start")
            page.wait_for_selector(".input-row", timeout=15000)
            page.wait_for_timeout(400)
            expect_guarded(page, "the composer", "3", "Chat",
                           lambda: page.click(".composer-box textarea"),
                           value_sel=".composer-box textarea")
            page.fill(".composer-box textarea", "")

            # ---- role form: number + text inputs --------------------------
            page.get_by_role("button", name="Settings").first.click()
            page.wait_for_selector('[data-testid="settings-roles"]',
                                   timeout=15000)
            section = page.get_by_test_id("settings-roles")
            section.get_by_test_id("roles-add-toggle").click()
            page.wait_for_selector('[data-testid="role-maxc"]', timeout=5000)
            expect_guarded(page, "the role maxConcurrent number input", "3",
                           "Chat",
                           lambda: page.click('[data-testid="role-maxc"]'),
                           value_sel='[data-testid="role-maxc"]')
            expect_guarded(page, "the role id text input", "2", "Chat",
                           lambda: page.click('[data-testid="role-id"]'),
                           value_sel='[data-testid="role-id"]')
            overlay = page.locator(".settings-overlay")
            if overlay.count() and overlay.first.is_visible():
                # name="Close" is a substring match — the tab strip's
                # "Close tab" buttons would win .first; exact keeps it the
                # dialog's own Close.
                page.get_by_role("button", name="Close", exact=True).first.click()
                page.wait_for_timeout(300)
            check("settings overlay closed",
                  page.locator(".settings-overlay").count() == 0
                  or not page.locator(".settings-overlay").first.is_visible())

            # ---- rail button focused again after the dialog ---------------
            page.click('.rail-btn[aria-label="Board"]')
            page.wait_for_timeout(250)
            expect_view(page, "1", "Chat",
                        focus_sel='.rail-btn[aria-label="Board"]')

            ctx.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
