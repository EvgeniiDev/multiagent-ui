#!/usr/bin/env python3
"""E2E for the W-A workstream: global Settings/Traffic in the scope bar +
"New project" on the Projects view.

Runs against the real web build served on http://127.0.0.1:25985/ and asserts:

  * on each of the 4 views (Chat/Projects/Board/Dashboard) the Settings and
    Traffic buttons live in `.scope-bar`, are VISIBLE (`is_visible()`, not
    mere DOM presence), Settings opens the overlay and closes, Traffic
    toggles the panel;
  * the same on 390x844 (buttons >= 44px, no horizontal scroll, no wrapping);
  * the Projects header has a "New project" button; creating with a new
    folder /home/hermes/projects/e2e-<uniq> really creates the directory on
    the host (verified via GET /api/fs/list?path=/home/hermes/projects
    before/after through the real Hermes bridge on 127.0.0.1:25901);
  * creating with an existing folder registers the project and it appears in
    the scope selector;
  * the new project becomes the active scope (selector value + filtered
    session list);
  * reusing the same path shows a visible error and creates nothing;
  * zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_global_actions.py

NEEDS THE LIVE BRIDGE: the mkdir assertion only makes sense against the
real Hermes bridge on http://127.0.0.1:25901. The web bundle is served by
the suite itself; when the bridge is unreachable the suite prints SKIP and
exits 0 instead of failing.

Screenshots land in docs/global-actions-1440x900.png and
docs/global-actions-390x844.png.
Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
PORT = 25985
BASE = f"http://127.0.0.1:{PORT}/"
BRIDGE = "http://127.0.0.1:25901"

results: list[tuple[str, bool, str]] = []
page_errors: list[str] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# ---------------------------------------------------------------------------
# Host bridge helpers (real mkdir/list on the Hermes agent host bridge)
# ---------------------------------------------------------------------------

def bridge_list_dirs(parent: str) -> list[str]:
    q = urllib.parse.urlencode({"path": parent, "hidden": "1"})
    with urllib.request.urlopen(f"{BRIDGE}/api/fs/list?{q}", timeout=10) as r:
        data = json.loads(r.read().decode())
    return [d.get("name", "") for d in data.get("dirs", [])]


def bridge_has_dir(parent: str, name: str) -> bool:
    return name in bridge_list_dirs(parent)


def bridge_mkdir(path: str) -> tuple[bool, str]:
    status, body = bridge_mkdir_raw(path)
    if 200 <= status < 300:
        return True, json.dumps(body)[:160]
    return False, (body.get("error") or f"HTTP {status}")[:160]


def bridge_mkdir_raw(path: str) -> tuple[int, dict]:
    """POST /api/fs/mkdir on the real bridge; return (status, body)."""
    import urllib.error

    try:
        req = urllib.request.Request(
            f"{BRIDGE}/api/fs/mkdir",
            data=json.dumps({"path": path}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {"error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return 502, {"error": str(e)[:160]}


# --------------------------------------------------------------------------
# App fixtures
# --------------------------------------------------------------------------

COMMON_PATH = "/home/hermes/projects"


def session_infos():
    now = int(time.time() * 1000)

    def iso(ms):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))

    return [
        {"sessionId": "sess-alpha-1", "cwd": f"{COMMON_PATH}/alpha",
         "title": "alpha one", "updatedAt": iso(now - 3600_000)},
        {"sessionId": "sess-beta-1", "cwd": f"{COMMON_PATH}/beta",
         "title": "beta one", "updatedAt": iso(now - 3 * 3600_000)},
    ]


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
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker.

    Only READ endpoints are stubbed (root/list). POST /api/fs/mkdir passes
    through to the real Hermes bridge on 25901 so folder creation really
    happens on the host — that is the point of the assertion.
    """
    if route.request.method.upper() == "POST":
        route.continue_()
        return
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
    """localStorage: one ws agent + telemetry off.

    Guarded (`if (!localStorage.getItem ...)`) so a reload mid-test keeps the
    app's own persisted state rather than re-seeding over it.
    """
    agents = {
        "agents": {
            "Hermes Agent": {"transport": "websocket", "url": "ws://127.0.0.1:25901/"},
        }
    }
    pairs = [
        ("acp-ui:agents", agents),
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def wire(page):
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))

    def handle_fs(route):
        # The active projects implementation (registry stub, owned by the
        # parallel workstream until the W1 merge — see REPORT.md) POSTs a
        # page-ORIGIN-relative `/api/fs/mkdir` (best-effort, errors swallowed).
        # Proxy that POST to the real Hermes bridge so folder creation really
        # happens on the host; reads keep the deterministic stub.
        if route.request.method.upper() == "POST" and "/api/fs/mkdir" in route.request.url:
            try:
                payload = json.loads(route.request.post_data or "{}")
            except ValueError:
                payload = {}
            status, body = bridge_mkdir_raw(payload.get("path", ""))
            route.fulfill(
                status=status,
                content_type="application/json",
                body=json.dumps(body),
            )
            return
        if route.request.method.upper() == "POST":
            route.continue_()
            return
        fs_api(route)

    page.route(re.compile(r"/api/fs/"), handle_fs)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)


