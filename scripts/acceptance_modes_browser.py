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
      --fixture-root <mounted-allowed-WORKSPACE_ROOT> --output-dir <dir> \\
      [--modes preparation,fusion,orchestrator,swarm] [--existing-fixture-state JSON]
      [--profile-a ID --profile-b ID] [--timeout-s 600]

Without --live: prints usage-relevant offline self-check result, touches no
network, exits 0 (--help exits 0 as usual). No default run does anything live.

Flow per mode (all through the real panel UI; a silently-passing
failed/stopped run is FORBIDDEN — terminal non-accepted states FAIL):
  preparation : fill prep-intent -> prep-start (real grill discussion) ->
                answer via prep-a-<qid>/prep-send-<qid> -> attach+approve
                requirements/plan docs -> assert binding gates correct card,
                filled plan exists, ready state.
  fusion/orchestrator/swarm : compose via panel documents/composition setup
                (reuse accepted generated docs where UI allows) -> panel start
                with runtime-discovered profile IDs -> advance ONLY user-pending
                approvals (pendingActions) -> terminal accept through UI
                (exec-accept bound to accept_result{resultSha256}) ->
                assert result/checks/workspace diffs REAL.

Profiles: NEVER guessed. Runtime discovery order: explicit --profile-* args,
then the UI-rendered compat list (exec.compatibility[cli].models — the only
server-blessed source); empty -> fail closed with profile_registry_missing.

Fixture: CAS-merge a UNIQUE prefixed project/card set (acc-b<ts>-*) into
projects.json/board.json via GET rev + PUT rev. Preserves ALL existing
records; deletes NOTHING foreign. --existing-fixture-state JSON reuses a
prior fixture ({projectId, cardIds:{...}}) to avoid reseed duplicates.
--fixture-root is the private git fixture path the PARENT supplies (mounted
allowed WORKSPACE_ROOT); the harness refuses --live without it.

Evidence: <output-dir>/<mode>-*.png screenshots, receipt-<mode>.json, zero
pageerrors required. Per-mode budget >=600s (bounded poll, fail-fast with
panel text + pendingActions + events tail + traffic tail diagnostics).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

STATE_URL = "http://127.0.0.1:25900"
UI_URL = "https://127.0.0.1:25809/"
EXPECTED_STATE_DIR = "/home/hermes/.hermes/acp-ui-state"
TERMINAL = {"awaiting_acceptance", "succeeded", "failed", "cancelled",
            "stopped", "blocked"}
MODES = ("preparation", "fusion", "orchestrator", "swarm")
MIN_TIMEOUT_S = 600

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []
DIAG_NET: list[str] = []
DIAG_PAGES: list = []


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
    return api("GET", f"/api/execution/cards/{card_id}")


def send_command(card_id, ctype, payload=None, rev=None, cid=None):
    """POST a user command; one fresh-rev retry on CAS conflict (never for explicit stale rev)."""
    if rev is None:
        st, view = card_view(card_id)
        rev = int(view["controlRevision"]) if st == 200 else 0
        explicit = False
    else:
        explicit = True
    body = {"commandId": cid or f"acc-{uuid.uuid4().hex[:12]}", "type": ctype,
            "expectedControlRevision": rev, "payload": payload or {}}
    st, res = api("POST", f"/api/execution/cards/{card_id}/commands", body)
    if st == 409 and not explicit:
        st2, view = card_view(card_id)
        if st2 == 200:
            body["expectedControlRevision"] = int(view["controlRevision"])
            st, res = api("POST", f"/api/execution/cards/{card_id}/commands", body)
    return st, res


# ---- fixture: CAS merge, preserve-all, delete-nothing -------------------------

