#!/usr/bin/env python3
"""E2E for the Board workstream (F3 + F4), run against the real web build.

Usage:
    npm run build:web
    cd dist-web && python3 -m http.server 25999 &
    ~/.hermes/tools-venv/bin/python scripts/e2e_board.py

Asserts: rail switches to Board, all six pipeline stages render in order, a
card can be created into `backlog`, moved to `spec` via the card menu (counts
update, initial `in_progress` status chip shows), survives a reload, the
Events tab shows rows, and the page produces zero `pageerror` events.
Screenshots land in docs/board-*.png.
"""

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:25999/"
ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def seed_ledger(context):
    """Pre-populate the activity ledger in localStorage so Events/Timeline/
    Locks have real rows without needing a live agent."""
    now = int(time.time() * 1000)
    H = 3600 * 1000
    D = 24 * H
    entries = [
        {"at": now - 2 * D, "kind": "session-open", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "new session"},
        {"at": now - 2 * D + 60_000, "kind": "turn-start", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "wire the board store"},
        {"at": now - 2 * D + 120_000, "kind": "tool-call", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "Edit board.ts", "detail": "edit"},
        {"at": now - 2 * D + 180_000, "kind": "turn-end", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "end_turn"},
        {"at": now - D, "kind": "session-open", "agentName": "OpenCode",
         "sessionId": "sess-e2e-2", "cwd": "/home/hermes/projects/infra",
         "title": "infra", "detail": "resumed"},
        {"at": now - D + 90_000, "kind": "error", "agentName": "OpenCode",
         "sessionId": "sess-e2e-2", "cwd": "/home/hermes/projects/infra",
         "title": "infra", "detail": "prompt failed: transport timeout"},
        {"at": now - 3 * H, "kind": "lock", "agentName": "Devin",
         "sessionId": "sess-e2e-3", "cwd": "/home/hermes/projects/api",
         "title": "api", "detail": "session_locked: already open in another process (pid 4242)"},
        {"at": now - 2 * H, "kind": "turn-start", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "write the e2e script"},
        {"at": now - 1 * H, "kind": "turn-end", "agentName": "Hermes Agent",
         "sessionId": "sess-e2e-1", "cwd": "/home/hermes/projects/acp-ui",
         "title": "acp-ui", "detail": "end_turn"},
    ]
    for i, e in enumerate(entries):
        e["id"] = f"seed-{i}"
    usage = [
        {"at": now - 2 * D + 100_000, "agentName": "Hermes Agent", "sessionId": "sess-e2e-1",
         "cwd": "/home/hermes/projects/acp-ui", "used": 42000, "size": 200000,
         "cost": 0.31, "currency": "USD"},
        {"at": now - D + 100_000, "agentName": "OpenCode", "sessionId": "sess-e2e-2",
         "cwd": "/home/hermes/projects/infra", "used": 12500, "size": 128000,
         "cost": 0.08, "currency": "USD"},
        {"at": now - 1 * H, "agentName": "Hermes Agent", "sessionId": "sess-e2e-1",
         "cwd": "/home/hermes/projects/acp-ui", "used": 8300, "size": 200000,
         "cost": 0.06, "currency": "USD"},
    ]
    payload = json.dumps({"entries": entries, "usage": usage})
    board_cards = [
        {"id": "seed-card-1", "title": "Seed: review board PR", "description": "Seeded card.",
         "project": "acp-ui", "agent": "Hermes Agent", "priority": "medium",
         "acceptance": "", "verification": "", "links": [], "session": None,
         "blocked": False, "blockedReason": "", "cancelled": False,
         "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
         "stage": "spec", "status": "in_progress", "order": 10,
         "createdAt": now - H, "updatedAt": now - H},
        {"id": "seed-card-2", "title": "Triage incoming agent work",
         "description": "Seeded card.", "project": "infra", "agent": "OpenCode",
         "priority": "high", "acceptance": "", "verification": "",
         "links": [{"label": "brief", "url": "https://example.com/brief"}],
         "session": None, "blocked": True, "blockedReason": "waiting on api spec",
         "cancelled": False, "touches": [], "dependsOn": [], "blocks": [],
         "conflictsWith": [], "stage": "backlog", "status": None, "order": 10,
         "createdAt": now - 2 * H, "updatedAt": now - 2 * H},
    ]
    board_payload = json.dumps({"version": 2, "cards": board_cards})
    # Guarded: the init script runs on every navigation, so on reload the
    # app's own persisted state must win — otherwise the seed would wipe the
    # card the test just created.
    context.add_init_script(
        f"if (!localStorage.getItem('acp-ui:activity.json'))"
        f" localStorage.setItem('acp-ui:activity.json', {json.dumps(payload)});"
        f"if (!localStorage.getItem('acp-ui:board.json'))"
        f" localStorage.setItem('acp-ui:board.json', {json.dumps(board_payload)});"
    )


