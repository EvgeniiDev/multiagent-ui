#!/usr/bin/env python3
"""u7_browser.py — real Playwright suite over the isolated compose stack.

Drives the ACTUAL page (no SSR/mocks) against the test state server +
web container on the fixed ports. Two phases:

  --phase off   default-off behaviour: unmanaged card shows explicit opt-in,
                enable/doc approvals work, but `start` is gated by the
                server (ACP_EXEC_START=0) — the UI must surface the honest
                error, create no run, and never queue a later POST.
                Legacy board/review surfaces verified unchanged.

  --phase on    full managed flow in the browser on TWO CONCURRENT tabs:
                enable → requirements → explicit approve → plan + check →
                approve → preset from real compatibility → start.
                While run 1 is mid-flight: offline tab must NOT queue a
                command POST (zero replay after reconnect), then a real
                Stop lands on the live run and Continue launches run 2.
                Run 2 reaches awaiting_acceptance → NONVACUOUS artifact
                proof (row count, exact bytes vs server contentBase64 +
                sha256), attempts/checks/rounds/findings all real,
                >200 canonical events verified via bounded API paging,
                run-history rows honest, session identity is
                {agentName, sessionId} — never a porchRunId.
                Card-B input edit invalidates approvals and closes the
                start gate. Accept on tab 1; stale second-accept on tab 2
                is refused without duplicating the acceptance; both tabs
                converge on succeeded. Browser descendant cleanup proven.

Requires the isolated stack up on fixed ports (run inside a u7_run window).
Browser: ~/.hermes/tools-venv/bin/python + cached playwright chromium.
"""
from __future__ import annotations

import argparse
import base64
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

CARD_BASE = "u7-browser"
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
PROJ_ID = "u7-proj"
PROJ_LABEL = "u7-sandbox"
TERMINAL = {"awaiting_acceptance", "succeeded", "failed", "cancelled",
            "stopped"}

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []
DIAG_PAGES: list = []          # live pages for the failure-forensics dump
DIAG_CARDS: list[str] = []     # seeded card ids for the same dump
DIAG_NET: list[str] = []       # execution-API responses seen by the pages


_NET_BODY_SEEN = 0


def _net_response(r):
    try:
        if "/api/execution" not in r.url:
            return
        DIAG_NET.append(f"{r.status} {r.request.method} {r.url}")
        # Capture ONE run-detail body — the shape may be the whole mystery.
        global _NET_BODY_SEEN
        if (_NET_BODY_SEEN < 2 and r.request.method == "GET"
                and r.status == 200 and "/runs/" in r.url
                and "/events" not in r.url and "/artifacts/" not in r.url):
            _NET_BODY_SEEN += 1
            try:
                body = r.json()
                keys = (sorted(body.keys()) if isinstance(body, dict)
                        else type(body).__name__)
                DIAG_NET.append(
                    f"    body keys={keys} status={body.get('status')!r}"
                    if isinstance(body, dict) else f"    body={body!r}")
            except Exception as e:
                DIAG_NET.append(f"    body read failed: {e}")
    except Exception:
        pass


def _net_failed(r):
    # requestfailed hands a Request (not Response) — r.method/r.url/r.failure.
    try:
        if "/api/execution" in r.url:
            DIAG_NET.append(f"FAILED {r.method} {r.url} {r.failure}")
    except Exception:
        pass


def _accept_dialog(d):
    try:
        d.accept()
    except Exception:
        pass


def _console_msg(m):
    try:
        t = m.text
        if "[u7dbg]" in t or "error" in t.lower():
            DIAG_NET.append(f"console[{m.type}]: {t[:300]}")
    except Exception:
        pass


def track_page(page):
    """Register a page for forensics: pageerrors + execution-API traffic.
    Listeners must never raise — a pyee listener exception cascades into
    the dispatcher and corrupts unrelated events (observed live)."""
    DIAG_PAGES.append(page)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("dialog", _accept_dialog)
    page.on("response", _net_response)
    page.on("requestfailed", _net_failed)
    page.on("console", _console_msg)


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}"
          + (f"  ({detail})" if detail else ""))


