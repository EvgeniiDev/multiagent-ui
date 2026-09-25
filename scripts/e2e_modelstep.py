#!/usr/bin/env python3
"""E2E for the W15 modelstep feature: a role may carry per-step models —
`role.models = {plan, execute}` — and `role.args` may reference
`{models.plan}` / `{models.execute}`, which the runner substitutes at spawn
time with the model for the CURRENT step (card in `plan` stage -> `plan`,
any other stage -> `execute`). Ledger card entries gain `model` so it is
visible which model did which step; a role without `models` gets neither
substitution nor the field.

Note on semantics: BOTH placeholder spellings resolve to the model of the
current step — the spelling is documentation, the step decides. That is
what lets ONE role bound to plan+dev stages switch model mid-pipeline
(plain key-lookup would make the placeholders no better than a literal
string). Leg A deliberately puts `{models.execute}` in the args and still
expects the plan model on the plan-step child — proving the substitution
is driven by the step, not by the spelling.

Spins up its OWN state server on port 25917 with
STATE_DIR=<worktree>/tmp-modelstep-test, a project inside it, and a role
whose `cli` is `node <stub>` — a stub that dumps argv into the card dir.
Asserts:

  A. one role bound to plan+dev stages with `models` + `{models.execute}`
     in args: the plan-stage child gets `--model <models.plan>`, the
     dev-stage child gets `--model <models.execute>` (stub argv dump);
     the live claim records the step model; every ledger card entry for
     each run carries the right `model`;
  B. `cancel` on a claim that recorded a model writes its audit entry
     with the claim's `model`;
  C. a role WITHOUT `models`: argv unchanged, and its ledger card entries
     carry NO `model` field — nothing is invented;
  D. a role with a malformed `models` (empty `execute`): treated as
     absent — placeholder left literal in argv, a stderr warning, and no
     `model` field in the ledger;
  E. the panel: the model pair fields stay hidden until the args template
     references `{models.*}`; a half-filled pair is rejected by the roles
     store validation (visible error), as are non-object `models` writes;
     a full pair persists into roles.json.

Usage:
    npm run build:web   # leg E needs dist-web
    ~/.hermes/tools-venv/bin/python scripts/e2e_modelstep.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _e2e_harness import STATE_SERVER, serve_state, serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "server" / "acp-runner.mjs"
DIST = ROOT / "dist-web"
STATE_DIR = ROOT / "tmp-modelstep-test"
STATE_PORT = 25917               # preferred; harness falls back when busy
WEB_PORT = 25962                 # panel leg (roles form)
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"   # rebased in main()
WEB_URL = f"http://127.0.0.1:{WEB_PORT}/"      # rebased in main()
PROJ = STATE_DIR / "proj"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def wait_for(fn, timeout=15.0, interval=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        val = fn()
        if val:
            return val
        time.sleep(interval)
    return fn()


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


def put_doc(name, data, rev):
    return api(f"/{name}", "PUT", {"data": data, "rev": rev})


def force_put(name, data):
    _, rev = get_doc(name)
    status, body = put_doc(name, data, rev)
    assert status == 200, f"put {name} -> {status} {body}"


def mk_card(cid, stage, status=None, project="p1", order=10):
    now = int(time.time() * 1000)
    return {
        "id": cid, "title": f"E2E {cid}", "description": "d",
        "project": project, "agent": "", "priority": "medium",
        "acceptance": "accepts X", "verification": "run Y",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": order, "createdAt": now, "updatedAt": now,
    }


def mk_role(args, models=None):
    role = {
        "id": "dev", "label": "Dev", "cli": "node",
        "args": [str(STATE_DIR / "stub-cli.mjs"), *args],
        "promptFile": ".acp/roles/dev.md",
        "maxConcurrent": 2, "pollIntervalSec": 5,
        "timeoutMin": 0.5, "maxRetries": 1,
    }
    if models is not None:
        role["models"] = models
    return role


def seed(board_cards, role, stage_roles):
    """Rewrite board.json + roles.json for a leg (claims/activity persist)."""
    force_put("board.json", {"version": 2, "cards": board_cards})
    force_put("roles.json", {
        "version": 1, "roles": [role], "stageRoles": stage_roles,
    })


def runner_env(env_extra=None):
    env = {**os.environ, "STATE_URL": STATE_URL,
           "ROOT_DIR": str(STATE_DIR),
           "RUNNER_ID": "e2e-runner"}
    env.update(env_extra or {})
    return env


def run_runner(*args, env_extra=None, timeout=120):
    return subprocess.run(
        ["node", str(RUNNER), *args], capture_output=True, text=True,
        timeout=timeout, env=runner_env(env_extra), cwd=ROOT)


def spawn_runner_once(env_extra=None):
    return subprocess.Popen(
        ["node", str(RUNNER), "--once"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=runner_env(env_extra), cwd=ROOT)


def card_dir(card_id):
    return PROJ / ".acp" / "cards" / card_id


def card_argv(card_id):
    f = card_dir(card_id) / "argv.json"
    return json.loads(f.read_text()) if f.exists() else None


def flag_value(argv, flag):
    """Value after `--flag X` or inside `--flag=X` in an argv list."""
    argv = argv or []
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None


def claims_map():
    doc, _ = get_doc("claims.json")
    return (doc or {}).get("claims") or {}


def activity_entries():
    doc, _ = get_doc("activity.json")
    return (doc or {}).get("entries") or []


def card_entries(cid):
    return [e for e in activity_entries()
            if e.get("kind") == "card" and e.get("title") == f"E2E {cid}"]


def write_stub():
    """The stub role CLI: `node stub-cli.mjs <role-args...> --prompt-file <brief>`.

    Dumps its argv into <cardDir>/argv.json so the suite can prove which
    --model value the substitution produced, writes the verdict artefact,
    prints a session id, then exits 0 (or sleeps STUB_SLEEP_SEC first).
    """
    stub = STATE_DIR / "stub-cli.mjs"
    stub.write_text(
        "import { promises as fs } from 'node:fs';\n"
        "const env = process.env;\n"
        "const briefArg = process.argv.slice(2).find((a) => a.endsWith('00_brief.md')) || '';\n"
        "if (!briefArg) { console.error('stub: no brief path in argv'); process.exit(64); }\n"
        "const cardDir = briefArg.split('/').slice(0, -1).join('/');\n"
        "const cardId = cardDir.split('/').filter(Boolean).pop();\n"
        "console.log(`SESSION: sess-${cardId}`);\n"
        "await fs.mkdir(cardDir, { recursive: true });\n"
        "await fs.writeFile(`${cardDir}/argv.json`, JSON.stringify(process.argv.slice(2)));\n"
        "const sleepSec = Number(env.STUB_SLEEP_SEC || 0);\n"
        "if (sleepSec > 0) await new Promise((r) => setTimeout(r, sleepSec * 1000));\n"
        "await fs.writeFile(`${cardDir}/04_impl_log.md`, 'did the thing\\nSTATUS: DONE\\n');\n"
        "process.exit(0);\n")
    return stub


# ---------------------------------------------------------------------------
# Panel leg (playwright): the roles form's optional model pair.
# ---------------------------------------------------------------------------

def panel_leg():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        check("panel leg: playwright importable", False,
              "run via ~/.hermes/tools-venv/bin/python")
        return
    if not (DIST / "index.html").exists():
        check("panel leg: dist-web built", False, "run `npm run build:web` first")
        return

    def down_state(route):
        route.fulfill(status=500, content_type="application/json",
                      body=json.dumps({"error": "state server down"}))

    global WEB_URL
    server, WEB_URL = serve_web(WEB_PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1440, "height": 900}
            )
            pairs = [
                ("acp-ui:preferences.json", {"telemetryEnabled": False}),
                ("acp-ui:projects.json",
                 {"version": 1, "projects": [], "activeProjectId": "all"}),
                ("acp-ui:board.json", {"version": 2, "cards": []}),
            ]
            for key, val in pairs:
                ctx.add_init_script(
                    f"if (!localStorage.getItem({json.dumps(key)}))"
                    f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
                )
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.route(re.compile(r":25900/"), down_state)

            page.goto(WEB_URL, wait_until="load")
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Settings").first.click()
            page.wait_for_selector('[data-testid="settings-roles"]', timeout=15000)
            section = page.get_by_test_id("settings-roles")
            section.get_by_test_id("roles-add-toggle").click()
            section.get_by_test_id("role-id").fill("dev-models")
            section.get_by_test_id("role-label").fill("Dev Models")
            section.get_by_test_id("role-cli").select_option("devin")
            section.get_by_test_id("role-prompt").fill("/tmp/dev-models.md")
            section.get_by_test_id("role-args").fill("-p --model fixed")

            check("model pair hidden while args carry no placeholder",
                  section.get_by_test_id("role-model-plan").count() == 0
                  and section.get_by_test_id("role-model-execute").count() == 0)

            section.get_by_test_id("role-args").fill("-p --model {models.execute}")
            check("model pair appears once args reference {models.*}",
                  section.get_by_test_id("role-model-plan").count() == 1
                  and section.get_by_test_id("role-model-execute").count() == 1)

            # Store-level validation: malformed `models` is rejected no
            # matter how it reaches the store (hand-built patch, imports).
            bad = page.evaluate(
                """() => {
                  const mk = (models) => ({id: 'badm' + Math.random().toString(36).slice(2, 6),
                    label: 'b', cli: 'devin', args: [], promptFile: 'x.md',
                    maxConcurrent: 1, pollIntervalSec: 15, timeoutMin: 45, maxRetries: 1, models});
                  const out = {};
                  for (const [k, m] of [['empty', ''], ['halfEmpty', {plan: '', execute: 'x'}],
                                        ['missingKey', {plan: 'x'}]]) {
                    try { window.__roles.addRole(mk(m)); out[k] = null; }
                    catch (e) { out[k] = String(e.message || e); }
                  }
                  return out;
                }""")
            check("store rejects models as a bare empty string",
                  bad is not None and bad.get("empty") is not None
                  and "models" in bad["empty"],
                  json.dumps(bad))
            check("store rejects a half-empty model pair",
                  bad is not None and bad.get("halfEmpty") is not None
                  and "models" in bad["halfEmpty"],
                  json.dumps(bad))
            check("store rejects a model pair missing a key",
                  bad is not None and bad.get("missingKey") is not None
                  and "models" in bad["missingKey"],
                  json.dumps(bad))

            # Half-filled pair through the form -> visible validation error.
            section.get_by_test_id("role-model-plan").fill("strong-model")
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(200)
            err = section.get_by_test_id("roles-error")
            check("form rejects a half-filled model pair",
                  err.count() == 1 and "models" in err.inner_text(),
                  err.inner_text() if err.count() else "no error")

            section.get_by_test_id("role-model-execute").fill("cheap-model")
            section.get_by_test_id("role-save").click()
            page.wait_for_timeout(300)
            check("full model pair saves",
                  section.get_by_test_id("role-dev-models").count() == 1)
            check("role row shows the model pair",
                  section.get_by_test_id("role-models-dev-models").count() == 1)
            page.wait_for_timeout(800)  # debounced save
            doc = page.evaluate(
                "() => JSON.parse(localStorage.getItem('acp-ui:roles.json') || '{}')"
            )
            dm = [r for r in doc.get("roles", []) if r.get("id") == "dev-models"]
            check("models persisted into roles.json",
                  len(dm) == 1
                  and dm[0].get("models") == {"plan": "strong-model",
                                              "execute": "cheap-model"},
                  json.dumps(dm)[:250] if dm else "role missing")

            ctx.close()
            browser.close()
    finally:
        stop(server)


# ---------------------------------------------------------------------------

def main():
    global STATE_PORT, STATE_URL
    if not STATE_SERVER.exists():
        print(f"FAIL  {STATE_SERVER} missing")
        sys.exit(1)
    if not RUNNER.exists():
        print(f"FAIL  {RUNNER} missing")
        sys.exit(1)

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)
    PROJ.mkdir(parents=True)
    write_stub()

    state, STATE_PORT = serve_state(STATE_PORT, STATE_DIR)
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        now = int(time.time() * 1000)
        projects = {"version": 1,
                    "projects": [{"id": "p1", "name": "P1",
                                   "path": str(PROJ), "createdAt": now}],
                    "activeProjectId": "all"}
        for name, doc in (("projects.json", projects),
                          ("claims.json", {"version": 1, "claims": {}, "attempts": {}}),
                          ("activity.json", {"entries": [], "usage": []})):
            status, _ = put_doc(name, doc, 0)
            assert status == 200, f"seed {name} -> {status}"

        # ===== leg A: one role, plan+dev steps, two models =================
        # args deliberately say `{models.execute}` — under step resolution
        # the plan-stage child must still get models.plan.
        seed([mk_card("card-plan", "plan", "in_progress"),
              mk_card("card-exec", "dev", "in_progress")],
             mk_role(["-p", "--model", "{models.execute}"],
                     models={"plan": "model-plan-x", "execute": "model-exec-y"}),
             {"plan": "dev", "dev": "dev"})

        proc = spawn_runner_once({"STUB_SLEEP_SEC": "8"})
        claim_plan = wait_for(lambda: claims_map().get("card-plan"), timeout=15)
        check("step model recorded on the live plan claim",
              bool(claim_plan) and claim_plan.get("model") == "model-plan-x",
              json.dumps(claim_plan)[:200])
        claim_exec = wait_for(
            lambda: claims_map().get("card-exec"), timeout=30)
        check("step model recorded on the live exec claim",
              bool(claim_exec) and claim_exec.get("model") == "model-exec-y",
              json.dumps(claim_exec)[:200])
        out, err = proc.communicate(timeout=90)
        check("leg A once exits 0", proc.returncode == 0, (err or "")[:200])

        check("plan-step child argv carries --model <models.plan>",
              flag_value(card_argv("card-plan"), "--model") == "model-plan-x",
              json.dumps(card_argv("card-plan"))[:250])
        check("execute-step child argv carries --model <models.execute>",
              flag_value(card_argv("card-exec"), "--model") == "model-exec-y",
              json.dumps(card_argv("card-exec"))[:250])

        plan_es = card_entries("card-plan")
        check("ledger: every plan-step card entry carries model=model-plan-x",
              len(plan_es) >= 3
              and all(e.get("model") == "model-plan-x" for e in plan_es),
              json.dumps(plan_es)[:300])
        exec_es = card_entries("card-exec")
        check("ledger: every exec-step card entry carries model=model-exec-y",
              len(exec_es) >= 3
              and all(e.get("model") == "model-exec-y" for e in exec_es),
              json.dumps(exec_es)[:300])
        check("card state survives the model switch (artefacts in card dirs)",
              (card_dir("card-plan") / "04_impl_log.md").exists()
              and (card_dir("card-exec") / "04_impl_log.md").exists())

        # ===== leg B: cancel audit entry carries the claim's model =========
        seed([mk_card("card-cancel", "dev", "in_progress")],
             mk_role(["-p", "--model", "{models.execute}"],
                     models={"plan": "model-plan-x", "execute": "model-exec-y"}),
             {"dev": "dev"})
        claims, crev = get_doc("claims.json")
        claims["claims"]["card-cancel"] = {
            "agentName": "e2e-runner:dev", "sessionId": "",
            "leaseUntil": int(time.time() * 1000) + 600_000,
            "startedAt": now, "claimedAt": now,
            "pid": 999999999, "roleId": "dev", "runnerId": "e2e-runner",
            "runnerPid": 999999998, "stage": "dev", "model": "audit-model-z"}
        force_put("claims.json", claims)
        proc = run_runner("cancel", "card-cancel")
        check("cancel exits 0", proc.returncode == 0, proc.stderr[:200])
        cancel_es = [e for e in card_entries("card-cancel")
                     if "cancel" in (e.get("detail") or "")]
        check("cancel audit entry carries the claim's model",
              bool(cancel_es) and cancel_es[-1].get("model") == "audit-model-z",
              json.dumps(cancel_es[-1])[:250] if cancel_es else "no entry")

        # ===== leg C: role without models — nothing changes ================
        seed([mk_card("card-plain", "dev", "in_progress")],
             mk_role(["-p", "--model", "fixed-model"]),
             {"dev": "dev"})
        proc = run_runner("--once")
        check("leg C once exits 0", proc.returncode == 0, proc.stderr[:200])
        check("no models: argv unchanged (--model fixed-model)",
              flag_value(card_argv("card-plain"), "--model") == "fixed-model",
              json.dumps(card_argv("card-plain"))[:250])
        plain_es = card_entries("card-plain")
        check("no models: ledger card entries have NO model field",
              len(plain_es) >= 3
              and all("model" not in e for e in plain_es),
              json.dumps(plain_es[-1])[:250] if plain_es else "none")

        # ===== leg D: malformed models = absent ============================
        seed([mk_card("card-bad", "dev", "in_progress")],
             mk_role(["-p", "--model", "{models.plan}"],
                     models={"plan": "model-plan-x", "execute": ""}),
             {"dev": "dev"})
        proc = run_runner("--once")
        check("leg D once exits 0", proc.returncode == 0, proc.stderr[:300])
        check("malformed models: placeholder left literal in argv",
              flag_value(card_argv("card-bad"), "--model") == "{models.plan}",
              json.dumps(card_argv("card-bad"))[:250])
        check("malformed models: stderr warning names it",
              "left literal" in (proc.stderr or ""), (proc.stderr or "")[:200])
        bad_es = card_entries("card-bad")
        check("malformed models: ledger card entries have NO model field",
              len(bad_es) >= 3 and all("model" not in e for e in bad_es),
              json.dumps(bad_es[-1])[:250] if bad_es else "none")

        # ===== leg E: the roles form in the panel ==========================
        panel_leg()

    finally:
        stop(state)
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