def main():
    SHOTS.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
        seed_ledger(context)
        page = context.new_page()
        page.route(re.compile(r":25900/"), lambda route: route.abort())
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)

        # 1. Rail switches to the Board view.
        page.click('button[aria-label="Board"]')
        page.wait_for_selector(".view-pane .tab-bar", timeout=5000)
        check("rail switches to Board view", page.locator(".view-pane h2").inner_text() == "Board")

        # 2. All six pipeline stages render.
        cols = page.locator(".board-col")
        check("all six stages render", cols.count() == 6, f"found {cols.count()}")
        expected = ["backlog", "spec", "plan", "dev", "reviewtest", "done"]
        got = [cols.nth(i).get_attribute("data-col") for i in range(cols.count())]
        check("stage order backlog..done", got == expected, ",".join(got))

        # 3. Create a card -> lands in backlog, drawer opens, set title.
        page.locator('[data-col="backlog"] .col-add').click()
        page.wait_for_selector(".card-drawer", timeout=5000)
        check("create opens the side drawer", True)
        page.fill('[data-field="title"]', "E2E board card")
        page.fill('[data-field="description"]', "created by e2e_board.py")
        page.click(".drawer-foot .btn:text-is('Done')")
        page.wait_for_selector(".card-drawer", state="detached", timeout=5000)
        backlog_card = page.locator('[data-col="backlog"] .board-card', has_text="E2E board card")
        check("new card appears in backlog", backlog_card.count() == 1)
        check("backlog card has no status chip (status-less stage)",
              backlog_card.locator(".status-chip").count() == 0)

        # 4. Move it to Spec via the card menu; counts + status chip update.
        spec_before = page.locator('[data-col="spec"] .col-count').inner_text()
        backlog_card.hover()
        backlog_card.locator(".card-menu-btn").click()
        page.locator(".card-menu .menu-item", has_text="Spec").first.click()
        page.wait_for_selector('[data-col="spec"] .board-card', timeout=5000)
        page.wait_for_selector(
            '[data-col="spec"] .board-card .status-chip', timeout=5000)
        moved = page.locator('[data-col="spec"] .board-card', has_text="E2E board card")
        spec_after = page.locator('[data-col="spec"] .col-count').inner_text()
        check("card moved to spec via menu", moved.count() == 1)
        check("spec count incremented", spec_after == str(int(spec_before or "0") + 1),
              f"{spec_before} -> {spec_after}")
        check("moved card carries spec's initial status",
              moved.locator(".status-chip").inner_text() == "in_progress",
              moved.locator(".status-chip").inner_text())
        note = page.locator(".pane-note").inner_text()
        check("summary line updates", f"spec {spec_after}" in note, note)

        # 5. Flag the seeded blocked card — flag, badge and column marker.
        seeded_blocked = page.locator(".board-card", has_text="Triage incoming agent work")
        check("seeded blocked flag renders as badge",
              seeded_blocked.locator(".meta-chip.flag.blocked").count() == 1)
        check("backlog header counts blocked flags",
              page.locator('[data-col="backlog"] .col-blocked').inner_text() == "1 blocked")

        # 6. Reload -> card persists in spec. Give the debounced save a
        # beat (there is also a pagehide flush), then wait for the card.
        page.wait_for_timeout(700)
        page.reload(wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)
        page.click('button[aria-label="Board"]')
        page.wait_for_selector('[data-col="spec"] .board-card', timeout=5000)
        persisted = page.locator('[data-col="spec"] .board-card', has_text="E2E board card")
        check("card survives reload", persisted.count() == 1)
        check("status chip survives reload",
              persisted.locator(".status-chip").inner_text() == "in_progress")

        # 7. Secondary tabs render content.
        page.click('.tab-btn:text-is("Events")')
        page.wait_for_selector(".event-row", timeout=5000)
        n_events = page.locator(".event-row").count()
        check("Events tab shows rows", n_events > 0, f"{n_events} rows")
        page.screenshot(path=str(SHOTS / "board-events-1440x900.png"))

        page.click('.tab-btn:text-is("Agents")')
        # The tab's rows are executors keyed on `role.cli` (see AgentsTab.vue);
        # its fixture has no roles, so the honest empty state is shown instead.
        check("Agents tab shows its honest empty state",
              page.locator(".tab-empty").count() == 1
              and "No roles or claims yet" in page.locator(".tab-empty").inner_text(),
              page.locator(".tab-empty").inner_text()[:80])

        page.click('.tab-btn:text-is("Locks")')
        n_locks = page.locator(".lock-row").count()
        check("Locks tab shows lock rows", n_locks >= 1, f"{n_locks} rows")

        page.click('.tab-btn:text-is("Timeline")')
        n_days = page.locator(".day-row").count()
        check("Timeline tab shows day rows", n_days >= 1, f"{n_days} rows")
        if n_days:
            page.locator(".day-row").first.click()
            page.wait_for_timeout(200)
            check("day expands to events", page.locator(".day-events .event-row").count() > 0)
        page.screenshot(path=str(SHOTS / "board-timeline-1440x900.png"))

        # Screenshots: tasks view at the three required viewports.
        page.click('.tab-btn:text-is("Tasks")')
        page.wait_for_selector('[data-col="backlog"]', timeout=5000)
        page.screenshot(path=str(SHOTS / "board-1440x900.png"))

        # drawer screenshot for review
        page.locator('[data-col="spec"] .board-card', has_text="E2E board card").first.click()
        page.wait_for_selector(".card-drawer", timeout=5000)
        page.screenshot(path=str(SHOTS / "board-drawer-1440x900.png"))
        page.keyboard.press("Escape")
        page.wait_for_selector(".card-drawer", state="detached", timeout=5000)

        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "board-1024x768.png"))

        # Phone: fresh context at 390x844 — resizing a loaded desktop page
        # leaves the shell's sidebar drawer open, which is a pre-existing
        # App.vue quirk unrelated to the board.
        phone = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 390, "height": 844})
        seed_ledger(phone)
        p2 = phone.new_page()
        p2.route(re.compile(r":25900/"), lambda route: route.abort())
        p2.on("pageerror", lambda exc: page_errors.append(str(exc)))
        p2.goto(BASE, wait_until="load")
        p2.wait_for_selector(".view-rail")
        p2.click('button[aria-label="Board"]')
        p2.wait_for_selector(".col-switcher", timeout=5000)
        check("phone layout shows stage switcher", p2.locator(".switch-btn").count() == 6)
        # switch to the stage holding the moved card
        p2.locator(".switch-btn", has_text="Spec").click()
        p2.wait_for_timeout(200)
        p2.screenshot(path=str(SHOTS / "board-390x844.png"))
        phone.close()

        # 8. No page errors.
        check("zero pageerror events", len(page_errors) == 0,
              "; ".join(page_errors[:3]) if page_errors else "")

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
