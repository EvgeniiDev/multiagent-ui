#!/usr/bin/env python3
"""E2E for the kanban pipeline (W-B / v2 §C/§E/§F), against the real web build.

Serves `dist-web/` itself on http://127.0.0.1:25984/ and asserts:

  * migration — a seeded v1 board (all seven legacy columns populated, plus
    malformed entries) loads into the six-stage model: right stage, right
    in-stage status, `blocked`/`cancelled` as card flags, `blockedBy` kept as
    `blockedReason`, nothing lost, `version` bumped to 2;
  * the six stages render in order and the stage header carries the
    per-status breakdown plus a separate blocked-flag count;
  * the status chip on a card opens the stage's status picker, the change
    applies and survives a reload;
  * moving a card to another stage applies that stage's initial status;
    `accepted` in reviewtest sends the card to done;
  * `blocked`/`cancelled` flags set, render (badge + card mark) and clear
    from the card menu;
  * project scope — the global selector filters the board to the project's
    cards, the board's own `All` button returns the full board, and a card
    outside every project is marked `unassigned`;
  * 390x844 — stage switcher, touch targets >= 44px, no horizontal scroll;
  * zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_board_pipeline.py

Screenshots land in docs/pipeline-*.png. Prints PASS/FAIL per assertion and
exits non-zero on any failure.
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
SHOTS = ROOT / "docs"
PORT = 25984
BASE = f"http://127.0.0.1:{PORT}/"
MIN_TOUCH = 44.0
EPS = 0.6

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

REGISTRY = {
    "version": 1,
    "projects": [
        {"id": "p-common", "name": "Common", "path": "/home/hermes/projects",
         "createdAt": 1700000000000},
        {"id": "p-alpha", "name": "Alpha", "path": "/home/hermes/projects/alpha",
         "createdAt": 1700000001000},
        {"id": "p-beta", "name": "Beta", "path": "/home/hermes/projects/beta",
         "createdAt": 1700000002000},
    ],
    "activeProjectId": "all",
}


def legacy_board():
    """A v1 board: the seven old columns, a card in each, plus malformed
    entries that must be dropped by sanitizeCard."""
    now = int(time.time() * 1000)
    H = 3600 * 1000

    def card(cid, title, status, project="", blockedBy=""):
        return {
            "id": cid, "title": title, "description": "seeded v1 card",
            "project": project, "agent": "", "priority": "medium",
            "acceptance": "", "verification": "", "links": [], "session": None,
            "blockedBy": blockedBy, "status": status, "order": 10,
            "createdAt": now - H, "updatedAt": now - H,
        }

    return {
        "version": 1,
        "cards": [
            card("mig-inbox", "Legacy: triage idea", "inbox", "alpha"),
            card("mig-ready", "Legacy: ready work", "ready", "alpha"),
            card("mig-blocked", "Legacy: blocked task", "blocked", "beta",
                 blockedBy="waiting on api spec"),
            card("mig-active", "Legacy: active dev", "active", "beta"),
            # no project -> unassigned, visible in All only
            card("mig-review", "Legacy: in review", "review", ""),
            card("mig-done", "Legacy: finished", "done", "alpha"),
            card("mig-cancelled", "Legacy: dropped", "cancelled", "beta"),
            # a label that matches no project -> unassigned too
            card("mig-ghost", "Legacy: orphan project", "ready", "ghost"),
            {"id": "mig-broken"},          # no title -> dropped
            42,                            # not an object -> dropped
        ],
    }


def seed(context):
    """Guarded localStorage seed: registry + v1 board + telemetry off.
    The guard keeps the app's own persisted state on reload (migration and
    status edits must survive it)."""
    pairs = [
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
        ("acp-ui:projects.json", REGISTRY),
        ("acp-ui:board.json", legacy_board()),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def card_titles(page, stage):
    return sorted(
        page.eval_on_selector_all(
            f'[data-col="{stage}"] .board-card .card-title',
            "els => els.map(e => e.textContent.trim())",
        )
    )


def col_count(page, stage):
    return page.locator(f'[data-col="{stage}"] .board-card').count()


def open_card_menu(card):
    card.hover()
    card.locator(".card-menu-btn").click()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
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


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        page.route(re.compile(r":25900/"), lambda r: r.abort())
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)
        page.click('button[aria-label="Board"]')
        page.wait_for_selector(".board-col", timeout=5000)

        # ---------------- migration --------------------------------------
        # The migrated document is persisted right after load; poll briefly
        # so the assert doesn't race the write.
        stored_version = None
        for _ in range(20):
            stored_version = page.evaluate(
                "() => { const d = JSON.parse(localStorage.getItem('acp-ui:board.json') || '{}');"
                " return d.version ?? null; }"
            )
            if stored_version == 2:
                break
            page.wait_for_timeout(150)
        check("migration: board.json bumped to version 2",
              stored_version == 2, f"version={stored_version}")

        total = page.locator(".board-card").count()
        check("migration: all 8 valid cards survive, 2 malformed dropped",
              total == 8, f"{total} cards")

        check("migration: inbox -> backlog",
              "Legacy: triage idea" in card_titles(page, "backlog"))
        check("migration: blocked column -> backlog + blocked flag",
              "Legacy: blocked task" in card_titles(page, "backlog"))
        check("migration: ready -> spec",
              "Legacy: ready work" in card_titles(page, "spec"))
        check("migration: active -> dev",
              "Legacy: active dev" in card_titles(page, "dev"))
        check("migration: review -> reviewtest",
              "Legacy: in review" in card_titles(page, "reviewtest"))
        check("migration: done -> done, cancelled -> done",
              card_titles(page, "done") ==
              ["Legacy: dropped", "Legacy: finished"],
              ",".join(card_titles(page, "done")))

        spec_chip = page.locator('[data-col="spec"] .board-card .status-chip')
        check("migration: ready -> spec carries in_progress status",
              spec_chip.count() >= 1 and
              spec_chip.first.inner_text() == "in_progress",
              spec_chip.first.inner_text() if spec_chip.count() else "no chip")
        check("migration: review -> reviewtest carries in_progress status",
              page.locator('[data-col="reviewtest"] .board-card .status-chip')
              .first.inner_text() == "in_progress")

        blocked_card = page.locator(".board-card", has_text="Legacy: blocked task")
        check("migration: blocked flag renders as badge on the card",
              blocked_card.locator(".meta-chip.flag.blocked").count() == 1)
        check("migration: blocked card carries the flag mark",
              "flag-blocked" in (blocked_card.get_attribute("class") or ""))
        reason_title = blocked_card.locator(".meta-chip.flag.blocked").get_attribute("title")
        check("migration: blockedBy kept as blockedReason",
              bool(reason_title) and "waiting on api spec" in reason_title,
              str(reason_title))
        cancelled_card = page.locator(".board-card", has_text="Legacy: dropped")
        check("migration: cancelled column -> done + cancelled flag",
              cancelled_card.locator(".meta-chip.flag.cancelled").count() == 1)

        # ---------------- stage rendering --------------------------------
        cols = page.locator(".board-col")
        got = [cols.nth(i).get_attribute("data-col") for i in range(cols.count())]
        check("six stages render in pipeline order",
              got == ["backlog", "spec", "plan", "dev", "reviewtest", "done"],
              ",".join(got))

        backlog_statuses = page.locator('[data-col="backlog"] .col-statuses')
        check("backlog header shows no status breakdown (status-less stage)",
              backlog_statuses.count() == 0)
        spec_breakdown = page.locator('[data-col="spec"] .col-statuses')
        check("spec header shows status breakdown",
              spec_breakdown.count() == 1 and
              spec_breakdown.inner_text() == "in_progress 2",
              spec_breakdown.inner_text() if spec_breakdown.count() else "none")
        blocked_mark = page.locator('[data-col="backlog"] .col-blocked')
        check("backlog header counts blocked flags separately",
              blocked_mark.count() == 1 and blocked_mark.inner_text() == "1 blocked",
              blocked_mark.inner_text() if blocked_mark.count() else "none")

        # ---------------- status picker on the card ----------------------
        ready_card = page.locator('[data-col="spec"] .board-card',
                                  has_text="Legacy: ready work")
        ready_card.locator(".status-chip").click()
        page.wait_for_selector(".status-menu", timeout=5000)
        menu_items = page.locator(".status-menu .menu-item")
        check("status picker lists the stage's statuses",
              [menu_items.nth(i).inner_text() for i in range(menu_items.count())]
              == ["in_progress", "review", "done"])
        menu_items.filter(has_text="review").first.click()
        check("status change applies on the card",
              ready_card.locator(".status-chip").inner_text() == "review")
        check("spec header breakdown follows the status change",
              page.locator('[data-col="spec"] .col-statuses').inner_text()
              == "in_progress 1 / review 1")

        # survives a reload (debounced save + pagehide flush)
        page.wait_for_timeout(800)
        page.reload(wait_until="load")
        page.wait_for_selector(".view-rail", timeout=10000)
        page.click('button[aria-label="Board"]')
        page.wait_for_selector(".board-col", timeout=5000)
        persisted = page.locator('[data-col="spec"] .board-card',
                                 has_text="Legacy: ready work")
        check("status survives reload",
              persisted.locator(".status-chip").inner_text() == "review",
              persisted.locator(".status-chip").inner_text())

        # ---------------- stage move applies the initial status ----------
        open_card_menu(persisted)
        page.locator(".card-menu .menu-item", has_text="Plan").first.click()
        moved = page.locator('[data-col="plan"] .board-card',
                             has_text="Legacy: ready work")
        page.wait_for_timeout(200)
        check("card moved to plan via the card menu", moved.count() == 1)
        check("stage move applies the stage's initial status",
              moved.locator(".status-chip").inner_text() == "in_progress",
              moved.locator(".status-chip").inner_text())

        # Back to spec: the card had a status of this stage ('review'), so
        # the move restores it instead of resetting to the initial.
        open_card_menu(moved)
        page.locator(".card-menu .menu-item", has_text="Spec").first.click()
        back = page.locator('[data-col="spec"] .board-card',
                            has_text="Legacy: ready work")
        page.wait_for_timeout(200)
        check("return to a visited stage restores its status",
              back.locator(".status-chip").inner_text() == "review",
              back.locator(".status-chip").inner_text())
        # Restore the spec flow for the screenshot: back to in_progress.
        back.locator(".status-chip").click()
        page.locator(".status-menu .menu-item", has_text="in_progress").click()

        # backlog card -> done: terminal stage, status cleared
        inbox_card = page.locator('[data-col="backlog"] .board-card',
                                  has_text="Legacy: triage idea")
        open_card_menu(inbox_card)
        page.locator(".card-menu .menu-item", has_text="Done").first.click()
        done_card = page.locator('[data-col="done"] .board-card',
                                 has_text="Legacy: triage idea")
        page.wait_for_timeout(200)
        check("card moved to done via the card menu", done_card.count() == 1)
        check("done stage carries no status chip",
              done_card.locator(".status-chip").count() == 0)

        # reviewtest: in_progress -> agent_tested -> accepted -> done
        rt_card = page.locator('[data-col="reviewtest"] .board-card',
                               has_text="Legacy: in review")
        rt_card.locator(".status-chip").click()
        page.locator(".status-menu .menu-item", has_text="agent_tested").click()
        check("reviewtest status -> agent_tested",
              rt_card.locator(".status-chip").inner_text() == "agent_tested")
        rt_card.locator(".status-chip").click()
        page.locator(".status-menu .menu-item", has_text="accepted").click()
        page.wait_for_timeout(200)
        check("accepted sends the card to done",
              page.locator('[data-col="done"] .board-card',
                           has_text="Legacy: in review").count() == 1)

        # ---------------- flags ------------------------------------------
        dev_card = page.locator('[data-col="dev"] .board-card',
                                has_text="Legacy: active dev")
        open_card_menu(dev_card)
        page.locator(".card-menu .menu-item", has_text="Flag blocked").click()
        check("blocked flag sets from the card menu",
              dev_card.locator(".meta-chip.flag.blocked").count() == 1)
        check("blocked flag marks the card",
              "flag-blocked" in (dev_card.get_attribute("class") or ""))
        check("dev header counts the blocked flag",
              page.locator('[data-col="dev"] .col-blocked').inner_text() == "1 blocked")

        open_card_menu(dev_card)
        page.locator(".card-menu .menu-item", has_text="Flag cancelled").click()
        check("cancelled flag sets and renders",
              dev_card.locator(".meta-chip.flag.cancelled").count() == 1 and
              "flag-cancelled" in (dev_card.get_attribute("class") or ""))

        open_card_menu(dev_card)
        page.locator(".card-menu .menu-item", has_text="Clear blocked flag").click()
        check("blocked flag clears",
              dev_card.locator(".meta-chip.flag.blocked").count() == 0)
        open_card_menu(dev_card)
        page.locator(".card-menu .menu-item", has_text="Clear cancelled flag").click()
        check("cancelled flag clears",
              dev_card.locator(".meta-chip.flag.cancelled").count() == 0)

        page.screenshot(path=str(SHOTS / "pipeline-1440x900.png"))

        # zoom on a card carrying its status chip
        chip_card = page.locator('[data-col="dev"] .board-card').first
        chip_card.screenshot(path=str(SHOTS / "pipeline-card-zoom.png"))

        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "pipeline-1024x768.png"))
        ctx.close()

        # ---------------- project scope + All -----------------------------
        # Fresh context: the migrated seed (unmutated) keeps the counts exact.
        sc = browser.new_context(ignore_https_errors=True,
                                 viewport={"width": 1440, "height": 900})
        seed(sc)
        sp = sc.new_page()
        sp.route(re.compile(r":25900/"), lambda r: r.abort())
        sp.on("pageerror", lambda exc: page_errors.append(str(exc)))
        sp.goto(BASE, wait_until="load")
        sp.wait_for_selector(".view-rail", timeout=10000)
        sp.click('button[aria-label="Board"]')
        sp.wait_for_selector(".board-col", timeout=5000)

        sp.select_option(".scope-select", label="Alpha")
        sp.wait_for_timeout(250)
        check("Alpha scope: board shows only Alpha cards",
              sp.locator(".board-card").count() == 3,
              f"{sp.locator('.board-card').count()} cards")
        check("Alpha scope: spec keeps only the Alpha card",
              card_titles(sp, "spec") == ["Legacy: ready work"],
              ",".join(card_titles(sp, "spec")))
        check("Alpha scope: unassigned card hidden",
              sp.locator(".board-card", has_text="Legacy: orphan project").count() == 0)

        sp.select_option(".scope-select", label="Beta")
        sp.wait_for_timeout(250)
        check("Beta scope: board shows only Beta cards",
              sp.locator(".board-card").count() == 3,
              f"{sp.locator('.board-card').count()} cards")

        sp.locator(".board-filters .f-scope-all").click()
        sp.wait_for_timeout(250)
        check("board All button returns the full board",
              sp.locator(".board-card").count() == 8,
              f"{sp.locator('.board-card').count()} cards")
        check("board All button drives the global selector",
              sp.eval_on_selector(".scope-select", "el => el.value") == "all")
        unassigned = sp.locator(".board-card .meta-chip.unassigned")
        check("All: cards outside projects are marked unassigned",
              unassigned.count() == 2, f"{unassigned.count()} chips")
        check("All: unassigned mark sits on the project-less cards",
              sp.locator(".board-card", has_text="Legacy: in review")
                  .locator(".meta-chip.unassigned").count() == 1 and
              sp.locator(".board-card", has_text="Legacy: orphan project")
                  .locator(".meta-chip.unassigned").count() == 1)
        sc.close()

        # ---------------- 390x844 ----------------------------------------
        phone = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 390, "height": 844})
        seed(phone)
        p2 = phone.new_page()
        p2.route(re.compile(r":25900/"), lambda r: r.abort())
        p2.on("pageerror", lambda exc: page_errors.append(str(exc)))
        p2.goto(BASE, wait_until="load")
        p2.wait_for_selector(".view-rail", timeout=10000)
        p2.click('button[aria-label="Board"]')
        p2.wait_for_selector(".col-switcher", timeout=5000)
        check("390: stage switcher renders", p2.locator(".switch-btn").count() == 6)

        switch_h = p2.eval_on_selector_all(
            ".switch-btn", "els => els.map(e => e.getBoundingClientRect().height)"
        )
        check("390: switcher buttons are >=44px touch targets",
              all(h >= MIN_TOUCH - EPS for h in switch_h),
              f"min {min(switch_h):.0f}px" if switch_h else "none")

        # switch to Spec — it holds status chips
        p2.locator(".switch-btn", has_text="Spec").click()
        p2.wait_for_selector('[data-col="spec"] .status-chip', timeout=5000)
        chip_h = p2.eval_on_selector_all(
            ".status-chip", "els => els.map(e => e.getBoundingClientRect().height)"
        )
        check("390: status chips are >=44px touch targets",
              all(h >= MIN_TOUCH - EPS for h in chip_h),
              f"min {min(chip_h):.0f}px" if chip_h else "none")

        all_h = p2.evaluate(
            "() => document.querySelector('.f-scope-all').getBoundingClientRect().height"
        )
        check("390: board All button is a >=44px touch target",
              all_h >= MIN_TOUCH - EPS, f"{all_h:.0f}px")

        hscroll = p2.evaluate(
            "() => document.documentElement.scrollWidth - window.innerWidth"
        )
        check("390: no page-level horizontal scroll", hscroll <= 1, f"{hscroll}px")
        p2.screenshot(path=str(SHOTS / "pipeline-390x844.png"))
        phone.close()

        browser.close()


if __name__ == "__main__":
    main()
