#!/usr/bin/env python3
"""E2E for the phone-width polish fixes (acceptance audit defects).

Covers, against the real web build served on port 25996:

  * 390x844 Board view    — every rendered button/input/select inside the view
                            is >= 44px tall (incl. the card "Move to" trigger,
                            menu items, the card drawer and the empty state),
                            and .pane-note does not overflow its box.
  * 390x844 Projects view — head controls >= 44px, .search spans the pane
                            width, no page-level horizontal scroll.
  * 1024x768 both views   — desktop density preserved (spot-checked controls
                            are >= 24px and < 44px).
  * zero `pageerror` events everywhere.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_touch.py

The script serves dist-web itself via scripts/_e2e_harness.py (preferred
port 25996, falls back to the next free port when a stale/foreign server
holds it) and writes docs/polish-board-390x844.png /
docs/polish-projects-390x844.png.
"""

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import DIST, serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs"
PORT = 25996
BASE = f"http://127.0.0.1:{PORT}/"  # rebased in main() to the served port
MIN_TOUCH = 44.0
# getBoundingClientRect is subpixel; allow a hair of rounding slack.
EPS = 0.6

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def seed(context, with_board=True):
    """Seed localStorage: activity ledger + saved sessions (+ board cards).

    Guarded so a reload mid-test keeps the app's own persisted state."""
    now = int(time.time() * 1000)
    H = 3600 * 1000
    D = 24 * H
    entries = [
        {"at": now - 2 * D, "kind": "session-open", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "new session"},
        {"at": now - 2 * D + 120_000, "kind": "tool-call", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "Edit board.ts", "detail": "edit"},
        {"at": now - D, "kind": "session-open", "agentName": "OpenCode",
         "sessionId": "sess-e2e-2", "cwd": "/home/hermes/projects/infra",
         "title": "infra", "detail": "resumed"},
        {"at": now - 3 * H, "kind": "lock", "agentName": "Devin",
         "sessionId": "sess-e2e-3", "cwd": "/home/hermes/projects/api",
         "title": "api", "detail": "session_locked: already open in another process (pid 4242)"},
        {"at": now - H, "kind": "turn-end", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "end_turn"},
    ]
    for i, e in enumerate(entries):
        e["id"] = f"seed-{i}"
    usage = [
        {"at": now - H, "agentName": "Hermes Agent", "sessionId": "sess-e2e-1",
         "cwd": "/home/hermes/projects/acp-ui", "used": 8300, "size": 200000,
         "cost": 0.06, "currency": "USD"},
        {"at": now - D + 100_000, "agentName": "OpenCode", "sessionId": "sess-e2e-2",
         "cwd": "/home/hermes/projects/infra", "used": 12500, "size": 128000,
         "cost": 0.08, "currency": "USD"},
    ]
    sessions = [
        {"id": "saved-1", "agentName": "Hermes Agent", "sessionId": "sess-e2e-1",
         "title": "acp-ui polish work", "lastUpdated": now - H,
         "cwd": "/home/hermes/projects/acp-ui", "supportsLoadSession": True,
         "origin": "local"},
        {"id": "saved-2", "agentName": "OpenCode", "sessionId": "sess-e2e-2",
         "title": "infra triage", "lastUpdated": now - 2 * H,
         "cwd": "/home/hermes/projects/infra", "supportsLoadSession": True,
         "origin": "local"},
        {"id": "saved-3", "agentName": "Hermes Agent", "sessionId": "sess-e2e-9",
         "title": "older acp-ui session", "lastUpdated": now - 3 * H,
         "cwd": "/home/hermes/projects/acp-ui", "supportsLoadSession": True,
         "origin": "local"},
    ]
    scripts = [
        f"if (!localStorage.getItem('acp-ui:activity.json'))"
        f" localStorage.setItem('acp-ui:activity.json',"
        f" {json.dumps(json.dumps({'entries': entries, 'usage': usage}))});",
        f"if (!localStorage.getItem('acp-ui:sessions.json'))"
        f" localStorage.setItem('acp-ui:sessions.json',"
        f" {json.dumps(json.dumps({'sessions': sessions}))});",
    ]
    if with_board:
        cards = [
            {"id": "seed-card-1", "title": "Seed: review board PR",
             "description": "Seeded card.", "project": "acp-ui",
             "agent": "Hermes Agent", "priority": "medium", "acceptance": "",
             "verification": "", "links": [{"label": "brief", "url": "https://example.com/brief"}],
             "session": {"agentName": "Hermes Agent", "sessionId": "sess-e2e-1"},
             "blocked": False, "blockedReason": "", "cancelled": False,
             "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
             "stage": "backlog", "status": None, "statusByStage": {}, "order": 10,
             "createdAt": now - H, "updatedAt": now - H},
            {"id": "seed-card-2", "title": "Triage incoming agent work",
             "description": "Seeded card.", "project": "infra", "agent": "OpenCode",
             "priority": "high", "acceptance": "", "verification": "", "links": [],
             "session": None, "blocked": True, "blockedReason": "waiting on api spec",
             "cancelled": False, "touches": [], "dependsOn": [], "blocks": [],
             "conflictsWith": [], "stage": "backlog", "status": None,
             "statusByStage": {}, "order": 10,
             "createdAt": now - 2 * H, "updatedAt": now - 2 * H},
        ]
        scripts.append(
            f"if (!localStorage.getItem('acp-ui:board.json'))"
            f" localStorage.setItem('acp-ui:board.json',"
            f" {json.dumps(json.dumps({'version': 1, 'cards': cards}))});"
        )
    for s in scripts:
        context.add_init_script(s)


