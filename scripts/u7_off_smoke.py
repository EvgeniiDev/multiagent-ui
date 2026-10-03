#!/usr/bin/env python3
"""u7_off_smoke.py — OFF-phase proof on the transitioned isolated stack.

Over real HTTP against the isolated state service (fixed 25900), after
seeding ONLY its own fixture docs (fresh test state 404s otherwise):

  1. default-OFF gate: `start`, `continue` -> 501 gate=ACP_EXEC_START;
     `accept_result` -> 501 gate=ACP_EXEC_VALIDATION. Gate responses are
     only reachable PAST the CAS check, so every command carries the real
     expectedControlRevision read from GET /api/execution/cards/:id.
  2. non-launch-gated commands work while OFF: enable, attach_document
     (requirements + plan with {run,cwd,timeoutSec} checks),
     approve_requirements, approve_plan, save_preset.
  3. no launch while OFF: cardView.runs stays empty — approval alone
     never spawns; only the flag stands between approval and an agent.
  4. legacy surface: /api/state/{board,claims}.json shape,
     /api/porch/runs returns the REAL external registry through the new
     read-only steer mount (pre-transition deployment returned [] —
     recorded as a regression boundary, not silently claimed).
  5. marker nonce byte-identical disk<->HTTP.

Never touches a live card or the production ops/registry dirs.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

CARD = f"u7-card-off-{uuid.uuid4().hex[:8]}"   # rerunnable: fresh id each run
PROJ_ID = "u7-proj-a"
PROJ_LABEL = "u7-a"                     # resolves by name (real-card shape)
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
FAILED = []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print(f"{tag}  {name} {detail}", flush=True)
    if not cond:
        FAILED.append(f"{name}: {detail}")


def get_card(card_id):
    """cardView from the real GET route — 404 -> None."""
    status, body = H.http_json(
        "GET", f"{H.STATE_URL}/api/execution/cards/{card_id}")
    return body if status == 200 else None


def control_revision(card_id):
    view = get_card(card_id)
    if not isinstance(view, dict) or "controlRevision" not in view:
        raise AssertionError(
            f"card view for {card_id} missing controlRevision: {view}")
    return int(view["controlRevision"])


def cmd(card_id, type_, payload=None, revision=None):
    """User-channel command with a fresh isolation proof and the REAL
    current controlRevision (enable is pre-aggregate -> sends 0)."""
    H.verify_isolation()
    if revision is None:
        revision = control_revision(card_id)
    body = {
        "commandId": f"u7off:{uuid.uuid4().hex[:12]}",
        "type": type_,
        "payload": payload or {},
        "expectedControlRevision": revision,
    }
    req = urllib.request.Request(
        f"{H.STATE_URL}/api/execution/cards/{card_id}/commands",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def put_doc_merged(name, mutate):
    """Read-modify-write with real rev CAS: fetch current doc (404 -> None),
    mutate ONLY the fixture's own keys, PUT back at the current rev.
    Existing cards/projects/managed rows are never deleted."""
    status, doc = H.get_doc(name)
    if status == 404:
        cur_data, rev = None, 0          # CAS asserts "must not exist"
    elif status == 200:
        cur_data, rev = doc.get("data"), doc.get("rev")
    else:
        raise AssertionError(f"GET {name} -> {status}: {doc}")
    data = mutate(cur_data)
    status, body = H.seed_doc(name, data, rev=rev)
    return status, body


def seed_fixture() -> None:
    """Isolated fixture rows only — merged into whatever test state the
    persistent dir already holds; managed cards/claims are never dropped."""
    # claims.json: create only when absent — never wipe recorded attempts.
    status, _ = H.get_doc("claims.json")
    if status == 404:
        status, _ = H.seed_doc("claims.json", {"claims": {}, "attempts": {}})
    check("claims.json present", status == 200, f"{status}")

    def add_project(data):
        data = data or {"version": 1, "projects": []}
        projects = [p for p in data.get("projects", [])
                    if p.get("id") != PROJ_ID]
        projects.append({
            "id": PROJ_ID, "name": PROJ_LABEL,
            "path": str(SANDBOX / "proj-a"),
            "createdAt": int(time.time() * 1000),
        })
        return {**data, "projects": projects,
                "activeProjectId": data.get("activeProjectId") or PROJ_ID}

    status, _ = put_doc_merged("projects.json", add_project)
    check("merge projects.json", status == 200, f"{status}")

    now = int(time.time() * 1000)

    def add_card(data):
        data = data or {"version": 2, "cards": []}
        cards = [c for c in data.get("cards", []) if c.get("id") != CARD]
        cards.append({
            "id": CARD, "title": "U7 OFF gate card",
            "description": "off-phase fixture", "project": PROJ_LABEL,
            "agent": "", "priority": "normal", "acceptance": "",
            "verification": "", "links": [], "session": None,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [],
            "conflictsWith": [], "stage": "backlog", "status": "todo",
            "order": 0, "createdAt": now, "updatedAt": now,
        })
        return {**data, "cards": cards}

    status, _ = put_doc_merged("board.json", add_card)
    check("merge board.json", status == 200, f"{status}")


def main() -> int:
    print("== u7_off_smoke: isolation ==")
    try:
        H.verify_isolation()
        check("isolation marker+dir", True)
    except H.HarnessError as e:
        check("isolation marker+dir", False, str(e))
        print("\nFAILURES:", "; ".join(FAILED))
        return 1
    disk_nonce = H.expected_marker()["nonce"]
    status, marker = H.http_json(
        "GET", f"{H.STATE_URL}/api/state/{H.MARKER_DOC}")
    check("marker nonce disk==HTTP",
          status == 200
          and (marker.get("data") or {}).get("nonce") == disk_nonce,
          f"status={status}")

    print("== legacy surface ==")
    h_status, h = H.http_json("GET", f"{H.STATE_URL}/health")
    check("health dir is isolated",
          h_status == 200 and h.get("dir") == str(H.TEST_STATE_DIR),
          h.get("dir"))

    seed_fixture()

    status, board = H.http_json("GET", f"{H.STATE_URL}/api/state/board.json")
    check("board.json legacy shape",
          status == 200 and board.get("name") == "board.json"
          and isinstance(board.get("data"), dict)
          and any(c.get("id") == CARD
                  for c in board["data"].get("cards", [])))
    status, claims = H.http_json("GET", f"{H.STATE_URL}/api/state/claims.json")
    check("claims.json legacy shape",
          status == 200 and isinstance(claims.get("data"), dict))
    status, runs = H.http_json("GET", f"{H.STATE_URL}/api/porch/runs")
    n = len((runs or {}).get("runs") or [])
    check("external porch runs visible via ro steer mount",
          status == 200 and n >= 1,
          f"runs={n} (pre-transition deployment returned 0)")
    check("external runs carry no managed fields",
          all("managed" not in (r or {}) and "porchRunId" not in (r or {})
              for r in (runs.get("runs") or [])[:50]))

    print("== OFF gate ==")
    st, body = cmd(CARD, "enable", revision=0)
    check("enable ok (not launch-gated)",
          st == 200 and body.get("ok") is True,
          f"status={st} {body.get('error', '')}")
    check("cardView now managed with controlRevision 1",
          (get_card(CARD) or {}).get("controlRevision") == 1)

    st, body = cmd(CARD, "start")
    check("start gated 501/ACP_EXEC_START",
          st == 501 and body.get("gate") == "ACP_EXEC_START",
          f"{st} {body.get('code')} gate={body.get('gate')}")
    st, body = cmd(CARD, "continue")
    check("continue gated 501/ACP_EXEC_START",
          st == 501 and body.get("gate") == "ACP_EXEC_START",
          f"{st} {body.get('code')}")
    st, body = cmd(CARD, "accept_result",
                   {"runId": "run_none", "resultSha256": "0" * 64})
    check("accept_result gated 501/ACP_EXEC_VALIDATION",
          st == 501 and body.get("gate") == "ACP_EXEC_VALIDATION",
          f"{st} {body.get('code')}")
    # CAS actually enforced: a stale revision must 409, not slip through.
    st, body = cmd(CARD, "start", revision=0)
    check("stale expectedControlRevision -> 409 revision_conflict",
          st == 409 and body.get("code") == "revision_conflict",
          f"{st} {body.get('code')}")

    print("== setup commands work while OFF ==")
    st, body = cmd(CARD, "attach_document", {
        "kind": "requirements",
        "source": {"type": "text",
                   "text": "# requirements\nset VALUE = 42 in main.py\n"}})
    check("attach requirements", st == 200, f"{st} {body.get('error','')}")
    req_v = (body.get("result") or {})
    check("attach returns versionId+sha256",
          isinstance(req_v.get("versionId"), str)
          and isinstance(req_v.get("sha256"), str)
          and len(req_v.get("sha256", "")) == 64)
    st, body = cmd(CARD, "approve_requirements", {
        "versionId": req_v.get("versionId"),
        "sha256": req_v.get("sha256"), "by": "u7-off-smoke"})
    check("approve requirements", st == 200,
          f"{st} {body.get('error','')}")
    st, body = cmd(CARD, "attach_document", {
        "kind": "plan",
        "source": {"type": "text", "text": "# plan\n- edit main.py\n"},
        "checks": [{"run": "python3 -c 'import main; assert main.VALUE == 42'",
                    "timeoutSec": 30}]})
    check("attach plan w/ real checks shape", st == 200,
          f"{st} {body.get('error','')}")
    plan_v = (body.get("result") or {})
    check("plan bound to requirements version",
          (plan_v.get("requirementsBound") or {}).get("versionId")
          == req_v.get("versionId"))
    st, body = cmd(CARD, "approve_plan", {
        "versionId": plan_v.get("versionId"),
        "sha256": plan_v.get("sha256"), "by": "u7-off-smoke"})
    check("approve plan", st == 200, f"{st} {body.get('error','')}")
    st, body = cmd(CARD, "save_preset", {"preset": {
        "name": "u7-off-pi", "id": "u7-preset-off",
        "members": {
            "implementer": {"cli": "pi",
                            "model": "zen-relay/muse-spark-1.3-contributor-free"},
            "reviewer": {"cli": "pi",
                         "model": "zen-relay/muse-spark-1.3-contributor-free"},
            "checker": {"cli": "pi",
                        "model": "zen-relay/muse-spark-1.3-contributor-free"}},
        "limits": {"maxAttemptsPerRole": 1, "timeoutMin": 10,
                   "maxReviewRounds": 1}}})
    check("save_preset accepted", st == 200,
          f"{st} {body.get('error','')}")
    check("composition snapshot bound to card",
          (get_card(CARD) or {}).get("composition", {})
          .get("presetId") == "u7-preset-off")

    print("== no launch while OFF ==")
    st, body = cmd(CARD, "start")
    check("start still 501 after full approval+preset",
          st == 501 and body.get("gate") == "ACP_EXEC_START", f"{st}")
    view = get_card(CARD)
    check("cardView shape has runs array",
          isinstance(view, dict) and isinstance(view.get("runs"), list))
    check("zero runs exist (approval never launches)",
          view["runs"] == [], f"runs={view['runs']}")
    check("runner has no live children",
          H.only_service_process("runner", "acp-runner.mjs"),
          "docker top shows acp-runner only")

    print(f"\n{'ALL PASS' if not FAILED else 'FAILURES: ' + '; '.join(FAILED)}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
