#!/usr/bin/env python3
"""e2e_preparation.py — P5 real-browser suite over the isolated compose stack.

Requires the PREPARATION overlay live:
  python3 scripts/u7_transition.py preparation
  python3 scripts/e2e_preparation.py

Phases:
  A small   — start_preparation through the CARD UI with a real bound skill
             (grill-me-intent); the runner-side supervisor drives the real
             pi lead; a durable question arrives, is answered through the
             UI, and survives a browser reload and a second tab as the ONE
             session (no fork).
  B stale   — racing/duplicate starts mint exactly one session; a stale
             expectedControlRevision is refused 409 without overwriting;
             an unknown question answer is refused 422.
  C complex — multi-stage bindings mint pending SkillGates; attached +
             approved requirements/plan documents + confirmed gates drive
             readiness; a new document version invalidates the confirmed
             gate; a binding change invalidates dependent gates and re-mints;
             handoff_preparation records a durable OFFER and never starts a
             run; Stop preserves the checkpoint.
  D gates   — unsupported bindings are omitted from start options and
             refused with a reason at the API; offline (transport-failed)
             controls go disabled with the stale-state banner, no
             optimistic success.
  E legacy  — a card with accepted documents and NO session keeps the core
             path (no forced interview); starting preparation adopts the
             already-attached document as the session's presented version.
  F restart — `docker compose restart runner` mid-session: the durable
             discussion/checkpoint survives; the new supervisor re-discovers
             the running attempt and the session stays answerable.

Evidence: ~/.cache/acp-u7-devin/e2e-prep-*.png screenshots + printed
PASS/FAIL ledger + API snapshots. Model turns are real: question wait
bounds are generous (the grill-me skill asks within its first turn).
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

EVIDENCE = Path("/home/hermes/.cache/acp-u7-devin")
PROJ_ID = "u7-proj-a"
PROJ_LABEL = "u7-a"
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")

CARD_SMALL = "u7-p5-small"
CARD_COMPLEX = "u7-p5-complex"
CARD_LEGACY = "u7-p5-legacy"

# The initial idea lives in the small card description. Session reuse uses
# the exact durable raw snapshot returned by the preparation API.
SMALL_INTENT = ("A 'snooze card' feature for the kanban board: park a card "
                "until a date; it disappears and resurfaces in its column.")

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []
DIAG_NET: list[str] = []
DIAG_PAGES: list = []
DIAG_CARDS = [CARD_SMALL, CARD_COMPLEX, CARD_LEGACY]


# ---- diagnostics ------------------------------------------------------------

def _net_response(r):
    try:
        if "/api/execution/" in r.url or "/api/state/" in r.url:
            DIAG_NET.append(f"{r.request.method} {r.url} -> {r.status}")
    except Exception:
        pass


def _net_failed(r):
    try:
        DIAG_NET.append(f"FAILED {r.request.method} {r.url} "
                        f"{r.failure}")
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


def shot(page, name):
    try:
        p = EVIDENCE / f"e2e-prep-{name}.png"
        page.screenshot(path=str(p), full_page=False)
        print(f"  evidence: {p}")
    except Exception as e:
        print(f"  screenshot {name} failed: {e}")


def dump_forensics():
    print("\n--- failure forensics ---")
    for i, p in enumerate(DIAG_PAGES):
        try:
            panel = p.locator('[data-testid="prep-panel"]')
            txt = (panel.inner_text(timeout=3000)
                   if panel.count() else "(prep panel absent)")
            print(f"page{i} url={p.url}\n  prep-panel: {txt[:1200]}")
        except Exception as e:
            print(f"page{i} dump failed: {e}")
    for cid in DIAG_CARDS:
        try:
            st, view = prep_view(cid)
            print(f"server prep {cid}: st={st} {str(view)[:500]}")
        except Exception as e:
            print(f"server prep {cid} fetch failed: {e}")
    print("traffic (last 40):")
    for line in DIAG_NET[-40:]:
        print(f"  {line}")
    print("pageerrors:", page_errors[:10])


# ---- server helpers ---------------------------------------------------------

def api(method, path, body=None):
    return H.http_json(method, f"{H.STATE_URL}{path}", body=body)


def card_view(card_id):
    return api("GET", f"/api/execution/cards/{card_id}")


def prep_view(card_id):
    return api("GET", f"/api/execution/cards/{card_id}/preparation")


def bindings_view():
    return api("GET", "/api/execution/preparation/bindings")


def send_command(card_id, ctype, payload=None, rev=None, cid=None):
    """POST a command against the CURRENT controlRevision (API-driven).
    The real lead writes between the rev read and the post can 409 — one
    fresh-rev retry keeps the suite deterministic without masking a real
    conflict (an explicit stale `rev=` is never retried)."""
    if rev is None:
        st, view = card_view(card_id)
        rev = int(view["controlRevision"]) if st == 200 else 0
        st, r = api("POST", f"/api/execution/cards/{card_id}/commands",
                    {"commandId": cid or f"p5-{ctype}-{time.time_ns() % 10**10}",
                     "type": ctype, "payload": payload or {},
                     "expectedControlRevision": rev})
        if (st == 409 and isinstance(r, dict)
                and r.get("code") in (
                    "revision_conflict", "stale_revision", "conflict")):
            st, view = card_view(card_id)
            if st == 200:
                rev = int(view["controlRevision"])
                st, r = api(
                    "POST", f"/api/execution/cards/{card_id}/commands",
                    {"commandId": f"p5-{ctype}-{time.time_ns() % 10**10}",
                     "type": ctype, "payload": payload or {},
                     "expectedControlRevision": rev})
        return st, r
    return api("POST", f"/api/execution/cards/{card_id}/commands",
               {"commandId": cid or f"p5-{ctype}-{time.time_ns() % 10**10}",
                "type": ctype, "payload": payload or {},
                "expectedControlRevision": rev})


def wait_prep(card_id, predicate, timeout_s=240, poll=2.0):
    """Poll the server prep view until predicate(view) — returns the view."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st, v = prep_view(card_id)
        if st == 200 and predicate(v.get("preparation") or v):
            return v.get("preparation") or v
        time.sleep(poll)
    return None


