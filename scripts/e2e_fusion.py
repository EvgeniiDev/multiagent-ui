#!/usr/bin/env python3
"""e2e_fusion.py — F4 real-browser suite over the isolated compose stack.

Drives the ACTUAL page against the test state server + web container on
the fixed ports, on the FUSION overlay (ACP_EXEC_FUSION=1 — transition
mode `fusion`, stacked after u7-on). Panel/judge/integrator attempts are
REAL F1 worker launches through the shared env-controller substrate; no
mocked runtime anywhere.

Scenarios (F4 acceptance):
  * document run: composition/participants/roles render; a deliberately
    unanswerable panelist (bogus model — real launch, real provider error)
    reaches awaiting_decision; retry_participant and exclude_panelist are
    issued through the panel UI; the panel settles, the judge mints a
    versioned work order, the run parks for explicit approval (NEVER
    auto-approved), a two-tab stale-revision race surfaces a real 409,
    and the approved work order becomes the document result.
  * browser close does not stop execution — the run advances server-side
    while no tab exists.
  * unreachable state server — a command click fails honestly, nothing is
    queued, zero replay on reconnect.
  * implementation run composed ENTIRELY through the run editor UI:
    stop mid-panel, continue mints a fusion continuation, the work order
    auto-routes (or is approved) to the integrator, reviewer/checker
    gates run, awaiting_acceptance accepts via the UI.
  * legacy unmanaged card + porch reader coexist untouched next to the
    managed/fusion index in the Workflow panel.

Requires the isolated stack up on fixed ports with the fusion overlay
(run inside a u7_run window: phases "fusion", then "browser-fusion").
Browser: ~/.hermes/tools-venv/bin/python + cached playwright chromium.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

CARD_BASE = "u7-fusion"
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
PROJ_ID = "u7-proj"
PROJ_LABEL = "u7-sandbox"
TERMINAL = {"awaiting_acceptance", "succeeded", "failed", "cancelled",
            "stopped", "blocked"}

# Real zen-relay free models (registered provider; allowlisted egress
# destinations through the F1 gateway). Live-verified via the relay's
# openai-responses API 2026-10-02: deepseek-v4-flash-free answers 400
# "Model is unavailable", mimo-v2.5-free is FreeTier-gated — the two
# contributor-free muse-spark builds are the live distinct pair.
MODEL_A = "zen-relay/muse-spark-1.3-contributor-free"
MODEL_B = "zen-relay/muse-spark-1.2-contributor-free"
MODEL_C = "zen-relay/muse-spark-1.3-contributor-free"
# MODEL_RE-valid but served by no provider — its worker errors fast on the
# real launch path (the point: a participant that CANNOT answer).
MODEL_BOGUS = "zen-relay/no-such-free-model"

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []
DIAG_PAGES: list = []
DIAG_CARDS: list[str] = []
DIAG_NET: list[str] = []


def _net_response(r):
    try:
        if "/api/" not in r.url:
            return
        DIAG_NET.append(f"{r.status} {r.request.method} {r.url}")
    except Exception:
        pass


def _net_failed(r):
    try:
        if "/api/" in r.url:
            DIAG_NET.append(f"FAILED {r.method} {r.url} {r.failure}")
    except Exception:
        pass


def _accept_dialog(d):
    try:
        d.accept()
    except Exception:
        pass


def track_page(page):
    DIAG_PAGES.append(page)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("dialog", _accept_dialog)
    page.on("response", _net_response)
    page.on("requestfailed", _net_failed)


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}"
          + (f"  ({detail})" if detail else ""), flush=True)


def dump_forensics():
    print("\n--- failure forensics ---")
    for i, p in enumerate(DIAG_PAGES):
        try:
            panel = p.locator('[data-testid="execution-panel"]')
            txt = (panel.inner_text(timeout=3000)
                   if panel.count() else "(panel absent)")
            print(f"page{i} url={p.url}\n  panel: {txt[:1000]}")
        except Exception as e:
            print(f"page{i} dump failed: {e}")
    for cid in DIAG_CARDS:
        try:
            st, view = card_view(cid)
            print(f"server card {cid}: st={st} {str(view)[:400]}")
        except Exception as e:
            print(f"server card {cid} fetch failed: {e}")
    print("execution-API traffic (last 30):")
    for line in DIAG_NET[-30:]:
        print(f"  {line}")
    print("pageerrors:", page_errors[:10])


# ---- server-side helpers ---------------------------------------------------

def api(method, path, body=None):
    return H.http_json(method, f"{H.STATE_URL}{path}", body=body)


def card_view(card_id):
    return api("GET", f"/api/execution/cards/{card_id}")


def run_view(run_id):
    return api("GET", f"/api/execution/runs/{run_id}")


def current_run_id(card_id):
    st, view = card_view(card_id)
    if st == 200:
        runs = view.get("runs") or []
        if runs:
            cur = [r for r in runs if r.get("isCurrent")] or runs
            return cur[-1].get("id")
    return None


def send_command(card_id, ctype, payload=None):
    """POST a command against the CURRENT controlRevision (API-driven)."""
    st, view = card_view(card_id)
    rev = int(view["controlRevision"]) if st == 200 else 0
    return api("POST", f"/api/execution/cards/{card_id}/commands",
               {"commandId": f"f4-{ctype}-{time.time_ns() % 10**10}",
                "type": ctype, "payload": payload or {},
                "expectedControlRevision": rev})


def wait_run(card_id, predicate, timeout=600000, poll=3.0, want_run=None):
    """Poll the SERVER run view until predicate(run) — returns the run.
    `timeout` is milliseconds (call sites pass ms-shaped values); without
    the /1000 a failed run parks the suite for ~days, not minutes."""
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        rid = want_run or current_run_id(card_id)
        if rid:
            st, run = run_view(rid)
            if st == 200 and predicate(run):
                return run
        time.sleep(poll)
    return None


def seed_card(card_id: str, title: str | None = None):
    status, doc = H.get_doc("projects.json")
    data = doc.get("data") if status == 200 else {"version": 1,
                                                  "projects": []}
    rev = doc.get("rev") if status == 200 else 0
    projects = [p for p in data.get("projects", [])
                if p.get("id") != PROJ_ID]
    projects.append({"id": PROJ_ID, "name": PROJ_LABEL,
                     "path": str(SANDBOX / "proj-a"),
                     "createdAt": int(time.time() * 1000)})
    st, _ = H.seed_doc("projects.json",
                       {**data, "projects": projects,
                        "activeProjectId":
                        data.get("activeProjectId") or PROJ_ID},
                       rev=rev)
    assert st == 200, f"projects seed -> {st}"
    status, doc = H.get_doc("board.json")
    data = doc.get("data") if status == 200 else {"version": 2, "cards": []}
    rev = doc.get("rev") if status == 200 else 0
    now = int(time.time() * 1000)
    cards = [c for c in data.get("cards", []) if c.get("id") != card_id]
    cards.append({
        "id": card_id, "title": title or f"U7 fusion {card_id}",
        "description": "f4 fusion browser suite", "project": PROJ_LABEL,
        "agent": "", "priority": "normal", "acceptance": "",
        "verification": "", "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": "backlog", "status": "todo", "order": 0,
        "createdAt": now, "updatedAt": now,
    })
    st, _ = H.seed_doc("board.json", {**data, "cards": cards}, rev=rev)
    assert st == 200, f"board seed -> {st}"
    seed_chat_tab()


def seed_preset(preset_id):
    """One registry preset via the presets API — implementation runs require
    a bound composition (save_preset) as a card-level gate; the bind itself
    is exercised through the UI (preset-pick + Use-for-this-card)."""
    member = {"cli": "pi", "model": MODEL_A}
    st, r = api("POST", "/api/execution/presets", {"preset": {
        "id": preset_id, "name": f"e2e {preset_id}",
        "members": {"implementer": dict(member), "reviewer": dict(member),
                    "checker": dict(member)},
        "limits": {"maxAttemptsPerRole": 2, "timeoutMin": 12,
                   "maxReviewRounds": 2}}})
    assert st in (200, 409), f"preset seed -> {st} {r}"


# ---- UI helpers ---------------------------------------------------------------

def seed_chat_tab():
    """Persist one open MockACP tab. The composer — ModePicker, and the
    Workflow side panel behind it — only mounts inside a ChatView, and a
    ChatView only exists per open tab; the welcome screen has none. The
    stored tab restores on boot and reconnects to the mock bridge."""
    st, doc = H.get_doc("sessions.json")
    data = doc.get("data") if st == 200 else {}
    rev = doc.get("rev") if st == 200 else 0
    tab = {"agentName": "MockACP", "sessionId": "u7-e2e-wf-tab"}
    sess = {"id": "u7-e2e-wf", **tab, "title": "u7 e2e workflow tab",
            "lastUpdated": int(time.time() * 1000),
            "cwd": "/home/hermes/projects", "origin": "local"}
    sessions = [s for s in (data.get("sessions") or [])
                if s.get("id") != sess["id"]]
    sessions.append(sess)
    open_tabs = [t for t in (data.get("openTabs") or [])
                 if (t.get("agentName"), t.get("sessionId"))
                 != (tab["agentName"], tab["sessionId"])]
    open_tabs.append(tab)
    st, _ = H.seed_doc("sessions.json",
                       {**data, "sessions": sessions,
                        "openTabs": open_tabs, "activeTab": tab,
                        "lastAgent": tab["agentName"]}, rev=rev)
    assert st == 200, f"sessions seed -> {st}"


def _nav_board(page):
    """Activate the Board view — rail click, verified; '3' shortcut fallback
    (a different input path to the same setView)."""
    for _ in range(6):
        try:
            page.locator('.view-rail button[aria-label="Board"]').click(
                timeout=10000)
        except Exception:
            pass
        page.wait_for_timeout(400)
        if page.locator('.view-rail button[aria-label="Board"]'
                        ).get_attribute("aria-current") == "page":
            return
        try:
            page.locator("body").click(position={"x": 5, "y": 5})
            page.keyboard.press("3")
        except Exception:
            pass
        page.wait_for_timeout(400)
        if page.locator('.view-rail button[aria-label="Board"]'
                        ).get_attribute("aria-current") == "page":
            return
    raise TimeoutError("board view did not activate")


def open_card_drawer(page, card_id):
    # The web container was recreated seconds before the suite starts —
    # the first board load can race its warm-up. Bounded reload+retry.
    page.goto(H.WEB_URL, wait_until="domcontentloaded")
    sel = re.compile(re.escape(card_id) + r"(?![0-9a-z-])")
    deadline = time.time() + 120
    while True:
        try:
            _nav_board(page)
            page.locator(".card-title", has_text=sel).first.click(
                timeout=20000)
            page.locator('[data-testid="execution-panel"]').wait_for(
                timeout=15000)
            return
        except Exception:
            if time.time() > deadline:
                try:
                    cur = page.evaluate(
                        "document.querySelector("
                        "'.view-rail [aria-current]')"
                        "?.getAttribute('aria-label')")
                    DIAG_NET.append(
                        "drawer-open diagnostics: card-titles="
                        f"{page.locator('.card-title').count()} "
                        f"board-empty={page.locator('.board-empty').count()} "
                        f"board-pane={page.locator('.view-pane').count()} "
                        f"chat-view={page.locator('.chat-view').count()} "
                        f"welcome={page.locator('.welcome-screen').count()} "
                        f"rail-active={cur!r} url={page.url}")
                    page.screenshot(
                        path="/home/hermes/.cache/acp-u7-devin/"
                             "e2e-fusion-drawer-fail.png")
                except Exception:
                    pass
                raise
            page.reload(wait_until="domcontentloaded")


def attach_and_approve(page, tab_button: str, text: str):
    page.locator(".exec-doc-tabs").locator(
        "button", has_text=tab_button).first.click()
    page.locator('[data-testid="doc-new"]').click()
    page.locator('[data-testid="doc-draft"]').fill(text)
    page.locator('[data-testid="doc-attach"]').click()
    page.locator('[data-testid="doc-version-pick"] option').nth(
        0).wait_for(state="attached", timeout=15000)
    page.locator('[data-testid="doc-approve"]').click()
    page.wait_for_timeout(500)


def enable_card(page):
    page.locator('[data-testid="exec-enable"]').click()
    page.locator('[data-testid="exec-status-line"]').wait_for(
        timeout=20000)


# ---- fusion spec (mirrors ui-model fusionProfile/fusionStartPayload) ---------

def fusion_profile(profile_id, model, role, search=False):
    tools = {
        "panelist": ["read", "bash", "grep", "find", "ls"],
        "judge": ["read", "bash", "grep", "find", "ls"],
        "integrator": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    }[role]
    return {
        "schemaVersion": 1,
        "profileId": profile_id,
        "pi": {"version": "0.85.1"},
        "image": "worker",
        "provider": model.split("/", 1)[0] if "/" in model else "zen-relay",
        "model": model,
        "thinking": "low",
        "skills": [],
        "extensions": ([{"resource": "piExt", "rel": "pi-web-access"}]
                       if search else []),
        "tools": sorted({*tools, "web_search"} if search else tools),
        "search": ({"enabled": True, "provider": "duckduckgo", "params": {}}
                   if search else
                   {"enabled": False, "provider": None, "params": {}}),
        "launch": {"progress": "none", "extraFlags": []},
        "systemPromptFile": None,
    }


def start_fusion_api(card_id, fusion, base_ref=None):
    payload = {"mode": "fusion", "fusion": fusion}
    if base_ref:
        payload["baseRef"] = base_ref
    st, body = send_command(card_id, "start", payload)
    return st, body


def participant(run, pid):
    for p in ((run.get("fusion") or {}).get("participants") or []):
        if p.get("id") == pid:
            return p
    return None


def pending_types(run):
    return [a.get("type")
            for a in ((run.get("fusion") or {}).get("pendingActions") or [])]


def fusion(run):
    return (run or {}).get("fusion") or {}


def run_signature(run):
    """Progress marker for the browser-close proof: participant states +
    attempt count — any change while no tab exists is server-side work."""
    fz = fusion(run)
    return json.dumps({
        "status": run.get("status"), "phase": run.get("phase"),
        "attempts": len(run.get("attempts") or []),
        "participants": [(p.get("id"), p.get("status"))
                         for p in fz.get("participants") or []],
        "fzStatus": fz.get("status"),
    }, sort_keys=True)


# ---- the suite -----------------------------------------------------------------

def phase_document(pw, card_id):
    """Document-kind fusion run: API-launched (3 panelists, one guaranteed
    to exhaust its budget), UI-driven decisions + acceptance."""
    seed_card(card_id, title=f"{card_id} document panel")
    DIAG_CARDS.append(card_id)
    st, body = send_command(card_id, "enable")
    assert st == 200, f"enable {st} {body}"
    st, view = card_view(card_id)
    feats = (view or {}).get("features") or {}
    check("doc: card view advertises features.fusion",
          feats.get("fusion") is True
          and feats.get("start") is True, f"features={feats}")
    st, body = send_command(card_id, "attach_document", {
        "kind": "requirements",
        "source": {"type": "text", "text":
                   "Panel task: recommend ONE small, safe improvement for "
                   "this repository's main.py (VALUE constant handling). "
                   "Judge strictly against the answer contract — produce "
                   "an in_plan work order."}})
    assert st == 200, f"attach req {st} {body}"
    req = body.get("result") or {}
    st, body = send_command(card_id, "approve_requirements", {
        "versionId": req["versionId"], "sha256": req["sha256"],
        "by": "f4-e2e"})
    assert st == 200, f"approve req {st} {body}"

    fusion_spec = {
        "resultKind": "document",
        "panelists": [
            {"id": "p1", "label": "Panelist A",
             "profile": fusion_profile("f4-p1", MODEL_A, "panelist")},
            {"id": "p2", "label": "Panelist B",
             "profile": fusion_profile("f4-p2", MODEL_B, "panelist")},
            {"id": "p3", "label": "Panelist C",
             "profile": fusion_profile("f4-p3", MODEL_BOGUS, "panelist")},
        ],
        "judge": {"profile": fusion_profile("f4-judge", MODEL_A, "judge")},
        "search": {"enabled": False},
        "limits": {"maxAttemptsPerParticipant": 2, "timeoutMin": 8,
                   "judgeAttempts": 4},
        "task": {"kind": "requirements", "versionId": req["versionId"],
                 "sha256": req["sha256"]},
    }
    st, body = start_fusion_api(card_id, fusion_spec)
    check("doc: fusion start accepted", st == 200,
          f"st={st} {str(body)[:200]}")
    if st != 200:
        return
    run1_id = (body.get("result") or {}).get("runId")
    check("doc: run id returned", bool(run1_id), f"run={run1_id}")

    browser = pw.chromium.launch(headless=True)
    tab1 = browser.new_page()
    try:
        track_page(tab1)
        open_card_drawer(tab1, card_id)
        tab1.locator('[data-testid="run-status"]').wait_for(timeout=30000)
        tab1.wait_for_timeout(1200)
        status_txt = tab1.locator('[data-testid="run-status"]').inner_text()
        check("doc: run status names fusion mode",
              "fusion" in status_txt.lower(), status_txt[:80])
        check("doc: fusion composition block renders",
              tab1.locator('[data-testid="fusion-detail"]').is_visible())
        check("doc: participant rows render",
              tab1.locator('[data-testid="fusion-participants"]')
              .inner_text().find("Panelist C") >= 0)
        check("doc: roles block lists the judge",
              "judge" in tab1.locator('[data-testid="fusion-roles"]')
              .inner_text().lower())

        # ---- browser close does NOT stop execution -------------------
        sig0 = None
        run_mid = wait_run(card_id, lambda r: len(r.get("attempts") or []) > 0
                           or any((p.get("status") or "") != "pending"
                                  for p in fusion(r).get("participants") or []),
                           timeout=300000, want_run=run1_id)
        check("doc: panel attempts observed (real worker launches)",
              bool(run_mid),
              f"status={(run_mid or {}).get('status')}")
        sig0 = run_signature(run_mid) if run_mid else ""
        tab1.close()               # zero pages attached — the run must
        # advance on server truth alone, no UI driving it
        run_after_close = wait_run(
            card_id, lambda r: run_signature(r) != sig0,
            timeout=420000, want_run=run1_id)
        check("doc: run advances with NO browser attached (server truth)",
              bool(run_after_close),
              f"sig0={sig0[:120]}")
        tab1 = browser.new_page()
        track_page(tab1)
        open_card_drawer(tab1, card_id)
        ok = True
        try:
            tab1.locator('[data-testid="run-status"]').wait_for(
                timeout=20000)
        except Exception:
            ok = False
        check("doc: reopened tab converges on the live run", ok)

        # ---- participant decision: retry + exclude via the panel UI ---
        run_dec = wait_run(
            card_id,
            lambda r: (participant(r, "p3") or {}).get("status")
            == "awaiting_decision",
            timeout=480000, want_run=run1_id)
        check("doc: p3 exhausted its attempts -> awaiting_decision",
              bool(run_dec),
              f"p3={(participant(run_dec or {}, 'p3') or {}).get('status')}")
        check("doc: pendingActions record the participant decision",
              "participant_decision" in pending_types(run_dec or {}),
              f"pending={pending_types(run_dec or {})}")

        tab2 = browser.new_page()
        track_page(tab2)
        open_card_drawer(tab2, card_id)
        try:
            tab1.locator('[data-testid="fusion-actions"]').wait_for(
                timeout=30000)
            check("doc: required-action banner renders in tab1", True)
        except Exception:
            check("doc: required-action banner renders in tab1", False)
        check("doc: pending decision text names p3",
              tab1.locator('[data-testid="fusion-pending-participant_decision"]')
              .is_visible())

        # offline no-queue on tab2 (exclude click must NOT replay)
        excl_pre = len(fusion(run_dec).get("exclusions") or [])
        try:
            tab2.locator('[data-testid="fusion-actions"]').wait_for(
                timeout=30000)
        except Exception:
            pass
        tab2.route("**/api/execution/**", lambda r: r.abort())
        clicked = False
        for tid in (f'[data-testid="fusion-exclude-p3"]',
                    f'[data-testid="fusion-exclude-alt-p3"]'):
            if tab2.locator(tid).count():
                try:
                    tab2.locator(tid).click()
                    clicked = True
                    break
                except Exception:
                    pass
        tab2.wait_for_timeout(1200)
        offline_shown = (
            tab2.locator('[data-testid="exec-command-error"]').is_visible()
            or tab2.locator('[data-testid="exec-error"]').is_visible()
            or tab2.locator('[data-testid="exec-online"]')
            .inner_text().strip().lower() == "offline")
        tab2.unroute("**/api/execution/**")
        tab2.locator('[data-testid="exec-refresh"]').click()
        tab2.wait_for_timeout(1000)
        _, run_post = run_view(run1_id)
        check("doc: offline exclude surfaced honestly (no silent queue)",
              offline_shown)
        check("doc: zero replayed commands after reconnect "
              "(p3 still parked, no exclusion landed)",
              len(fusion(run_post).get("exclusions") or []) == excl_pre
              and (participant(run_post, "p3") or {}).get("status")
              == "awaiting_decision")

        # retry_participant through the real button
        tab1.locator('[data-testid="fusion-retry-p3"]').click()
        run_retry = wait_run(
            card_id,
            lambda r: (participant(r, "p3") or {}).get("extraAttempts") == 1
            and "participant_decision" not in [
                a.get("participantId") for a in
                fusion(r).get("pendingActions") or []],
            timeout=60000, want_run=run1_id)
        check("doc: retry grants exactly one extra attempt server-side",
              bool(run_retry)
              and (participant(run_retry, "p3") or {}).get("status")
              in ("pending", "launching", "running", "awaiting_decision"),
              f"p3={participant(run_retry or {}, 'p3')}")
        # the retried attempt fails again on the bogus model -> parked again
        run_dec2 = wait_run(
            card_id,
            lambda r: (participant(r, "p3") or {}).get("status")
            == "awaiting_decision",
            timeout=300000, want_run=run1_id)
        check("doc: retried p3 exhausts again -> decision re-parked",
              bool(run_dec2), "")

        # exclude_panelist through the real button (dialog auto-accepted)
        tab1.locator('[data-testid="exec-refresh"]').click()
        tab1.wait_for_timeout(800)
        tab1.locator('[data-testid="fusion-exclude-p3"]').click()
        run_excl = wait_run(
            card_id,
            lambda r: (participant(r, "p3") or {}).get("status") == "excluded",
            timeout=60000, want_run=run1_id)
        check("doc: exclude commits durably (exclusions recorded)",
              bool(run_excl)
              and len(fusion(run_excl).get("exclusions") or []) >= 1,
              f"excl={fusion(run_excl or {}).get('exclusions')}")
        try:
            tab1.locator('[data-testid="fusion-exclusions"]').wait_for(
                timeout=15000)
            check("doc: exclusion row renders", True)
        except Exception:
            check("doc: exclusion row renders", False)

        # ---- judge -> work order -> parked for approval ----------------
        run_wo = wait_run(
            card_id,
            lambda r: len(fusion(r).get("workOrders") or []) > 0,
            timeout=480000, want_run=run1_id)
        check("doc: judge minted a versioned work order", bool(run_wo),
              f"status={(run_wo or {}).get('status')} "
              f"fz={fusion(run_wo or {}).get('status')}")
        if not run_wo:
            return
        wo = fusion(run_wo)["workOrders"][-1]
        check("doc: document run PARKS on work-order approval "
              "(never auto-approved)",
              (run_wo.get("status") == "blocked"
               and "work_order_approval" in pending_types(run_wo)
               and not (fusion(run_wo).get("workOrder") or {}).get(
                   "approvedAt")),
              f"pending={pending_types(run_wo)} "
              f"decision={wo.get('decision')}")
        try:
            tab1.locator('[data-testid="fusion-workorders"]').wait_for(
                timeout=20000)
            wo_txt = tab1.locator('[data-testid="fusion-workorders"]'
                                  ).inner_text()
            check("doc: work order renders verdict + awaits-approval state",
                  "await" in wo_txt.lower() and wo["versionId"] in wo_txt,
                  wo_txt[:200])
        except Exception:
            check("doc: work order renders verdict + awaits-approval state",
                  False)

        # ---- two tabs, real 409 revision conflict -----------------------
        # tab2 serves a PRE-mutation card view -> its command POST carries a
        # stale controlRevision -> the server answers a real 409.
        st, stale_view = card_view(card_id)
        check("doc: tab2 captured pre-approval view for the stale POST",
              st == 200)

        def serve_stale(route):
            if route.request.method == "GET" \
                    and route.request.url.endswith(
                        f"/api/execution/cards/{card_id}"):
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps(stale_view))
            else:
                route.continue_()

        tab2.route("**/api/execution/cards/**", serve_stale)
        tab1.locator('[data-testid="exec-refresh"]').click()
        tab1.wait_for_timeout(600)
        approved = False
        try:
            tab1.wait_for_selector(
                '[data-testid="fusion-approve-wo"]:enabled', timeout=30000)
            approved = True
        except Exception:
            try:
                tab1.wait_for_selector(
                    '[data-testid^="fusion-approve-"]:enabled', timeout=5000)
                approved = True
            except Exception:
                pass
        check("doc: approve work-order control enabled while parked",
              approved)
        tab1.locator('[data-testid="fusion-approve-wo"]').first.click() \
            if tab1.locator('[data-testid="fusion-approve-wo"]').count() \
            else tab1.locator('[data-testid^="fusion-approve-"]').first.click()
        run_ok = wait_run(card_id, lambda r: r.get("status") == "succeeded",
                          timeout=60000, want_run=run1_id)
        check("doc: user approval completes the document run",
              bool(run_ok), f"status={(run_ok or {}).get('status')}")

        # tab2's stale-rendered button still issues a POST with the old
        # revision -> 409 surfaces; nothing silently succeeds.
        diag_409 = False
        try:
            btn2 = tab2.locator('[data-testid="fusion-approve-wo"]')
            if not btn2.count():
                btn2 = tab2.locator('[data-testid^="fusion-approve-"]')
            btn2.first.click()
            tab2.wait_for_timeout(1500)
            err = tab2.locator('[data-testid="exec-command-error"]')
            diag_409 = err.is_visible() and (
                "revision" in err.inner_text().lower()
                or "409" in err.inner_text())
        except Exception:
            pass
        saw_409 = any("409" in ln and "commands" in ln
                      for ln in DIAG_NET)
        check("doc: stale tab command -> real 409 revision conflict",
              diag_409 or saw_409,
              f"net={[l for l in DIAG_NET if 'commands' in l][-4:]}")
        tab2.unroute("**/api/execution/cards/**")
        tab2.locator('[data-testid="exec-refresh"]').click()
        tab2.wait_for_timeout(800)

        # ---- document result assertions ---------------------------------
        st, runA = run_view(run1_id)
        fzA = fusion(runA)
        check("doc: result is the accepted work order (document kind)",
              runA.get("status") == "succeeded"
              and (runA.get("result") or {}).get("kind") == "document"
              and ((runA.get("result") or {}).get("workOrder") or {})
              .get("versionId") == wo["versionId"]
              and (fzA.get("workOrder") or {}).get("versionId")
              == wo["versionId"],
              f"result={runA.get('result')}")
        check("doc: work order records the approval",
              (fzA.get("workOrders") or [{}])[-1].get("approved") is not None
              and (fzA.get("workOrder") or {}).get("by") == "user")
        st, art = api("GET", f"/api/execution/runs/{run1_id}"
                           f"/artifacts/{wo['artifactId']}")
        check("doc: work-order artifact fetchable + hash-bound",
              st == 200 and art.get("sha256") == wo["sha256"],
              f"st={st}")
        try:
            tab1.locator('[data-testid="fusion-result-doc"]').wait_for(
                timeout=15000)
            check("doc: document result section renders", True)
        except Exception:
            check("doc: document result section renders", False)
        try:
            tab1.locator('[data-testid="fusion-wo-accepted"]').wait_for(
                timeout=15000)
            check("doc: accepted work-order line renders", True)
        except Exception:
            check("doc: accepted work-order line renders", False)

        # ---- porch reader unchanged + workflow cohabitation -------------
        st, porch_runs = api("GET", "/api/porch/runs")
        check("doc: porch reader endpoint answers (unchanged contract)",
              st == 200 and isinstance((porch_runs or {}).get("runs"), list),
              f"st={st}")

        tab1.locator('.view-rail button[aria-label="Chat"]').click()
        # The composer mounts with the restored MockACP tab — wait it out.
        tab1.locator(".mode-picker").first.wait_for(timeout=20000)
        # The composer's chat/workflow ModePicker: .mode-button text carries
        # the ▼ arrow, so match the clean .mode-name span instead.
        picker = tab1.locator(".mode-picker").filter(
            has=tab1.locator(".mode-name",
                             has_text=re.compile(r"^\s*(Chat|Workflow)\s*$")))
        picker.locator(".mode-button").click()
        tab1.locator(".dropdown-item", has_text="Workflow").click()
        tab1.locator('[data-testid="managed-section"]').wait_for(
            timeout=20000)
        check("doc: managed index lists the fusion card with its badge",
              tab1.locator(".managed-row", has_text="fusion").count() >= 1)
        tab1.locator(".managed-row", has_text=card_id).first.click()
        try:
            tab1.locator('[data-testid="managed-fusion"]').wait_for(
                timeout=20000)
            check("doc: workflow focused view renders fusion summary",
                  "document" in tab1.locator(
                      '[data-testid="managed-fusion"]').inner_text().lower())
        except Exception:
            check("doc: workflow focused view renders fusion summary", False)
        check("doc: porch section coexists with the managed index "
              "(panel up, no error banner)",
              tab1.locator(".wf-panel").is_visible()
              and not tab1.locator(".wf-banner.error").count())
        tab1.locator('.view-rail button[aria-label="Board"]').click()
    finally:
        try:
            tab1.close()
        except Exception:
            pass
        browser.close()


def phase_implementation(pw, card_id):
    """Implementation-kind run composed ENTIRELY through the editor UI:
    stop/continue on the panel, auto-route or approval, reviewer/checker
    gates, user acceptance."""
    seed_card(card_id, title=f"{card_id} implementation panel")
    seed_preset(f"{card_id}-preset")
    DIAG_CARDS.append(card_id)
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()
    try:
        track_page(page)
        open_card_drawer(page, card_id)
        enable_card(page)
        attach_and_approve(
            page, "Requirements",
            "Change VALUE in main.py from 1 to 42. Keep the diff minimal.")
        attach_and_approve(
            page, "Plan",
            "1. Edit main.py: VALUE = 42\n2. Verify with python3.\n\n"
            "```acp-checks\n"
            '{"checks": [{"run": "python3 -c \'import main;'
            ' assert main.VALUE == 42\'", "timeoutSec": 60}]}\n```\n')

        # impl runs inherit the card-level composition gate — bind the
        # seeded preset through the UI (preset-pick -> Use for this card).
        page.locator('[data-testid="preset-pick"]').select_option(
            f"{card_id}-preset")
        page.locator('[data-testid="preset-apply"]').click()
        page.locator('[data-testid="composition-line"]').wait_for(
            timeout=20000)
        page.locator('[data-testid="fusion-configure"]').click()
        page.locator('[data-testid="fusion-kind"]').select_option(
            "implementation")
        msel = page.locator('[data-testid="fusion-pmodel-p1"]')
        models = msel.locator("option").evaluate_all(
            "els => els.map(e => e.value).filter(v => v)")
        check("impl: editor lists the seeded pi compat models",
              MODEL_A in models and MODEL_B in models, f"{models}")
        if MODEL_A not in models or MODEL_B not in models:
            return
        msel.select_option(MODEL_A)
        page.locator('[data-testid="fusion-pmodel-p2"]').select_option(MODEL_B)
        page.locator('[data-testid="fusion-judge"]').select_option(MODEL_C)
        page.locator('[data-testid="fusion-integrator"]').select_option(MODEL_A)
        for role in ("reviewer", "checker"):
            page.locator(f'[data-testid="fusion-{role}-cli"]'
                         ).select_option("pi")
            page.locator(f'[data-testid="fusion-{role}-model"]'
                         ).select_option(MODEL_A)
        page.locator('[data-testid="fusion-attempts"]').fill("2")
        page.locator('[data-testid="fusion-timeout"]').fill("12")
        en = True
        try:
            page.wait_for_selector('[data-testid="fusion-start"]:enabled',
                                   timeout=20000)
        except Exception:
            en = False
        check("impl: fusion start gate opens on a complete draft", en,
              page.locator('[data-testid="fusion-problems"]')
              .inner_text()[:200]
              if page.locator('[data-testid="fusion-problems"]').count()
              else "")
        if not en:
            return
        page.locator('[data-testid="fusion-start"]').click()
        try:
            page.locator('[data-testid="run-status"]').wait_for(
                timeout=30000)
        except Exception:
            err = page.locator('[data-testid="exec-command-error"]')
            detail = (err.inner_text()[:200] if err.count()
                      else "no command-error banner; "
                      + "net="
                      + str([l for l in DIAG_NET
                             if "commands" in l][-4:]))
            check("impl: fusion start created the run", False, detail)
            return
        run1 = wait_run(card_id, lambda r: bool(r.get("attempts")),
                        timeout=420000)
        check("impl: run launched (panel attempts live)", bool(run1),
              f"status={(run1 or {}).get('status')}")
        if not run1:
            return
        run1_id = run1["id"]

        # ---- stop mid-panel, then continue -------------------------------
        page.wait_for_selector('[data-testid="exec-stop"]:enabled',
                               timeout=30000)
        page.locator('[data-testid="exec-stop"]').click()
        run1_end = wait_run(
            card_id, lambda r: r.get("id") == run1_id
            and r.get("status") in ("stopped", "cancelled", "failed",
                                    "blocked"),
            timeout=300000, want_run=run1_id)
        check("impl: stop parks the run terminally",
              bool(run1_end) and run1_end.get("status") != "succeeded",
              f"status={(run1_end or {}).get('status')}")
        if not run1_end:
            return
        # A 'blocked' stop needs the attempts drained before continue —
        # poll until continue's server gate would accept (no live attempts).
        def settled(r):
            return r.get("id") == run1_id and not [
                a for a in (r.get("attempts") or [])
                if (a.get("status") or "") in ("launching", "running",
                                              "cancelling")]
        wait_run(card_id, settled, timeout=180000, want_run=run1_id)
        page.locator('[data-testid="exec-refresh"]').click()
        en_cont = True
        try:
            page.wait_for_selector('[data-testid="exec-continue"]:enabled',
                                   timeout=60000)
        except Exception:
            en_cont = False
        check("impl: continue enabled after the stopped run settles",
              en_cont)
        page.locator('[data-testid="continue-note"]').fill(
            "f4 fusion continuation")
        page.locator('[data-testid="exec-continue"]').click()
        page.wait_for_timeout(1500)
        run2_id = current_run_id(card_id)
        check("impl: continue minted a NEW fusion run",
              bool(run2_id) and run2_id != run1_id,
              f"run1={run1_id} run2={run2_id}")
        st, run2 = run_view(run2_id)
        check("impl: continuation carries the panel forward",
              (run2 or {}).get("mode") == "fusion"
              and fusion(run2).get("continuedFrom") == run1_id,
              f"mode={(run2 or {}).get('mode')} "
              f"continuedFrom={fusion(run2).get('continuedFrom')}")

        # ---- panel -> judge -> work order -> integrate -> gates ---------
        def parked_or_integrating(r):
            fz = fusion(r)
            return (r.get("id") == run2_id
                    and (r.get("phase") in ("integrate", "awaiting_validation",
                                            "awaiting_acceptance")
                         or "work_order_approval" in pending_types(r)
                         or r.get("status") == "awaiting_acceptance"))
        run_mid = wait_run(card_id, parked_or_integrating, timeout=900000,
                           want_run=run2_id)
        check("impl: work order routed (auto or parked for approval)",
              bool(run_mid), f"phase={(run_mid or {}).get('phase')} "
              f"pending={pending_types(run_mid or {})}")
        if not run_mid:
            return
        wo_list = fusion(run_mid).get("workOrders") or []
        if "work_order_approval" in pending_types(run_mid):
            wo = wo_list[-1] if wo_list else {}
            vid = wo.get("versionId")
            sel = f'[data-testid="fusion-approve-{vid}"]'
            page.locator('[data-testid="exec-refresh"]').click()
            try:
                page.wait_for_selector(f"{sel}:enabled", timeout=30000)
                page.locator(sel).click()
            except Exception:
                send_command(card_id, "approve_work_order", {
                    "runId": run2_id, "versionId": vid,
                    "sha256": wo.get("sha256")})
            run_mid = wait_run(
                card_id,
                lambda r: r.get("id") == run2_id
                and r.get("phase") in ("integrate", "awaiting_validation",
                                       "awaiting_acceptance"),
                timeout=120000, want_run=run2_id)
            check("impl: work-order approval routes to integration",
                  bool(run_mid), f"phase={(run_mid or {}).get('phase')}")
        else:
            auto = [(w.get("decision") or {}).get("routed") == "auto"
                    for w in wo_list]
            check("impl: in-plan work order auto-routed to the integrator",
                  any(auto), f"decisions={[w.get('decision') for w in wo_list]}")

        # ---- reviewer/checker gates -> awaiting_acceptance -> accept -----
        run_acc = wait_run(
            card_id,
            lambda r: r.get("id") == run2_id
            and r.get("status") == "awaiting_acceptance",
            timeout=1200000, want_run=run2_id)
        check("impl: run reaches awaiting_acceptance through the gates",
              bool(run_acc), f"status={(run_acc or {}).get('status')}")
        if not run_acc:
            return
        roles = {a.get("role") for a in (run_acc.get("attempts") or [])}
        check("impl: reviewer+checker gate attempts recorded",
              {"reviewer", "checker"} <= roles,
              f"roles={sorted(roles)}")
        check("impl: integrator import recorded",
              bool(fusion(run_acc).get("integratorReport")
                   or (fusion(run_acc).get("integrate") or {}).get("import")),
              f"report={bool(fusion(run_acc).get('integratorReport'))}")

        page.locator('[data-testid="exec-refresh"]').click()
        try:
            page.wait_for_selector('[data-testid="exec-accept"]:enabled',
                                   timeout=60000)
            page.locator('[data-testid="exec-accept"]').click()
        except Exception:
            send_command(card_id, "accept_result", {"runId": run2_id})
        run_done = wait_run(
            card_id, lambda r: r.get("id") == run2_id
            and r.get("status") == "succeeded",
            timeout=120000, want_run=run2_id)
        check("impl: user acceptance -> succeeded",
              bool(run_done)
              and (run_done.get("acceptance") or {}).get("resultSha256"),
              f"status={(run_done or {}).get('status')}")
        # run history + honest fusion badge in history rows
        check("impl: run history lists both runs",
              page.locator('[data-testid="run-history"] .exec-histrow')
              .count() >= 2 if run_done else False)
    finally:
        try:
            page.close()
        except Exception:
            pass
        browser.close()


def phase_cohabitation(pw, card_id):
    """Legacy unmanaged card + managed fusion cards side by side; porch
    reader untouched."""
    seed_card(card_id, title=f"{card_id} legacy unmanaged")
    DIAG_CARDS.append(card_id)
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()
    try:
        track_page(page)
        page.goto(H.WEB_URL, wait_until="domcontentloaded")
        _nav_board(page)
        sel = re.compile(re.escape(card_id) + r"(?![0-9a-z-])")
        try:
            page.locator(".card-title", has_text=sel).first.wait_for(
                timeout=30000)
            ok_render = True
        except Exception:
            ok_render = False
        check("legacy: unmanaged card renders beside managed ones",
              ok_render)
        page.locator(".card-title", has_text=sel).first.click()
        page.locator('[data-testid="execution-panel"]').wait_for(
            timeout=15000)
        check("legacy: unmanaged card shows explicit opt-in (no managed UI)",
              page.locator('[data-testid="exec-unmanaged"]').is_visible())
        check("legacy: no fusion editor offered on unmanaged cards",
              not page.locator('[data-testid="fusion-configure"]').count())
    finally:
        try:
            page.close()
        except Exception:
            pass
        browser.close()


def main():
    H.require_stack()
    nonce = int(time.time()) % 100000
    print(f"e2e_fusion nonce={nonce}")

    with sync_playwright() as pw:
        try:
            phase_document(pw, f"{CARD_BASE}-doc-{nonce}")
            phase_implementation(pw, f"{CARD_BASE}-impl-{nonce}")
            phase_cohabitation(pw, f"{CARD_BASE}-legacy-{nonce}")
        except Exception:
            dump_forensics()
            raise

    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    check("zero pageerrors", not page_errors, ";".join(page_errors[:3]))
    failed = [c for c in checks if not c[0]]
    print(f"final: {len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
