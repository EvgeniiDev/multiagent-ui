#!/usr/bin/env python3
"""E2E for the W5 roles registry (role = CLI + args + prompt file) and the
stage -> role binding on the board.

Serves `dist-web/` itself on http://127.0.0.1:25983/ and asserts:

  * a role is created through the Settings -> Roles form, lands in
    `acp-ui:roles.json` (version 1) and survives a page reload;
  * a duplicate `id` and invalid limits (maxConcurrent < 1,
    pollIntervalSec < 5, timeoutMin < 1) are rejected with a visible error;
  * deleting a role still assigned to a stage is rejected with a visible
    error, and the explicit Force delete path clears the assignment;
  * the column header carries the stage-role selector (value = the assigned
    role) and the stage's cards carry the role badge;
  * a role whose CLI has no configured runner (codex: no agent on the
    seeded config) shows the `no runner for role` badge on the card;
  * the prompt file round-trips through the real bridge fs API
    (GET /api/fs/read -> 404 shown honestly, POST /api/fs/write creates the
    file, a reopen loads the saved content) — test files stay inside
    ./tmp-roles-test in the worktree;
  * zero `pageerror` events.

Isolation: every `:25900` state-server call is failed by a route so the
panel falls back to localStorage — nothing is written to ~/.hermes. The
only host-side writes are the prompt files under ./tmp-roles-test.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_roles.py
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
TESTDATA = ROOT / "tmp-roles-test"
PORT = 25983
BASE = f"http://127.0.0.1:{PORT}/"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def board_doc():
    """A v2 board: one card in backlog, spec and dev."""
    now = int(time.time() * 1000)

    def card(cid, title, stage, status):
        return {
            "id": cid, "title": title, "description": "seeded w5 card",
            "project": "", "agent": "", "priority": "medium",
            "acceptance": "", "verification": "", "links": [], "session": None,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
            "stage": stage, "status": status, "statusByStage": {},
            "order": 10, "createdAt": now, "updatedAt": now,
        }

    return {
        "version": 2,
        "cards": [
            card("w5-backlog", "W5 backlog card", "backlog", None),
            card("w5-spec", "W5 spec card", "spec", "in_progress"),
            card("w5-dev", "W5 dev card", "dev", "in_progress"),
        ],
    }


REGISTRY = {
    "version": 1,
    "projects": [
        {"id": "p-common", "name": "Common", "path": "/home/hermes/projects",
         "createdAt": 1700000000000},
    ],
    "activeProjectId": "all",
}


def seed(context):
    pairs = [
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
        ("acp-ui:projects.json", REGISTRY),
        ("acp-ui:board.json", board_doc()),
    ]
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def down_state(route):
    """Every state-server call fails -> the panel falls back to localStorage,
    so the test never touches ~/.hermes/acp-ui-state."""
    route.fulfill(status=500, content_type="application/json",
                  body=json.dumps({"error": "state server down"}))


def open_settings(page):
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1500)
    btn = page.get_by_role("button", name="Settings")
    assert btn.count() > 0, "no Settings button"
    btn.first.click()
    page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)


def read_roles_doc(page):
    return page.evaluate(
        "() => JSON.parse(localStorage.getItem('acp-ui:roles.json') || '{}')"
    )


def open_board(page):
    # Close the settings overlay if it is still up — it covers the rail.
    overlay = page.locator(".settings-overlay")
    if overlay.count() and overlay.first.is_visible():
        page.get_by_role("button", name="Close").first.click()
        page.wait_for_timeout(300)
    page.click('button[aria-label="Board"]')
    page.wait_for_selector(".board-col", timeout=5000)
    page.wait_for_timeout(300)


def fill_role_form(section, rid, label, cli, prompt_file, args="",
                   maxc=1, poll=15, timeout=45):
    section.get_by_test_id("role-id").fill(rid)
    section.get_by_test_id("role-label").fill(label)
    section.get_by_test_id("role-cli").select_option(cli)
    section.get_by_test_id("role-args").fill(args)
    section.get_by_test_id("role-prompt").fill(prompt_file)
    section.get_by_test_id("role-maxc").fill(str(maxc))
    section.get_by_test_id("role-poll").fill(str(poll))
    section.get_by_test_id("role-timeout").fill(str(timeout))


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    TESTDATA.mkdir(exist_ok=True)
    SHOTS.mkdir(exist_ok=True)
    prompt_dev = TESTDATA / "dev.md"
    prompt_ghost = TESTDATA / "ghost.md"
    for f in (prompt_dev, prompt_ghost):
        if f.exists():
            f.unlink()

    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1440, "height": 900}
            )
            seed(ctx)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.route(re.compile(r":25900/"), down_state)

            # ---------------- create + persist -----------------------------
            open_settings(page)
            section = page.get_by_test_id("settings-roles")
            check("settings roles section renders", section.count() == 1)

            section.get_by_test_id("roles-add-toggle").click()
            fill_role_form(
                section, "dev", "Developer", "devin", str(prompt_dev),
                args="-p --model swe-2-max", maxc=2, poll=15, timeout=45,
            )
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(300)
            check("role row appears", section.get_by_test_id("role-dev").count() == 1)
            page.wait_for_timeout(800)  # debounced save
            doc = read_roles_doc(page)
            devs = [r for r in doc.get("roles", []) if r.get("id") == "dev"]
            check("role persisted in roles.json", len(devs) == 1, json.dumps(doc)[:300])
            check("roles.json version is 1", doc.get("version") == 1)
            if devs:
                check("role fields round-trip",
                      devs[0].get("cli") == "devin"
                      and devs[0].get("promptFile") == str(prompt_dev)
                      and devs[0].get("maxConcurrent") == 2
                      and devs[0].get("args") == ["-p", "--model", "swe-2-max"],
                      json.dumps(devs[0])[:200])

            # survives a reload
            page.reload(wait_until="load")
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Settings").first.click()
            page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)
            check("role survives reload",
                  page.get_by_test_id("role-dev").count() == 1)

            # ---------------- validation ---------------------------------
            section.get_by_test_id("roles-add-toggle").click()
            fill_role_form(section, "dev", "Dupe", "devin", str(prompt_dev))
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            err = section.get_by_test_id("roles-error")
            check("duplicate id rejected with visible error",
                  err.count() == 1 and "already exists" in err.inner_text(),
                  err.inner_text() if err.count() else "no error")
            check("duplicate id not added",
                  section.locator(".role-item").count() == 1)

            fill_role_form(section, "badlimits", "Bad", "devin", str(prompt_dev),
                           maxc=0)
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            check("maxConcurrent < 1 rejected",
                  "maxConcurrent" in section.get_by_test_id("roles-error").inner_text())
            fill_role_form(section, "badlimits", "Bad", "devin", str(prompt_dev),
                           poll=3)
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            check("pollIntervalSec < 5 rejected",
                  "pollIntervalSec" in section.get_by_test_id("roles-error").inner_text())
            fill_role_form(section, "badlimits", "Bad", "devin", str(prompt_dev),
                           timeout=0)
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            check("timeoutMin < 1 rejected",
                  "timeoutMin" in section.get_by_test_id("roles-error").inner_text())
            check("invalid role not added",
                  section.locator(".role-item").count() == 1)
            section.get_by_test_id("role-cancel").click()

            # second role: codex — a known CLI with no configured runner
            section.get_by_test_id("roles-add-toggle").click()
            fill_role_form(section, "ghost", "Ghost", "codex", str(prompt_ghost))
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(300)
            check("second role created", section.get_by_test_id("role-ghost").count() == 1)
            check("codex role flagged no-runner in the list",
                  section.get_by_test_id("role-ghost")
                  .get_by_test_id("role-no-runner").count() == 1)

            # ---------------- stage -> role --------------------------------
            section.get_by_test_id("stage-role-dev").select_option("dev")
            section.get_by_test_id("stage-role-spec").select_option("ghost")
            page.wait_for_timeout(300)
            check("stage assignments in the selects",
                  section.get_by_test_id("stage-role-dev").input_value() == "dev"
                  and section.get_by_test_id("stage-role-spec").input_value() == "ghost")

            # delete-while-assigned is rejected without force
            section.get_by_test_id("role-delete-dev").click()
            page.wait_for_timeout(200)
            err = section.get_by_test_id("roles-error")
            check("delete of assigned role rejected",
                  err.count() == 1 and "assigned to stage" in err.inner_text(),
                  err.inner_text() if err.count() else "no error")
            check("assigned role still listed",
                  section.get_by_test_id("role-dev").count() == 1)
            check("force delete offered after rejection",
                  section.get_by_test_id("role-force-delete-dev").count() == 1)

            # ---------------- prompt file via the bridge -------------------
            section.get_by_test_id("role-prompt-btn-dev").click()
            page.wait_for_selector('[data-testid="prompt-editor"]', timeout=5000)
            page.wait_for_timeout(1200)
            perr = section.get_by_test_id("prompt-error")
            check("missing prompt file shows the bridge error",
                  perr.count() == 1 and perr.inner_text().strip() != "",
                  perr.inner_text() if perr.count() else "no error element")
            shown_path = section.get_by_test_id("prompt-path").inner_text()
            check("prompt path shown is the role's promptFile",
                  shown_path == str(prompt_dev), shown_path)
            section.get_by_test_id("prompt-content").fill("# Dev role\nDo dev things.\n")
            section.get_by_test_id("prompt-save").click()
            page.wait_for_timeout(1200)
            check("prompt write lands on disk via the bridge",
                  prompt_dev.exists() and "Do dev things." in prompt_dev.read_text(),
                  str(prompt_dev))
            check("save status shown",
                  "saved" in (section.get_by_test_id("prompt-status").inner_text()
                              if section.get_by_test_id("prompt-status").count() else ""))
            section.get_by_test_id("prompt-close").click()
            section.get_by_test_id("role-prompt-btn-dev").click()
            page.wait_for_timeout(1200)
            check("reopened editor loads the saved content",
                  "Do dev things." in section.get_by_test_id("prompt-content").input_value())
            section.get_by_test_id("prompt-close").click()

            # ---------------- board: selector + badges ---------------------
            open_board(page)
            dev_sel = page.locator('[data-col="dev"] [data-testid="col-role-select"]')
            check("dev column selector shows the assigned role",
                  dev_sel.count() == 1 and dev_sel.input_value() == "dev",
                  dev_sel.input_value() if dev_sel.count() else "no select")
            spec_sel = page.locator('[data-col="spec"] [data-testid="col-role-select"]')
            check("spec column selector shows ghost",
                  spec_sel.count() == 1 and spec_sel.input_value() == "ghost")
            check("unassigned column selector is empty",
                  page.locator('[data-col="plan"] [data-testid="col-role-select"]')
                  .input_value() == "")

            dev_card = page.locator('[data-col="dev"] .board-card', has_text="W5 dev card")
            check("dev card carries the role badge",
                  dev_card.get_by_test_id("card-role-badge").count() == 1
                  and dev_card.get_by_test_id("card-role-badge").inner_text() == "Developer",
                  dev_card.get_by_test_id("card-role-badge").inner_text()
                  if dev_card.get_by_test_id("card-role-badge").count() else "no badge")
            check("dev role has a runner (no warning badge)",
                  dev_card.get_by_test_id("card-no-runner").count() == 0)

            spec_card = page.locator('[data-col="spec"] .board-card', has_text="W5 spec card")
            check("spec card carries the ghost role badge",
                  spec_card.get_by_test_id("card-role-badge").count() == 1)
            check("codex role shows 'no runner for role' on the card",
                  spec_card.get_by_test_id("card-no-runner").count() == 1
                  and spec_card.get_by_test_id("card-no-runner").inner_text()
                  == "no runner for role")

            backlog_card = page.locator('[data-col="backlog"] .board-card')
            check("unassigned stage shows no role badge",
                  backlog_card.get_by_test_id("card-role-badge").count() == 0)

            # column selector writes through: plan -> dev role
            page.locator('[data-col="plan"] [data-testid="col-role-select"]') \
                .select_option("dev")
            page.wait_for_timeout(300)
            check("column header can assign a role",
                  page.locator('[data-col="plan"] [data-testid="col-role-select"]')
                  .input_value() == "dev")
            page.locator('[data-col="plan"] [data-testid="col-role-select"]') \
                .select_option("")
            page.wait_for_timeout(300)

            page.screenshot(path=str(SHOTS / "roles-board-1440x900.png"))

            # ---------------- force delete --------------------------------
            page.get_by_role("button", name="Settings").first.click()
            page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)
            page.get_by_test_id("role-delete-dev").click()
            page.wait_for_timeout(200)
            page.get_by_test_id("role-force-delete-dev").click()
            page.wait_for_timeout(300)
            check("force delete removes the role",
                  page.get_by_test_id("role-dev").count() == 0)
            page.wait_for_timeout(800)
            doc = read_roles_doc(page)
            check("force delete clears the stage assignment",
                  doc.get("stageRoles", {}).get("dev") is None
                  and doc.get("stageRoles", {}).get("spec") == "ghost",
                  json.dumps(doc.get("stageRoles", {})))

            ctx.close()
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
