#!/usr/bin/env python3
"""u7_api_flow.py — real managed solo flow through the live ON stack.

Drives ONE short real run end-to-end over the actual HTTP surface + real
scheduler + real porch runtime + the real agent CLI:

    enable -> attach requirements -> approve (versionId+sha256)
    -> attach plan (with real `bash -c` check) -> approve -> save_preset
    -> start -> poll until awaiting_acceptance -> assert:
       one completed attempt per role with its own porchRunId;
       APPLIED backend/model/effort from the porch registry meta.json
         (what actually launched) for ALL THREE roles, plus the requested
         porch-config snapshot;
       every recorded artifact re-fetched over HTTP and byte-hashed
         against its recorded sha256/bytes;
       validation exact schema (status 'settled', checks 'done'/'pass'),
         check reports SHA-bound to their log artifacts, findings/verdicts
         docs SHA-bound to reviewer/checker attempt artifacts, the closed
         round binding decision+resultSha256+report ids;
       card-view workspace shape (id/status/runId/branch/owner), a real
         git worktree at-or-descended-from the recorded baseCommit, and
         the implemented bytes on disk;
    -> accept_result with WRONG hash (409 stale_result) then
       the verified resultSha256 -> succeeded.

Usage: u7_api_flow.py --cli pi|codex|devin   (one card, one CLI for all
three roles — the smallest honest per-backend proof; model comes from the
compat table, never silently substituted).

Isolated state only; fresh card id per invocation; every write re-proves
the marker. Exit 0 = all assertions held.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

PROJ_ID = "u7-proj-a"
PROJ_LABEL = "u7-a"
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
EXEC_DIR = Path("/home/hermes/.hermes/acp-ui-state-u7/execution")
WS_DIR = Path("/home/hermes/projects/.acp-workspaces-u7")

MODELS = {
    "pi": {"model": "zen-relay/muse-spark-1.3-contributor-free"},
    # codex: porch backend_contract.resolve_model_effort aliases the request
    # "gpt-5.6" -> "gpt-5.6-sol" at launch. meta.json records the APPLIED
    # (resolved) model — asserted via appliedModel — while the per-attempt
    # porch-config snapshot keeps pinning the requested "gpt-5.6".
    "codex": {"model": "gpt-5.6", "effort": "low",
              "appliedModel": "gpt-5.6-sol"},
    "devin": {"model": "swe-2-max"},
}
BACKENDS = {"pi": "pi-cli", "codex": "codex-cli", "devin": "devin-cli"}

TERMINAL = {"succeeded", "failed", "cancelled", "stopped", "blocked"}
FAILED = []


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {detail}", flush=True)
    if not cond:
        FAILED.append(f"{name}: {detail}")


def api(method, path, body=None, timeout=20.0):
    return H.http_json(method, f"{H.STATE_URL}{path}", body=body,
                       timeout=timeout)


def card_cmd(card_id, type_, payload=None, revision=None):
    H.verify_isolation()
    if revision is None:
        st, view = api("GET", f"/api/execution/cards/{card_id}")
        if st != 200 or not isinstance(view, dict):
            raise AssertionError(f"GET card -> {st}: {view}")
        revision = int(view["controlRevision"])
    body = {
        "commandId": f"u7flow:{uuid.uuid4().hex[:12]}",
        "type": type_,
        "payload": payload or {},
        "expectedControlRevision": revision,
    }
    return api("POST", f"/api/execution/cards/{card_id}/commands", body)


def seed_card(card_id):
    """Merge-fixture: project + card rows added to existing test state."""
    status, doc = H.get_doc("projects.json")
    data = doc.get("data") if status == 200 else \
        {"version": 1, "projects": []}
    rev = doc.get("rev") if status == 200 else 0
    projects = [p for p in data.get("projects", []) if p.get("id") != PROJ_ID]
    projects.append({"id": PROJ_ID, "name": PROJ_LABEL,
                     "path": str(SANDBOX / "proj-a"),
                     "createdAt": int(time.time() * 1000)})
    data = {**data, "projects": projects,
            "activeProjectId": data.get("activeProjectId") or PROJ_ID}
    st, _ = H.seed_doc("projects.json", data, rev=rev)
    assert st == 200, f"projects seed -> {st}"

    status, doc = H.get_doc("board.json")
    data = doc.get("data") if status == 200 else {"version": 2, "cards": []}
    rev = doc.get("rev") if status == 200 else 0
    now = int(time.time() * 1000)
    cards = [c for c in data.get("cards", []) if c.get("id") != card_id]
    cards.append({
        "id": card_id, "title": f"U7 managed {card_id.split('-')[2]} run",
        "description": "u7 api flow", "project": PROJ_LABEL, "agent": "",
        "priority": "normal", "acceptance": "", "verification": "",
        "links": [], "session": None, "blocked": False,
        "blockedReason": "", "cancelled": False, "touches": [],
        "dependsOn": [], "blocks": [], "conflictsWith": [],
        "stage": "backlog", "status": "todo", "order": 0,
        "createdAt": now, "updatedAt": now,
    })
    st, _ = H.seed_doc("board.json", {**data, "cards": cards}, rev=rev)
    assert st == 200, f"board seed -> {st}"


def flow(cli: str) -> None:
    member = {"cli": cli, **MODELS[cli]}
    card = f"u7-flow-{cli}-{uuid.uuid4().hex[:8]}"
    print(f"\n==== cli={cli} card={card} ====")
    H.verify_isolation()
    seed_card(card)

    st, body = card_cmd(card, "enable", revision=0)
    check("enable", st == 200 and body.get("ok"), f"{st} {body.get('error','')}")

    st, body = card_cmd(card, "attach_document", {
        "kind": "requirements",
        "source": {"type": "text", "text":
                   "# requirements\n"
                   "In main.py set the constant `VALUE` to `42` "
                   "(currently `VALUE = 1`). That is the whole change — "
                   "do not refactor, format, or commit anything else.\n"}})
    check("attach requirements", st == 200, f"{st} {body.get('error','')}")
    req = body.get("result") or {}
    st, body = card_cmd(card, "approve_requirements",
                        {"versionId": req["versionId"],
                         "sha256": req["sha256"], "by": "u7-api-flow"})
    check("approve requirements", st == 200, f"{st} {body.get('error','')}")

    st, body = card_cmd(card, "attach_document", {
        "kind": "plan",
        "source": {"type": "text",
                   "text": "# plan\n1. Edit main.py: VALUE = 42.\n"
                           "2. Run the check.\n"},
        "checks": [{"run": "python3 -c 'import main; assert main.VALUE == 42'",
                    "timeoutSec": 120}]})
    check("attach plan + check", st == 200, f"{st} {body.get('error','')}")
    plan = body.get("result") or {}
    check("plan bound to requirements version",
          (plan.get("requirementsBound") or {}).get("versionId")
          == req.get("versionId"))
    st, body = card_cmd(card, "approve_plan",
                        {"versionId": plan["versionId"],
                         "sha256": plan["sha256"], "by": "u7-api-flow"})
    check("approve plan", st == 200, f"{st} {body.get('error','')}")

    st, body = card_cmd(card, "save_preset", {"preset": {
        "name": f"u7-{cli}", "id": f"u7-preset-{cli}",
        "members": {"implementer": member, "reviewer": member,
                    "checker": member},
        "limits": {"maxAttemptsPerRole": 2, "timeoutMin": 12,
                   "maxReviewRounds": 1}}})
    check("save_preset", st == 200, f"{st} {body.get('error','')}")

    # Actual base commit of the source project — captured BEFORE start so
    # the run's recorded baseCommit is bound to a real git rev, not just
    # "a string of the right length".
    head = subprocess.run(
        ["git", "-C", str(SANDBOX / "proj-a"), "rev-parse", "HEAD"],
        capture_output=True, text=True)
    sandbox_head = head.stdout.strip() if head.returncode == 0 else None
    check("sandbox proj-a HEAD readable", isinstance(sandbox_head, str)
          and len(sandbox_head) == 40, f"HEAD={sandbox_head}")

    st, body = card_cmd(card, "start")
    check("start -> run queued", st == 200
          and (body.get("result") or {}).get("status") == "queued",
          f"{st} {body.get('error','')}")
    run_id = (body.get("result") or {}).get("runId")
    base_commit = (body.get("result") or {}).get("baseCommit")
    check("runId recorded + baseCommit bound to actual sandbox HEAD",
          isinstance(run_id, str) and base_commit == sandbox_head,
          f"runId={run_id} base={base_commit} sandbox={sandbox_head}")

    # ---- watch until the acceptance gate -----------------------------
    deadline = time.time() + 1200
    status, detail = "queued", {}
    last_phase = None
    while time.time() < deadline:
        st, run = api("GET", f"/api/execution/runs/{run_id}")
        if st != 200:
            time.sleep(2); continue
        status = run.get("status") or "?"
        phase = run.get("phase")
        if phase != last_phase:
            print(f"  … run {status}/{phase}", flush=True)
            last_phase = phase
        if status in TERMINAL or status == "awaiting_acceptance":
            detail = run
            break
        time.sleep(3)
    check(f"run reached awaiting_acceptance (got {status}/{last_phase})",
          status == "awaiting_acceptance")
    if status != "awaiting_acceptance":
        diag = detail.get("diagnostic") or {}
        print("  run detail:", json.dumps({
            "status": status, "phase": last_phase, "error": detail.get("error"),
            "diagnostic": diag, "attempts": [
                {k: a.get(k) for k in ("id", "role", "status", "error")}
                for a in (detail.get("attempts") or [])]}, indent=2)[:3000])
        return
    check("acceptance carries resultSha256",
          bool((detail.get("acceptance") or {}).get("resultSha256")))
    check("run record persists baseCommit == actual sandbox HEAD",
          detail.get("baseCommit") == sandbox_head,
          f"run.baseCommit={detail.get('baseCommit')}")

    # ---- evidence: attempts / roles -----------------------------------
    attempts = detail.get("attempts") or []
    by_role = {}
    for a in attempts:
        by_role.setdefault(a.get("role"), []).append(a)
    check("exactly one completed attempt per role",
          sorted(by_role) == ["checker", "implementer", "reviewer"]
          and all(len(v) == 1 for v in by_role.values()),
          f"n={len(attempts)} roles={sorted(by_role)}")
    check("every attempt completed, att-<runId>-<n> id, own porchRunId",
          all(re.match(r"^att-" + re.escape(run_id) + r"-\d+$",
                       a.get("id") or "")
              and a.get("status") == "completed"
              and isinstance(a.get("porchRunId"), str)
              for a in attempts)
          and len({a.get("porchRunId") for a in attempts}) == len(attempts),
          str([(a.get("id"), a.get("role"), a.get("status"))
               for a in attempts]))

    # ---- APPLIED backend/model — the actual porch registry record -----
    # <exec>/steer/runs/<porchRunId>/meta.json is the real launch metadata
    # porch-runtime status()/wait() parse; the porch-config snapshot only
    # proves what was REQUESTED. Verified for ALL THREE roles.
    steer = EXEC_DIR / "steer" / "runs"
    test_roots = (str(WS_DIR), str(EXEC_DIR), str(SANDBOX))
    want = MODELS[cli]
    for role in ("implementer", "reviewer", "checker"):
        att = by_role[role][0]
        meta_p = steer / att["porchRunId"] / "meta.json"
        try:
            meta = json.loads(meta_p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            check(f"{role}: applied run meta readable", False, str(e))
            continue
        check(f"{role}: applied backend/model/effort from run meta",
              meta.get("backend") == BACKENDS[cli]
              and meta.get("model") == (want.get("appliedModel")
                                        or want["model"])
              and (meta.get("effort") or "") == (want.get("effort") or ""),
              f"{meta.get('backend')}/{meta.get('model')}"
              f"/{meta.get('effort')!r}")
        check(f"{role}: meta bound to attempt profile + uid 1001",
              meta.get("run_id") == att["porchRunId"]
              and meta.get("agent_id") == f"acp-{role}"
              and meta.get("owner_uid") == 1001,
              f"agent_id={meta.get('agent_id')} uid={meta.get('owner_uid')}")
        check(f"{role}: meta cwd inside U7 test roots",
              isinstance(meta.get("cwd"), str)
              and meta["cwd"].startswith(test_roots),
              f"cwd={meta.get('cwd')}")

    # requested-side pinning — per-attempt porch config snapshot
    att = by_role["implementer"][0]
    cfg_path = EXEC_DIR / "attempts" / att["id"] / "porch-config.json"
    try:
        cfg = json.loads(cfg_path.read_text())
        agent = (cfg.get("agents") or {}).get("acp-implementer") or {}
        check("porch-config snapshot pins requested backend+model",
              agent.get("backend") == BACKENDS[cli]
              and agent.get("model") == want["model"],
              f"{agent.get('backend')}/{agent.get('model')}")
    except OSError as e:
        check("porch-config snapshot exists", False, str(e))

    # ---- artifacts: content/hash contract, not just HTTP 200 ----------
    arts = detail.get("artifacts") or {}
    check("artifacts recorded", len(arts) >= 1, f"n={len(arts)}")
    raw_by_aid = {}
    for aid, rec in sorted(arts.items()):
        s, b = api("GET", f"/api/execution/runs/{run_id}/artifacts/{aid}")
        raw = b""
        try:
            raw = base64.b64decode(b.get("contentBase64") or "")
        except Exception:
            pass
        ok = (s == 200 and b.get("runId") == run_id
              and b.get("artifactId") == aid
              and b.get("sha256") == rec.get("sha256")
              and b.get("bytes") == rec.get("bytes")
              and hashlib.sha256(raw).hexdigest() == rec.get("sha256")
              and len(raw) == rec.get("bytes"))
        if ok:
            raw_by_aid[aid] = raw
        check(f"artifact {aid} bytes hash-bound to served content",
              ok, f"kind={rec.get('kind')} sha={str(rec.get('sha256'))[:12]}…")

    # ---- validation: exact schema, SHA-bound reports ------------------
    val = detail.get("validation") or {}
    acc_sha = (detail.get("acceptance") or {}).get("resultSha256")
    check("validation.status == 'settled' (exact)",
          val.get("status") == "settled", f"got {val.get('status')!r}")
    vchecks = val.get("checks") or {}
    check("checks.status == 'done' and checks.verdict == 'pass' (exact)",
          vchecks.get("status") == "done" and vchecks.get("verdict") == "pass",
          f"status={vchecks.get('status')!r} verdict={vchecks.get('verdict')!r}")
    creports = vchecks.get("reports") or []
    check("one recorded check report per approved check",
          len(creports) == 1, f"n={len(creports)}")
    procs = val.get("procs") or {}
    for r in creports:
        i = r.get("index")
        bound = True
        for aid_key, sha_key in (("logOutArtifactId", "logSha256Out"),
                                 ("logErrArtifactId", "logSha256Err")):
            aid, sha = r.get(aid_key), r.get(sha_key)
            bound = bound and isinstance(aid, str) \
                and isinstance(sha, str) and len(sha) == 64 \
                and (arts.get(aid) or {}).get("sha256") == sha
        check(f"check[{i}] pass exit0 + log artifacts SHA-bound",
              r.get("status") == "pass" and r.get("exitCode") == 0 and bound)
        proc = procs.get(str(i)) or procs.get(i) or {}
        check(f"check[{i}] process group proven dead",
              proc.get("state") == "settled"
              and (proc.get("proof") or {}).get("groupDead") is True,
          f"proc.state={proc.get('state')!r}")

    check("recorded validation resultSha256 == acceptance resultSha256",
          val.get("resultSha256") == acc_sha,
          f"val={str(val.get('resultSha256'))[:12]}…")
    vrep = val.get("reports") or {}
    fnd, vrd = vrep.get("findings") or {}, vrep.get("verdicts") or {}
    rev_att = by_role["reviewer"][0]["id"]
    chk_att = by_role["checker"][0]["id"]
    check("findings report SHA-bound to reviewer attempt artifact",
          fnd.get("attemptId") == rev_att
          and isinstance(fnd.get("artifactId"), str)
          and (arts.get(fnd.get("artifactId")) or {}).get("sha256")
          == fnd.get("artifactSha256"),
          f"artifactId={fnd.get('artifactId')}")
    check("verdicts report SHA-bound to checker attempt artifact",
          vrd.get("attemptId") == chk_att
          and isinstance(vrd.get("artifactId"), str)
          and (arts.get(vrd.get("artifactId")) or {}).get("sha256")
          == vrd.get("artifactSha256"),
          f"artifactId={vrd.get('artifactId')}")
    # Normalized docs are parseFindingsDoc/parseVerdictDoc outputs —
    # {version, round, findings|verdicts}; top-level resultSha256 lives on
    # the RAW artifact bytes the agent wrote (prompt contract), not on the
    # normalized record. Verify both sides.
    check("findings normalized doc: version 1 + round + findings[]",
          (fnd.get("doc") or {}).get("version") == 1
          and (fnd.get("doc") or {}).get("round") == val.get("round")
          and isinstance((fnd.get("doc") or {}).get("findings"), list),
          f"doc.round={(fnd.get('doc') or {}).get('round')}")
    check("verdicts normalized doc: version 1 + round + verdicts[]",
          (vrd.get("doc") or {}).get("version") == 1
          and (vrd.get("doc") or {}).get("round") == val.get("round")
          and isinstance((vrd.get("doc") or {}).get("verdicts"), list),
          f"doc.round={(vrd.get('doc') or {}).get('round')}")
    for label, rep in (("findings", fnd), ("verdicts", vrd)):
        raw = raw_by_aid.get(rep.get("artifactId"))
        doc = None
        try:
            doc = json.loads(raw) if raw else None
        except (json.JSONDecodeError, TypeError):
            pass
        check(f"{label} RAW artifact binds round + resultSha256",
              isinstance(doc, dict) and doc.get("round") == val.get("round")
              and doc.get("resultSha256") == acc_sha,
              f"raw round={doc and doc.get('round')} "
              f"sha={doc and str(doc.get('resultSha256'))[:12]}")
    rounds = detail.get("rounds") or []
    last = rounds[-1] if rounds else {}
    check("closed round binds decision + resultSha + report ids",
          last.get("decision") == "awaiting_acceptance"
          and last.get("resultSha256") == acc_sha
          and last.get("checksVerdict") == "pass"
          and last.get("findingsArtifactId") == fnd.get("artifactId")
          and last.get("verdictsArtifactId") == vrd.get("artifactId")
          and last.get("findingsAttemptId") == rev_att
          and last.get("verdictsAttemptId") == chk_att,
          json.dumps({k: last.get(k)
                      for k in ("decision", "checksVerdict", "round")}))

    # ---- workspace view == state-service cardView shape + real git ----
    wsid = detail.get("workspaceId")
    st, view = api("GET", f"/api/execution/cards/{card}")
    check("run.workspaceId set + card view reachable",
          isinstance(wsid, str) and st == 200, f"wsid={wsid} st={st}")
    ws = ((view.get("workspaces") or {}).get(wsid)) or {}
    check("workspace view: id/status/runId/branch/path under WS_DIR",
          ws.get("id") == wsid and ws.get("status") == "ready"
          and ws.get("runId") == run_id
          and isinstance(ws.get("branch"), str) and bool(ws.get("branch"))
          and isinstance(ws.get("path"), str)
          and ws["path"].startswith(str(WS_DIR) + "/"),
          json.dumps({k: ws.get(k)
                      for k in ("id", "status", "runId", "branch", "path")}))
    owner = ws.get("owner")
    env_key = owner.get("envKey") if isinstance(owner, dict) else None
    check("workspace owner identity shape (runnerId/pid/ns)",
          owner is None or (
              owner.get("runnerId") == "host-runner"
              and isinstance(owner.get("instanceId"), str)
              and isinstance(owner.get("pid"), int)
              and isinstance(owner.get("pidStarttime"), str)
              and isinstance(env_key, dict)
              and env_key.get("uid") == 1001
              and isinstance(env_key.get("pidNs"), str)
              and isinstance(env_key.get("bootId"), str)),
          f"owner={owner}")
    wpath = ws.get("path")
    ok = False
    if wpath:
        f = Path(wpath) / "main.py"
        ok = f.exists() and "VALUE = 42" in f.read_text()
    check("workspace on disk contains the implemented change",
          ok, f"path={wpath}")
    if wpath:
        # Real isolated git worktree bound to the recorded baseCommit —
        # the change may legitimately sit dirty/uncommitted (the task says
        # commit nothing else; the result snapshot captures dirty/new/
        # deleted vs. base). HEAD equal-to-or-descended-from base is the
        # contract, never "must have committed".
        head = subprocess.run(
            ["git", "-C", wpath, "rev-parse", "HEAD"],
            capture_output=True, text=True)
        anc = subprocess.run(
            ["git", "-C", wpath, "merge-base", "--is-ancestor",
             base_commit, "HEAD"], capture_output=True)
        check("real git worktree; HEAD at-or-descended-from baseCommit",
              head.returncode == 0 and anc.returncode == 0,
              f"HEAD={head.stdout.strip()[:12]} base={base_commit[:12]}")

    # ---- events cursor paging — bounded, strict nextCursor ------------
    seen, cursor, pages = [], 0, 0
    MAX_PAGES = 40                       # hard bound — no unbounded paging
    while pages < MAX_PAGES:
        s, ev = api("GET", f"/api/execution/runs/{run_id}/events"
                          f"?cursor={cursor}&limit=50")
        if s != 200:
            break
        items = ev.get("events") or []
        seen.extend(items)
        pages += 1
        nxt = ev.get("nextCursor")
        if not items or nxt is None:
            break
        if not isinstance(nxt, int) or nxt <= cursor:
            check("nextCursor strictly increases", False,
                  f"cursor={cursor} next={nxt}")
            break
        cursor = nxt
    seqs = [e.get("seq") for e in seen if isinstance(e.get("seq"), int)]
    check("events page monotonic via cursor (bounded)",
          1 <= pages < MAX_PAGES and seqs == sorted(seqs)
          and len(seqs) == len(set(seqs)),
          f"events={len(seen)} pages={pages}")

    # ---- acceptance: wrong hash -> 409, real hash -> 200 ---------------
    st, body = card_cmd(card, "accept_result",
                        {"runId": run_id, "resultSha256": "f" * 64})
    check("wrong resultSha256 -> 409 stale_result",
          st == 409 and body.get("code") == "stale_result",
          f"{st} {body.get('code')}")
    st, body = card_cmd(card, "accept_result",
                        {"runId": run_id,
                         "resultSha256": detail["acceptance"]["resultSha256"]})
    check("accept_result verified sha -> succeeded",
          st == 200 and (body.get("result") or {}).get("status") == "succeeded",
          f"{st} {body.get('error','')}")
    st, view = api("GET", f"/api/execution/cards/{card}")
    check("card view shows succeeded run",
          any(r.get("id") == run_id and r.get("status") == "succeeded"
              for r in view.get("runs", [])))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True, choices=sorted(MODELS))
    args = ap.parse_args()
    try:
        H.verify_isolation()
    except H.HarnessError as e:
        print(f"FAIL  isolation: {e}")
        return 1
    flow(args.cli)
    print(f"\n{'ALL PASS' if not FAILED else 'FAILURES: ' + '; '.join(FAILED)}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
