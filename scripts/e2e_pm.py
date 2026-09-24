#!/usr/bin/env python3
"""E2E for the pm role (F10): the board-graph reviewer.

Own state server on :25909 (STATE_DIR=<worktree>/tmp-pm-test/state), a
scratch project at tmp-pm-test/proj, and its own web bundle
(tmp-pm-test/dist-web, built with VITE_STATE_URL) served on :25995.

The script seeds a board with a KNOWN set of problems, then:

  1. `pmgraph scan` finds the mechanical classes naming the right pairs
     (module_overlap on the touches-intersecting pair, cycle on the
     dependsOn loop, unmirrored edges, impliedBlocked);
  2. `pmgraph apply` with a pm-style plan (the four finding classes,
     safe `link` actions, substance proposals) — asserts:
       - applied changes are exactly the safe set (graph fields + the
         derived blocked flag), each with a `pm` audit entry;
       - a correctly-linked consistent card and an out-of-scope card are
         byte-identical afterwards (no false positive);
       - a human-owned blockedReason is NOT overwritten;
       - substance changes (merge/rewrite/cycle-break) land in
         <proj>/.acp/pm/proposals.md and are NOT applied;
       - a re-run is a no-op (boardWritten false, rev unchanged);
  3. failure legs — malformed plan, unsafe op, cycle-closing link,
     out-of-scope action — each exits non-zero with the board document
     byte-identical AND the ledger untouched;
  4. the web panel on the test bundle shows the verdict: Links tab with
     the run line, applied-vs-proposed split, graph rows, blocked list,
     `blocked by <id8>` badge on the card, drawer relations + navigation,
     `pm` rows in Events.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_pm.py

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

ROOT = Path(__file__).resolve().parent.parent
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
PMGRAPH = ROOT / "scripts" / "pmgraph"
WORK = ROOT / "tmp-pm-test"
STATE_DATA = WORK / "state"
PROJ = WORK / "proj"
DIST = WORK / "dist-web"
PLAN = WORK / "plan.json"

STATE_PORT = 25909
WEB_PORT = 25995
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
WEB_URL = f"http://127.0.0.1:{WEB_PORT}/"

PROJECT_LABEL = "pm-proj"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def port_free(port):
    try:
        out = subprocess.run(
            ["ss", "-ltn"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    if out:
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 4 and parts[3].rsplit(":", 1)[-1] == str(port):
                return False
        return True
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
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


def force_put(name, data):
    _, rev = get_doc(name)
    status, body = api(f"/{name}", "PUT", {"data": data, "rev": rev})
    assert status == 200, f"put {name} -> {status} {body}"


def board_file_bytes():
    p = STATE_DATA / "board.json.json"
    return p.read_bytes() if p.exists() else b""


def activity_entries():
    doc, _ = get_doc("activity.json")
    return (doc or {}).get("entries") or []


def pmgraph(*args, expect=0):
    proc = subprocess.run(
        [sys.executable, str(PMGRAPH), "--url", STATE_URL, *args],
        capture_output=True, text=True, timeout=60, cwd=ROOT,
    )
    if expect is not None:
        assert proc.returncode == expect, (
            f"pmgraph {' '.join(args)} -> {proc.returncode}\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}")
    return proc


def mk_card(cid, title, stage="spec", status="in_progress",
            project=PROJECT_LABEL, **kw):
    now = int(time.time() * 1000)
    card = {
        "id": cid, "title": title, "description": "",
        "project": project, "agent": "", "priority": "medium",
        "acceptance": "", "verification": "",
        "links": [], "session": None,
        "blocked": False, "blockedReason": "", "cancelled": False,
        "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": stage, "status": status, "statusByStage": {},
        "order": 10, "createdAt": now, "updatedAt": now,
    }
    card.update(kw)
    return card


# --- the seeded board --------------------------------------------------------
# ids are readable so the assertions stay legible; id8 = first 8 chars.

OV_A, OV_B = "pm-ov-aaaa", "pm-ov-bbbb"      # touches intersect -> module_overlap
CT_A, CT_B = "pm-ct-aaaa", "pm-ct-bbbb"      # CSV-only vs JSON-only -> contradiction
DUP_A, DUP_B = "pm-dup-aaa", "pm-dup-bbb"    # same work twice -> duplicate
CY_A, CY_B = "pm-cy-aaaa", "pm-cy-bbbb"      # wait on each other -> cycle
DEP = "pm-dep-0001"                          # waits on OV_A -> pm blocked
HUMAN = "pm-human-01"                        # waits on OV_A, human reason kept
CLEAN = "pm-clean-01"                        # depends on DONE, mirrors set -> untouched
DONE = "pm-done-0001"                        # done; blocks CLEAN mirror
FOREIGN = "pm-foreign1"                      # other project -> out of scope


def seed_board():
    cards = [
        mk_card(OV_A, "Paginate the audit endpoint",
                touches=["src/api/audit.ts"], stage="spec"),
        mk_card(OV_B, "Filter the audit endpoint",
                touches=["./src/api/audit.ts"], stage="spec"),
        mk_card(CT_A, "Report export returns CSV",
                description="The /report endpoint must respond CSV only.",
                acceptance="GET /report -> text/csv", stage="spec"),
        mk_card(CT_B, "Report export returns JSON",
                description="The /report endpoint must respond JSON only.",
                acceptance="GET /report -> application/json", stage="spec"),
        mk_card(DUP_A, "Add retry to the indexer",
                description="Indexer retries failed batches with backoff.",
                acceptance="failed batch retried 3x", stage="backlog",
                status=None),
        mk_card(DUP_B, "Retry the indexer on failure",
                description="Failed indexer batches should retry with backoff.",
                acceptance="batch retried 3 times", stage="backlog",
                status=None),
        mk_card(CY_A, "Wire the cache layer",
                dependsOn=[CY_B], stage="dev"),
        mk_card(CY_B, "Warm the cache on boot",
                dependsOn=[CY_A], stage="dev"),
        mk_card(DEP, "Render the audit page",
                dependsOn=[OV_A], stage="dev"),
        mk_card(HUMAN, "Localise the audit page",
                dependsOn=[OV_A], stage="dev",
                blocked=True, blockedReason="waiting for design review"),
        mk_card(CLEAN, "Ship the audit endpoint",
                dependsOn=[DONE], stage="spec"),
        mk_card(DONE, "Audit endpoint",
                blocks=[CLEAN], stage="done", status="done"),
        mk_card(FOREIGN, "Foreign card: same dependency",
                project="other-proj", dependsOn=[OV_A], stage="dev"),
    ]
    force_put("board.json", {"version": 2, "cards": cards})
    force_put("projects.json", {
        "version": 1,
        "projects": [{"id": "pm-e2e", "name": PROJECT_LABEL,
                      "path": str(PROJ), "createdAt": int(time.time() * 1000)}],
        "activeProjectId": "pm-e2e",
    })
    return {c["id"]: c for c in cards}


def card(cid):
    doc, _ = get_doc("board.json")
    for c in (doc or {}).get("cards", []):
        if c.get("id") == cid:
            return c
    return None


def write_plan(payload):
    PLAN.write_text(json.dumps(payload, indent=2))
    return PLAN


# --- legs --------------------------------------------------------------------

def leg_scan():
    proc = pmgraph("scan", "--project", PROJECT_LABEL)
    out = json.loads(proc.stdout)
    findings = out.get("findings") or []

    def pairs(cls):
        return [set(f.get("cards") or []) for f in findings
                if f.get("class") == cls]

    check("scan: module_overlap names the touches pair",
          {OV_A, OV_B} in pairs("module_overlap"),
          json.dumps([f for f in findings if f["class"] == "module_overlap"])[:200])
    check("scan: cycle names the waiting pair",
          {CY_A, CY_B} in pairs("cycle"),
          json.dumps([f for f in findings if f["class"] == "cycle"])[:200])
    check("scan: unmirrored edge DEP->OV_A reported",
          {DEP, OV_A} in pairs("unmirrored_edge"))
    check("scan: no overlap finding for text-only pair",
          {CT_A, CT_B} not in pairs("module_overlap"))
    implied = out.get("impliedBlocked") or {}
    check("scan: impliedBlocked marks DEP (unfinished dep)",
          implied.get(DEP) == [OV_A], json.dumps(implied)[:200])
    check("scan: impliedBlocked marks CY_A and CY_B (the loop)",
          implied.get(CY_A) == [CY_B] and implied.get(CY_B) == [CY_A])
    check("scan: consistent CLEAN is not implied-blocked",
          CLEAN not in implied)
    check("scan: out-of-scope card is not implied-blocked",
          FOREIGN not in implied)


def leg_apply(seeded):
    plan = {
        "project": PROJECT_LABEL,
        "findings": [
            {"class": "module_overlap", "cards": [OV_A, OV_B],
             "summary": "both cards edit the audit endpoint module",
             "evidence": "touches intersect on src/api/audit.ts"},
            {"class": "contradiction", "cards": [CT_A, CT_B],
             "summary": "export format specified two ways",
             "evidence": "CSV-only vs JSON-only acceptance"},
            {"class": "duplicate", "cards": [DUP_A, DUP_B],
             "summary": "indexer retry is requested twice",
             "evidence": "titles and acceptance describe one change"},
            {"class": "cycle", "cards": [CY_A, CY_B],
             "summary": "cache cards wait on each other",
             "evidence": "a.dependsOn b and b.dependsOn a"},
        ],
        "actions": [
            {"op": "link", "field": "conflictsWith", "from": OV_A, "to": OV_B},
            {"op": "link", "field": "conflictsWith", "from": CT_A, "to": CT_B},
        ],
        "proposals": [
            {"kind": "merge", "cards": [DUP_A, DUP_B],
             "summary": "merge into a single indexer-retry card",
             "reason": "duplicate work"},
            {"kind": "rewrite", "cards": [CT_A, CT_B],
             "summary": "pick one export format",
             "reason": "contradictory acceptance"},
            {"kind": "other", "cards": [CY_A, CY_B],
             "summary": "decide which cache card precedes; break the loop",
             "reason": "dependency cycle"},
        ],
    }
    write_plan(plan)
    before_entries = len(activity_entries())
    proc = pmgraph("apply", "--plan", str(PLAN),
                   "--project", PROJECT_LABEL,
                   "--project-path", str(PROJ),
                   "--session", "pmrun-e2e")
    out = json.loads(proc.stdout)
    applied = out.get("applied") or []

    check("apply: run ok, board written",
          out.get("ok") is True and out.get("boardWritten") is True,
          f"ok={out.get('ok')} boardWritten={out.get('boardWritten')}")

    # 1. applied changes are exactly the safe set.
    SAFE = {"dependsOn", "blocks", "conflictsWith", "blocked", "blockedReason"}
    fields = {a.get("field") for a in applied}
    check("apply: every applied field is in the safe set",
          fields <= SAFE, f"fields={sorted(fields)}")
    check("apply: conflict linked on the overlap pair (both sides)",
          OV_B in (card(OV_A) or {}).get("conflictsWith", [])
          and OV_A in (card(OV_B) or {}).get("conflictsWith", []))
    check("apply: conflict linked on the contradiction pair (both sides)",
          CT_B in (card(CT_A) or {}).get("conflictsWith", [])
          and CT_A in (card(CT_B) or {}).get("conflictsWith", []))
    check("apply: mirror blocks += DEP on OV_A",
          DEP in (card(OV_A) or {}).get("blocks", []))
    dep = card(DEP) or {}
    check("apply: DEP flagged blocked by pm naming OV_A",
          dep.get("blocked") is True
          and dep.get("blockedReason") == f"pm: blocked by {OV_A[:8]}",
          dep.get("blockedReason") or "")
    cyc = (card(CY_A) or {}), (card(CY_B) or {})
    check("apply: cycle cards pm-blocked (both wait forever)",
          cyc[0].get("blocked") is True and cyc[1].get("blocked") is True
          and (cyc[0].get("blockedReason") or "").startswith("pm:")
          and (cyc[1].get("blockedReason") or "").startswith("pm:"))

    # 2. cards the pm must NOT touch.
    human = card(HUMAN) or {}
    check("apply: human blockedReason NOT overwritten",
          human.get("blockedReason") == "waiting for design review",
          human.get("blockedReason") or "")
    check("apply: consistent CLEAN untouched",
          card(CLEAN) == seeded[CLEAN])
    check("apply: DONE untouched",
          card(DONE) == seeded[DONE])
    check("apply: out-of-scope card untouched",
          card(FOREIGN) == seeded[FOREIGN])

    # 3. substance stays a proposal.
    doc, _ = get_doc("board.json")
    ids = {c.get("id") for c in (doc or {}).get("cards", [])}
    check("apply: duplicate pair still exists (merge NOT applied)",
          {DUP_A, DUP_B} <= ids)
    check("apply: contradiction texts NOT rewritten",
          (card(CT_A) or {}).get("acceptance") == "GET /report -> text/csv"
          and (card(CT_B) or {}).get("acceptance")
          == "GET /report -> application/json")
    check("apply: no stage moved",
          (card(CT_A) or {}).get("stage") == "spec"
          and (card(DUP_A) or {}).get("stage") == "backlog")

    prop_file = PROJ / ".acp" / "pm" / "proposals.md"
    ok_file = prop_file.exists()
    text = prop_file.read_text() if ok_file else ""
    check("apply: proposals.md written under the project",
          ok_file and "merge" in text and DUP_A[:8] in text,
          str(prop_file))
    check("apply: proposals.md states nothing was auto-applied",
          "never auto-applied" in text)

    # 4. audit ledger: one entry per applied change + proposals + run.
    entries = activity_entries()
    new = entries[before_entries:]
    applied_rows = [e for e in new
                    if e.get("kind") == "pm"
                    and (e.get("detail") or "").startswith("applied:")]
    proposed_rows = [e for e in new
                     if e.get("kind") == "pm"
                     and (e.get("detail") or "").startswith("proposed:")]
    run_rows = [e for e in new
                if e.get("kind") == "pm"
                and (e.get("detail") or "").startswith("run pmrun-e2e")]
    check("audit: one pm entry per applied change",
          len(applied_rows) == len(applied) and len(applied) > 0,
          f"{len(applied_rows)} rows vs {len(applied)} applied")
    check("audit: every applied change text lands in the ledger",
          all(any(a["change"] in (e.get("detail") or "")
                  for e in applied_rows) for a in applied))
    check("audit: pm entries carry role + session",
          all(e.get("role") == "pm" and e.get("sessionId") == "pmrun-e2e"
              for e in applied_rows + proposed_rows + run_rows)
          and bool(applied_rows))
    check("audit: three proposal rows",
          len(proposed_rows) == 3, f"{len(proposed_rows)}")
    check("audit: run summary lists all four finding classes",
          bool(run_rows) and all(
              cls in run_rows[0].get("detail", "")
              for cls in ("contradiction", "module_overlap",
                          "duplicate", "cycle")),
          (run_rows[0].get("detail") if run_rows else "no run row"))

    # 5. re-run is a no-op on the board.
    _, rev_before = get_doc("board.json")
    proc2 = pmgraph("apply", "--plan", str(PLAN),
                    "--project", PROJECT_LABEL,
                    "--project-path", str(PROJ),
                    "--session", "pmrun-e2e-rerun")
    out2 = json.loads(proc2.stdout)
    _, rev_after = get_doc("board.json")
    check("apply: rerun writes nothing (idempotent)",
          out2.get("boardWritten") is False and rev_after == rev_before
          and out2.get("applied") == [],
          f"rev {rev_before} -> {rev_after}, applied={len(out2.get('applied') or [])}")


def leg_failures():
    """Every rejected/broken run leaves the board doc byte-identical — and
    the ledger gains nothing (validation precedes every write)."""
    snap = board_file_bytes()
    entries_before = len(activity_entries())

    def leg(name, payload=None, raw=None):
        nonlocal snap, entries_before
        p = PLAN
        if raw is not None:
            p = WORK / "plan-bad.json"
            p.write_text(raw)
        else:
            write_plan(payload)
        proc = pmgraph("apply", "--plan", str(p),
                       "--project", PROJECT_LABEL,
                       "--project-path", str(PROJ),
                       "--session", f"pmrun-bad-{name}",
                       expect=None)
        check(f"failure[{name}]: exit non-zero", proc.returncode != 0,
              f"rc={proc.returncode} {proc.stderr.strip()[:120]}")
        check(f"failure[{name}]: board byte-identical",
              board_file_bytes() == snap)
        check(f"failure[{name}]: ledger untouched",
              len(activity_entries()) == entries_before)

    leg("malformed", raw="{ not json ]")
    leg("unsafe-op", payload={
        "findings": [], "proposals": [],
        "actions": [{"op": "move", "field": "dependsOn",
                     "from": DEP, "to": OV_A}]})
    leg("non-graph-field", payload={
        "findings": [], "proposals": [],
        "actions": [{"op": "link", "field": "stage",
                     "from": DEP, "to": OV_A}]})
    leg("cycle-closing", payload={
        "findings": [], "proposals": [],
        # OV_A -> DEP would close DEP -> OV_A -> DEP.
        "actions": [{"op": "link", "field": "dependsOn",
                     "from": OV_A, "to": DEP}]})
    leg("out-of-scope", payload={
        "findings": [], "proposals": [],
        "actions": [{"op": "unlink", "field": "dependsOn",
                     "from": FOREIGN, "to": OV_A}]})
    leg("unknown-card", payload={
        "findings": [], "proposals": [],
        "actions": [{"op": "link", "field": "conflictsWith",
                     "from": DEP, "to": "pm-nope-999"}]})
    leg("finding-out-of-scope", payload={
        "actions": [], "proposals": [],
        "findings": [{"class": "duplicate", "cards": [FOREIGN, OV_A],
                      "summary": "x", "evidence": "y"}]})

    # A valid plan whose diff is empty must also write nothing.
    write_plan({"project": PROJECT_LABEL, "findings": [], "proposals": [],
                "actions": []})
    proc = pmgraph("apply", "--plan", str(PLAN),
                   "--project", PROJECT_LABEL,
                   "--project-path", str(PROJ),
                   "--session", "pmrun-empty")
    check("empty plan: exit 0 but board byte-identical",
          proc.returncode == 0 and board_file_bytes() == snap)


def leg_ui():
    """The web panel on the test bundle (VITE_STATE_URL=:25909) shows the
    pm verdict — Links tab, applied/proposed split, card badge, drawer."""
    from playwright.sync_api import sync_playwright

    build = subprocess.run(
        ["npx", "vite", "build", "--mode", "web", "--outDir", str(DIST)],
        capture_output=True, text=True, timeout=300, cwd=ROOT,
        env={**os.environ, "VITE_STATE_URL": STATE_URL},
    )
    check("ui: test web bundle builds", build.returncode == 0,
          build.stderr.strip()[-200:] if build.returncode else "")
    if build.returncode != 0:
        return

    httpd = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(WEB_PORT), "--bind", "127.0.0.1"],
        cwd=str(DIST), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        check("ui: web server up", wait_port(WEB_PORT, 10))
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                ignore_https_errors=True,
                viewport={"width": 1440, "height": 900})
            page = context.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.goto(WEB_URL, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.click('button[aria-label="Board"]')
            page.wait_for_selector(".view-pane .tab-bar", timeout=5000)

            links_btn = page.locator('.tab-btn:text-is("Links")')
            check("ui: Links tab exists", links_btn.count() == 1)
            check("ui: Links badge counts problem cards",
                  links_btn.locator(".tab-count").inner_text() == "8",
                  links_btn.locator(".tab-count").inner_text())
            links_btn.click()

            page.wait_for_selector('[data-testid="pm-last-run"]', timeout=5000)
            check("ui: last run line shows the pm session",
                  "run pmrun-e2e" in page.locator(
                      '[data-testid="pm-last-run"]').inner_text(),
                  page.locator('[data-testid="pm-last-run"]').inner_text()[:80])
            check("ui: applied section lists ledger rows",
                  page.locator('[data-testid="pm-applied"] .lnk-row').count() > 0)
            proposals = page.locator('[data-testid="pm-proposals"]')
            check("ui: proposals section shows the merge proposal",
                  "merge" in proposals.inner_text())
            # The file arrives from the fs bridge asynchronously: wait for either
            # the content or the honest error instead of sampling one frame.
            file_or_error = page.locator(
                '[data-testid="pm-proposals-file"], '
                '[data-testid="pm-proposals-error"]')
            waited = 0
            while waited < 10000 and file_or_error.count() == 0:
                page.wait_for_timeout(250)
                waited += 250
            check("ui: proposals file or honest error rendered",
                  file_or_error.count() == 1,
                  f"after {waited}ms; section={proposals.inner_text()[:160]!r}")
            graph = page.locator('[data-testid="pm-graph"]')
            check("ui: graph section shows depends/conflicts rows",
                  "depends on" in graph.inner_text()
                  and "conflicts" in graph.inner_text())
            blocked = page.locator('[data-testid="pm-blocked"]')
            check("ui: blocked list names DEP and HUMAN",
                  DEP[:8] in blocked.inner_text()
                  and HUMAN[:8] in blocked.inner_text())

            # Card badge names the blocker; drawer relations navigate.
            page.click('.tab-btn:text-is("Tasks")')
            dep_card = page.locator(".board-card", has_text="Render the audit page")
            badge = dep_card.locator('[data-testid="card-blocked-badge"]')
            check("ui: card badge names the blocker",
                  badge.inner_text() == f"blocked by {OV_A[:8]}",
                  badge.inner_text())
            dep_card.click()
            page.wait_for_selector(".card-drawer", timeout=5000)
            rel = page.locator('[data-testid="card-relations"]')
            check("ui: drawer relations show depends-on + pm mark",
                  "depends on" in rel.inner_text()
                  and "pm: blocked" in rel.inner_text(),
                  rel.inner_text()[:120])
            rel.locator(".rel-chip", has_text=OV_A[:8]).first.click()
            page.wait_for_timeout(300)
            check("ui: relation chip navigates to the blocker card",
                  page.locator(".card-drawer .drawer-id").inner_text()
                  == OV_A[:8],
                  page.locator(".card-drawer .drawer-id").inner_text())

            page.keyboard.press("Escape")
            page.click('.tab-btn:text-is("Events")')
            page.wait_for_selector(".event-row", timeout=5000)
            check("ui: Events ledger shows pm rows",
                  page.locator(".event-row .kind", has_text="pm").count() > 0)
            check("ui: zero pageerror events", len(page_errors) == 0,
                  "; ".join(page_errors[:3]) if page_errors else "")
            browser.close()
    finally:
        httpd.terminate()
        try:
            httpd.wait(timeout=5)
        except subprocess.TimeoutExpired:
            httpd.kill()


def main():
    if not port_free(STATE_PORT):
        print(f"FAIL  port {STATE_PORT} is not free")
        sys.exit(1)
    if WORK.exists():
        shutil.rmtree(WORK)
    STATE_DATA.mkdir(parents=True)
    PROJ.mkdir(parents=True)

    state = subprocess.Popen(
        ["node", str(STATE_SERVER)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "PORT": str(STATE_PORT),
             "STATE_DIR": str(STATE_DATA)})
    try:
        check("state server up", wait_port(STATE_PORT, 10))
        seeded = seed_board()
        leg_scan()
        leg_apply(seeded)
        # UI before the failure legs so the "last run" line is the real
        # pmrun-e2e session; the failure legs write nothing anyway.
        leg_ui()
        leg_failures()
    finally:
        state.terminate()
        try:
            state.wait(timeout=5)
        except subprocess.TimeoutExpired:
            state.kill()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
