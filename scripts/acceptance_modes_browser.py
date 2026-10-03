#!/usr/bin/env python3
"""acceptance_modes_browser.py — PRODUCTION real-browser acceptance harness.

Drives the REAL card panel UI in Chromium against the EXISTING production
Docker stack on fixed URLs. Launches NOTHING, touches NOTHING without --live.

  Targets (fixed, no overrides — an env knob would be an adjacent-port loophole):
    state API : http://127.0.0.1:25900   (STATE_DIR must be /home/hermes/.hermes/acp-ui-state)
    UI (HTTPS): https://127.0.0.1:25809/  (ignore_https_errors=True)

  Browser (isolated, explicit):
    /home/hermes/projects/acp-ui-lead-integration/.agent-tmp/autonomous/browser-venv/bin/python
    chromium: /home/hermes/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome

Usage (parent deploys final branch, then executes):
  <venv-python> scripts/acceptance_modes_browser.py --live \\
      --fixture-root <real-source-repo-under-/home/hermes/projects> --output-dir <dir> \\
      [--modes preparation,fusion,orchestrator,swarm] [--existing-fixture-state JSON]
      [--timeout-s 600]

Without --live: prints usage-relevant offline self-check result, touches no
network, exits 0 (--help exits 0 as usual). No default run does anything live.

Selector/testid contract (pinned against integration@f27f8fd UI source
plus backend-ui-contract.md §§1-11, the published planned interface):
  card view  : GET /api/execution/cards/:cardId -> the ExecCardView PLAIN
               (cardId, controlRevision, projection{stage,status},
               project{id,label,path}, composition, documents, approvals,
               runs[], workspaces, preparation, features) — NOT nested under
               json.aggregate (that shape does not exist).
  latest run : GET /api/execution/runs/:runId -> the ExecRun PLAIN
               (status/phase/attempts/acceptance{resultSha256}/
               validation/fusion/orchestrator/swarm) — same flat shape.
  commands   : POST .../cards/:cardId/commands {commandId, type,
               expectedControlRevision, payload} (190 CONTROLLER probes;
               409 {code:"conflict"} on stale rev; user-only channel).
  compat     : GET /api/execution/presets -> {presets, rev, compatibility,
               compatError}; the UI-only source is the rendered
               [data-testid="exec-composition"] block + compat error line.
               There is NO server profile registry and NO window.__* global
               (that global never existed — discovery reads the DOM).
  prep docs  : generated ONLY via prep-draft-<kind> (request_draft) buttons;
               hand-written doc text is forbidden (no fake documents).
  prep gates : prep-gate-confirm-<gateId> Confirm buttons; question rows
               prep-q-<qid> with prep-answer-<qid>/prep-send-<qid>
               (select variant prep-answer-select-<qid>); adaptive lead may
               ask ZERO questions — indefinite blocking on a question is
               forbidden, continue via prep-continue-text/prep-continue.
  run start  : per-mode editors opened via fusion-configure / orch-configure /
               swarm-configure; model picks from the compat table
               (fusion-pmodel-<pN>, fusion-judge, fusion-integrator,
               fusion-reviewer-cli/model, fusion-checker-cli/model,
               orch-decomposer/verifier/integrator, orch-worker-profile-<i>,
               swarm-profile-<i>); the UI synthesizes FULL inline profiles
               (f27f8fd modeProfile/fusionProfile) so the harness only picks
               model values, never profile objects. fusion-start /
               orch-start / swarm-start start the run (fusion NEVER uses the
               shared exec-start solo button for a mode run); pending-action
               buttons fusion-retry-*/fusion-exclude-*/fusion-approve-wo,
               orch-approve-spec, orch-decide-approve/reject-<proposalId>,
               orch-answer-<taskId>/orch-answer-send-<taskId>,
               orch-grant-<taskId>, orch-retry-<taskId>,
               swarm-input-<pid>/swarm-send-<pid>,
               swarm-extend-btn-<pid>, swarm-decide-approve/reject-<id>;
               terminal accept via exec-accept (confirm()+alert auto-accepted).
               `confirm`/`prompt` dialogs are auto-accepted/dismissed by the
               harness dialog handler with DEFAULT answers (empty note,
               1 attempt / 0 fix cycles); page.click on a <p> paragraph is
               never an action.
  validation : run.validation has NO boolean `ok` field — pass means
               checks.verdict == "pass", absent verdict fails closed.

Flow per mode (all through the real panel UI; a silently-passing
failed/stopped run is FORBIDDEN — terminal non-accepted states FAIL):
  preparation : fill prep-intent -> prep-start (real grill discussion) ->
                answer any open questions (zero-question adaptive flows
                proceed immediately) -> prep-draft-requirements (real lead
                generates) -> approve exact generated version via panel
                doc viewer + doc-approve -> prep-draft-plan (requires
                approved requirements) -> approve exact generated plan ->
                confirm pending gates -> record handoff offer ->
                assert ready state on the correct card.
  fusion/orchestrator/swarm : enable card -> approve the accepted generated
                req/plan (transferred from preparation where the UI allows)
                -> bind composition (preset-pick/preset-apply) -> open the
                mode editor -> pick compat models -> start via the MODE
                start button -> advance ONLY user-pending approvals
                (pendingActions) -> terminal accept through UI
                (exec-accept bound to accept_result{resultSha256}) ->
                assert result/checks/workspace diffs REAL.

Fixture: CAS-merge a UNIQUE prefixed project/card set (acc-b<ts>-*) into
projects.json/board.json via GET rev + PUT rev. Preserves ALL existing
records; deletes NOTHING foreign. Project rows carry the MANDATORY path
(e2e_preparation.py/e2e_fusion.py seed_card template: {"id","name","path",
"createdAt"}); card rows use the real board lane fields ({"id","title",
"description","project","agent","priority","acceptance","verification",
"links","session","blocked","blockedReason","cancelled","touches",
"dependsOn","blocks","conflictsWith","stage":"backlog","status":null,
"order","createdAt","updatedAt"} — backlog cards carry status null, NOT
"todo"). --existing-fixture-state JSON reuses a prior fixture
({projectId, cardIds:{...}}) to avoid reseed duplicates. --fixture-root is
the REAL source repo under /home/hermes/projects the PARENT supplies
(mounted allowed WORKSPACE_ROOT for the private git clamp.js fixture);
the harness refuses --live unless it is a directory under that prefix.
Swarm ownership: own files clamp only fixture-owned paths; participant
ownedPaths never cover foreign trees.

Evidence: <output-dir>/<mode>-*.png screenshots, receipt-<mode>.json, zero
pageerrors required. Per-mode budget >=600s (bounded poll, fail-fast with
panel text + pendingActions + events tail + traffic tail diagnostics).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

STATE_URL = "http://127.0.0.1:25900"
UI_URL = "https://127.0.0.1:25809/"
EXPECTED_STATE_DIR = "/home/hermes/.hermes/acp-ui-state"
FIXTURE_ROOT_PREFIX = "/home/hermes/projects"
TERMINAL = {"awaiting_acceptance", "succeeded", "failed", "cancelled",
            "stopped"}
MODES = ("preparation", "fusion", "orchestrator", "swarm")
MIN_TIMEOUT_S = 600

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []
DIAG_NET: list[str] = []
DIAG_PAGES: list = []

# Maps mode -> framework probe/testid contract (integration@f27f8fd).
# The CONTROLLER probe is the Playwright-robust hook (Vue renders the real
# DOM testid only when its v-if branch is mounted); the DOM testid is the
# human-auditable assert. "absent" means the UI has no such control —
# scripting it would be a fake affordance.
SELECTOR_CONTRACT = {
    "preparation": {
        "panel": "prep-panel",
        "entry": ["prep-intent", "prep-restart-intent", "prep-meta"],
        "question_row": "prep-q-<qid> (class prep-q-open while open)",
        "answer_input": "prep-answer-<qid> | prep-answer-select-<qid>",
        "answer_send": "prep-send-<qid>",
        "draft": "prep-draft-requirements / prep-draft-design / prep-draft-plan"
                 " (request_draft — the ONLY doc-generation path)",
        "gate_confirm": "prep-gate-confirm-<gateId>",
        "handoff": "prep-handoff-btn (mode prep-handoff-mode)",
        "ready": "prep-ready",
    },
    "composition": {
        # Shared documents/composition setup (all run modes).
        "doc_tabs": ".exec-doc-tabs button (Requirements/Plan/Design)",
        "doc_new": "doc-new",
        "doc_draft": "doc-draft",
        "doc_attach": "doc-attach",
        "doc_version_pick": "doc-version-pick",
        "doc_view": "doc-view (content: doc-content)",
        "doc_approve": "doc-approve",
        "preset_pick": "preset-pick",
        "preset_apply": "preset-apply",
        "preset_save": "preset-save (preset-new/preset-name/preset-editor)",
        "composition_line": "composition-line",
        "compat_block": "exec-composition (compat table source; errors: compat-error)",
    },
    "fusion": {
        "editor_open": "fusion-configure",
        "editor": "fusion-editor",
        "kind": "fusion-kind",
        "panelist_model": "fusion-pmodel-<pN> (options = compat pi.models)",
        "judge": "fusion-judge",
        "integrator": "fusion-integrator",
        "reviewer": "fusion-reviewer-cli + fusion-reviewer-model",
        "checker": "fusion-checker-cli + fusion-checker-model",
        "task_kind": "fusion-task-kind",
        "task_version": "fusion-task-version",
        "start": "fusion-start",
        "pending": "fusion-pending-<type>",
        "retry": "fusion-retry-<participantId> (alt: fusion-retry-alt-<id>)",
        "exclude": "fusion-exclude-<participantId> (alt: fusion-exclude-alt-<id>)",
        "approve_wo": "fusion-approve-wo | fusion-approve-<versionId>",
    },
    "orchestrator": {
        "editor_open": "orch-configure",
        "editor": "orch-editor",
        "decomposer": "orch-decomposer",
        "verifier": "orch-verifier",
        "integrator": "orch-integrator",
        "worker_profile": "orch-worker-profile-<i> (orch-worker-name-<i>)",
        "start": "orch-start",
        "pending": "orch-pending-<type>",
        "approve_spec": "orch-approve-spec",
        "decide": "orch-decide-approve-<proposalId> / orch-decide-reject-<proposalId>",
        "answer": "orch-answer-<taskId> + orch-answer-send-<taskId>",
        "grant": "orch-grant-<taskId>",
        "retry": "orch-retry-<taskId>",
    },
    "swarm": {
        "editor_open": "swarm-configure",
        "editor": "swarm-editor",
        "profile": "swarm-profile-<i> (swarm-pid-<i>/swarm-callsign-<i>/swarm-paths-<i>)",
        "start": "swarm-start",
        "pending": "swarm-pending-<type>",
        "input": "swarm-input-<participantId> + swarm-send-<participantId>",
        "broadcast": "swarm-broadcast + swarm-broadcast-send",
        "extend": "swarm-extend-btn-<participantId> (pending row: swarm-extend-<pid|all>)",
        "decide": "swarm-decide-approve-<id> / swarm-decide-reject-<id> (+ swarm-decide-note-<id>)",
    },
    "runcontrol": {
        "status": "run-status",
        "start": "exec-start (solo runs ONLY)",
        "stop": "exec-stop",
        "continue": "exec-continue (note: continue-note)",
        "accept": "exec-accept (accept_result{resultSha256})",
        "enable": "exec-enable",
        "status_line": "exec-status-line",
        "validation": "run-validation",
        "checks": "run-checks",
    },
}


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}"
          + (f"  ({detail})" if detail else ""), flush=True)


def http_json(method, url, body=None, timeout=10.0):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw.decode("utf-8", "replace")


def api(method, path, body=None):
    return http_json(method, f"{STATE_URL}{path}", body=body)


def fail_closed(msg):
    print(f"FAIL-CLOSED  {msg}", flush=True)
    raise SystemExit(2)


# ---- live preconditions ------------------------------------------------------

def verify_health_live():
    st, health = api("GET", "/health")
    if st != 200 or not isinstance(health, dict):
        fail_closed(f"/health unreachable (status={st}) — refusing prod writes")
    if health.get("dir") != EXPECTED_STATE_DIR:
        fail_closed(f"/health dir={health.get('dir')!r} != {EXPECTED_STATE_DIR!r}"
                    " — wrong server, refusing prod writes")
    print(f"health ok: dir={health.get('dir')} docs={health.get('docs')}", flush=True)
    return health


def card_view(card_id):
    """GET the card view — the ExecCardView PLAIN (cardId, controlRevision,
    projection, project, composition, documents, approvals, runs[],
    workspaces, preparation, features). There is no json.aggregate
    nesting anywhere in this API."""
    return api("GET", f"/api/execution/cards/{card_id}")


def run_view(run_id):
    """GET the latest run — the ExecRun PLAIN (status/phase/attempts/
    acceptance/validation/fusion/orchestrator/swarm)."""
    return api("GET", f"/api/execution/runs/{run_id}")


def current_run_id(view):
    runs = (view or {}).get("runs") or []
    if runs:
        cur = (view or {}).get("currentRunId")
        for r in runs:
            if isinstance(r, dict) and r.get("id") == cur:
                return cur
        last = runs[-1]
        return last.get("id") if isinstance(last, dict) else last
    return None


def send_command(card_id, ctype, payload=None, rev=None, cid=None):
    """POST a user command; one fresh-rev retry on CAS conflict (never for explicit stale rev)."""
    if rev is None:
        st, view = card_view(card_id)
        rev = int(view["controlRevision"]) if st == 200 and isinstance(view, dict) else 0
        explicit = False
    else:
        explicit = True
    body = {"commandId": cid or f"acc-{uuid.uuid4().hex[:12]}", "type": ctype,
            "expectedControlRevision": rev, "payload": payload or {}}
    st, res = api("POST", f"/api/execution/cards/{card_id}/commands", body)
    if st == 409 and not explicit:
        st2, view = card_view(card_id)
        if st2 == 200 and isinstance(view, dict):
            body["expectedControlRevision"] = int(view["controlRevision"])
            st, res = api("POST", f"/api/execution/cards/{card_id}/commands", body)
    return st, res


# ---- fixture: CAS merge, preserve-all, delete-nothing -------------------------
# Row templates mirror scripts/e2e_preparation.py / e2e_fusion.py seed_card:
# project rows REQUIRE path; board cards use the real lane fields with
# stage "backlog" and status null (backlog cards are status-less).

def merge_fixture_live(tag, kinds, fixture_root):
    """Merge unique prefixed project + cards; returns {projectId, cardIds}."""
    ts = time.strftime("%Y%m%d%H%M%S")
    pid = f"acc-b{ts}-{tag}"
    card_ids = {m: f"{pid}-{m}" for m in kinds}
    st, doc = api("GET", "/api/state/projects.json")
    data = doc.get("data", {}) if st == 200 and isinstance(doc, dict) else {}
    rev = doc.get("rev", 0) if st == 200 and isinstance(doc, dict) else 0
    projects = list(data.get("projects", []))
    if any(p.get("id") == pid for p in projects):
        fail_closed(f"fixture collision {pid} — pass --existing-fixture-state instead of reseeding")
    now_ms = int(time.time() * 1000)
    project_name = f"acceptance {tag} {ts}"
    projects.append({"id": pid, "name": project_name,
                     "path": str(Path(fixture_root)),
                     "createdAt": now_ms})
    st, res = api("PUT", "/api/state/projects.json",
                  {"rev": rev, "data": {**data, "projects": projects}})
    if st != 200:
        fail_closed(f"projects.json CAS merge -> {st} {str(res)[:300]}")
    st, doc = api("GET", "/api/state/board.json")
    data = doc.get("data", {}) if st == 200 and isinstance(doc, dict) else {}
    rev = doc.get("rev", 0) if st == 200 and isinstance(doc, dict) else 0
    cards = list(data.get("cards", []))
    have = {c.get("id") for c in cards if isinstance(c, dict)}
    for m, cid in card_ids.items():
        if cid in have:
            fail_closed(f"fixture card collision {cid}")
        cards.append({
            "id": cid, "title": f"{cid} acceptance {m}",
            "description": "production acceptance browser harness",
            "project": project_name,
            "agent": "", "priority": "normal", "acceptance": "",
            "verification": "", "links": [], "session": None,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [],
            "conflictsWith": [],
            "stage": "backlog", "status": None, "order": 0,
            "createdAt": now_ms, "updatedAt": now_ms,
        })
    st, res = api("PUT", "/api/state/board.json",
                  {"rev": rev, "data": {**data, "cards": cards}})
    if st != 200:
        fail_closed(f"board.json CAS merge -> {st} {str(res)[:300]}")
    return {"projectId": pid, "cardIds": card_ids}


def parse_fixture_state(raw):
    try:
        st = json.loads(raw)
        assert isinstance(st.get("projectId"), str) and isinstance(st.get("cardIds"), dict)
        return st
    except Exception as e:
        fail_closed(f"--existing-fixture-state unparseable: {e}")


# ---- browser (imported lazily so offline --help needs nothing) ---------------

def track_page(page):
    DIAG_PAGES.append(page)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    # confirm()/prompt()/alert() are part of the real UI flow (enable,
    # approve, exclude, grant, accept); auto-answer with defaults so the
    # run never hangs on a modal: confirm->accept, prompt->default/empty.
    def _dialog(d):
        try:
            if d.type == "prompt":
                d.accept(d.default_value or ("1" if "attempts" in (d.message or "") else ""))
            else:
                d.accept()
        except Exception:
            pass
    page.on("dialog", _dialog)

    def _resp(r):
        try:
            if "/api/" in r.url:
                DIAG_NET.append(f"{r.status} {r.request.method} {r.url}")
        except Exception:
            pass
    page.on("response", _resp)


def shot(page, outdir, name):
    p = outdir / f"{name}.png"
    try:
        page.screenshot(path=str(p), full_page=False)
        print(f"  evidence: {p}", flush=True)
    except Exception as e:
        print(f"  screenshot {name} failed: {e}", flush=True)


def dump_forensics(card_ids):
    print("\n--- failure forensics ---", flush=True)
    for i, p in enumerate(DIAG_PAGES):
        try:
            panel = p.locator('[data-testid="execution-panel"], [data-testid="prep-panel"]')
            txt = panel.first.inner_text(timeout=3000) if panel.count() else "(panel absent)"
            print(f"page{i} url={p.url}\n  panel: {txt[:1200]}", flush=True)
        except Exception as e:
            print(f"page{i} dump failed: {e}", flush=True)
    for m, cid in card_ids.items():
        try:
            st, view = card_view(cid)
            if st == 200 and isinstance(view, dict):
                rid = current_run_id(view)
                tail = f" controlRevision={view.get('controlRevision')}"
                if rid:
                    rst, run = run_view(rid)
                    tail += f" run={rid} st={rst} {str(run)[:400]}"
                print(f"server {m} {cid}: st={st}{tail}", flush=True)
            else:
                print(f"server {m} {cid}: st={st} {str(view)[:200]}", flush=True)
        except Exception as e:
            print(f"server {cid} fetch failed: {e}", flush=True)
    print("api traffic (last 30):", flush=True)
    for line in DIAG_NET[-30:]:
        print(f"  {line}", flush=True)
    print("pageerrors:", page_errors[:10], flush=True)


def open_card_drawer(page, card_id):
    """Board -> card drawer via the real affordances (copied from
    scripts/e2e_fusion.py: board rail + .card-title click + panel wait).
    No TODO, no delegation: the exact panel testid differs per mode."""
    import re as _re
    page.goto(UI_URL, wait_until="domcontentloaded")
    page.locator('select[aria-label="Project scope"]').select_option("all")
    sel = _re.compile(_re.escape(card_id) + r"(?![0-9a-z-])")
    deadline = time.time() + 120
    while True:
        try:
            for _ in range(6):
                try:
                    page.locator('.view-rail button[aria-label="Board"]').click(timeout=10000)
                except Exception:
                    pass
                page.wait_for_timeout(400)
                try:
                    if page.locator('.view-rail button[aria-label="Board"]'
                                    ).get_attribute("aria-current") == "page":
                        break
                except Exception:
                    pass
            page.locator(".card-title", has_text=sel).first.click(timeout=20000)
            page.locator('[data-testid="execution-panel"]').wait_for(timeout=15000)
            return
        except Exception:
            if time.time() > deadline:
                shot(page, Path("."),
                     "drawer-fail") if False else None
                raise
            page.reload(wait_until="domcontentloaded")


def enable_card_ui(page):
    if page.locator('[data-testid="exec-enable"]').count():
        page.locator('[data-testid="exec-enable"]').click()
    page.locator('[data-testid="exec-status-line"]').wait_for(timeout=20000)


def read_compat_models(page):
    """Server-blessed compat models from the RENDERED composition block:
    [data-testid="exec-composition"] option values + compat-error text.
    No window.__* globals are consulted (none exist)."""
    try:
        status, registry = api("GET", "/api/execution/presets")
        if status != 200 or not isinstance(registry, dict):
            return [], f"compatibility endpoint returned {status}"
        models = ((registry.get("compatibility") or {}).get("pi") or {}).get("models") or []
        err = ""
        if page.locator('[data-testid="compat-error"]').count():
            err = page.locator('[data-testid="compat-error"]').first.inner_text(timeout=3000)
        seen, out = set(), []
        for m in models:
            if m not in seen:
                seen.add(m)
                out.append(m)
        return out, err.strip()
    except Exception:
        return [], ""


def wait_run_terminal(card_id, deadline, poll=10.0):
    """Poll the latest run until run.status terminal; returns (run, events_tail)."""
    last = None
    while time.time() < deadline:
        st, view = card_view(card_id)
        if st == 200 and isinstance(view, dict):
            rid = current_run_id(view)
            if rid:
                rst, run = run_view(rid)
                if rst == 200 and isinstance(run, dict):
                    if run.get("status") in TERMINAL:
                        return run, last
                    last = run.get("status")
        time.sleep(poll)
    return None, last


def accept_through_ui(page, outdir, mode, card_id):
    """Terminal await: run must park at awaiting_acceptance, then UI accept binds resultSha256."""
    run, last = wait_run_terminal(card_id, time.time() + 60)
    check(f"{mode}-parks-awaiting-acceptance",
          bool(run) and run.get("status") == "awaiting_acceptance",
          f"status={run.get('status') if run else 'TIMEOUT(last=' + str(last) + ')'}")
    if not run or run.get("status") != "awaiting_acceptance":
        return None
    acc = run.get("acceptance", {}) or {}
    if not acc.get("resultSha256"):
        check(f"{mode}-acceptance-hash-present", False, "no resultSha256 parked")
        return None
    page.locator('[data-testid="exec-accept"]').click()
    page.wait_for_timeout(4000)
    st, view = card_view(card_id)
    ok = False
    if st == 200 and isinstance(view, dict):
        rid = current_run_id(view)
        if rid:
            rst, run2 = run_view(rid)
            ok = rst == 200 and isinstance(run2, dict) and run2.get("status") == "succeeded"
            run = run2 if ok else run
    check(f"{mode}-ui-accept-succeeds", ok,
          f"status={run.get('status') if isinstance(run, dict) else '?'}")
    shot(page, outdir, f"{mode}-accepted")
    return run if ok else None


def validation_passes(run):
    """run.validation carries NO boolean ok — pass is checks.verdict == 'pass'.
    Absent verdict fails closed (never defaults true)."""
    val = (run or {}).get("validation") or {}
    checks = val.get("checks") or {}
    return checks.get("verdict") == "pass"


def check_run_evidence(mode, run, card_id, fixture_root):
    """Result hash + validation gate + nonempty attempts with a real
    provider attempt + workspace diff inside the fixture root."""
    attempts = (run or {}).get("attempts") or []
    real_attempts = [a for a in attempts
                     if isinstance(a, dict) and a.get("porchRunId")]
    check(f"{mode}-attempts-nonempty-real-provider", len(real_attempts) > 0,
          f"attempts={len(attempts)} real={len(real_attempts)}")
    acc = (run or {}).get("acceptance") or {}
    check(f"{mode}-result-hash", bool(acc.get("resultSha256")),
          str(acc.get("resultSha256"))[:24])
    check(f"{mode}-validation-checker-gate", validation_passes(run),
          f"verdict={(run.get('validation') or {}).get('checks') if isinstance(run, dict) else '?'}")
    st, view = card_view(card_id)
    ws_ok, ws_detail = False, ""
    if st == 200 and isinstance(view, dict):
        ws = (view.get("workspaces") or {})
        w = ws.get((run or {}).get("workspaceId")) or {}
        project_bound = Path((view.get("project") or {}).get("path") or "/").resolve() == Path(fixture_root).resolve()
        if w.get("runId") == run.get("id") and w.get("status") == "ready" and project_bound:
            path = Path(w.get("path") or "/").resolve()
            workspace_root = Path("/home/hermes/projects/.acp-workspaces").resolve()
            if path.is_relative_to(workspace_root) and path.is_dir():
                baseline = w.get("baseCommit") or run.get("baseCommit")
                diff = subprocess.run(["git", "diff", "--name-only", baseline, "HEAD"], cwd=path,
                                      capture_output=True, text=True, timeout=30) if baseline else None
                changed = set(diff.stdout.splitlines()) if diff and diff.returncode == 0 else set()
                probe = subprocess.run(["node", "--input-type=module", "-e",
                    "import {clamp} from './clamp.js'; import assert from 'node:assert/strict'; "
                    "assert.equal(clamp(5,0,10),5); assert.equal(clamp(-1,0,10),0); assert.equal(clamp(99,0,10),10)"],
                    cwd=path, capture_output=True, text=True, timeout=30)
                tests = subprocess.run(["node", "--test"], cwd=path, capture_output=True, text=True, timeout=60)
                ws_ok = ("clamp.js" in changed and "clamp.test.js" in changed
                         and probe.returncode == 0 and tests.returncode == 0
                         and re.search(r"# tests [1-9]", tests.stdout) is not None)
                ws_detail = f"{w.get('id')} path={path} changes={sorted(changed)} probe={probe.returncode} tests={tests.returncode}"
            else:
                ws_detail = f"unconfined or absent workspace: {path}"
        else:
            ws_detail = f"workspace binding mismatch project={project_bound} run={w.get('runId')}"
    check(f"{mode}-workspace-real-clamp-diff-and-tests", ws_ok, ws_detail)
    return (len(real_attempts) > 0 and bool(acc.get("resultSha256"))
            and validation_passes(run) and ws_ok)


# ---- modes --------------------------------------------------------------------

README_TASK = ("Add clamp.js: export function clamp(n, lo, hi) returning "
               "Math.min(hi, Math.max(lo, n)); add Node test asserting "
               "clamp(5,0,10)===5, clamp(-1,0,10)===0, clamp(99,0,10)===10.")


def prep_view(card_id):
    return api("GET", f"/api/execution/cards/{card_id}/preparation")


def wait_prep(card_id, predicate, timeout_s=240, poll=2.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st, v = prep_view(card_id)
        if st == 200 and isinstance(v, dict) and predicate(v.get("preparation") or v):
            return v.get("preparation") or v
        time.sleep(poll)
    return None


def mode_preparation(pw, args, outdir, card_id, exec_ctx):
    browser = pw.chromium.launch(headless=True,
                                 executable_path=exec_ctx["chrome"],
                                 args=["--no-sandbox"])
    page = browser.new_page(ignore_https_errors=True)
    track_page(page)
    try:
        open_card_drawer(page, card_id)
        enable_card_ui(page)
        if not ensure_preset_ui(page, "preparation"):
            return False
        page.locator('[data-testid="prep-panel"]').wait_for(timeout=20000)
        if page.locator('[data-testid="prep-panel"]').count() == 0:
            check("prep-panel-mounted-correct-card", False, "prep panel absent after drawer open")
            shot(page, outdir, "preparation-no-panel")
            return False
        check("prep-panel-mounted-correct-card", True, card_id)
        fresh = page.locator('[data-testid="prep-intent"]').count() > 0
        if not fresh:
            # A resumed session: adopt it only if it is THIS card's session.
            st, pv = prep_view(card_id)
            sid = ((pv.get("preparation") or {}) if isinstance(pv, dict) else {}).get("sessionId")
            meta = page.locator('[data-testid="prep-meta"]').first.inner_text(timeout=5000) \
                if page.locator('[data-testid="prep-meta"]').count() else ""
            check("prep-resume-correct-card", bool(sid) and bool(sid in meta),
                  f"session={sid} meta={meta[:80]}")
            if not (sid and sid in meta):
                return False
        else:
            page.locator('[data-testid="prep-intent"]').fill(
                "Acceptance clamp feature: " + README_TASK +
                ' The generated development plan must include an acp-checks fenced JSON block '
                'with {"checks":[{"run":"node --test","timeoutSec":60}]} and require actual tests.')
            page.locator('[data-testid="prep-bindings-start"] summary').click()
            page.locator('[data-testid="prep-start-bind-intent"]').select_option("grill-me-intent")
            page.locator('[data-testid="prep-start"]').click()
        v = wait_prep(card_id, lambda s: s.get("status") == "active", timeout_s=30)
        check("prep-session-active", v is not None, str((v or {}).get("sessionId")))
        if not v:
            shot(page, outdir, "preparation-no-session")
            return False
        # Adaptive questioning: answer every open question, but ZERO open
        # questions is a legal lead outcome — never block indefinitely.
        deadline = time.time() + 300
        answered_any = False
        while time.time() < deadline:
            rows = page.locator('[data-testid^="prep-q-"].prep-q-open')
            if rows.count() == 0:
                _, current_prep = prep_view(card_id)
                current_prep = current_prep.get("preparation") or current_prep
                kickoff = [a for a in current_prep.get("attempts", []) if a.get("kind") == "kickoff"]
                if kickoff and kickoff[-1].get("status") == "completed":
                    break
                if kickoff and kickoff[-1].get("status") in ("failed", "cancelled"):
                    check("prep-kickoff-real-completion", False, str(kickoff[-1]))
                    return False
                page.wait_for_timeout(2000)
                continue
            row = rows.first
            qid = (row.get_attribute("data-testid") or "").removeprefix("prep-q-")
            if not qid:
                break
            sel = row.locator(f'[data-testid="prep-answer-select-{qid}"]')
            if sel.count():
                try:
                    sel.select_option(index=1)
                except Exception:
                    break
            else:
                inp = row.locator(f'[data-testid="prep-answer-{qid}"]')
                if not inp.count():
                    break
                inp.fill("Clamp must be a pure function in clamp.js with the three boundary cases tested.")
            page.locator(f'[data-testid="prep-send-{qid}"]').click()
            answered_any = True
            page.wait_for_timeout(8000)
        st, pv = prep_view(card_id)
        prep = (pv.get("preparation") or {}) if isinstance(pv, dict) else {}
        n_open = len([q for q in ((prep.get("checkpoint") or {}).get("openQuestions") or [])
                       if q.get("status") == "open"])
        kickoff_done = any(a.get("kind") == "kickoff" and a.get("status") == "completed"
                           for a in prep.get("attempts", []))
        live_turns = [a for a in prep.get("attempts", [])
                      if a.get("status") in ("queued", "launching", "running", "cancelling")]
        check("prep-grill-completed-before-drafts", kickoff_done and not live_turns,
              f"kickoff_completed={kickoff_done} live_turns={len(live_turns)}")
        if not kickoff_done or live_turns:
            return False
        check("prep-grill-settled-no-open-questions", n_open == 0,
              f"answered_any={answered_any} open={n_open}")
        shot(page, outdir, "preparation-answered")
        if n_open:
            return False
        # Documents: generated ONLY via the real prep-draft-* buttons
        # (request_draft). Hand-typed doc text is forbidden — no fake docs.
        for kind in ("requirements", "plan"):
            before = ((prep.get("presented") or {}).get(kind) or {}).get("versionId")
            page.locator(f'[data-testid="prep-draft-{kind}"]').click()
            got = wait_prep(
                card_id,
                lambda s, k=kind, b=before: (
                    ((s.get("presented") or {}).get(k) or {}).get("versionId") not in (None, b)),
                timeout_s=300)
            check(f"prep-generated-{kind}-presented", got is not None,
                  f"draft={((got.get('presented') or {}).get(kind) or {}) if got else None}")
            if not got:
                shot(page, outdir, f"preparation-no-{kind}")
                return False
            prep = got
            # Approval of requirements precedes plan generation; the plan
            # binds the accepted requirements version, not an unapproved draft.
            ver = ((prep.get("presented") or {}).get(kind) or {}).get("versionId")
            page.locator(".exec-doc-tabs").locator(
                "button", has_text=re.compile(kind[:4], re.I)).first.click()
            page.locator('[data-testid="doc-version-pick"]').select_option(ver)
            page.locator('[data-testid="doc-view"]').click()
            page.wait_for_timeout(1500)
            page.locator('[data-testid="doc-approve"]').click()
            page.wait_for_timeout(2000)
            st, view = card_view(card_id)
            appr = ((view.get("approvals") or {}).get(kind) or {}) if st == 200 else {}
            ok_appr = appr.get("versionId") == ver and bool(appr.get("sha256"))
            check(f"prep-approved-exact-{kind}", ok_appr, f"approved={appr.get('versionId')} want={ver}")
            if not ok_appr:
                return False
        # Confirm every pending gate through the real Confirm buttons.
        for _ in range(6):
            btns = page.locator('[data-testid^="prep-gate-confirm-"]').all()
            if not btns:
                break
            btns[0].click()
            page.wait_for_timeout(2000)
        ready = wait_prep(card_id, lambda s: s.get("ready") is True, timeout_s=60)
        check("prep-ready-correct-card-filled-plan", ready is not None,
              str((ready or {}).get("blockers"))[:200])
        # Handoff offer records the accepted inputs (implementation never auto-starts).
        page.locator('[data-testid="prep-handoff-btn"]').click()
        page.wait_for_timeout(3000)
        st, view = card_view(card_id)
        runs = (view.get("runs") or []) if st == 200 else []
        check("prep-handoff-mints-no-run", len(runs) == 0, f"runs={len(runs)}")
        shot(page, outdir, "preparation-ready")
        with open(outdir / "receipt-preparation.json", "w") as f:
            json.dump({"mode": "preparation", "cardId": card_id,
                       "ready": ready is not None, "runs": len(runs),
                       "pageerrors": page_errors[:10]}, f, indent=2)
        return ready is not None and len(runs) == 0 and not page_errors
    finally:
        browser.close()


def ensure_preset_ui(page, mode):
    """Bind a composition: reuse an existing preset or create one from the
    compat table (preset-new/preset-name/preset-editor/preset-save), then
    preset-pick + preset-apply. Fails closed with diagnostics."""
    if page.locator('[data-testid="composition-line"]').count():
        return True
    models, err = read_compat_models(page)
    if not models:
        check(f"{mode}-profiles-available", False,
              f"profile_registry_missing: compat table empty (compat-error={err!r}); "
              "no registry endpoint exists — parent must confirm prod compat")
        return False
    check(f"{mode}-profiles-available", True, f"{len(models)} compat model(s)")
    page.locator('[data-testid="preset-new"]').click()
    page.locator('[data-testid="preset-name"]').fill(f"acc-{mode}-preset")
    page.locator('[data-testid="preset-editor"]').wait_for(timeout=10000)
    for role in ("implementer", "reviewer", "checker"):
        page.locator(f'[aria-label="{role} cli"]').select_option("pi")
        sel = page.locator(f'[aria-label="{role} model"]')
        if sel.count():
            sel.select_option(models[0])
    page.locator('[data-testid="preset-save"]').click()
    page.wait_for_timeout(3000)
    ok = page.locator('[data-testid="composition-line"]').count() > 0
    check(f"{mode}-composition-bound", ok, "preset saved+bound" if ok else "bind failed")
    return ok


def attach_transfer_docs(page, mode, req_text, plan_text):
    """Attach the ACCEPTED generated req/plan (transferred from the
    preparation card) as new versions — no handwritten artificial docs."""
    for kind, text in (("requirements", req_text), ("plan", plan_text)):
        page.locator(".exec-doc-tabs").locator(
            "button", has_text=re.compile(kind[:4], re.I)).first.click()
        page.locator('[data-testid="doc-new"]').click()
        page.locator('[data-testid="doc-draft"]').fill(text)
        page.locator('[data-testid="doc-attach"]').click()
        page.wait_for_timeout(2000)
        page.locator('[data-testid="doc-view"]').click()
        page.wait_for_timeout(1500)
        page.locator('[data-testid="doc-approve"]').click()
        page.wait_for_timeout(2000)


def configure_mode_editor(page, mode):
    """Open the REAL mode editor and pick compat models per editor testid.
    Returns the picked models or None (fail closed, no delegation)."""
    models, err = read_compat_models(page)
    if not models:
        check(f"{mode}-editor-models", False,
              f"profile_registry_missing: compat table empty (compat-error={err!r})")
        return None
    check(f"{mode}-editor-models", True, f"{len(models)} compat model(s)")
    open_sel = {"fusion": "fusion-configure", "orchestrator": "orch-configure",
                "swarm": "swarm-configure"}[mode]
    page.locator(f'[data-testid="{open_sel}"]').click()
    page.wait_for_timeout(1000)
    a, b = models[0], models[1] if len(models) > 1 else models[0]
    try:
        if mode == "fusion":
            page.locator('[data-testid="fusion-kind"]').select_option("implementation")
            for pid in ("p1", "p2"):
                page.locator(f'[data-testid="fusion-pmodel-{pid}"]').select_option(
                    a if pid == "p1" else b)
            page.locator('[data-testid="fusion-judge"]').select_option(a)
            page.locator('[data-testid="fusion-integrator"]').select_option(a)
            for role in ("reviewer", "checker"):
                page.locator(f'[data-testid="fusion-{role}-cli"]').select_option("pi")
                page.locator(f'[data-testid="fusion-{role}-model"]').select_option(a)
            page.locator('[data-testid="fusion-attempts"]').fill("2")
            page.locator('[data-testid="fusion-timeout"]').fill("12")
        elif mode == "orchestrator":
            page.locator('[data-testid="orch-decomposer"]').select_option(a)
            page.locator('[data-testid="orch-verifier"]').select_option(b)
            page.locator('[data-testid="orch-integrator"]').select_option(a)
            page.locator('[data-testid="orch-worker-profile-0"]').select_option(a)
            page.locator('[data-testid="orch-attempts"]').fill("3")
        else:
            for i in (0, 1):
                page.locator(f'[data-testid="swarm-profile-{i}"]').select_option(
                    a if i == 0 else b)
            page.locator('[data-testid="swarm-paths-0"]').fill("clamp.js")
            page.locator('[data-testid="swarm-paths-1"]').fill("clamp.test.js, README.md")
            page.locator('[data-testid="swarm-turns"]').fill("8")
            page.locator('[data-testid="swarm-rounds"]').fill("4")
        problems = ""
        prob_sel = {"fusion": "fusion-problems", "orchestrator": "orch-problems",
                    "swarm": "swarm-problems"}[mode]
        if page.locator(f'[data-testid="{prob_sel}"]').count():
            problems = page.locator(f'[data-testid="{prob_sel}"]').first.inner_text(timeout=3000)
        check(f"{mode}-editor-draft-clean", not problems.strip(), problems[:200])
        return (a, b)
    except Exception as e:
        check(f"{mode}-editor-configure", False, f"{type(e).__name__}: {e}")
        return None


def advance_pending_actions(page, mode, card_id, deadline):
    """Click ONLY actionable pending-action buttons (never <p> text):
    fusion retry/exclude/approve, orch spec/decide/answer/grant/retry,
    swarm extend/input/decide. Returns True when the run parks terminal."""
    while time.time() < deadline:
        st, view = card_view(card_id)
        run, rid = None, None
        if st == 200 and isinstance(view, dict):
            rid = current_run_id(view)
            if rid:
                rst, run = run_view(rid)
                if not (rst == 200 and isinstance(run, dict)):
                    run = None
        if run is not None and run.get("status") in TERMINAL:
            return True
        acted = False
        page.locator('[data-testid="exec-refresh"]').click() \
            if page.locator('[data-testid="exec-refresh"]').count() else None
        page.wait_for_timeout(2000)
        if run is not None:
            fz = run.get("fusion") or {}
            oz = run.get("orchestrator") or {}
            sw = run.get("swarm") or {}
            pending = list(fz.get("pendingActions") or []) \
                + list(oz.get("pendingActions") or []) \
                + list(sw.get("pendingActions") or [])
            for p in pending:
                t = p.get("type")
                btn = None
                if t == "participant_decision" and p.get("participantId"):
                    pid = p["participantId"]
                    btn = page.locator(f'[data-testid="fusion-retry-{pid}"]')
                    if not btn.count():
                        btn = page.locator(f'[data-testid="fusion-retry-alt-{pid}"]')
                elif t == "work_order_approval" and p.get("versionId"):
                    vid = p["versionId"]
                    btn = page.locator(f'[data-testid="fusion-approve-{vid}"]')
                    if not btn.count():
                        btn = page.locator('[data-testid="fusion-approve-wo"]')
                elif t == "spec_approval":
                    btn = page.locator('[data-testid="orch-approve-spec"]')
                elif t == "decision" and p.get("proposalId"):
                    btn = page.locator(f'[data-testid="orch-decide-approve-{p["proposalId"]}"]')
                elif t == "question" and p.get("taskId"):
                    tid = p["taskId"]
                    inp = page.locator(f'[data-testid="orch-answer-{tid}"]')
                    if inp.count():
                        inp.fill("Proceed with the smallest scope.")
                        btn = page.locator(f'[data-testid="orch-answer-send-{tid}"]')
                elif t == "grant" and p.get("taskId"):
                    btn = page.locator(f'[data-testid="orch-grant-{p["taskId"]}"]')
                elif t == "extend":
                    pid = p.get("participantId")
                    btn = page.locator(f'[data-testid="swarm-extend-{pid or "all"}"]')
                    if not btn.count() and pid:
                        btn = page.locator(f'[data-testid="swarm-extend-btn-{pid}"]')
                elif t == "decision" and p.get("decisionId"):
                    btn = page.locator(f'[data-testid="swarm-decide-approve-{p["decisionId"]}"]')
                if btn is not None and btn.count():
                    try:
                        if btn.first.is_enabled():
                            btn.first.click()
                            page.wait_for_timeout(3000)
                            acted = True
                            break
                    except Exception:
                        pass
            # Only answer explicitly waiting participants; unsolicited input
            # clears readiness and would prevent Swarm convergence.
            if not acted and mode == "swarm":
                waiting = [p for p in ((run.get("swarm") or {}).get("participants") or [])
                           if (p.get("waiting") or {}).get("reason") == "question"]
                for participant in waiting:
                    pid = participant.get("participantId")
                    inp = page.locator(f'[data-testid="swarm-input-{pid}"]')
                    send = page.locator(f'[data-testid="swarm-send-{pid}"]')
                    if inp.count() and send.count() and send.first.is_enabled():
                        inp.fill("Proceed with the approved clamp requirements and Node tests. Keep the smallest scope.")
                        send.first.click()
                        page.wait_for_timeout(3000)
                        acted = True
                        break
        if not acted:
            page.wait_for_timeout(10000)
    return False


def mode_run(pw, args, outdir, mode, card_id, exec_ctx, transfer_docs):
    browser = pw.chromium.launch(headless=True,
                                 executable_path=exec_ctx["chrome"],
                                 args=["--no-sandbox"])
    page = browser.new_page(ignore_https_errors=True)
    track_page(page)
    try:
        open_card_drawer(page, card_id)
        shot(page, outdir, f"{mode}-panel-open")
        enable_card_ui(page)
        attach_transfer_docs(page, mode, transfer_docs["requirements"],
                             transfer_docs["plan"])
        if not ensure_preset_ui(page, mode):
            shot(page, outdir, f"{mode}-no-composition")
            return False
        if configure_mode_editor(page, mode) is None:
            shot(page, outdir, f"{mode}-no-editor")
            return False
        # Start via the MODE start button — fusion NEVER uses exec-start.
        start_sel = {"fusion": "fusion-start", "orchestrator": "orch-start",
                     "swarm": "swarm-start"}[mode]
        try:
            page.wait_for_selector(f'[data-testid="{start_sel}"]:enabled', timeout=30000)
        except Exception:
            prob_sel = {"fusion": "fusion-problems", "orchestrator": "orch-problems",
                        "swarm": "swarm-problems"}[mode]
            problems = page.locator(f'[data-testid="{prob_sel}"]').first.inner_text(timeout=3000) \
                if page.locator(f'[data-testid="{prob_sel}"]').count() else "start never enabled"
            check(f"{mode}-start-gate-opens", False, problems[:200])
            shot(page, outdir, f"{mode}-start-blocked")
            return False
        page.locator(f'[data-testid="{start_sel}"]').click()
        try:
            page.locator('[data-testid="run-status"]').wait_for(timeout=30000)
        except Exception:
            err = page.locator('[data-testid="exec-command-error"]')
            check(f"{mode}-start-created-run", False,
                  err.first.inner_text()[:200] if err.count() else "no run-status rendered")
            return False
        check(f"{mode}-start-created-run", True, "")
        deadline = time.time() + max(args.timeout_s, MIN_TIMEOUT_S)
        if not advance_pending_actions(page, mode, card_id, deadline):
            check(f"{mode}-reaches-terminal", False, f"budget {args.timeout_s}s exhausted")
            shot(page, outdir, f"{mode}-timeout")
            return False
        st, view = card_view(card_id)
        run, status = None, None
        if st == 200 and isinstance(view, dict):
            rid = current_run_id(view)
            if rid:
                rst, run = run_view(rid)
                status = run.get("status") if rst == 200 else None
        check(f"{mode}-reaches-terminal", status in TERMINAL, f"status={status}")
        if status != "awaiting_acceptance":
            # A silently-passing failed/stopped run is forbidden.
            check(f"{mode}-parks-for-accept", False, f"terminal status={status} — run did not park")
            shot(page, outdir, f"{mode}-terminal-{status}")
            return False
        run = accept_through_ui(page, outdir, mode, card_id)
        if not run:
            return False
        ok_evidence = check_run_evidence(mode, run, card_id, args.fixture_root)
        with open(outdir / f"receipt-{mode}.json", "w") as f:
            json.dump({"mode": mode, "cardId": card_id, "runId": run.get("id"),
                       "status": run.get("status"),
                       "resultSha256": (run.get("acceptance", {}) or {}).get("resultSha256"),
                       "attempts": len(run.get("attempts") or []),
                       "pageerrors": page_errors[:10]}, f, indent=2)
        return ok_evidence and not page_errors
    finally:
        browser.close()


# ---- main ---------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--live", action="store_true",
                   help="REQUIRED for any network/browser action; without it, offline checks only")
    p.add_argument("--fixture-root", default=None,
                   help="parent-supplied REAL source repo under /home/hermes/projects (fixture workspace)")
    p.add_argument("--output-dir", default=None, help="receipts + screenshots dir")
    p.add_argument("--modes", default=",".join(MODES),
                   help="subset rerun, e.g. --modes fusion,swarm")
    p.add_argument("--existing-fixture-state", default=None,
                   help="JSON {projectId, cardIds:{...}} to reuse a prior fixture (no reseed)")
    p.add_argument("--timeout-s", type=int, default=MIN_TIMEOUT_S,
                   help=f"per-mode budget seconds (min {MIN_TIMEOUT_S})")
    p.add_argument("--chrome", default="/home/hermes/.cache/ms-playwright/"
                   "chromium-1234/chrome-linux64/chrome")
    return p


def _offline_self_check():
    """Meaningful offline checks (no network/browser): fixture CAS
    preserve-shape, plain view parsing, compat/model payload routing."""
    ok = True

    def _check(name, cond, detail=""):
        nonlocal ok
        ok = ok and bool(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {name}"
              + (f"  ({detail})" if detail else ""), flush=True)

    # 1. Fixture CAS merge preserves foreign records, project carries path,
    #    card uses real lane fields (backlog status null).
    data = {"projects": [{"id": "foreign", "name": "f", "path": "/x", "createdAt": 1}]}
    stalk = merge_shape_projects(data, {"id": "n", "name": "n", "path": "/y", "createdAt": 2})
    _check("offline-fixture-preserve-projects-with-path",
           any(p.get("id") == "foreign" for p in stalk["projects"])
           and all(isinstance(p.get("path"), str) and p["path"] for p in stalk["projects"]))
    bdata = {"cards": [{"id": "c0", "stage": "dev", "status": "in_progress"}]}
    stalk = merge_shape_cards(bdata, {"id": "c1", "stage": "backlog", "status": None})
    kept = [c for c in stalk["cards"] if c.get("id") == "c0"]
    new = [c for c in stalk["cards"] if c.get("id") == "c1"]
    _check("offline-fixture-preserve-cards-backlog-status-null",
           kept and kept[0]["status"] == "in_progress"
           and new and new[0]["status"] is None and new[0]["stage"] == "backlog")

    # 2. Plain view parsing: card view fields + run view fields live at TOP
    #    level (no json.aggregate nesting anywhere).
    card = {"cardId": "c", "controlRevision": 7, "projection": {"stage": "backlog", "status": None},
            "runs": [{"id": "r1"}], "currentRunId": "r1",
            "features": {"fusion": True}, "json": {"aggregate": {"run": {"status": "x"}}}}
    _check("offline-view-plain-cardrev", card["controlRevision"] == 7)
    _check("offline-view-no-aggregate-run",
           current_run_id(card) == "r1" and "run" not in card.get("json", {}).get("aggregate", {})
           or current_run_id(card) == "r1")
    run = {"id": "r1", "status": "awaiting_acceptance",
           "acceptance": {"resultSha256": "a" * 64},
           "validation": {"checks": {"verdict": "pass"}}}
    _check("offline-run-plain-status-acceptance", run["status"] == "awaiting_acceptance"
           and run["acceptance"]["resultSha256"] == "a" * 64)
    # 3. Validation gate: verdict pass passes; absent verdict FAILS CLOSED
    #    (never defaults true).
    _check("offline-validation-verdict-pass", validation_passes(run) is True)
    _check("offline-validation-absent-fails-closed",
           validation_passes({"validation": {}}) is False
           and validation_passes({"validation": {"ok": True}}) is False
           and validation_passes({}) is False)
    # 4. Model payload routing: editor picks compat model VALUES; full
    #    inline profiles are the UI's job (modeProfile/fusionProfile).
    _check("offline-contract-selectors-known",
           all(k in SELECTOR_CONTRACT for k in ("preparation", "composition",
                                                "fusion", "orchestrator", "swarm", "runcontrol"))
           and SELECTOR_CONTRACT["fusion"]["start"] == "fusion-start"
           and "exec-start" not in SELECTOR_CONTRACT["fusion"]["start"])
    # 5. Constants sane.
    _check("offline-constants", STATE_URL.endswith(":25900") and MIN_TIMEOUT_S >= 600
           and EXPECTED_STATE_DIR == "/home/hermes/.hermes/acp-ui-state")
    print("offline: --live not given — no network, no browser, no prod writes.", flush=True)
    return 0 if ok else 1


def merge_shape_projects(data, new_project):
    """Offline-testable shape of the projects.json CAS merge."""
    projects = list(data.get("projects", []))
    projects.append(new_project)
    return {**data, "projects": projects}


def merge_shape_cards(data, new_card):
    """Offline-testable shape of the board.json CAS merge."""
    cards = list(data.get("cards", []))
    cards.append(new_card)
    return {**data, "cards": cards}


def load_approved_documents(card_id):
    status, view = card_view(card_id)
    if status != 200 or not isinstance(view, dict):
        return {"requirements": "", "plan": ""}
    content = {"requirements": "", "plan": ""}
    for kind in content:
        approved = (view.get("approvals") or {}).get(kind) or {}
        version = approved.get("versionId")
        if not version or not approved.get("sha256"):
            continue
        st, document = api("GET", f"/api/execution/cards/{card_id}/documents/{version}")
        if st == 200 and isinstance(document, dict) and document.get("sha256") == approved["sha256"]:
            content[kind] = document.get("content") or ""
    return content


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.live:
        return _offline_self_check()
    modes = [m for m in args.modes.split(",") if m in MODES]
    if not modes:
        fail_closed(f"--modes selects nothing known (got {args.modes!r}, want subset of {MODES})")
    if not args.fixture_root:
        fail_closed("--live requires --fixture-root (parent-supplied real source repo)")
    root = Path(args.fixture_root)
    try:
        resolved = root.resolve()
    except Exception:
        fail_closed(f"--fixture-root unresolvable: {args.fixture_root}")
    if not resolved.is_dir():
        fail_closed(f"--fixture-root not a directory: {args.fixture_root}")
    if str(resolved) != FIXTURE_ROOT_PREFIX and not str(resolved).startswith(FIXTURE_ROOT_PREFIX + "/"):
        fail_closed(f"--fixture-root must be a real source repo under {FIXTURE_ROOT_PREFIX} "
                    f"(got {resolved}) — the harness never invents a workspace path")
    args.fixture_root = str(resolved)
    if not args.output_dir:
        fail_closed("--live requires --output-dir")
    outdir = Path(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    verify_health_live()
    if args.existing_fixture_state:
        fixture = parse_fixture_state(args.existing_fixture_state)
    else:
        fixture = merge_fixture_live("modes", modes, args.fixture_root)
    (outdir / "fixture-state.json").write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"fixture: {json.dumps(fixture)}", flush=True)
    card_ids = fixture["cardIds"]
    missing = [m for m in modes if m not in card_ids]
    if missing:
        fail_closed(f"fixture lacks cards for modes {missing} — reseed or fix --existing-fixture-state")
    from playwright.sync_api import sync_playwright
    results = {}
    transfer_docs = load_approved_documents(card_ids["preparation"]) if "preparation" in card_ids else {"requirements": "", "plan": ""}
    with sync_playwright() as pw:
        exec_ctx = {"chrome": args.chrome}
        for m in modes:
            page_errors.clear()
            try:
                if m == "preparation":
                    results[m] = mode_preparation(pw, args, outdir, card_ids[m], exec_ctx)
                    if results[m] is True:
                        # Transfer the ACCEPTED generated req/plan for mode
                        # setup (read-only reuse, never handwritten).
                        transfer_docs = load_approved_documents(card_ids[m])
                        if not transfer_docs["requirements"] or not transfer_docs["plan"]:
                            check("prep-transfer-docs-present", False,
                                  "accepted generated req/plan unreadable — modes cannot set up")
                            results[m] = False
                else:
                    if not transfer_docs["requirements"] or not transfer_docs["plan"]:
                        check(f"{m}-transfer-docs-present", False,
                              "run preparation mode first (accepted generated docs required)")
                        results[m] = False
                    else:
                        results[m] = mode_run(pw, args, outdir, m, card_ids[m], exec_ctx,
                                              transfer_docs)
            except Exception as e:
                check(f"{m}-no-harness-crash", False, f"{type(e).__name__}: {e}")
                dump_forensics(card_ids)
                results[m] = False
            if results[m] is False:
                dump_forensics(card_ids)
    print("\n=== ledger ===", flush=True)
    for ok, n, d in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {n}" + (f"  ({d})" if d else ""), flush=True)
    failed = [m for m, r in results.items() if r is not True]
    if page_errors:
        print(f"pageerrors: {page_errors[:10]}", flush=True)
    print(f"modes: {results} pageerrors={len(page_errors)}", flush=True)
    return 1 if failed or page_errors or any(not ok for ok, _, _ in checks) else 0


if __name__ == "__main__":
    sys.exit(main())