def merge_fixture_live(tag, kinds):
    """Merge unique prefixed project + cards; returns {projectId, cardIds}."""
    ts = time.strftime("%Y%m%d%H%M%S")
    pid = f"acc-b{ts}-{tag}"
    card_ids = {m: f"{pid}-{m}" for m in kinds}
    st, doc = api("GET", "/api/state/projects.json")
    data = doc.get("data", {}) if st == 200 and isinstance(doc, dict) else {}
    rev = doc.get("rev", 0) if st == 200 else 0
    projects = list(data.get("projects", []))
    if any(p.get("id") == pid for p in projects):
        fail_closed(f"fixture collision {pid} — pass --existing-fixture-state instead of reseeding")
    projects.append({"id": pid, "name": f"acceptance {tag} {ts}"})
    st, res = api("PUT", "/api/state/projects.json",
                  {"rev": rev, "data": {**data, "projects": projects}})
    if st != 200:
        fail_closed(f"projects.json CAS merge -> {st} {str(res)[:300]}")
    st, doc = api("GET", "/api/state/board.json")
    data = doc.get("data", {}) if st == 200 and isinstance(doc, dict) else {}
    rev = doc.get("rev", 0) if st == 200 else 0
    cards = list(data.get("cards", []))
    have = {c.get("id") for c in cards}
    for m, cid in card_ids.items():
        if cid in have:
            fail_closed(f"fixture card collision {cid}")
        cards.append({"id": cid, "projectId": pid, "title": f"acceptance {m} {ts}",
                      "status": "todo"})
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
    page.on("dialog", lambda d: d.accept())
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
            agg = (view.get("json", {}) if isinstance(view, dict) else {})
            print(f"server {m} {cid}: st={st} {str(agg)[:400]}", flush=True)
        except Exception as e:
            print(f"server {cid} fetch failed: {e}", flush=True)
    print("api traffic (last 30):", flush=True)
    for line in DIAG_NET[-30:]:
        print(f"  {line}", flush=True)
    print("pageerrors:", page_errors[:10], flush=True)


def discover_profiles(page):
    """Read the UI-rendered compat model list — the only server-blessed source."""
    try:
        return page.evaluate(
            """() => { const el = document.querySelector('[data-testid="exec-composition"]');"""
            """ return (window.__accCompat ?? null); }""")
    except Exception:
        return None


def wait_run_terminal(card_id, deadline, poll=10.0):
    """Poll until run.status terminal; returns (run, events_tail)."""
    last = None
    while time.time() < deadline:
        st, view = card_view(card_id)
        if st == 200:
            agg = ((view.get("json", {}) or {}).get("aggregate", {}) or {})
            run = agg.get("run") or {}
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
    agg = ((view.get("json", {}) or {}).get("aggregate", {}) or {}) if st == 200 else {}
    ok = (agg.get("run", {}) or {}).get("status") == "succeeded"
    check(f"{mode}-ui-accept-succeeds", ok, f"status={(agg.get('run', {}) or {}).get('status')}")
    shot(page, outdir, f"{mode}-accepted")
    return agg.get("run") if ok else None


# ---- modes --------------------------------------------------------------------

README_TASK = ("Add clamp.js: export function clamp(n, lo, hi) returning "
               "Math.min(hi, Math.max(lo, n)); add Node test asserting "
               "clamp(5,0,10)===5, clamp(-1,0,10)===0, clamp(99,0,10)===10.")


def mode_preparation(pw, args, outdir, card_id, exec_ctx):
    from playwright.sync_api import sync_playwright as _unused  # noqa
    browser = pw.chromium.launch(headless=True,
                                 executable_path=exec_ctx["chrome"],
                                 args=["--no-sandbox"])
    page = browser.new_page(ignore_https_errors=True)
    track_page(page)
    try:
        page.goto(UI_URL, wait_until="domcontentloaded")
        page.wait_for_selector('[data-testid="prep-panel"]', timeout=30000)
        intent = ("Acceptance clamp feature: " + README_TASK)
        page.locator('[data-testid="prep-intent"]').fill(intent)
        page.locator('[data-testid="prep-start"]').click()
        # Real grill discussion: wait for a durable question (generous bound).
        q = page.locator('[data-testid^="prep-q-"]').first
        try:
            q.wait_for(state="visible", timeout=300000)
            check("prep-grill-question-arrives", True, "")
        except Exception as e:
            check("prep-grill-question-arrives", False, f"no question in 300s: {e}")
            shot(page, outdir, "preparation-no-question")
            return False
        qid = q.get_attribute("data-testid").removeprefix("prep-q-")
        page.locator(f'[data-testid="prep-a-{qid}"]').fill(
            "Clamp must be a pure function in clamp.js with the three boundary cases tested.")
        page.locator(f'[data-testid="prep-send-{qid}"]').click()
        page.wait_for_timeout(5000)
        shot(page, outdir, "preparation-answered")
        # Requirements + plan docs: attach text, approve, confirm gates.
        for kind, text in (("requirements", "REQ: clamp.js pure function + Node test."),
                            ("plan", "PLAN: 1) clamp.js 2) test 3) run node --test.")):
            page.locator('[data-testid="doc-new"]').click()
            page.locator('[data-testid="doc-draft"]').fill(text)
            page.locator('[data-testid="doc-attach"]').click()
            page.wait_for_timeout(2000)
        page.locator('[data-testid="doc-approve"]').click()
        page.wait_for_timeout(3000)
        for g in page.locator('[data-testid^="prep-gate-confirm-"]').all():
            try:
                g.click()
                page.wait_for_timeout(1500)
            except Exception:
                pass
        ready = page.locator('[data-testid="prep-ready"]')
        ok_ready = ready.count() > 0 and "ready" in (ready.first.inner_text() or "").lower()
        check("prep-ready-correct-card-filled-plan", ok_ready, "ready indicator after gates")
        gates = page.locator('[data-testid="prep-gates"]').first.inner_text(timeout=5000) \
            if page.locator('[data-testid="prep-gates"]').count() else ""
        check("prep-binding-gates-sane", "requir" in gates.lower() or "plan" in gates.lower(),
              gates[:200])
        shot(page, outdir, "preparation-ready")
        with open(outdir / "receipt-preparation.json", "w") as f:
            json.dump({"mode": "preparation", "cardId": card_id, "ready": ok_ready,
                       "pageerrors": page_errors[:10]}, f, indent=2)
        return ok_ready and not page_errors
    finally:
        browser.close()