def goto_view(page, label: str, wait_sel: str) -> None:
    page.click(f'.rail-btn[aria-label="{label}"]')
    page.wait_for_selector(wait_sel, timeout=10000)
    page.wait_for_timeout(300)


def check_global_buttons(page, tag: str) -> None:
    """Settings + Traffic in .scope-bar: visible, open/close + toggle."""
    settings = page.locator('.scope-bar button[title="Settings"]')
    traffic = page.locator('.scope-bar button[title="ACP Traffic Monitor"]')
    check(f"{tag}: Settings button in scope bar and visible",
          settings.count() == 1 and settings.first.is_visible())
    check(f"{tag}: Traffic button in scope bar and visible",
          traffic.count() == 1 and traffic.first.is_visible())

    # Settings opens the overlay and closes it again.
    settings.first.click()
    page.wait_for_selector(".settings-panel", timeout=5000)
    check(f"{tag}: Settings opens the overlay", True)
    page.click(".settings-panel .close-btn")
    page.wait_for_selector(".settings-panel", state="detached", timeout=5000)
    check(f"{tag}: Settings closes", True)

    # Traffic toggles the panel.
    traffic.first.click()
    page.wait_for_selector(".traffic-panel", timeout=5000)
    check(f"{tag}: Traffic opens the panel", True)
    traffic.first.click()
    page.wait_for_selector(".traffic-panel", state="detached", timeout=5000)
    check(f"{tag}: Traffic toggles closed", True)