def dump_forensics():
    """What the UI actually showed — must run while the browser is still
    alive (inside the phase's except, before browser.close())."""
    print("\n--- failure forensics ---")
    for i, p in enumerate(DIAG_PAGES):
        try:
            panel = p.locator('[data-testid="execution-panel"]')
            txt = (panel.inner_text(timeout=3000)
                   if panel.count() else "(panel absent)")
            print(f"page{i} url={p.url}\n  panel: {txt[:1200]}")
            # Prod builds strip __vueParentComponent but keep __vue_app__
            # on the mount container — walk app._context.provides for the
            # pinia instance (identified by its _s store Map), read the
            # 'execution' store entries, AND walk the component tree to the
            # ExecutionPanel instance to read its own st/run bindings.
            probe = p.evaluate("""() => {
              const app = document.querySelector('#app')?.__vue_app__
                       || document.querySelector('[id]')?.__vue_app__;
              const provides = app && app._context && app._context.provides;
              if (!provides) return {err: 'no app/provides'};
              let pinia = null;
              for (const s of Object.getOwnPropertySymbols(provides)) {
                const v = provides[s];
                if (v && v._s instanceof Map) { pinia = v; break; }
              }
              if (!pinia) {
                for (const k of Object.keys(provides)) {
                  const v = provides[k];
                  if (v && v._s instanceof Map) { pinia = v; break; }
                }
              }
              if (!pinia) return {err: 'no pinia', keys: Object.keys(provides)};
              const store = pinia._s.get('execution');
              if (!store) return {err: 'no exec store',
                                  ids: [...pinia._s.keys()]};
              const entries = {};
              for (const [cid, st] of Object.entries(store.cards || {})) {
                entries[cid] = {
                  phase: st.phase, watchers: st.watchers,
                  selectedRunId: st.selectedRunId,
                  hasRun: !!st.run,
                  runStatus: st.run && st.run.status,
                  runError: st.runError,
                  events: (st.events || []).length,
                  eventsCursor: st.eventsCursor,
                  runInflight: !!st.runInflight,
                  seq: st.seq, reqSeq: st.reqSeq, runReqSeq: st.runReqSeq,
                  viewRuns: (st.view && st.view.runs || []).map(r => r.id),
                  currentRunId: st.view && st.view.currentRunId,
                };
              }
              // Walk the live component tree: instance.subTree is the
              // rendered vnode root; component vnodes carry .component;
              // slot children are objects of fns — iterate them all.
              const panels = [];
              const types = [];
              const seen = new Set();
              const walk = (vnode, depth) => {
                if (!vnode || typeof vnode !== 'object' || seen.has(vnode)
                    || depth > 60) return;
                seen.add(vnode);
                const ci = vnode.component;
                if (ci && ci !== vnode) {
                  const tn = (ci.type && (ci.type.__name ||
                                          (ci.type.__file || '')
                                            .split('/').pop())) || '?';
                  if (depth < 30) types.push(
                    '  '.repeat(Math.min(depth, 12)) + tn);
                  if (String(tn).includes('ExecutionPanel')
                      || String(tn).includes('CardDrawer')) {
                    const ss = ci.setupState || {};
                    const unref = (x) => (x && typeof x === 'object'
                                          && 'value' in x) ? x.value : x;
                    const stC = unref(ss.st);
                    const runC = unref(ss.run);
                    panels.push({
                      type: tn,
                      propCardId: ci.props && ci.props.cardId,
                      stCardId: stC && stC.cardId,
                      stIsStoreEntry:
                        !!(stC && store.cards[stC.cardId] === stC),
                      stRun: stC ? !!stC.run : null,
                      stRunId: stC && stC.run && stC.run.id,
                      runComputed: !!runC,
                      runId: runC && runC.id,
                      selectedRunId: stC && stC.selectedRunId,
                      phase: stC && stC.phase,
                      suspended: !!ci.isDeactivated,
                      setupKeys: Object.keys(ss).slice(0, 40),
                    });
                  }
                  walk(ci.subTree, depth + 1);
                  return;
                }
                const ch = vnode.children;
                if (Array.isArray(ch)) {
                  for (const c of ch) walk(c, depth + 1);
                } else if (ch && typeof ch === 'object') {
                  // slots object — every value can be a slot function
                  for (const k of Object.keys(ch)) {
                    const f = ch[k];
                    if (typeof f === 'function') {
                      let out;
                      try { out = f(); } catch (e) { continue; }
                      for (const c of (Array.isArray(out) ? out : [out]))
                        walk(c, depth + 1);
                    }
                  }
                }
              };
              try {
                const rootInst = app._instance
                              || (app._vnode && app._vnode.component);
                if (rootInst && rootInst.subTree) walk(rootInst.subTree, 0);
                else return {err: 'no root instance',
                             inst: !!rootInst, appKeys: Object.keys(app),
                             entries};
              } catch (e) { return {err: 'walk: ' + e, entries}; }
              return {online: store.online, entries, panels,
                      seen: types.slice(-30)};
            }""")
            print(f"  store probe: {probe}")
        except Exception as e:
            print(f"page{i} dump failed: {e}")
    for cid in DIAG_CARDS:
        try:
            st, view = card_view(cid)
            print(f"server card {cid}: st={st} "
                  f"{str(view)[:400]}")
        except Exception as e:
            print(f"server card {cid} fetch failed: {e}")
    print("execution-API traffic (last 30):")
    for line in DIAG_NET[-30:]:
        print(f"  {line}")
    print("pageerrors:", page_errors[:10])


