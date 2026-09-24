#!/usr/bin/env python3
"""E2E for the pipeline role files (.acp/roles/*.md) — the contract the
panel reads.

The role itself is DATA: `{id, cli, args, promptFile, maxConcurrent,
pollIntervalSec, timeoutMin, maxRetries}` (+ `review` for the reviewtest
role), and the panel's roles store is the code that parses it. This suite
seeds the documented records for the whole conveyor
(orchestrator/plan-writer/dev/pm/reviewer) on its OWN acp-state-server
(25961, STATE_DIR=<worktree>/tmp-rolefiles-test; the page's :25900 traffic
is proxied to it — the host service is never touched), serves dist-web on
25960, and asserts:

  * every seeded record survives the store's real load path
    (sanitizeRole): a role row renders per record and
    `role-promptfile-<id>` shows the file path;
  * the stage->role binding parses: `roleForStage` maps spec->orchestrator,
    plan->plan-writer, dev->dev, reviewtest->reviewer;
  * `addRole` (the store's write-time validateRole) accepts a well-formed
    record and persists it to roles.json on the state server;
  * the same validation rejects: cli outside KNOWN_CLIS, an empty
    promptFile ("Prompt file path is required"), and a `review` block
    whose blocking severities leave the vocabulary;
  * every record's promptFile exists on disk (resolved against the repo);
  * the two new prompt files carry the required tool names
    (orchestrator: boardctl / porch-dispatch / delegate;
    plan-writer: .acp/cards/<id>/ + 02_plan.md + STATUS token);
  * zero `pageerror` events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_role_files.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
STATE_DIR = ROOT / "tmp-rolefiles-test"
UI_PORT = 25960
STATE_PORT = 25961
BASE = f"http://127.0.0.1:{UI_PORT}/"
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def port_free(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.3).close()
    except OSError:
        return True
    return False


def wait_port(port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        STATE_URL + "/api/state" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def get_doc(name):
    status, body = api(f"/{name}")
    if status == 200:
        return body.get("data"), body.get("rev", 0)
    return None, 0


def put_doc(name, data):
    _, rev = get_doc(name)
    status, body = put_doc_raw(name, data, rev)
    assert status == 200, f"put {name} -> {status} {body}"


def put_doc_raw(name, data, rev):
    return api(f"/{name}", "PUT", {"data": data, "rev": rev})


def proxy_state(route):
    """Forward the page's :25900 calls to this suite's own state server."""
    url = re.sub(r":25900", f":{STATE_PORT}", route.request.url, count=1)
    resp = route.fetch(url=url)
    route.fulfill(response=resp)


# The role records exactly as .acp/README.md documents them — this is the
# shape the panel (and boardctl) parses.
PIPELINE_ROLES = [
    {"id": "orchestrator", "label": "Orchestrator", "cli": "devin",
     "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
     "promptFile": ".acp/roles/orchestrator.md", "maxConcurrent": 1,
     "pollIntervalSec": 30, "timeoutMin": 120, "maxRetries": 1},
    {"id": "plan-writer", "label": "Plan writer", "cli": "devin",
     "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
     "promptFile": ".acp/roles/plan-writer.md", "maxConcurrent": 2,
     "pollIntervalSec": 15, "timeoutMin": 30, "maxRetries": 2},
    {"id": "dev", "label": "Developer", "cli": "devin",
     "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
     "promptFile": ".acp/roles/dev.md", "maxConcurrent": 2,
     "pollIntervalSec": 15, "timeoutMin": 45, "maxRetries": 1},
    {"id": "pm", "label": "PM", "cli": "hermes",
     "args": ["-z"], "promptFile": ".acp/roles/pm.md", "maxConcurrent": 1,
     "pollIntervalSec": 15, "timeoutMin": 30, "maxRetries": 1},
    {"id": "reviewer", "label": "Reviewer", "cli": "hermes",
     "args": [], "promptFile": ".acp/roles/reviewer.md", "maxConcurrent": 1,
     "pollIntervalSec": 15, "timeoutMin": 30, "maxRetries": 1,
     "review": {"severities": ["critical", "major", "minor", "nit"],
                "blocking": ["critical", "major"],
                "backlog": ["minor", "nit"], "maxRounds": 3}},
]

STAGE_ROLES = {"spec": "orchestrator", "plan": "plan-writer",
               "dev": "dev", "reviewtest": "reviewer"}


def seed_docs():
    put_doc("roles.json", {"version": 1, "roles": PIPELINE_ROLES,
                           "stageRoles": STAGE_ROLES})
    put_doc("board.json", {"version": 2, "cards": []})
    put_doc("claims.json", {"version": 1, "claims": {}, "attempts": {}})
    put_doc("activity.json", {"entries": [], "usage": []})
    put_doc("projects.json",
            {"version": 1, "projects": [], "activeProjectId": "all"})


def open_roles(page):
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1500)
    btn = page.get_by_role("button", name="Settings")
    assert btn.count() > 0, "no Settings button"
    btn.first.click()
    page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)
    # __roles is published on section mount, after initRolesStore().
    page.wait_for_function("() => !!(window).__roles", timeout=10000)


def add_role_eval(page, record):
    """Call the store's real write path; returns {ok|error}."""
    return page.evaluate(
        """(rec) => {
          try { const r = window.__roles.addRole(rec); return {ok: true, role: r}; }
          catch (e) { return {ok: false, error: String(e && e.message || e)}; }
        }""",
        record,
    )


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        return 1
    if not STATE_SERVER.exists():
        print(f"FAIL  {STATE_SERVER} missing")
        return 1
    for p in (UI_PORT, STATE_PORT):
        if not port_free(p):
            print(f"FAIL  port {p} in use — refusing a stale server")
            return 1

    # ---- leg 0: the files themselves (job 1, "the prompt file exists") --
    role_files = {r["id"]: ROOT / r["promptFile"] for r in PIPELINE_ROLES}
    for rid, f in role_files.items():
        check(f"prompt file exists for role '{rid}' ({f.relative_to(ROOT)})",
              f.is_file() and f.stat().st_size > 0)

    orch = (ROOT / ".acp/roles/orchestrator.md").read_text(encoding="utf-8")
    plan = (ROOT / ".acp/roles/plan-writer.md").read_text(encoding="utf-8")
    check("orchestrator names boardctl", "boardctl" in orch)
    check("orchestrator names scripts/porch-dispatch", "porch-dispatch" in orch)
    check("orchestrator records subagents via boardctl delegate",
          "delegate" in orch)
    check("orchestrator never moves past reviewtest (done/accepted banned)",
          "done" in orch and "accepted" in orch)
    check("plan-writer writes .acp/cards/<id>/02_plan.md",
          ".acp/cards/<id>/02_plan.md" in plan)
    check("plan-writer ends with the STATUS token contract",
          "STATUS:" in plan)
    check("orchestrator ends with the STATUS token contract",
          "STATUS:" in orch)
    readme = (ROOT / ".acp/README.md").read_text(encoding="utf-8")
    check("README documents orchestrator + plan-writer records",
          '"orchestrator"' in readme and '"plan-writer"' in readme)

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)

    state = subprocess.Popen(
        ["node", str(STATE_SERVER)],
        env={**os.environ,
             "STATE_DIR": str(STATE_DIR), "PORT": str(STATE_PORT)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ui = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(UI_PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(STATE_PORT) or not wait_port(UI_PORT):
            print("FAIL  servers did not start")
            return 1
        seed_docs()

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True,
                viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), proxy_state)
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))

            # ---- leg 1: records parse on the store's real load path ----
            open_roles(page)
            rows = page.locator('[data-testid^="role-"]')
            listed = set(rows.evaluate_all(
                """els => els.map(e => e.getAttribute('data-testid'))
                           .filter(t => /^role-[a-z-]+$/.test(t)
                                        && !/^role-(promptfile|no-runner|prompt-btn|review)-/.test(t)
                                        && !/^role-(id|label|cli|prompt|args|maxc|poll|timeout|retries|save|cancel|add-toggle|review-sev|review-blocking|review-backlog|review-rounds)$/.test(t))"""))
            expected = {f"role-{r['id']}" for r in PIPELINE_ROLES}
            check("every seeded role record parses into a role row",
                  expected <= listed,
                  f"missing: {sorted(expected - listed)}")

            for r in PIPELINE_ROLES:
                loc = page.locator(f'[data-testid="role-promptfile-{r["id"]}"]')
                txt = loc.inner_text().strip() if loc.count() else None
                check(f"promptFile shown for '{r['id']}'", txt == r["promptFile"],
                      txt or "row missing")

            stage_map = page.evaluate(
                """() => ['spec','plan','dev','reviewtest'].map(s =>
                     [s, (window.__roles.roleForStage(s) || {}).id || null])""")
            check("stage->role binding parsed (spec/plan/dev/reviewtest)",
                  dict(stage_map) == STAGE_ROLES, str(stage_map))

            rev = page.evaluate(
                "() => (window.__roles.roleById('reviewer') || {}).review || null")
            check("reviewer 'review' block round-trips through the store",
                  rev is not None
                  and rev.get("blocking") == ["critical", "major"]
                  and rev.get("backlog") == ["minor", "nit"]
                  and rev.get("maxRounds") == 3,
                  json.dumps(rev)[:200])

            # ---- leg 2: write path (validateRole) accepts + persists ----
            ok_rec = {"id": "qa-live", "label": "QA", "cli": "devin",
                      "args": ["-p"], "promptFile": ".acp/roles/dev.md",
                      "maxConcurrent": 1, "pollIntervalSec": 15,
                      "timeoutMin": 10, "maxRetries": 1}
            res = add_role_eval(page, ok_rec)
            check("addRole accepts a well-formed record",
                  res.get("ok"), json.dumps(res)[:200])
            page.wait_for_timeout(1200)  # persist is debounced ~600ms
            doc, _ = get_doc("roles.json")
            ids = [r.get("id") for r in (doc or {}).get("roles", [])]
            check("accepted role persisted to roles.json on the state server",
                  "qa-live" in ids, str(ids))

            # ---- leg 3: validation rejects malformed records ------------
            bad_cli = add_role_eval(page, dict(ok_rec, id="bad-cli", cli="bogus"))
            check("cli outside KNOWN_CLIS rejected",
                  not bad_cli.get("ok") and "cli" in bad_cli.get("error", ""),
                  bad_cli.get("error", ""))
            bad_pf = add_role_eval(page, dict(ok_rec, id="bad-pf", promptFile=""))
            check("empty promptFile rejected",
                  not bad_pf.get("ok")
                  and "Prompt file path is required" in bad_pf.get("error", ""),
                  bad_pf.get("error", ""))
            bad_rev = add_role_eval(page, dict(
                ok_rec, id="bad-rev",
                review={"severities": ["critical", "major"],
                        "blocking": ["critical", "bogus"],
                        "backlog": [], "maxRounds": 3}))
            check("review.blocking outside the vocabulary rejected",
                  not bad_rev.get("ok")
                  and "severities" in bad_rev.get("error", ""),
                  bad_rev.get("error", ""))

            check("zero pageerrors", not page_errors,
                  "; ".join(page_errors[:3]))
            browser.close()
    finally:
        state.terminate()
        ui.terminate()
        for proc in (state, ui):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("failed:", "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