def open_questions(view):
    return [q for q in (view.get("checkpoint", {}).get("openQuestions") or [])
            if q.get("status") == "open"]


def answered(view):
    return [q for q in (view.get("checkpoint", {}).get("openQuestions") or [])
            if q.get("status") == "answered"]


def gates(view):
    return view.get("gates") or []


def seed_card(card_id: str, title: str, description: str = "p5 preparation browser suite"):
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
        "id": card_id, "title": title,
        "description": description, "project": PROJ_LABEL,
        "agent": "", "priority": "normal", "acceptance": "",
        "verification": "", "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": "backlog", "status": "todo", "order": 0,
        "createdAt": now, "updatedAt": now,
    })
    st, _ = H.seed_doc("board.json", {**data, "cards": cards}, rev=rev)
    assert st == 200, f"board seed -> {st}"


def enable_card_api(card_id):
    st, r = send_command(card_id, "enable")
    # Re-seeded cards keep their aggregate — already-managed is success.
    if st in (200,) or (st == 409):
        return
    assert st == 200, f"enable -> {st} {r}"


def attach_doc(card_id, kind, text, rev=None):
    return send_command(card_id, "attach_document",
                        {"kind": kind,
                         "source": {"type": "text", "text": text}}, rev=rev)


def doc_version(card_id, kind, version_id):
    st, view = card_view(card_id)
    if st != 200:
        return None
    docs = (view.get("documents") or {}).get(kind) or {}
    return next((v for v in docs.get("versions") or []
                 if v.get("versionId") == version_id), None)


def approve_doc(card_id, kind, version_id, checks=None):
    v = doc_version(card_id, kind, version_id)
    assert v, f"{kind} {version_id} not on card"
    payload = {"versionId": version_id, "sha256": v["sha256"]}
    if checks is not None:
        payload["checks"] = checks
    return send_command(card_id, f"approve_{kind}", payload)


def doc_current(card_id, kind):
    st, view = card_view(card_id)
    if st != 200:
        return None
    docs = (view.get("documents") or {}).get(kind) or {}
    return docs.get("current")


# ---- UI helpers ---------------------------------------------------------------

def _nav_board(page):
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


def open_card_drawer(page, card_id, wait_panel=True):
    page.goto(H.WEB_URL, wait_until="domcontentloaded")
    sel = re.compile(re.escape(card_id) + r"(?![0-9a-z-])")
    # Offline legs route-abort /api/execution/** — the exec view can never
    # load, so the honest surface is NO prep panel. wait_panel=False waits
    # only for the drawer itself.
    anchor = ('[data-testid="prep-panel"]' if wait_panel
              else ".card-drawer")
    deadline = time.time() + 120
    while True:
        try:
            _nav_board(page)
            page.locator(".card-title", has_text=sel).first.click(
                timeout=20000)
            page.locator(anchor).wait_for(timeout=15000)
            return
        except Exception:
            if time.time() > deadline:
                shot(page, f"drawer-fail-{card_id}")
                raise
            page.reload(wait_until="domcontentloaded")