def controls(page, scope_sel):
    """Rendered button/input/select/textarea metrics inside `scope_sel`."""
    return page.evaluate(
        """(scope) => {
          const root = document.querySelector(scope);
          if (!root) return null;
          return [...root.querySelectorAll('button, input, select, textarea')]
            .map(el => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              // Effective touch target: the control box unioned with any
              // ::before/::after hit-area extension (transparent overlays are
              // the sanctioned way to enlarge a dense control on phones).
              let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
              for (const pseudo of ['::before', '::after']) {
                const ps = getComputedStyle(el, pseudo);
                if (ps.content === 'none' || ps.position !== 'absolute') continue;
                const pr = el.getBoundingClientRect();
                const t = parseFloat(ps.top) || 0, b = parseFloat(ps.bottom) || 0;
                const l = parseFloat(ps.left) || 0, rr = parseFloat(ps.right) || 0;
                top = Math.min(top, pr.top - t); bottom = Math.max(bottom, pr.bottom + b);
                left = Math.min(left, pr.left - l); right = Math.max(right, pr.right + rr);
              }
              return {
                tag: el.tagName.toLowerCase(),
                cls: String(el.className).split(' ')[0],
                label: (el.getAttribute('aria-label') || el.textContent || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, 24),
                h: bottom - top, w: right - left,
                shown: r.width > 0 && r.height > 0 &&
                       cs.display !== 'none' && cs.visibility !== 'hidden',
              };
            })
            .filter(i => i.shown);
        }""",
        scope_sel,
    )


def check_touch(page, scope_sel, what):
    """Assert every rendered control inside scope_sel is >= 44px tall."""
    items = controls(page, scope_sel)
    if items is None:
        check(f"{what}: controls present", False, f"no element matches {scope_sel}")
        return
    short = [i for i in items if i["h"] < MIN_TOUCH - EPS]
    check(
        f"{what}: all {len(items)} controls >= 44px",
        not short,
        "; ".join(f'{i["tag"]}.{i["cls"]} "{i["label"]}"={i["h"]:.0f}px' for i in short)
        or "min " + f'{min(i["h"] for i in items):.0f}px',
    )


def check_desktop_density(page, selectors, what):
    """Spot-check that controls keep dense desktop geometry (24 <= h < 44)."""
    for sel in selectors:
        h = page.evaluate(
            """(s) => { const el = document.querySelector(s);
                       return el ? el.getBoundingClientRect().height : -1; }""",
            sel,
        )
        check(
            f"{what}: {sel} stays dense ({h:.0f}px)",
            24 - EPS <= h < MIN_TOUCH - EPS,
        )