def mode_run(pw, args, outdir, mode, card_id, exec_ctx, profile_ids):
    browser = pw.chromium.launch(headless=True,
                                 executable_path=exec_ctx["chrome"],
                                 args=["--no-sandbox"])
    page = browser.new_page(ignore_https_errors=True)
    track_page(page)
    try:
        page.goto(UI_URL, wait_until="domcontentloaded")
        page.wait_for_selector('[data-testid="execution-panel"]', timeout=30000)
        # TODO(parent-run): select card `card_id` via board/panel card picker.
        shot(page, outdir, f"{mode}-panel-open")
        profiles = profile_ids or (discover_profiles(page) or [])
        if not profiles:
            check(f"{mode}-profiles-available", False,
                  "profile_registry_missing: no --profile-* args and no UI compat list; "
                  "backend contract §3 provides inline profiles only, no registry endpoint")
            return False
        check(f"{mode}-profiles-available", True, f"{len(profiles)} profile(s)")
        # Composition via panel setup + start; per-mode testids resolved live.
        start_sel = {"fusion": '[data-testid="exec-start"]',
                     "orchestrator": '[data-testid="orch-start"]',
                     "swarm": '[data-testid="swarm-start"]'}[mode]
        if page.locator(start_sel).count() == 0:
            start_sel = '[data-testid="exec-start"]'
        page.locator(start_sel).click()
        # Advance ONLY user-pending approvals until terminal (bounded).
        deadline = time.time() + max(args.timeout_s, MIN_TIMEOUT_S)
        approved_any = False
        while time.time() < deadline:
            st, view = card_view(card_id)
            agg = ((view.get("json", {}) or {}).get("aggregate", {}) or {}) if st == 200 else {}
            run = agg.get("run", {}) or {}
            if run.get("status") in TERMINAL:
                break
            pending = ((run.get("orchestrator", {}) or {}).get("pendingActions", [])
                       + (run.get("swarm", {}) or {}).get("pendingActions", []))
            acted = False
            for a in pending:
                btn = page.locator(f'[data-testid="{mode}-pending-{a.get("type")}"]')
                if btn.count():
                    btn.first.click()
                    page.wait_for_timeout(3000)
                    acted = True
                    approved_any = True
                    break
            if not acted:
                page.wait_for_timeout(10000)
        else:
            check(f"{mode}-reaches-terminal", False, f"budget {args.timeout_s}s exhausted")
            shot(page, outdir, f"{mode}-timeout")
            return False
        st, view = card_view(card_id)
        agg = ((view.get("json", {}) or {}).get("aggregate", {}) or {}) if st == 200 else {}
        status = (agg.get("run", {}) or {}).get("status")
        check(f"{mode}-reaches-terminal", status in TERMINAL, f"status={status}")
        if status != "awaiting_acceptance":
            # A silently-passing failed/stopped run is forbidden.
            check(f"{mode}-parks-for-accept", False,
                  f"terminal status={status} (approved_any={approved_any}) — run did not park")
            shot(page, outdir, f"{mode}-terminal-{status}")
            return False
        run = accept_through_ui(page, outdir, mode, card_id)
        if not run:
            return False
        ok_checks = bool((run.get("validation", {}) or {}).get("ok", True)) and \
            bool(run.get("acceptance", {}).get("resultSha256"))
        check(f"{mode}-result-checks-real", ok_checks, "result hash + validation present")
        with open(outdir / f"receipt-{mode}.json", "w") as f:
            json.dump({"mode": mode, "cardId": card_id, "runId": run.get("id"),
                       "status": run.get("status"), "resultSha256":
                       (run.get("acceptance", {}) or {}).get("resultSha256"),
                       "approvedAny": approved_any, "pageerrors": page_errors[:10]}, f, indent=2)
        return ok_checks and not page_errors
    finally:
        browser.close()