def seed_card(card_id: str):
    """Same merge pattern as u7_api_flow.seed_card — project + card rows."""
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
        "id": card_id, "title": f"U7 browser {card_id}",
        "description": "u7 browser suite", "project": PROJ_LABEL,
        "agent": "", "priority": "normal", "acceptance": "",
        "verification": "", "links": [],
        # Real cards carry their originating chat session — the exec
        # aggregate inherits it at `enable`. Session identity is
        # {agentName, sessionId} and must never be a porchRunId.
        "session": {"agentName": "pi",
                    "sessionId": f"u7-browser-sess-{int(time.time())}"},
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": "backlog", "status": "todo", "order": 0,
        "createdAt": now, "updatedAt": now,
    })
    st, _ = H.seed_doc("board.json", {**data, "cards": cards}, rev=rev)
    assert st == 200, f"board seed -> {st}"


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


def open_card_drawer(page, card_id):
    page.goto(H.WEB_URL, wait_until="domcontentloaded")
    page.locator('.view-rail button[aria-label="Board"]').click()
    # Card ids nest (<id> vs <id>-b) — a bare has_text substring match can
    # land the sibling card. The lookahead refuses a continuation char of
    # the id alphabet ([0-9a-z-]) right after the id.
    page.locator(".card-title", has_text=re.compile(
        re.escape(card_id) + r"(?![0-9a-z-])")).first.click()
    page.locator('[data-testid="execution-panel"]').wait_for(timeout=15000)


def attach_and_approve(page, tab_button: str, text: str,
                       approve: bool = True):
    """Switch doc tab, attach a new version; optionally approve it."""
    # Scope to the doc tab strip — "Change requirements" also substring-
    # matches "Requirements"; DOM order alone would save it by accident.
    page.locator(".exec-doc-tabs").locator(
        "button", has_text=tab_button).first.click()
    page.locator('[data-testid="doc-new"]').click()
    page.locator('[data-testid="doc-draft"]').fill(text)
    page.locator('[data-testid="doc-attach"]').click()
    # <option> children of a closed native <select> are never "visible" —
    # the select itself only renders once docVersions.length>0, so an
    # attached option[0] still proves the attach landed.
    page.locator('[data-testid="doc-version-pick"] option').nth(
        0).wait_for(state="attached", timeout=15000)
    if approve:
        page.locator('[data-testid="doc-approve"]').click()
        page.wait_for_timeout(400)


def pick_preset(page, cli: str):
    page.locator('[data-testid="preset-new"]').click()
    # unique name per run — save_preset upserts by id, and a recycled name
    # would make the registry write ambiguous across windows.
    page.locator('[data-testid="preset-name"]').fill(
        f"u7-browser-{cli}-{int(time.time()) % 100000}")
    for role in ("implementer", "reviewer", "checker"):
        sel = page.locator(f'select[aria-label="{role} cli"]')
        sel.wait_for(timeout=15000)
        opts = [o.strip() for o in sel.locator("option").all_inner_texts()]
        pick = cli if cli in opts else None
        if not pick:
            vals = sel.locator("option").evaluate_all(
                "els => els.map(e => e.value).filter(v => v)")
            pick = vals[0] if vals else None
        assert pick, f"no cli option for {role}: {opts}"
        sel.select_option(pick)
        msel = page.locator(f'select[aria-label="{role} model"]')
        mvals = msel.locator("option").evaluate_all(
            "els => els.map(e => e.value).filter(v => v)")
        if mvals:
            msel.select_option(mvals[0])
    page.locator('[data-testid="preset-save"]').click()
    page.wait_for_timeout(600)