def main():
    global BASE
    SHOTS.mkdir(exist_ok=True)
    server, BASE = serve_web(PORT, DIST)
    try:
        run_checks()
    finally:
        stop(server)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---------------- 390x844 ----------------
        phone = browser.new_context(
            ignore_https_errors=True, viewport={"width": 390, "height": 844}
        )
        seed(phone)
        page = phone.new_page()
        page.route(re.compile(r":25900/"), lambda route: route.abort())
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        # --- Board view ---
        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)
        page.click('.rail-btn[aria-label="Board"]')
        page.wait_for_selector(".col-switcher", timeout=5000)
        page.wait_for_selector('[data-col="backlog"] .board-card', timeout=5000)

        check_touch(page, ".view-pane", "board@390")

        note = page.evaluate(
            """() => { const el = document.querySelector('.view-pane .pane-note');
                      return { sw: el.scrollWidth, cw: el.clientWidth }; }"""
        )
        check(
            "board@390: .pane-note stays in its box",
            note["sw"] <= note["cw"] + 1,
            f"scrollWidth {note['sw']} <= clientWidth {note['cw']} + 1",
        )

        hscroll = page.evaluate(
            "() => document.documentElement.scrollWidth - window.innerWidth"
        )
        check("board@390: no page-level horizontal scroll", hscroll <= 1, f"{hscroll}px")

        # Card "Move to" menu: trigger + items.
        page.locator('[data-col="backlog"] .board-card .card-menu-btn').first.click()
        page.wait_for_selector(".card-menu .menu-item", timeout=5000)
        check_touch(page, ".card-menu", "board@390 move-to menu")
        page.keyboard.press("Escape")
        page.mouse.click(10, 400)  # dismiss the menu via the document listener
        page.wait_for_timeout(150)

        # Card drawer.
        page.locator('[data-col="backlog"] .board-card').first.click()
        page.wait_for_selector(".card-drawer", timeout=5000)
        check_touch(page, ".card-drawer", "board@390 drawer")
        page.keyboard.press("Escape")
        page.wait_for_selector(".card-drawer", state="detached", timeout=5000)

        # Filter-empty path exposes .filter-clear.
        page.fill(".board-filters .f-search", "zzz-no-match")
        page.wait_for_selector(".filter-clear", timeout=5000)
        check_touch(page, ".filter-empty", "board@390 filter-empty")
        page.locator(".filter-clear").click()
        page.wait_for_timeout(150)

        page.screenshot(path=str(SHOTS / "polish-board-390x844.png"), full_page=False)

        # --- Projects view ---
        page.click('.rail-btn[aria-label="Projects"]')
        page.wait_for_selector(".view-pane .head-controls .search", timeout=5000)
        page.wait_for_selector(".project-row", timeout=5000)

        check_touch(page, ".view-pane", "projects@390")

        widths = page.evaluate(
            """() => ({
                 search: document.querySelector('.head-controls .search')
                           .getBoundingClientRect().width,
                 controls: document.querySelector('.head-controls')
                           .getBoundingClientRect().width,
               })"""
        )
        check(
            "projects@390: search spans the pane width",
            abs(widths["search"] - widths["controls"]) <= 1,
            f'search {widths["search"]:.0f}px of {widths["controls"]:.0f}px',
        )
        hscroll = page.evaluate(
            "() => document.documentElement.scrollWidth - window.innerWidth"
        )
        check("projects@390: no page-level horizontal scroll", hscroll <= 1, f"{hscroll}px")

        # Detail pane exposes one more button ("New session here").
        page.locator(".project-row").first.click()
        page.wait_for_selector(".project-detail .action", timeout=5000)
        check_touch(page, ".project-detail", "projects@390 detail")

        page.screenshot(path=str(SHOTS / "polish-projects-390x844.png"), full_page=False)
        phone.close()

        # Empty board state (no board seed) — .empty-btn targets.
        empty_ctx = browser.new_context(
            ignore_https_errors=True, viewport={"width": 390, "height": 844}
        )
        seed(empty_ctx, with_board=False)
        ep = empty_ctx.new_page()
        ep.route(re.compile(r":25900/"), lambda route: route.abort())
        ep.on("pageerror", lambda exc: page_errors.append(str(exc)))
        ep.goto(BASE, wait_until="load")
        ep.wait_for_selector(".view-rail", timeout=10000)
        ep.click('.rail-btn[aria-label="Board"]')
        ep.wait_for_selector(".board-empty .empty-btn", timeout=5000)
        check_touch(ep, ".board-empty", "board@390 empty state")
        empty_ctx.close()

        # ---------------- 1024x768 ----------------
        desk = browser.new_context(
            ignore_https_errors=True, viewport={"width": 1024, "height": 768}
        )
        seed(desk)
        dp = desk.new_page()
        dp.route(re.compile(r":25900/"), lambda route: route.abort())
        dp.on("pageerror", lambda exc: page_errors.append(str(exc)))
        dp.goto(BASE, wait_until="load")
        dp.wait_for_selector(".view-rail", timeout=10000)

        dp.click('.rail-btn[aria-label="Board"]')
        dp.wait_for_selector('[data-col="backlog"]', timeout=5000)
        check_desktop_density(
            dp, [".tab-btn", ".board-filters .f-search"], "board@1024"
        )
        note = dp.evaluate(
            """() => { const el = document.querySelector('.view-pane .pane-note');
                      return { sw: el.scrollWidth, cw: el.clientWidth }; }"""
        )
        check(
            "board@1024: .pane-note stays in its box",
            note["sw"] <= note["cw"] + 1,
            f"scrollWidth {note['sw']} <= clientWidth {note['cw']} + 1",
        )

        dp.click('.rail-btn[aria-label="Projects"]')
        dp.wait_for_selector(".head-controls .search", timeout=5000)
        check_desktop_density(
            dp, [".head-controls .search", ".range button"], "projects@1024"
        )
        desk.close()

        # ---------------- page errors ----------------
        check(
            "zero pageerror events",
            len(page_errors) == 0,
            "; ".join(page_errors[:3]) if page_errors else "",
        )
        browser.close()


if __name__ == "__main__":
    main()