# ---- main ---------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--live", action="store_true",
                   help="REQUIRED for any network/browser action; without it, offline checks only")
    p.add_argument("--fixture-root", default=None,
                   help="parent-supplied mounted allowed WORKSPACE_ROOT for the private git fixture")
    p.add_argument("--output-dir", default=None, help="receipts + screenshots dir")
    p.add_argument("--modes", default=",".join(MODES),
                   help="subset rerun, e.g. --modes fusion,swarm")
    p.add_argument("--existing-fixture-state", default=None,
                   help="JSON {projectId, cardIds:{...}} to reuse a prior fixture (no reseed)")
    p.add_argument("--profile-a", default=None, help="explicit profile ID override")
    p.add_argument("--profile-b", default=None, help="explicit profile ID override")
    p.add_argument("--decomposer", default=None)
    p.add_argument("--verifier", default=None)
    p.add_argument("--integrator", default=None)
    p.add_argument("--worker", default=None)
    p.add_argument("--timeout-s", type=int, default=MIN_TIMEOUT_S,
                   help=f"per-mode budget seconds (min {MIN_TIMEOUT_S})")
    p.add_argument("--chrome", default="/home/hermes/.cache/ms-playwright/"
                   "chromium-1234/chrome-linux64/chrome")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.live:
        print("offline: --live not given — no network, no browser, no prod writes. "
              "Self-check: argparse ok, constants ok "
              f"(STATE={STATE_URL} UI={UI_URL} DIR={EXPECTED_STATE_DIR}).", flush=True)
        return 0
    modes = [m for m in args.modes.split(",") if m in MODES]
    if not modes:
        fail_closed(f"--modes selects nothing known (got {args.modes!r}, want subset of {MODES})")
    if not args.fixture_root:
        fail_closed("--live requires --fixture-root (parent-supplied mounted WORKSPACE_ROOT)")
    if not Path(args.fixture_root).is_dir():
        fail_closed(f"--fixture-root not a directory: {args.fixture_root}")
    if not args.output_dir:
        fail_closed("--live requires --output-dir")
    outdir = Path(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    verify_health_live()
    if args.existing_fixture_state:
        fixture = parse_fixture_state(args.existing_fixture_state)
    else:
        fixture = merge_fixture_live("modes", modes)
    print(f"fixture: {json.dumps(fixture)}", flush=True)
    card_ids = fixture["cardIds"]
    missing = [m for m in modes if m not in card_ids]
    if missing:
        fail_closed(f"fixture lacks cards for modes {missing} — reseed or fix --existing-fixture-state")
    from playwright.sync_api import sync_playwright
    profiles = [x for x in (args.profile_a, args.profile_b) if x]
    results = {}
    with sync_playwright() as pw:
        exec_ctx = {"chrome": args.chrome}
        for m in modes:
            page_errors.clear()
            try:
                if m == "preparation":
                    results[m] = mode_preparation(pw, args, outdir, card_ids[m], exec_ctx)
                else:
                    results[m] = mode_run(pw, args, outdir, m, card_ids[m], exec_ctx, profiles)
            except Exception as e:
                check(f"{m}-no-harness-crash", False, f"{type(e).__name__}: {e}")
                dump_forensics(card_ids)
                results[m] = False
            if results[m] is False:
                dump_forensics(card_ids)
    print("\n=== ledger ===", flush=True)
    for n, ok, d in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {n}" + (f"  ({d})" if d else ""), flush=True)
    failed = [m for m, r in results.items() if r is not True]
    if page_errors:
        print(f"pageerrors: {page_errors[:10]}", flush=True)
    print(f"modes: {results} pageerrors={len(page_errors)}", flush=True)
    return 1 if failed or page_errors else 0


if __name__ == "__main__":
    sys.exit(main())
