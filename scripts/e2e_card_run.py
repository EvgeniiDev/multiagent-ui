#!/usr/bin/env python3
"""E2E for card visibility (pipeline requirements E / P7): the running
orchestrator and its subagents shown on the board card.

Serves `dist-web/` itself on http://127.0.0.1:25984/ and seeds the shared
state docs in localStorage (every :25900 call is failed, so the panel uses
its localStorage backend — nothing touches ~/.hermes):

  * board.json  — four dev cards: a claimed run, an idle session, a
    finished run, and a plain card with no session;
  * claims.json — one live claim on the first card;
  * activity.json — `delegate` entries for the live run's session (one
    running subagent, one finished) and a terminal `exit=` entry for the
    finished run's session.

Asserts:

  1. the claimed card shows the orchestrator line — agent, session,
     state `идёт`, a ticking duration — and one row per delegated
     subagent, with the subagent's own state;
  2. a card whose session has NO delegate events shows `ждёт` and zero
     subagent rows ("без событий строк нет");
  3. a card with a terminal ledger entry and no live claim shows
     `завершён` and the run's duration;
  4. a card with neither claim nor session shows no run block at all;
  5. LIVE: a `delegate` entry written into the ledger through the store's
     own `recordEntry` (window.__activity, same path session.ts uses)
     makes a new subagent row appear on the card, and its finishing event
     flips the row to `завершён`;
  6. zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_card_run.py
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

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def board_doc(now):
    def card(cid, title, session=None):
        return {
            "id": cid, "title": title, "description": "seeded p7 card",
            "project": "", "agent": "", "priority": "medium",
            "acceptance": "", "verification": "", "links": [],
            "session": session,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
            "stage": "dev", "status": "in_progress", "statusByStage": {},
            "order": 10, "createdAt": now - 3600_000, "updatedAt": now - 60_000,
        }

    return {
        "version": 2,
        "cards": [
            card("run-live", "P7 live run card",
                 {"agentName": "orch-dev", "sessionId": "sess-orch-1"}),
            card("run-wait", "P7 idle session card",
                 {"agentName": "orch-dev", "sessionId": "sess-orch-2"}),
            card("run-fin", "P7 finished run card",
                 {"agentName": "orch-dev", "sessionId": "sess-orch-3"}),
            card("run-plain", "P7 plain card"),
        ],
    }


def claims_doc(now):
    return {
        "version": 1,
        "claims": {
            "run-live": {
                "agentName": "orch-dev",
                "sessionId": "sess-orch-1",
                "leaseUntil": now + 600_000,
                "startedAt": now - 120_000,
                "claimedAt": now - 120_000,
                "pid": 424242,
                "roleId": "dev",
                "runnerId": "e2e-runner",
                "stage": "dev",
                "hbAt": now - 1_000,
            }
        },
        "attempts": {},
    }


def activity_doc(now):
    entries = [
        # The finished run: claimed -> start -> exit (terminal record).
        {"id": "e-fin-1", "at": now - 300_000, "kind": "card",
         "agentName": "orch-dev", "sessionId": "sess-orch-3",
         "title": "P7 finished run card",
         "detail": "claimed run-fin lease=45m role=dev"},
        {"id": "e-fin-2", "at": now - 299_000, "kind": "card",
         "agentName": "orch-dev", "sessionId": "sess-orch-3",
         "title": "P7 finished run card",
         "detail": "start run-fin attempt=1/1 pid=4242"},
        {"id": "e-fin-3", "at": now - 90_000, "kind": "card",
         "agentName": "orch-dev", "sessionId": "sess-orch-3",
         "title": "P7 finished run card",
         "detail": "exit=0 dur=209s attempt=1/1 finished verdict: none log: run-1.log"},
        # The live run's subagents: one running, one finished.
        {"id": "e-sub-1", "at": now - 60_000, "kind": "delegate",
         "agentName": "orch-dev", "sessionId": "sess-orch-1",
         "title": "explore-auth", "detail": "map the auth flow",
         "subagent": "explore-auth", "subState": "running",
         "goal": "map the auth flow"},
        {"id": "e-sub-2", "at": now - 50_000, "kind": "delegate",
         "agentName": "orch-dev", "sessionId": "sess-orch-1",
         "title": "impl-board", "detail": "build the run block",
         "subagent": "impl-board", "subState": "running",
         "goal": "build the run block"},
        {"id": "e-sub-3", "at": now - 20_000, "kind": "delegate",
         "agentName": "orch-dev", "sessionId": "sess-orch-1",
         "title": "impl-board", "detail": "landed in 3 files",
         "subagent": "impl-board", "subState": "done",
         "endedAt": now - 20_000},
        # Noise: a delegate event for a DIFFERENT session must not leak
        # into this card's rows.
        {"id": "e-sub-x", "at": now - 10_000, "kind": "delegate",
         "agentName": "other-orch", "sessionId": "sess-other",
         "title": "stray-sub", "detail": "unrelated work",
         "subagent": "stray-sub", "subState": "running",
         "goal": "unrelated work"},
    ]
    return {"entries": entries, "usage": []}


def seed(context, now):
    pairs = [
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
        ("acp-ui:board.json", board_doc(now)),
        ("acp-ui:claims.json", claims_doc(now)),
        ("acp-ui:activity.json", activity_doc(now)),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def down_state(route):
    """Every state-server call fails -> the panel falls back to localStorage."""
    route.fulfill(status=500, content_type="application/json",
                  body=json.dumps({"error": "state server down"}))


def dev_card(page, cid):
    return page.locator(f'[data-col="dev"] .board-card[data-card-id="{cid}"]')


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
    now = int(time.time() * 1000)

    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1440, "height": 900}
            )
            seed(ctx, now)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.route(re.compile(r":25900/"), down_state)

            page.goto(BASE, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.wait_for_function("() => window.__activity", timeout=10000)
            page.click('button[aria-label="Board"]')
            page.wait_for_selector('[data-col="dev"] .board-card', timeout=5000)

            # ---- 1. live run: orchestrator line + subagent rows ---------
            live = dev_card(page, "run-live")
            check("live card renders", live.count() == 1)
            check("live card shows run block",
                  live.locator('[data-testid="run-block"]').count() == 1)
            check("live run state is идёт",
                  live.locator('[data-testid="run-state"]').inner_text() == "идёт",
                  live.locator('[data-testid="run-state"]').inner_text())
            check("orchestrator agent shown",
                  "orch-dev" in live.locator(".run-agent").inner_text(),
                  live.locator(".run-agent").inner_text())
            check("session id shown",
                  "sess-orch-1" in live.locator(".run-sess").inner_text(),
                  live.locator(".run-sess").inner_text())
            dur = live.locator('[data-testid="run-duration"]').inner_text()
            check("run duration shown (started 2m ago)",
                  re.fullmatch(r"\d+[smh].*", dur) is not None, dur)

            subs = live.locator('[data-testid="subagent-row"]')
            check("two subagent rows from the ledger", subs.count() == 2,
                  f"{subs.count()} rows")
            explore = live.locator('[data-testid="subagent-row"]', has_text="explore-auth")
            check("running subagent state идёт",
                  explore.count() == 1
                  and explore.locator(".sub-state").inner_text() == "идёт"
                  and explore.get_attribute("data-state") == "running",
                  explore.inner_text() if explore.count() else "missing")
            impl = live.locator('[data-testid="subagent-row"]', has_text="impl-board")
            check("finished subagent state завершён",
                  impl.count() == 1
                  and impl.locator(".sub-state").inner_text() == "завершён"
                  and impl.get_attribute("data-state") == "done",
                  impl.inner_text() if impl.count() else "missing")
            check("foreign-session delegate does not leak",
                  live.locator('[data-testid="subagent-row"]',
                               has_text="stray-sub").count() == 0)

            # ---- 2. idle session: ждёт, no subagent rows ----------------
            wait = dev_card(page, "run-wait")
            check("idle card shows ждёт",
                  wait.locator('[data-testid="run-state"]').inner_text() == "ждёт",
                  wait.locator('[data-testid="run-state"]').inner_text())
            check("idle card: no delegate events -> no subagent rows",
                  wait.locator('[data-testid="subagent-row"]').count() == 0)

            # ---- 3. finished run: завершён + duration -------------------
            fin = dev_card(page, "run-fin")
            check("finished card shows завершён",
                  fin.locator('[data-testid="run-state"]').inner_text() == "завершён",
                  fin.locator('[data-testid="run-state"]').inner_text())
            fdur = fin.locator('[data-testid="run-duration"]').inner_text()
            check("finished run duration shown",
                  re.fullmatch(r"\d+[smh].*", fdur) is not None, fdur)

            # ---- 4. plain card: no run block -----------------------------
            plain = dev_card(page, "run-plain")
            check("plain card has no run block",
                  plain.locator('[data-testid="run-block"]').count() == 0)

            # ---- 5. live ledger write -> new subagent row ----------------
            page.evaluate(
                """() => window.__activity.recordEntry({
                    kind: 'delegate', agentName: 'orch-dev',
                    sessionId: 'sess-orch-1', title: 'review-diffs',
                    detail: 'check the diff', subagent: 'review-diffs',
                    subState: 'running', goal: 'check the diff' })"""
            )
            new_row = live.locator('[data-testid="subagent-row"]', has_text="review-diffs")
            new_row.wait_for(timeout=5000)
            n_rows = live.locator('[data-testid="subagent-row"]').count()
            check("ledger write -> new subagent row appears",
                  n_rows == 3
                  and new_row.locator(".sub-state").inner_text() == "идёт",
                  f"{n_rows} rows")

            page.evaluate(
                """() => window.__activity.recordEntry({
                    kind: 'delegate', agentName: 'orch-dev',
                    sessionId: 'sess-orch-1', title: 'review-diffs',
                    detail: '2 files look fine', subagent: 'review-diffs',
                    subState: 'done', endedAt: Date.now() })"""
            )
            page.wait_for_timeout(300)
            check("finish event -> subagent row завершён",
                  new_row.locator(".sub-state").inner_text() == "завершён",
                  new_row.inner_text())

            page.screenshot(path=str(SHOTS / "card-run-1440x900.png"))

            # ---- 6. no page errors ---------------------------------------
            check("zero pageerror events", len(page_errors) == 0,
                  "; ".join(page_errors[:3]) if page_errors else "")

            browser.close()
    finally:
        stop(server)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