def run_desktop(browser, uniq: str) -> None:
    ctx = browser.new_context(
        ignore_https_errors=True, viewport={"width": 1440, "height": 900}
    )
    seed(ctx)
    page = ctx.new_page()
    wire(page)
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".scope-bar", timeout=10000)
    page.wait_for_selector(".scope-select", timeout=10000)
    # The sole configured agent auto-selects and its mocked session/list
    # populates the sidebar through the real sync path.
    page.wait_for_selector(".session-row", timeout=15000)

    # --- the old buttons are gone from the sidebar header ---
    check("desktop: sidebar no longer has Settings/Traffic buttons",
          page.locator(".sidebar-header .settings-btn").count() == 0)

    # --- global actions on all 4 views ---
    check_global_buttons(page, "desktop Chat")
    goto_view(page, "Projects", ".project-row")
    check_global_buttons(page, "desktop Projects")
    goto_view(page, "Board", ".view-pane")
    check_global_buttons(page, "desktop Board")
    goto_view(page, "Dashboard", ".view-pane")
    check_global_buttons(page, "desktop Dashboard")

    # --- New project with a brand-new folder ---
    goto_view(page, "Projects", ".project-row")
    new_btn = page.get_by_role("button", name="New project")
    check("desktop: Projects header has New project button",
          new_btn.count() == 1 and new_btn.first.is_visible())

    new_folder = f"{COMMON_PATH}/e2e-{uniq}"
    check("desktop: target folder absent before the test",
          not bridge_has_dir(COMMON_PATH, f"e2e-{uniq}"), new_folder)

    new_btn.first.click()
    page.wait_for_selector(".np-dialog", timeout=5000)
    page.fill(".np-dialog #np-name", f"E2E {uniq}")
    page.fill(".np-dialog .cwd-input", new_folder)
    page.click(".np-dialog .np-confirm")
    page.wait_for_selector(".np-dialog", state="detached", timeout=15000)
    check("desktop: dialog closes after creation", True)

    check("desktop: folder really created on the host",
          bridge_has_dir(COMMON_PATH, f"e2e-{uniq}"), new_folder)

    scope_names = page.eval_on_selector_all(
        ".scope-select option", "els => els.map(e => e.textContent.trim())"
    )
    check("desktop: new project appears in the scope selector",
          f"E2E {uniq}" in scope_names, ",".join(scope_names))

    scope_val = page.eval_on_selector(".scope-select", "el => el.value")
    check("desktop: new project is the active scope",
          scope_val != "all" and scope_val != "", scope_val)

    # Sidebar (chat drawer on desktop is always visible; navigate there) is
    # filtered to the new project's (empty) sessions — assert via the
    # selector value + the scoped Projects detail instead.
    detail = page.locator(".project-detail")
    check("desktop: scoped detail opens on the new project",
          detail.count() == 1 and f"E2E {uniq}" in detail.locator("h3").inner_text(),
          detail.locator("h3").inner_text() if detail.count() else "no detail")

    # --- New project with an existing folder ---
    seed_name = f"e2e-{uniq}-seed"
    ok, detail_txt = bridge_mkdir(f"{COMMON_PATH}/{seed_name}")
    check("desktop: seed folder for existing-folder mode", ok, detail_txt)

    new_btn.first.click()
    page.wait_for_selector(".np-dialog", timeout=5000)
    page.locator(".np-dialog .np-modes button", has_text="Existing folder").click()
    page.fill(".np-dialog #np-name", f"E2E existing {uniq}")
    page.fill(".np-dialog .cwd-input", f"{COMMON_PATH}/{seed_name}")
    page.click(".np-dialog .np-confirm")
    page.wait_for_selector(".np-dialog", state="detached", timeout=15000)
    scope_names = page.eval_on_selector_all(
        ".scope-select option", "els => els.map(e => e.textContent.trim())"
    )
    check("desktop: existing-folder project appears in the scope selector",
          f"E2E existing {uniq}" in scope_names, ",".join(scope_names))
    scope_val = page.eval_on_selector(".scope-select", "el => el.value")
    check("desktop: existing-folder project becomes the active scope",
          scope_val != "all" and scope_val != "", scope_val)

    # --- duplicate path: visible error, no new project ---
    before = page.eval_on_selector_all(
        ".scope-select option", "els => els.length"
    )
    new_btn.first.click()
    page.wait_for_selector(".np-dialog", timeout=5000)
    page.locator(".np-dialog .np-modes button", has_text="Existing folder").click()
    page.fill(".np-dialog #np-name", "duplicate attempt")
    page.fill(".np-dialog .cwd-input", f"{COMMON_PATH}/{seed_name}")
    page.click(".np-dialog .np-confirm")
    page.wait_for_selector(".np-dialog .np-error", timeout=5000)
    err_text = page.locator(".np-dialog .np-error").inner_text()
    check("desktop: duplicate path shows a visible error", bool(err_text.strip()),
          err_text[:120])
    # Dialog stays open (no silent swallow); close it and confirm the count.
    check("desktop: dialog stays open on error",
          page.locator(".np-dialog").count() == 1)
    page.click(".np-dialog .np-cancel")
    page.wait_for_selector(".np-dialog", state="detached", timeout=5000)
    after = page.eval_on_selector_all(
        ".scope-select option", "els => els.length"
    )
    check("desktop: duplicate path creates no project", before == after,
          f"{before} -> {after}")

    # --- session list filtered by the new scope (Chat view, sidebar) ---
    page.click('.rail-btn[aria-label="Chat"]')
    page.wait_for_selector(".sidebar .session-list", timeout=10000)
    page.wait_for_timeout(400)
    titles = sorted(
        page.eval_on_selector_all(
            ".sidebar .session-row .row-title",
            "els => els.map(e => e.textContent.trim())",
        )
    )
    # Active scope is the seed project (no sessions live under it) — the
    # sidebar must not leak Alpha/Beta rows through the filter.
    check("desktop: scoped session list hides out-of-scope sessions",
          titles == [], ",".join(titles))

    page.select_option(".scope-select", label="All")
    page.wait_for_timeout(300)
    titles = sorted(
        page.eval_on_selector_all(
            ".sidebar .session-row .row-title",
            "els => els.map(e => e.textContent.trim())",
        )
    )
    check("desktop: All scope restores the session list",
          titles == ["alpha one", "beta one"], ",".join(titles))

    page.screenshot(path=str(SHOTS / "global-actions-1440x900.png"))
    ctx.close()