def wait_run(card_id, predicate, timeout=900000, poll=3.0):
    """Poll the SERVER run view until predicate(run) — returns the run."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rid = current_run_id(card_id)
        if rid:
            st, run = run_view(rid)
            if st == 200 and predicate(run):
                return run
        time.sleep(poll)
    return None


def drain_events(run_id, limit=200):
    """Bounded-paging drain of the canonical event log — real server pages."""
    seen, cursor, pages = [], 0, 0
    total = None
    while True:
        st, body = api(
            "GET",
            f"/api/execution/runs/{run_id}/events?cursor={cursor}"
            f"&limit={limit}")
        if st != 200 or not isinstance(body, dict):
            return seen, total, pages, f"st={st}"
        evs = body.get("events") or []
        if len(evs) > limit:
            return seen, total, pages, f"page>{limit}"
        seen.extend(evs)
        total = body.get("total")
        pages += 1
        nc = body.get("nextCursor")
        if nc is None or not evs:
            break
        cursor = nc
        if pages > 64:
            return seen, total, pages, "paging runaway"
    seqs = [e.get("seq") for e in seen]
    if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
        return seen, total, pages, "non-monotonic seq"
    return seen, total, pages, ""


def chromium_children():
    try:
        out = subprocess.run(["pgrep", "-f", "chromium.*--headless"],
                             capture_output=True, text=True, timeout=10)
        return [p for p in out.stdout.split() if p.strip()]
    except Exception:
        return []


def phase_off(pw):
    """Default-off contract + legacy surfaces."""
    card_id = f"{CARD_BASE}-off-{int(time.time()) % 100000}"
    seed_card(card_id)
    DIAG_CARDS.append(card_id)
    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, card_id)

        check("off: unmanaged card shows explicit opt-in",
              page.locator('[data-testid="exec-unmanaged"]').is_visible())
        check("off: enable button present",
              page.locator('[data-testid="exec-enable"]').is_enabled())

        page.locator('[data-testid="exec-enable"]').click()
        page.locator('[data-testid="exec-status-line"]').wait_for(
            timeout=20000)
        st, view = card_view(card_id)
        check("off: enable committed server-side",
              st == 200 and view.get("managed") is True, f"st={st}")

        attach_and_approve(page, "Requirements",
                           "Browser flow requirements doc.")
        st, view = card_view(card_id)
        check("off: requirements approval recorded",
              bool((view.get("approvals") or {}).get("requirements")), "")

        # start must be gated OFF — honest error, no run, no queued POST.
        # The client gate (canStart) disables the button until plan
        # approval + a bound preset, so satisfy both first: the click then
        # really reaches the server and the refusal is the OFF gate's own
        # 501, not a client-side block.
        attach_and_approve(
            page, "Plan",
            "1. off-phase plan\n\n```acp-checks\n"
            '{"checks": [{"run": "python3 -c \'print(1)\'",'
            ' "timeoutSec": 30}]}\n```\n')
        pick_preset(page, "pi")
        st, view = card_view(card_id)
        check("off: plan approval + preset bound (gate pass client-side)",
              bool((view.get("approvals") or {}).get("plan"))
              and bool((view.get("composition") or {}).get("preset")),
              f"approvals={view.get('approvals')} "
              f"composition={view.get('composition')}")
        # is_enabled(timeout) waits only for the element to EXIST — a
        # rendered-but-disabled button returns False instantly. The
        # :enabled pseudo-class inside wait_for_selector is the real wait.
        en = True
        try:
            page.wait_for_selector('[data-testid="exec-start"]:enabled',
                                   timeout=20000)
        except Exception:
            en = False
        check("off: start enabled once every client gate passes", en)
        page.locator('[data-testid="exec-start"]').click()
        page.wait_for_timeout(1500)
        err_loc = page.locator('[data-testid="exec-command-error"]')
        err_visible = (
            err_loc.is_visible()
            or page.locator('[data-testid="exec-error"]').is_visible())
        check("off: start refused with honest error", err_visible)
        if err_loc.is_visible():
            check("off: refusal names the ACP_EXEC_START gate",
                  "gated" in err_loc.inner_text().lower()
                  and "acp_exec_start" in err_loc.inner_text().lower(),
                  err_loc.inner_text()[:160])
        st2, view2 = card_view(card_id)
        check("off: server confirms zero runs after refused start",
              st2 == 200 and not view2.get("runs"),
              f"runs={view2.get('runs')}")

        # legacy surfaces intact
        check("legacy: board columns render",
              page.locator(".board-col").first.is_visible())
        page2 = browser.new_page()
        track_page(page2)
        open_card_drawer(page2, card_id)
        try:
            page2.locator('[data-testid="exec-status-line"]').wait_for(
                timeout=20000)
            ok2 = True
        except Exception:
            ok2 = False
        if not ok2:
            dump_forensics()
        check("off: second tab shows managed state", ok2)
        page2.close()
    except Exception:
        dump_forensics()
        raise
    finally:
        browser.close()
    check("off: zero pageerrors", not page_errors,
          ";".join(page_errors[:3]))


def phase_on(pw, cli: str):
    card_a = f"{CARD_BASE}-on-{cli}-{int(time.time()) % 100000}"
    card_b = f"{card_a}-b"
    seed_card(card_a)
    seed_card(card_b)
    DIAG_CARDS.extend([card_a, card_b])
    before = set(chromium_children())
    browser = pw.chromium.launch(headless=True)
    run1_id = run2_id = None
    try:
        # ---- concurrent tabs on card A BEFORE start -----------------
        tab1 = browser.new_page()
        track_page(tab1)
        tab2 = browser.new_page()
        track_page(tab2)
        open_card_drawer(tab1, card_a)
        open_card_drawer(tab2, card_a)

        tab1.locator('[data-testid="exec-enable"]').click()
        tab1.locator('[data-testid="exec-status-line"]').wait_for(
            timeout=20000)
        attach_and_approve(
            tab1, "Requirements",
            "Change VALUE in main.py to 42, run the check, keep it small.")
        attach_and_approve(
            tab1, "Plan",
            "1. Edit main.py VALUE to 42\n2. Run python3 main.py\n\n"
            "```acp-checks\n"
            '{"checks": [{"run": "python3 -c \'import main;'
            ' assert main.VALUE == 42\'", "timeoutSec": 60}]}\n```\n')
        pick_preset(tab1, cli)
        tab2.locator('[data-testid="exec-refresh"]').click()
        try:
            tab2.locator('[data-testid="exec-status-line"]').wait_for(
                timeout=15000)
            conv = True
        except Exception:
            conv = False
        check("on: tab2 concurrent view converges pre-start", conv)

        # ---- card B on tab2: input edit invalidates approvals -------
        open_card_drawer(tab2, card_b)
        tab2.locator('[data-testid="exec-enable"]').click()
        tab2.locator('[data-testid="exec-status-line"]').wait_for(
            timeout=20000)
        attach_and_approve(tab2, "Requirements", "cardB requirements v1")
        attach_and_approve(
            tab2, "Plan",
            "cardB plan v1\n\n```acp-checks\n"
            '{"checks": [{"run": "python3 -c \'print(1)\'",'
            ' "timeoutSec": 30}]}\n```\n')
        st, vb = card_view(card_b)
        check("on: cardB both approvals recorded pre-edit",
              bool((vb.get("approvals") or {}).get("requirements"))
              and bool((vb.get("approvals") or {}).get("plan")),
              f"approvals={vb.get('approvals')}")
        # attach a NEW requirements version — approval must be revoked
        attach_and_approve(tab2, "Requirements",
                           "cardB requirements v2 — replaces v1",
                           approve=False)
        tab2.wait_for_timeout(800)
        st, vb = card_view(card_b)
        check("on: cardB requirements approval revoked by input edit",
              st == 200
              and not (vb.get("approvals") or {}).get("requirements"),
              f"approvals={vb.get('approvals')}")
        check("on: cardB start gate closed after invalidation",
              not tab2.locator('[data-testid="exec-start"]')
              .is_enabled(), "")
        check("on: cardB gate hints explain the block",
              tab2.locator('[data-testid="gate-hints"]').is_visible(), "")

        # ---- offline tab must queue nothing -------------------------
        st_pre, vb_pre = card_view(card_b)
        tab2.route("**/api/execution/**", lambda r: r.abort())
        # no pre-refresh: a failed refresh already flips the store offline
        # which disables doc-approve before the click can dispatch. The
        # approve's own fresh read inside sendCommand is the honest probe.
        tab2.locator('[data-testid="doc-approve"]').click()
        tab2.wait_for_timeout(1200)
        offline_err = (
            tab2.locator('[data-testid="exec-command-error"]').is_visible()
            or tab2.locator('[data-testid="exec-error"]').is_visible()
            # the connectivity chip is always rendered — its TEXT flips to
            # "offline" when the state server stops answering.
            or tab2.locator('[data-testid="exec-online"]')
            .inner_text().strip().lower() == "offline")
        tab2.unroute("**/api/execution/**")
        tab2.locator('[data-testid="exec-refresh"]').click()
        tab2.wait_for_timeout(1200)
        st_post, vb_post = card_view(card_b)
        check("on: offline command attempt surfaced honestly",
              offline_err)
        check("on: ZERO queued POST replay after reconnect "
              "(approvals unchanged server-side)",
              st_post == 200 and (vb_post.get("approvals") or {})
              == (vb_pre.get("approvals") or {}),
              f"pre={vb_pre.get('approvals')} "
              f"post={vb_post.get('approvals')}")
        check("on: cardB still has zero runs (no replayed command)",
              not vb_post.get("runs"), "")

        # ---- start run 1 on tab1, stop it mid-flight ----------------
        open_card_drawer(tab1, card_a)  # re-focus A (A->B->A nav proof 1)
        en1 = True
        try:
            tab1.wait_for_selector('[data-testid="exec-start"]:enabled',
                                   timeout=20000)
        except Exception:
            en1 = False
        check("on: start enabled after approvals+preset", en1)
        tab1.locator('[data-testid="exec-start"]').click()
        tab1.locator('[data-testid="run-status"]').wait_for(timeout=30000)
        run1 = wait_run(card_a, lambda r: bool(r.get("attempts")),
                        timeout=240000)
        check("on: run1 reached live attempt", bool(run1),
              f"status={(run1 or {}).get('status')}")
        run1_id = (run1 or {}).get("id")
        if run1:
            stop_btn = tab1.locator('[data-testid="exec-stop"]')
            en_stop = True
            try:
                tab1.wait_for_selector(
                    '[data-testid="exec-stop"]:enabled', timeout=30000)
            except Exception:
                en_stop = False
            check("on: stop enabled on live run", en_stop)
            stop_btn.click()
            run1_end = wait_run(
                card_a, lambda r: r.get("id") == run1_id
                and r.get("status") in TERMINAL
                or (r.get("status") or "") in ("stopped", "cancelled",
                                              "failed"),
                timeout=300000)
            st_end = (run1_end or {}).get("status")
            check("on: stopped run terminal status is honest "
                  "(never succeeded)", st_end in ("stopped", "cancelled",
                                                 "failed"),
                  f"status={st_end}")

            # ---- continue launches run 2 carrying workspace ---------
            cont = tab1.locator('[data-testid="exec-continue"]')
            en_cont = True
            try:
                tab1.wait_for_selector(
                    '[data-testid="exec-continue"]:enabled', timeout=60000)
            except Exception:
                en_cont = False
            check("on: continue enabled after terminal stop", en_cont)
            tab1.locator('[data-testid="continue-note"]').fill(
                "u7 browser continue")
            cont.click()
            tab1.wait_for_timeout(1500)
        rid2 = current_run_id(card_a)
        check("on: continue produced a NEW run", bool(rid2)
              and rid2 != run1_id, f"run1={run1_id} run2={rid2}")

        run2 = wait_run(card_a, lambda r: r.get("id") == rid2
                        and r.get("status") in TERMINAL)
        check("on: run2 reached awaiting_acceptance",
              (run2 or {}).get("status") == "awaiting_acceptance",
              f"status={(run2 or {}).get('status')}")
        if not run2:
            return
        run2_id = run2["id"]

        # ---- detail surfaces: nonvacuous ----------------------------
        tab1.locator('[data-testid="exec-refresh"]').click()
        tab1.wait_for_timeout(800)
        check("on: attempts listed", tab1.locator(
            '[data-testid="run-attempts"]').is_visible())
        srv_attempts = run2.get("attempts") or []
        check("on: attempts are real role attempts (att- ids, 3 roles)",
              len(srv_attempts) >= 3 and all(
                  str(a.get("id", "")).startswith("att-")
                  for a in srv_attempts),
              f"ids={[a.get('id') for a in srv_attempts]}")
        check("on: check reports displayed", tab1.locator(
            '[data-testid="run-checks"]').is_visible())
        check("on: rounds rendered", tab1.locator(
            '[data-testid="run-rounds"]').is_visible())
        check("on: findings/verdicts rendered", tab1.locator(
            '[data-testid="run-findings"]').is_visible())

        arts = tab1.locator('[data-testid="run-artifacts"] .art-row')
        n_art = arts.count()
        check("on: artifact rows present (nonvacuous)", n_art >= 1,
              f"n={n_art}")
        srv_arts = list((run2.get("artifacts") or {}).items())
        check("on: server reports artifacts for the run",
              len(srv_arts) >= 1, f"n={len(srv_arts)}")
        if n_art >= 1 and srv_arts:
            arts.first.click()
            tab1.locator('[data-testid="artifact-content"]').wait_for(
                timeout=10000)
            ui_text = tab1.locator(
                '[data-testid="artifact-content"]').inner_text()
            # which artifact did row 0 open? runArtifacts order ==
            # Object.entries(run.artifacts) order in the component.
            aid0 = srv_arts[0][0]
            st, body = api(
                "GET",
                f"/api/execution/runs/{run2_id}/artifacts/{aid0}")
            ok_bytes = (st == 200
                        and base64.b64decode(
                            body.get("contentBase64") or b"")
                        .decode("utf-8", "replace").strip()
                        == ui_text.strip())
            check("on: artifact row 0 renders EXACT server bytes",
                  ok_bytes,
                  f"aid={aid0} st={st} ui={len(ui_text)}B")
            check("on: artifact sha256+bytes bound server-side",
                  st == 200 and len(str(body.get("sha256") or "")) == 64
                  and isinstance(body.get("bytes"), int),
                  f"sha={str(body.get('sha256'))[:16]}… "
                  f"bytes={body.get('bytes')}")

        # ---- >200 REAL events over bounded paging --------------------
        evs, total, pages, err = drain_events(run2_id, limit=200)
        check("on: canonical events drained without error", not err, err)
        check("on: >200 real server events", (total or 0) > 200,
              f"total={total} pages={pages} drained={len(evs)}")
        check("on: paging was bounded (no oversized page)",
              pages >= 2 and all(isinstance(e.get("seq"), int)
                                 for e in evs), f"pages={pages}")
        check("on: managed-run-events UI renders drained history",
              tab1.locator('[data-testid="managed-run-events"] .mre-event')
              .first.is_visible(), "")

        # ---- session identity: agentName+sessionId, never porchRunId -
        st, va = card_view(card_a)
        sess = (va or {}).get("session")
        porch_ids = [a.get("porchRunId") for a in srv_attempts
                     if a.get("porchRunId")]
        check("on: card session is {agentName,sessionId}",
              isinstance(sess, dict)
              and isinstance(sess.get("agentName"), str)
              and isinstance(sess.get("sessionId"), str),
              f"session={sess}")
        check("on: sessionId never equals a porchRunId",
              sess and sess.get("sessionId") not in porch_ids,
              f"sid={sess.get('sessionId') if sess else None}")

        # ---- accept on tab1; stale accept on tab2 must not duplicate -
        acc = tab1.locator('[data-testid="exec-accept"]')
        en_acc = True
        try:
            tab1.wait_for_selector('[data-testid="exec-accept"]:enabled',
                                   timeout=60000)
        except Exception:
            en_acc = False
        check("on: accept enabled at awaiting_acceptance", en_acc,
              tab1.locator('[data-testid="gate-hints"]')
              .inner_text()[:120] if not en_acc and
              tab1.locator('[data-testid="gate-hints"]').count() else "")
        acc.click()
        accepted = wait_run(card_a, lambda r: r.get("id") == run2_id
                            and r.get("status") == "succeeded",
                            timeout=120000)
        check("on: accept commits -> succeeded", bool(accepted), "")
        sha1 = ((accepted or {}).get("acceptance") or {}).get(
            "resultSha256")

        open_card_drawer(tab2, card_a)
        tab2.locator('[data-testid="exec-refresh"]').click()
        rs2 = tab2.locator('[data-testid="run-status"]')
        try:
            rs2.wait_for(timeout=15000)
        except Exception:
            pass
        # The terminal-truth label for status 'succeeded' is 'accepted'
        # (RUN_STATUS_LABELS); 'awaiting acceptance' must NOT match.
        check("on: tab2 converged to succeeded",
              rs2.count() > 0
              and rs2.inner_text().strip().endswith("accepted"),
              rs2.inner_text()[:80] if rs2.count() else "none")
        # stale second accept (if the stale gate still shows it enabled)
        if tab2.locator('[data-testid="exec-accept"]').is_enabled():
            tab2.locator('[data-testid="exec-accept"]').click()
            tab2.wait_for_timeout(1200)
        st, va = card_view(card_a)
        _, run2_post = run_view(run2_id)
        sha2 = ((run2_post or {}).get("acceptance") or {}).get(
            "resultSha256")
        check("on: stale double-accept did not alter the acceptance",
              sha2 == sha1 and (run2_post or {}).get("status")
              == "succeeded", f"sha={sha1}→{sha2}")

        # ---- run history: both runs, honest statuses ------------------
        hist = tab1.locator('[data-testid="run-history"] .exec-histrow')
        check("on: run history lists both runs", hist.count() >= 2,
              f"rows={hist.count()}")

        # ---- A→B→A switching + nav unmount -----------------------------
        open_card_drawer(tab1, card_b)
        st_b = tab1.locator('[data-testid="exec-status-line"]')
        try:
            st_b.wait_for(timeout=15000)
        except Exception:
            pass
        check("on: cardB drawer shows its own state (not stale cardA)",
              st_b.count() > 0
              and not tab1.locator('[data-testid="run-status"]').count(),
              "")
        open_card_drawer(tab1, card_a)
        rs_a = tab1.locator('[data-testid="run-status"]')
        try:
            rs_a.wait_for(timeout=15000)
        except Exception:
            pass
        check("on: A→B→A restores cardA terminal truth",
              rs_a.count() > 0
              and rs_a.inner_text().strip().endswith("accepted"),
              rs_a.inner_text()[:80] if rs_a.count() else "none")
        # navigate off board and back while drawer lives (timer cleanup)
        rail = tab1.locator('.view-rail button').first
        rail.click()
        tab1.wait_for_timeout(600)
        tab1.locator('.view-rail button[aria-label="Board"]').click()
        tab1.wait_for_timeout(600)
        check("on: nav-away/back leaves no stale overlay or error",
              not page_errors, ";".join(page_errors[-2:]))
    except Exception:
        dump_forensics()
        raise
    finally:
        browser.close()
        after = set(chromium_children()) - before
        check("on: no chromium descendants linger", not after,
              str(list(after)[:5]))
    check("on: zero pageerrors", not page_errors,
          ";".join(page_errors[:3]))


def phase_probe(pw):
    """Cheap repro for the run-status mystery: drive the card to a live run
    entirely via the API, then open the drawer in a real browser and watch
    whether run-status renders + what the store entry actually holds."""
    card_id = f"{CARD_BASE}-probe-{int(time.time()) % 100000}"
    seed_card(card_id)
    DIAG_CARDS.append(card_id)

    def cmd(t, payload=None):
        st, view = card_view(card_id)
        rev = int(view["controlRevision"]) if st == 200 else 0
        return api("POST", f"/api/execution/cards/{card_id}/commands",
                   {"commandId": f"probe-{t}-{time.time_ns() % 10**10}",
                    "type": t, "payload": payload or {},
                    "expectedControlRevision": rev})

    st, b = cmd("enable")
    assert st == 200, f"enable {st} {b}"
    st, b = cmd("attach_document", {
        "kind": "requirements",
        "source": {"type": "text", "text":
                   "probe: set VALUE=42 in main.py"}})
    assert st == 200, f"attach req {st} {b}"
    req = (b.get("result") or {})
    st, b = cmd("approve_requirements", {
        "versionId": req["versionId"], "sha256": req["sha256"],
        "by": "u7-browser-probe"})
    assert st == 200, f"approve req {st} {b}"
    st, b = cmd("attach_document", {
        "kind": "plan",
        "source": {"type": "text", "text": "probe plan"},
        "checks": [{"run": "python3 -c 'import main; "
                           "assert main.VALUE == 42'", "timeoutSec": 60}]})
    assert st == 200, f"attach plan {st} {b}"
    plan = (b.get("result") or {})
    st, b = cmd("approve_plan", {
        "versionId": plan["versionId"], "sha256": plan["sha256"],
        "by": "u7-browser-probe"})
    assert st == 200, f"approve plan {st} {b}"
    member = {"cli": "pi",
              "model": "zen-relay/muse-spark-1.3-contributor-free"}
    st, b = cmd("save_preset", {"preset": {
        "name": f"u7-probe-pi-{int(time.time()) % 100000}",
        "members": {"implementer": member, "reviewer": member,
                    "checker": member},
        "limits": {"maxAttemptsPerRole": 1, "timeoutMin": 60,
                   "maxReviewRounds": 1}}})
    assert st == 200, f"save_preset {st} {b}"
    st, b = cmd("start")
    assert st == 200, f"start {st} {b}"
    run_id = (b.get("result") or {}).get("runId")
    print(f"probe: run started {run_id}")

    browser = pw.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        track_page(page)
        open_card_drawer(page, card_id)
        try:
            page.locator('[data-testid="run-status"]').wait_for(
                timeout=30000)
            check("probe: run-status renders", True)
        except Exception:
            check("probe: run-status renders", False)
            dump_forensics()
        # keep watching a little longer — maybe it lands late
        page.wait_for_timeout(15000)
        check("probe: run-status renders within 45s",
              page.locator('[data-testid="run-status"]').count() > 0)
        # Always surface the [u7dbg] component-side trace — pass or fail.
        dbg = [l for l in DIAG_NET if "u7dbg" in l]
        print(f"[u7dbg] last lines ({len(dbg)} total):")
        for l in dbg[-12:]:
            print("   ", l[:220])
        # REACTIVITY SPLIT-TEST: write st.run through the SAME reactive
        # store entry — if the span appears, the component tracks this
        # entry and the real write path must have raced it; if not, the
        # component reads a different object entirely.
        try:
            injected = page.evaluate("""(cid) => {
              const app = document.querySelector('#app').__vue_app__;
              const provides = app._context.provides;
              let pinia = null;
              for (const s of Object.getOwnPropertySymbols(provides)) {
                const v = provides[s];
                if (v && v._s instanceof Map) { pinia = v; break; }
              }
              const store = pinia._s.get('execution');
              const st = store.cards[cid];
              if (!st) return 'no entry';
              st.run = {id: 'probeInjected-xyz', status: 'running',
                        phase: 'implement'};
              return 'injected hasRun=' + !!st.run;
            }""", card_id)
            page.wait_for_timeout(800)
            n = page.locator('[data-testid="run-status"]').count()
            print(f"probe inject: {injected} -> run-status count={n}")
            if n:
                print("  text:", page.locator(
                    '[data-testid="run-status"]').first.inner_text())
        except Exception as e:
            print(f"probe inject failed: {e}")
    finally:
        browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["off", "on", "probe"],
                    required=True)
    ap.add_argument("--cli", default="pi")
    args = ap.parse_args()

    H.require_stack()
    print(f"u7_browser phase={args.phase} cli={args.cli}")

    with sync_playwright() as pw:
        try:
            if args.phase == "off":
                phase_off(pw)
            elif args.phase == "probe":
                phase_probe(pw)
            else:
                phase_on(pw, args.cli)
        except Exception:
            # Phases dump live forensics in their own except; if the failure
            # never reached a phase body (seed/launch), still print pageerrors.
            print("pageerrors:", page_errors[:10])
            raise

    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