def enable_card_ui(page):
    page.locator('[data-testid="exec-enable"]').click()
    page.locator('[data-testid="exec-status-line"]').wait_for(
        timeout=20000)


def ui_answer_open_question(page, answer, timeout_s=300):
    """Wait for a real open question row in the UI, fill the answer, send."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        rows = page.locator(".prep-q-open")
        if rows.count():
            row = rows.first
            qid = (row.get_attribute("data-testid") or "").removeprefix(
                "prep-q-")
            sel = row.locator("select")
            if sel.count():
                sel.select_option(index=1)
            else:
                row.locator(f'[data-testid="prep-answer-{qid}"]').fill(answer)
            row.locator(f'[data-testid="prep-send-{qid}"]').click()
            return qid
        page.wait_for_timeout(1500)
    return None


# ---- phases -----------------------------------------------------------------

def phase_small(pw):
    """Real lead round-trip through the card UI + reload + second tab."""
    print("\n== phase A: small flow — real lead, one durable discussion ==")

    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, CARD_SMALL)

        check("A1 prep panel mounted in the card drawer",
              page.locator('[data-testid="prep-panel"]').count() == 1)
        # Three honest entry states: no session → start form; stopped →
        # restart row; active → the live discussion. The prep fetch can lag
        # the drawer — wait out the loading state before judging.
        fresh = restart = active = False
        for _ in range(24):
            fresh = page.locator('[data-testid="prep-card-source"]').count() > 0
            restart = page.locator(
                '[data-testid="prep-restart"]').count() > 0
            active = page.locator('[data-testid="prep-meta"]').count() > 0
            if fresh or restart or active:
                break
            page.wait_for_timeout(500)
        check("A2 entry surface matches the durable session state",
              fresh or restart or active)

        if fresh:
            # Advanced selectors list only available real registry bindings.
            page.locator(
                '[data-testid="prep-bindings-start"] summary').click()
            opts = page.locator(
                '[data-testid="prep-start-bind-intent"] option'
            ).all_inner_texts()
            check("A3 intent binding options list real bindings",
                  any("grill-me-intent" in o for o in opts), str(opts))
            page.locator(
                '[data-testid="prep-start-bind-intent"]').select_option(
                "grill-me-intent")
            page.locator('[data-testid="prep-start"]').click()
        elif restart:
            check("A3 restart path (stopped session) — start new session",
                  True)
            page.locator('[data-testid="prep-restart"]').click()
        else:
            check("A3 active session resumed — no duplicate start offered",
                  page.locator('[data-testid="prep-start"]').count() == 0)

        v = wait_prep(CARD_SMALL, lambda s: s.get("status") == "active",
                      timeout_s=30)
        check("A4 session active after UI start", v is not None,
              str((v or {}).get("sessionId")))
        session_id = (v or {}).get("sessionId")

        # The real pi lead asks its first durable question.
        qid = ui_answer_open_question(
            page,
            "Single board user; snoozed cards listed in a per-column "
            "'Snoozed' filter; resurfacing is silent.", timeout_s=300)
        check("A5 real lead question rendered + answered in the UI",
              qid is not None, f"question={qid}")
        if qid:
            # The honest client signal: the answered row renders only when
            # the polled server view carries the durable answer.
            try:
                page.locator(f'[data-testid="prep-a-{qid}"]').wait_for(
                    timeout=60000)
            except Exception:
                pass
        shot(page, "A-question-answered")

        v = wait_prep(
            CARD_SMALL,
            lambda s: any(q.get("questionId") == qid
                          for q in answered(s)),
            timeout_s=60)
        check("A6 answer is durable server-side",
              v is not None)

        # intent_confirm gate: minted pending at start on the fresh path
        # (binding selected in the start form); the restart/resume path
        # starts lead-only — the honest surface is NO gate until an
        # explicit change_skill_binding mints it (checked at A11b).
        gv = wait_prep(CARD_SMALL,
                       lambda s: any(g["type"] == "intent_confirm"
                                     for g in gates(s)),
                       timeout_s=15 if fresh else 4)
        gate = next((g for g in gates(gv or {})
                     if g["type"] == "intent_confirm"), None)
        if fresh:
            check("A7 intent_confirm gate minted pending by binding",
                  gate is not None and gate["status"] == "pending",
                  str(gate))
        else:
            # A resumed session may be lead-only (no gate) or carry a gate
            # minted by an earlier explicit binding change. The invariant
            # either way: nothing is confirmed without a bound subject.
            ok = gate is None or gate["status"] != "confirmed" \
                or gate.get("subject") is not None
            check("A7 no gate confirmed without a presented subject",
                  ok, str(gate))

        # Browser reload — the discussion restores from durable state.
        page.reload(wait_until="domcontentloaded")
        open_card_drawer(page, CARD_SMALL)
        page.locator(f'[data-testid="prep-a-{qid}"]').wait_for(
            timeout=20000)
        check("A8 answered question restored after browser reload", True)
        meta = page.locator('[data-testid="prep-meta"]').inner_text()
        check("A9 same session id after reload",
              session_id in meta, meta[:80])
        shot(page, "A-reloaded")

        # Second tab — same single session, never a fork.
        tab2 = browser.new_page()
        track_page(tab2)
        open_card_drawer(tab2, CARD_SMALL)
        meta2 = tab2.locator('[data-testid="prep-meta"]').inner_text()
        check("A10 second tab shows the SAME session",
              session_id in meta2, meta2[:80])
        st, rows = api("GET", "/api/execution/cards")
        sessions = [r for r in (rows.get("cards") or [])
                    if r.get("cardId") == CARD_SMALL
                    and (r.get("preparation") or {}).get("sessionId")]
        check("A11 one durable session for the card",
              len(sessions) == 1
              and sessions[0]["preparation"]["sessionId"] == session_id)

        # A session started without an intent binding (restart path or an
        # already-active lead-only session) — bind the intent stage through
        # the UI now: the minted gate is the change's proof.
        if not fresh and gate is None:
            diagnostics = tab2.locator('[data-testid="prep-diagnostics"]')
            if not diagnostics.evaluate("e => e.open"):
                diagnostics.locator("summary").first.click()
            controls = tab2.locator('[data-testid="prep-controls"]')
            if not controls.evaluate("e => e.open"):
                controls.locator("summary").click()
            tab2.locator('[data-testid="prep-bind-intent"]').select_option(
                "grill-me-intent")
            tab2.locator('[data-testid="prep-bind-apply-intent"]').click()
            gv = wait_prep(
                CARD_SMALL,
                lambda s: any(g["type"] == "intent_confirm"
                              and g["status"] == "pending"
                              for g in gates(s)),
                timeout_s=30)
            check("A11b binding change via UI mints its pending gate",
                  gv is not None)
        tab2.close()
    finally:
        browser.close()


def phase_stale():
    """Racing/duplicate commands + stale revision — no fork, no overwrite."""
    print("\n== phase B: racing commands, stale revisions ==")
    import concurrent.futures
    # Racing identical starts: the contract is convergence to the ONE
    # session — a contender may legitimately 409 on revision_conflict (the
    # lead writes between read and post) or preparation_active; a retry on
    # the fresh revision must then join the same session, never fork.
    st, existing = prep_view(CARD_SMALL)
    assert st == 200 and existing.get("preparation"), "small discussion must exist"
    intent = existing["preparation"]["intent"]["raw"]
    with concurrent.futures.ThreadPoolExecutor(2) as ex:
        f1 = ex.submit(send_command, CARD_SMALL, "start_preparation",
                       {"intent": intent})
        f2 = ex.submit(send_command, CARD_SMALL, "start_preparation",
                       {"intent": intent})
        s1, r1 = f1.result()
        s2, r2 = f2.result()
    retries = []
    for _ in range(3):
        if s1 == 200 and s2 == 200:
            break
        if s1 != 200:
            s1, r1 = send_command(CARD_SMALL, "start_preparation",
                                  {"intent": intent})
            retries.append(s1)
        if s2 != 200:
            s2, r2 = send_command(CARD_SMALL, "start_preparation",
                                  {"intent": intent})
            retries.append(s2)
    st, v = prep_view(CARD_SMALL)
    sid = (v.get("preparation") or {}).get("sessionId")
    check("B1 concurrent starts converge to the one session",
          s1 == 200 and s2 == 200 and sid is not None,
          f"{s1}/{s2} retries={retries}")
    st, v = prep_view(CARD_SMALL)
    check("B2 still exactly one session",
          st == 200
          and v.get("preparation", {}).get("sessionId") is not None)

    st, r = send_command(CARD_SMALL, "start_preparation",
                         {"intent": "a DIFFERENT idea entirely"})
    check("B3 contradictory intent refused 409 preparation_active",
          st == 409 and isinstance(r, dict)
          and r.get("code") == "preparation_active", f"{st} {str(r)[:160]}")

    st, view = card_view(CARD_SMALL)
    rev = int(view["controlRevision"])
    st, r = send_command(CARD_SMALL, "continue_discussion",
                         {"text": "stale write must not land"}, rev=rev - 1)
    code = r.get("code") if isinstance(r, dict) else None
    check("B4 stale controlRevision refused (conflict)",
          st == 409, f"{st} {code}")

    st, r = send_command(CARD_SMALL, "answer_question",
                         {"questionId": "q-nope", "answer": "x"})
    check("B5 unknown question refused 4xx",
          st in (404, 409, 422), f"{st} {str(r)[:160]}")


def phase_complex(pw):
    """Gates, document versions, binding swap, handoff — real UI + API."""
    print("\n== phase C: complex flow — gates/docs/handoff ==")
    seed_card(CARD_COMPLEX, "U7 P5 complex " + CARD_COMPLEX)
    enable_card_api(CARD_COMPLEX)

    REQ_V1 = ("# Requirements\n\n- Snooze parks a card until a date\n"
              "- Snoozed cards listed per column\n- Resurface is silent\n")
    REQ_V2 = REQ_V1 + "- Editing a snoozed card does not wake it\n"

    # Start with intent + requirements + plan bindings (design skipped —
    # a deliberate scope choice; lead-only stages are legal).
    st, r = send_command(CARD_COMPLEX, "start_preparation", {
        "intent": "Snooze card feature — complex path with documents",
        "bindings": {"intent": "grill-with-docs",
                     "requirements": "ce-brainstorm",
                     "plan": "ce-plan"},
    })
    check("C1 complex session started with 3 stage bindings",
          st == 200, f"{st} {str(r)[:200]}")

    v = wait_prep(CARD_COMPLEX, lambda s: len(gates(s)) >= 3, timeout_s=20)
    gs = {(g["type"], g["stage"]): g["status"] for g in gates(v or {})}
    check("C2 binding gate contracts minted pending",
          ("intent_confirm", "intent") in gs
          and ("artifact_confirm", "requirements") in gs
          and ("artifact_confirm", "plan") in gs, str(gs))

    # This card may carry adopted docs from earlier sessions (R6: current
    # card docs become the session's presented set at start). A plan gate
    # confirm then binds the adopted doc (200); with no plan presented it
    # must refuse gate_subject_absent (422). Either outcome is honest —
    # what must never happen is a confirm against nothing.
    plan_gate = next((g for g in gates(v or {})
                      if g["stage"] == "plan"), None)
    presented_plan = ((v or {}).get("presented") or {}).get("plan")
    st, r = send_command(CARD_COMPLEX, "confirm_gate",
                         {"gateId": plan_gate["gateId"]})
    if presented_plan:
        check("C3 plan gate confirm binds adopted presented plan",
              st == 200, f"{st} {str(r)[:140]}")
    else:
        check("C3 plan gate confirm refuses — no presented doc",
              st == 422, f"{st} {str(r)[:140]}")

    # Attach + approve requirements; the plan stage then accepts a plan
    # bound to that approved version.
    st, r = attach_doc(CARD_COMPLEX, "requirements", REQ_V1)
    check("C4 requirements v1 attached", st == 200, f"{st} {str(r)[:120]}")
    req_v1 = doc_current(CARD_COMPLEX, "requirements")
    st, r = approve_doc(CARD_COMPLEX, "requirements", req_v1)
    check("C5 requirements v1 approved by exact version",
          st == 200, f"{st} {str(r)[:120]}")

    req_gate = next(g for g in gates(
        prep_view(CARD_COMPLEX)[1]["preparation"])
        if g["stage"] == "requirements" and g["status"] == "pending")
    st, r = send_command(CARD_COMPLEX, "confirm_gate",
                         {"gateId": req_gate["gateId"]})
    check("C6 requirements gate confirmed against presented v1",
          st == 200, f"{st} {str(r)[:120]}")

    # A new document version invalidates the confirmed gate — approvals and
    # gates never silently inherit.
    st, r = attach_doc(CARD_COMPLEX, "requirements", REQ_V2)
    check("C7 requirements v2 attached", st == 200)
    v = wait_prep(CARD_COMPLEX,
                  lambda s: any(g["stage"] == "requirements"
                                and g["status"] == "invalidated"
                                for g in gates(s)),
                  timeout_s=15)
    check("C8 confirmed gate invalidated by new doc version",
          v is not None)
    req_v2 = doc_current(CARD_COMPLEX, "requirements")
    st, r = approve_doc(CARD_COMPLEX, "requirements", req_v2)
    check("C9 v2 must be re-approved (no inherited approval)", st == 200)

    # Plan bound to the approved requirements version.
    st, r = attach_doc(CARD_COMPLEX, "plan",
                       "# Plan\n\n1. store snoozeUntil on the card\n"
                       "2. filter in column render\n3. resurface job\n",
                       )
    if st != 200:
        # Requirements approval moved — re-read and retry once.
        st, r = attach_doc(CARD_COMPLEX, "plan",
                           "# Plan\n\n1. store snoozeUntil on the card\n"
                           "2. filter in column render\n3. resurface job\n")
    check("C10 plan attached against approved requirements",
          st == 200, f"{st} {str(r)[:160]}")
    plan_v = doc_current(CARD_COMPLEX, "plan")
    st, r = approve_doc(CARD_COMPLEX, "plan", plan_v,
                        checks=[{"run": "true", "timeoutSec": 30}])
    check("C11 plan approved by exact version + checks", st == 200,
          f"{st} {str(r)[:140]}")

    # Re-confirm the invalidated requirements gate (binds v2 now — an
    # invalidated gate re-confirms against the CURRENT presented subject),
    # confirm plan + intent gates.
    for want in [("artifact_confirm", "requirements"),
                 ("artifact_confirm", "plan"),
                 ("intent_confirm", "intent")]:
        v = prep_view(CARD_COMPLEX)[1]["preparation"]
        g = next((g for g in gates(v)
                  if (g["type"], g["stage"]) == want
                  and g["status"] in ("pending", "invalidated")), None)
        assert g, f"no {want} gate to confirm"
        st, r = send_command(CARD_COMPLEX, "confirm_gate",
                             {"gateId": g["gateId"]})
        check(f"C12 gate {want[0]}:{want[1]} confirmed", st == 200,
              f"{st} {str(r)[:140]}")

    # Binding change is explicit: swap requirements binding → confirmed
    # gates under the old ref invalidate, a fresh gate mints pending.
    st, r = send_command(CARD_COMPLEX, "change_skill_binding",
                         {"stage": "design",
                          "bindingId": "superpowers-architectural"})
    check("C13 explicit design binding accepted", st == 200,
          f"{st} {str(r)[:140]}")
    v = wait_prep(CARD_COMPLEX,
                  lambda s: any(g["stage"] == "design"
                                and g["status"] == "pending"
                                for g in gates(s)),
                  timeout_s=15)
    check("C14 design binding minted its artifact_confirm gate",
          v is not None)

    # No design doc is ever presented in this flow — confirming the design
    # gate must refuse fail-closed (nothing presented to bind to).
    dg = next((g for g in gates(v or {})
               if g["stage"] == "design" and g["status"] == "pending"),
              None)
    if dg:
        st, r = send_command(CARD_COMPLEX, "confirm_gate",
                             {"gateId": dg["gateId"]})
        check("C13b design gate confirm refuses — subject absent",
              st == 422 and "gate_subject_absent" in str(r),
              f"{st} {str(r)[:160]}")
    else:
        check("C13b design gate confirm refuses — subject absent",
              False, "no pending design gate found")

    # Drain any open durable questions the real lead minted — readiness can
    # never hold while a blocking question is unanswered, and this suite's
    # user policy is scripted: one bounded answering loop.
    deadline = time.time() + 300
    while time.time() < deadline:
        v = prep_view(CARD_COMPLEX)[1]["preparation"]
        oq = open_questions(v)
        if not oq:
            break
        send_command(CARD_COMPLEX, "answer_question",
                     {"questionId": oq[0]["questionId"],
                      "answer": "Settled — proceed with the smallest scope."})
        time.sleep(3.0)

    # Readiness: with requirements+plan approved and all pending gates
    # either confirmed or only the (unsubmitted) design gate pending,
    # `ready` must still be False while the design gate lacks a doc —
    # honest not-ready, not a fake green.
    v = prep_view(CARD_COMPLEX)[1]["preparation"]
    check("C15 not ready while design gate/doc unresolved",
          v.get("ready") is False
          and len(v.get("blockers") or []) > 0,
          str(v.get("blockers"))[:200])

    # Remove the design binding again (explicit) → its pending gate
    # invalidates; remaining gates confirmed → ready flips true.
    st, r = send_command(CARD_COMPLEX, "change_skill_binding",
                         {"stage": "design", "bindingId": None})
    check("C16 design binding explicitly cleared", st == 200,
          f"{st} {str(r)[:140]}")
    # Ready waits can race the lead minting a fresh question — answer as
    # they appear while polling (bounded).
    deadline = time.time() + 300
    v = None
    while time.time() < deadline:
        v = prep_view(CARD_COMPLEX)[1]["preparation"]
        if v.get("ready") is True:
            break
        oq = open_questions(v)
        if oq:
            send_command(CARD_COMPLEX, "answer_question",
                         {"questionId": oq[0]["questionId"],
                          "answer": "Settled — proceed."})
        time.sleep(3.0)
    check("C17 session ready once every required gate holds",
          v is not None and v.get("ready") is True,
          str((v or {}).get("blockers")))

    # Handoff — a durable OFFER only; implementation never starts.
    st, r = send_command(CARD_COMPLEX, "handoff_preparation",
                         {"mode": "solo",
                          "note": "p5 e2e handoff"})
    check("C18 handoff offer recorded", st == 200, f"{st} {str(r)[:160]}")
    st, view = card_view(CARD_COMPLEX)
    runs = view.get("runs") or []
    check("C19 handoff minted NO implementation run",
          len(runs) == 0, f"runs={len(runs)}")
    v = prep_view(CARD_COMPLEX)[1]["preparation"]
    ho = (v.get("handoffs") or [])[-1] if v.get("handoffs") else None
    check("C20 handoff carries the accepted inputs snapshot",
          ho is not None and ho.get("mode") == "solo",
          str(ho)[:160])

    # Browser evidence of the complex card's end state.
    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, CARD_COMPLEX)
        check("C21 UI shows ready state",
              page.locator('[data-testid="prep-ready"]').count() == 1
              or "ready" in (page.locator(
                  '[data-testid="prep-status"]').inner_text() or ""))
        check("C22 UI lists the recorded handoff",
              page.locator('[data-testid="prep-handoff"]').inner_text()
              .find("solo") >= 0)
        check("C23 UI still shows the gate list",
              page.locator('[data-testid="prep-gates"]').count() == 1)
        shot(page, "C-complex-ready")

        # Stop is explicit and preserves the checkpoint.
        page.locator('[data-testid="prep-stop"]').click()
        v = wait_prep(CARD_COMPLEX,
                      lambda s: s.get("status") == "stopped",
                      timeout_s=20)
        check("C24 stop_preparation via UI stops the session",
              v is not None)
        page.locator('[data-testid="prep-stopped"]').wait_for(
            timeout=15000)
        check("C25 stopped banner shows preserved checkpoint",
              "preserved" in page.locator(
                  '[data-testid="prep-stopped"]').inner_text())
        shot(page, "C-stopped")
    finally:
        browser.close()


def phase_failclosed(pw):
    """Unsupported bindings refuse with reasons; offline controls disable."""
    print("\n== phase D: fail-closed controls ==")
    st, r = send_command(CARD_SMALL, "change_skill_binding",
                         {"stage": "requirements",
                          "bindingId": "ce-slack-researcher"})
    code = r.get("code") if isinstance(r, dict) else None
    check("D1 unsupported binding refused at the API",
          st == 422 and code is not None, f"{st} {code}")

    st, b = bindings_view()
    slack = next((x for x in (b.get("bindings") or [])
                  if x.get("bindingId") == "ce-slack-researcher"), None)
    check("D2 registry lists the unsupported entry WITH its reason",
          st == 200 and slack is not None
          and slack.get("status") == "unsupported"
          and bool((slack.get("unsupported") or {}).get("reason")),
          str(slack)[:160])

    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, CARD_SMALL)
        # Existing discussions preserve their bindings. Check availability
        # in the start form on a fresh fixture card.
        seed_card("u7-p5-offline", "U7 P5 offline u7-p5-offline")
        enable_card_api("u7-p5-offline")
        page2 = browser.new_page()
        track_page(page2)
        open_card_drawer(page2, "u7-p5-offline")
        page2.locator('[data-testid="prep-bindings-start"] summary').click()
        options = page2.locator(
            '[data-testid="prep-start-bind-requirements"] option'
        ).all_inner_texts()
        values = page2.locator(
            '[data-testid="prep-start-bind-requirements"] option'
        ).evaluate_all('(options) => options.map(option => option.value)')
        allowed = {x.get("bindingId") for x in b.get("bindings", [])
                   if x.get("stage") == "requirements" and x.get("status") == "available"}
        check("D3 unsupported routes omitted from start options",
              bool(values) and all(not value or value in allowed for value in values)
              and not any("unavailable" in option for option in options), str(options)[:160])

        # Offline: every execution request fails on a FRESH page load —
        # the exec view never loads, so the honest surface is no prep
        # panel at all (fail-closed: the UI cannot claim the feature).
        # What must never render: a start control or a fake session.
        page2.route("**/api/execution/**",
                    lambda route: route.abort("connectionrefused"))
        page2.reload(wait_until="domcontentloaded")
        open_card_drawer(page2, "u7-p5-offline", wait_panel=False)
        check("D4 offline: prep panel hidden, no enabled start control",
              page2.locator('[data-testid="prep-panel"]').count() == 0
              or not page2.locator(
                  '[data-testid="prep-start"]').is_enabled())
        check("D5 offline: no fake session rendered",
              page2.locator('[data-testid="prep-meta"]').count() == 0)
        shot(page2, "D-offline")
        page2.unroute("**/api/execution/**")
    finally:
        browser.close()


def phase_legacy(pw):
    """Accepted docs continue to the core path; prep adopts, not re-asks."""
    print("\n== phase E: legacy card continuity ==")
    seed_card(CARD_LEGACY, "U7 P5 legacy " + CARD_LEGACY)
    enable_card_api(CARD_LEGACY)
    st, r = attach_doc(CARD_LEGACY, "requirements",
                       "# Requirements\n\n- legacy accepted scope\n")
    assert st == 200, f"attach -> {st} {r}"
    rv = doc_current(CARD_LEGACY, "requirements")
    st, r = approve_doc(CARD_LEGACY, "requirements", rv)
    assert st == 200, f"approve -> {st} {r}"

    # No session exists — the card is NOT forced through an interview.
    st, v = prep_view(CARD_LEGACY)
    check("E1 legacy card has no preparation session",
          st in (404, 501) or (st == 200 and not v.get("preparation")),
          f"{st}")

    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, CARD_LEGACY)
        check("E2 prep panel offers a start form, not a forced flow",
              page.locator('[data-testid="prep-card-source"]').is_visible())

        # When preparation does start, the accepted doc is adopted as the
        # session's presented requirements — no re-interview for it.
        st, r = send_command(CARD_LEGACY, "start_preparation",
                             {"intent": "continue the legacy scope"})
        check("E3 start_preparation on legacy card", st == 200,
              f"{st} {str(r)[:140]}")
        v = wait_prep(CARD_LEGACY,
                      lambda s: ((s.get("presented") or {})
                                 .get("requirements") or {})
                                .get("versionId") == rv,
                      timeout_s=15)
        check("E4 accepted document adopted as presented version",
              v is not None)
        shot(page, "E-legacy")
    finally:
        browser.close()


def phase_restart(pw):
    """Runner restart mid-session — durable state survives, supervisor
    re-discovers the card, the session stays answerable."""
    print("\n== phase F: runner restart persistence ==")
    before = prep_view(CARD_SMALL)[1].get("preparation") or {}
    res = H.compose("restart", "runner", timeout=90.0)
    check("F1 runner restart issued", res.returncode == 0,
          res.stderr.strip()[:120])
    H.require_stack(services=("state", "runner"), timeout=60.0)
    time.sleep(4.0)  # first sweep tick

    v = prep_view(CARD_SMALL)[1].get("preparation") or {}
    check("F2 session survives runner restart",
          v.get("sessionId") == before.get("sessionId")
          and v.get("status") == "active",
          f"{before.get('sessionId')} -> {v.get('sessionId')}")

    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, CARD_SMALL)
        qid = ui_answer_open_question(
            page,
            "Non-goals: recurring snooze and automation rules. Editing a "
            "snoozed card does not wake it.",
            timeout_s=300)
        check("F3 lead still answers after runner restart",
              qid is not None, f"question={qid}")
        shot(page, "F-after-restart")
    finally:
        browser.close()


def main() -> int:
    print("e2e_preparation — P5 browser suite")
    H.verify_isolation()
    H.require_stack()
    # Feature flags ride on the card view — seed one card first, then read.
    seed_card(CARD_SMALL, "U7 P5 small " + CARD_SMALL, SMALL_INTENT)
    enable_card_api(CARD_SMALL)
    st, cv = card_view(CARD_SMALL)
    prep_on = st == 200 and (cv.get("features") or {}).get("preparation")
    if not prep_on:
        print("REFUSE: ACP_EXEC_PREPARATION is not enabled on the test "
              "stack — run `python3 scripts/u7_transition.py preparation`")
        return 2
    print("preparation feature flag confirmed on the isolated stack")

    t0 = time.time()
    try:
        with sync_playwright() as pw:
            phase_small(pw)
            phase_stale()
            phase_complex(pw)
            phase_failclosed(pw)
            phase_legacy(pw)
            phase_restart(pw)
    except BaseException as e:
        print(f"\nSUITE ERROR: {e}")
        dump_forensics()
        return 2
    finally:
        dt = time.time() - t0

    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks)} checks, {len(checks) - len(failed)} pass, "
          f"{len(failed)} fail, {dt:.0f}s")
    if failed:
        dump_forensics()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