def run_phone(browser) -> None:
    phone = browser.new_context(
        ignore_https_errors=True, viewport={"width": 390, "height": 844}
    )
    seed(phone)
    page = phone.new_page()
    wire(page)
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".scope-bar", timeout=10000)
    page.wait_for_selector(".scope-select", timeout=10000)
    page.wait_for_timeout(400)

    settings = page.locator('.scope-bar button[title="Settings"]')
    traffic = page.locator('.scope-bar button[title="ACP Traffic Monitor"]')
    check("390: Settings button visible in scope bar",
          settings.count() == 1 and settings.first.is_visible())
    check("390: Traffic button visible in scope bar",
          traffic.count() == 1 and traffic.first.is_visible())

    for btn, name in ((settings, "Settings"), (traffic, "Traffic")):
        box = btn.first.bounding_box()
        ok = box is not None and box["width"] >= 44 - 0.6 and box["height"] >= 44 - 0.6
        check(f"390: {name} button >= 44px touch target", ok,
              f'{box["width"]:.0f}x{box["height"]:.0f}' if box else "no box")

    hscroll = page.evaluate(
        "() => document.documentElement.scrollWidth - window.innerWidth"
    )
    check("390: no page-level horizontal scroll", hscroll <= 1, f"{hscroll}px")

    wrap = page.evaluate(
        """() => { const el = document.querySelector('.scope-bar');
                  return { sw: el.scrollWidth, cw: el.clientWidth }; }"""
    )
    check("390: scope bar has no wrapped/overflowing row",
          wrap["sw"] <= wrap["cw"] + 1,
          f'scrollWidth {wrap["sw"]} <= clientWidth {wrap["cw"]} + 1')

    # Open/close still works on the phone layout.
    settings.first.click()
    page.wait_for_selector(".settings-panel", timeout=5000)
    check("390: Settings opens the overlay", True)
    page.click(".settings-panel .close-btn")
    page.wait_for_selector(".settings-panel", state="detached", timeout=5000)
    check("390: Settings closes", True)

    traffic.first.click()
    page.wait_for_selector(".traffic-panel", timeout=5000)
    check("390: Traffic opens the panel", True)
    traffic.first.click()
    page.wait_for_selector(".traffic-panel", state="detached", timeout=5000)
    check("390: Traffic toggles closed", True)

    # New project button reachable on the phone too.
    page.click('.rail-btn[aria-label="Projects"]')
    page.wait_for_selector(".project-row", timeout=10000)
    new_btn = page.get_by_role("button", name="New project")
    check("390: Projects header has New project button",
          new_btn.count() >= 1 and new_btn.first.is_visible())

    page.screenshot(path=str(SHOTS / "global-actions-390x844.png"))
    phone.close()


def main() -> int:
    try:
        bridge_list_dirs(COMMON_PATH)
    except Exception as e:  # noqa: BLE001
        print(f"SKIP: live Hermes bridge unreachable at {BRIDGE} ({e}) — "
              "this suite's mkdir assertion needs the real bridge")
        return 0
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        return 1
    SHOTS.mkdir(exist_ok=True)
    uniq = str(int(time.time()))[-6:]
    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            run_desktop(browser, uniq)
            run_phone(browser)
            browser.close()
    finally:
        stop(server)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
