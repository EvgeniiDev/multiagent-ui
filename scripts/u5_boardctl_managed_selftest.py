#!/usr/bin/env python3
"""u5_boardctl_managed_selftest.py — U5 boardctl managed-surface tests.

Imports the real `scripts/boardctl` module and drives `main(argv)` with the
HTTP layer stubbed — `_request` serves board/claims docs, `_exec_request`
records and answers the /api/execution routes. Asserts:

  * `review <managed>` reads the card view + run record through
    /api/execution and renders the run's verified evidence — never touches
    .acp/cards files;
  * every file-write review flag (--round/--close/--sync) and review-check
    are refused on managed cards BEFORE any request is made;
  * `accept` binds the exact recorded runId + resultSha256 through the
    user-channel command POST, retries revision_conflict with a fresh
    revision, and refuses a non-awaiting run without posting;
  * `stop` posts the never-gated stop command;
  * move/claim/rm/flag/set --stage are refused on managed rows;
  * legacy paths (review-check file write, move, set) still work —
    no managed card regressions;
  * no internal token / offline managed state: the module must not read
    BOARD_STATE_DIR/STATE_DIR nor send the internal token header.

Run: python3 scripts/u5_boardctl_managed_selftest.py
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
loader = importlib.machinery.SourceFileLoader(
    "boardctl", os.path.join(ROOT, "scripts", "boardctl"))
spec = importlib.util.spec_from_loader("boardctl", loader)
bc = importlib.util.module_from_spec(spec)
loader.exec_module(bc)

RESULT_SHA = "ab" * 32
CARD = {
    "id": "cardm00000000000000000000001",
    "title": "managed card",
    "stage": "reviewtest",
    "status": "agent_tested",
    "project": "proj",
    "execution": {"managed": True, "runId": "run-1", "runStatus": "awaiting_acceptance"},
}
LEGACY = {
    "id": "legacy00000000000000000000002",
    "title": "legacy card",
    "stage": "reviewtest",
    "status": "in_progress",
    "project": "proj",
}
CARD_VIEW = {
    "cardId": CARD["id"], "managed": True, "controlRevision": 7,
    "currentRunId": "run-1",
    "projection": {"stage": "reviewtest", "status": "agent_tested"},
}
RUN = {
    "id": "run-1", "status": "awaiting_acceptance",
    "validation": {
        "id": "val-1", "round": 1, "status": "settled", "phase": "done",
        "resultSha256": RESULT_SHA,
        "checks": {"status": "done", "verdict": "pass",
                   "reports": [{"index": 0, "status": "pass", "exitCode": 0}]},
        "reports": {
            "findings": {"doc": {"version": 1, "round": 1, "findings": [
                {"id": "f1", "round": 1, "severity": "major",
                 "status": "closed", "text": "naming", "where": "a.ts:1"}]}},
            "verdicts": {"doc": {"version": 1, "verdicts": [
                {"findingId": "f1", "verdict": "confirmed",
                 "checker": "checker-1"}]}},
        },
        "decision": {"outcome": "accept"},
    },
    "acceptance": {"resultSha256": RESULT_SHA},
}


class Transport:
    """Stubbed HTTP layer: serves /api/state docs + /api/execution views and
    records every call. `script` maps (method, path-prefix) → queue of
    (status, payload)."""
    def __init__(self, board_cards=None, script=None):
        self.calls = []          # (method, path, body)
        self.exec_calls = []     # (method, exec_path, body)
        self.board = {"version": 2, "cards": board_cards or []}
        self.script = dict(script or {})
        self.puts = []

    def request(self, path, method="GET", body=None):
        self.calls.append((method, path, body))
        if path == "/api/state/board.json" and method == "GET":
            return {"data": self.board, "rev": 1}
        if path == "/api/state/claims.json" and method == "GET":
            return {"data": {"version": 1, "claims": {}}, "rev": 1}
        if path == "/api/state/activity.json" and method == "GET":
            return {"data": {"entries": [], "usage": []}, "rev": 1}
        if path == "/api/state/roles.json" and method == "GET":
            return {"data": {"version": 1, "roles": [], "stageRoles": {}}, "rev": 1}
        if path == "/api/state/projects.json" and method == "GET":
            return {"data": {"version": 1, "projects": []}, "rev": 1}
        if method == "PUT":
            self.puts.append((path, body))
            if path == "/api/state/board.json":
                self.board = body["data"]
            return {"rev": body["rev"] + 1}
        return {"data": {}, "rev": 0}

    def exec_request(self, path, method="GET", body=None):
        self.exec_calls.append((method, path, body))
        for key in list(self.script):
            m, prefix = key.split(" ", 1)
            if method == m and path.startswith(prefix):
                q = self.script[key]
                out = q.pop(0) if isinstance(q, list) else q
                if not q:
                    self.script.pop(key)
                return out
        # default fixtures
        if method == "GET" and path == f"/cards/{CARD['id']}":
            return 200, dict(CARD_VIEW)
        if method == "GET" and path == "/runs/run-1":
            return 200, json.loads(json.dumps(RUN))
        if method == "POST" and path.endswith("/commands"):
            return 200, {"ok": True, "result": {"status": "succeeded"}}
        return 404, {"error": "not found", "code": "not_found"}


results = []


def run_cli(argv, t):
    """Drive the REAL cli surface: patched transport, captured stdio."""
    bc._request = t.request
    bc._exec_request = t.exec_request
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = bc.main(argv)
    return code, out.getvalue(), err.getvalue()


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"PASS {name}")
    except Exception as e:  # noqa: BLE001
        results.append((name, False, e))
        print(f"FAIL {name}: {e}")


def expect(cond, msg):
    if not cond:
        raise AssertionError(msg)


# --- managed read view ------------------------------------------------------

def t_review_view():
    t = Transport(board_cards=[CARD])
    # Prove the file layer is never consulted.
    real_loader = bc._load_review_doc
    bc._load_review_doc = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("file review path touched on a managed card"))
    try:
        code, out, err = run_cli(["review", CARD["id"][:8]], t)
    finally:
        bc._load_review_doc = real_loader
    expect(code == 0, f"exit {code}: {err}")
    expect(("GET", f"/cards/{CARD['id']}", None) in t.exec_calls,
           "card view not fetched")
    expect(("GET", "/runs/run-1", None) in t.exec_calls, "run not fetched")
    expect("checks: done pass" in out, out)
    expect("f1" in out and "confirmed" in out, out)
    expect(RESULT_SHA[:16] in out, out)


def t_review_json_mode():
    t = Transport(board_cards=[CARD])
    code, out, _ = run_cli(["--json", "review", CARD["id"][:8]], t)
    expect(code == 0, "exit")
    p = json.loads(out)
    expect(p["managed"] is True and p["run"] == "run-1", p)
    expect(p["validation"]["checks"]["verdict"] == "pass", p)
    expect(p["acceptance"]["resultSha256"] == RESULT_SHA, p)


def t_review_writes_refused():
    for extra in (["--round", "2"], ["--close", "f1"], ["--sync"]):
        t = Transport(board_cards=[CARD])
        code, _, err = run_cli(["review", CARD["id"][:8], *extra], t)
        expect(code == 1, f"{extra} exit {code}")
        expect("managed" in err and "immutable" in err, err)
        expect(not t.exec_calls, f"{extra} touched the API: {t.exec_calls}")
        expect(not t.puts, f"{extra} wrote board state")


def t_review_check_refused():
    t = Transport(board_cards=[CARD])
    code, _, err = run_cli(
        ["review-check", CARD["id"][:8], "f1", "rejected"], t)
    expect(code == 1, f"exit {code}")
    expect("verdict" in err and "managed" in err, err)
    expect(not t.exec_calls and not t.puts, "a refused verdict wrote anything")


# --- accept / stop ----------------------------------------------------------

def t_accept_posts_bound_command():
    t = Transport(board_cards=[CARD])
    code, out, err = run_cli(["accept", CARD["id"][:8]], t)
    expect(code == 0, f"exit {code}: {err}")
    posts = [b for m, p, b in t.exec_calls if m == "POST" and p.endswith("/commands")]
    expect(len(posts) == 1, f"expected 1 command POST: {t.exec_calls}")
    body = posts[0]
    expect(body["type"] == "accept_result", body)
    expect(body["expectedControlRevision"] == 7, body)
    expect(body["payload"] == {"runId": "run-1", "resultSha256": RESULT_SHA},
           "accept must bind the recorded run + verified hash")
    expect("commandId" in body and body["commandId"].startswith("bc-"), body)


def t_accept_retries_revision_conflict():
    # View consumption order: cmd_accept's own GET (rev7), _exec_command's
    # fresh GET (rev7 → first POST at 7 conflicts), retry GET (rev8).
    views = [
        (200, dict(CARD_VIEW)),
        (200, dict(CARD_VIEW)),
        (200, dict(CARD_VIEW, controlRevision=8)),
    ]
    t = Transport(board_cards=[CARD], script={
        f"GET /cards/{CARD['id']}": views,
        f"POST /cards/{CARD['id']}/commands": [
            (409, {"error": "rev", "code": "revision_conflict",
                   "controlRevision": 8}),
            (200, {"ok": True, "result": {"status": "succeeded"}}),
        ],
    })
    code, out, err = run_cli(["accept", CARD["id"][:8]], t)
    expect(code == 0, f"exit {code}: {err}")
    posts = [b for m, p, b in t.exec_calls if m == "POST"]
    expect(len(posts) == 2, posts)
    expect(posts[0]["expectedControlRevision"] == 7
           and posts[1]["expectedControlRevision"] == 8, posts)
    expect(posts[0]["commandId"] != posts[1]["commandId"],
           "a retried command must carry a fresh commandId")


def t_accept_refuses_non_awaiting():
    t = Transport(board_cards=[CARD], script={
        "GET /runs/run-1": (200, dict(RUN, status="running",
                                      acceptance=None)),
    })
    code, _, err = run_cli(["accept", CARD["id"][:8]], t)
    expect(code == 1, f"exit {code}")
    expect("awaiting_acceptance" in err, err)
    expect(not [c for c in t.exec_calls if c[0] == "POST"],
           "no command POST for a non-awaiting run")


def t_accept_refuses_legacy_card():
    t = Transport(board_cards=[LEGACY])
    code, _, err = run_cli(["accept", LEGACY["id"][:8]], t)
    expect(code == 1, f"exit {code}")
    expect("not managed" in err and "reviewtest accepted" in err, err)
    expect(not t.exec_calls, "no exec API touched for a legacy card")


def t_stop_posts_command():
    t = Transport(board_cards=[CARD], script={
        f"POST /cards/{CARD['id']}/commands":
            (200, {"ok": True, "result": {"status": "stopping",
                                          "stoppedRuns": ["run-1"]}}),
    })
    code, out, err = run_cli(["stop", CARD["id"][:8], "--reason", "test"], t)
    expect(code == 0, f"exit {code}: {err}")
    posts = [b for m, p, b in t.exec_calls if m == "POST"]
    expect(len(posts) == 1 and posts[0]["type"] == "stop", posts)
    expect(posts[0]["payload"]["reason"] == "test", posts)


def t_stop_refuses_legacy():
    t = Transport(board_cards=[LEGACY])
    code, _, err = run_cli(["stop", LEGACY["id"][:8]], t)
    expect(code == 1, f"exit {code}")
    expect("acp-runner" in err, err)


# --- lifecycle-owned refusals -----------------------------------------------

def t_lifecycle_refusals():
    for argv, frag in (
        (["move", CARD["id"][:8], "dev"], "lifecycle"),
        (["claim", CARD["id"][:8]], "claim"),
        (["rm", CARD["id"][:8], "--force"], "delete"),
        (["block", CARD["id"][:8]], "flag"),
        (["set", CARD["id"][:8], "--status", "accepted"], "stage/status"),
    ):
        t = Transport(board_cards=[CARD])
        code, _, err = run_cli(argv, t)
        expect(code == 1, f"{argv} exit {code}")
        expect("managed" in err and "boardctl" in err, f"{argv}: {err}")
        expect(not t.puts and not any(
            c[0] == "PUT" for c in t.calls), f"{argv} wrote")
        expect(not t.exec_calls, f"{argv} hit exec API")


def t_set_nonlifecycle_field_allowed():
    """`set --title` on a managed row writes board.json — the server keeps
    user fields and overlays only the projection."""
    t = Transport(board_cards=[CARD])
    code, _, err = run_cli(["set", CARD["id"][:8], "--title", "new"], t)
    expect(code == 0, f"exit {code}: {err}")
    bput = [p for p in t.puts if p[0] == "/api/state/board.json"]
    expect(bput and bput[-1][1]["data"]["cards"][0]["title"] == "new",
           "title write did not reach board.json")


# --- legacy regressions -----------------------------------------------------

def t_legacy_review_check_still_writes_file():
    with tempfile.TemporaryDirectory() as tmp:
        card = dict(LEGACY)
        cdir = os.path.join(tmp, ".acp", "cards", card["id"])
        os.makedirs(cdir)
        with open(os.path.join(cdir, "review_findings.json"), "w") as fh:
            json.dump({"version": 1, "round": 1, "findings": [
                {"id": "f1", "round": 1, "severity": "major",
                 "status": "open", "text": "x", "where": "a:1"}]}, fh)
        t = Transport(board_cards=[card])
        code, out, err = run_cli(
            ["review-check", card["id"][:8], "f1", "confirmed",
             "--reason", "ok", "--project-path", tmp], t)
        expect(code == 0, f"exit {code}: {err}")
        vf = os.path.join(cdir, "review_verdict.json")
        with open(vf) as fh:
            vdoc = json.load(fh)
        expect(vdoc["verdicts"][-1]["verdict"] == "confirmed", vdoc)


def t_legacy_move_still_works():
    t = Transport(board_cards=[dict(LEGACY)])
    code, out, err = run_cli(["move", LEGACY["id"][:8], "dev", "review"], t)
    expect(code == 0, f"exit {code}: {err}")
    bput = [p for p in t.puts if p[0] == "/api/state/board.json"]
    expect(bput and bput[-1][1]["data"]["cards"][0]["stage"] == "dev",
           "legacy move did not land")


def t_managed_unknown_card_fails_closed():
    t = Transport(board_cards=[CARD], script={
        f"GET /cards/{CARD['id']}": (404, {"error": "x", "code": "card_not_found"}),
    })
    code, _, err = run_cli(["review", CARD["id"][:8]], t)
    expect(code == 2, f"exit {code}: {err}")
    expect("managed" in err, err)


def t_no_offline_state_or_tokens():
    """Module source must never reference an offline managed store or the
    internal token header — user-channel API only."""
    src = open(os.path.join(ROOT, "scripts", "boardctl"), encoding="utf-8").read()
    for needle in ("BOARD_STATE_DIR", "STATE_DIR", "internal-token",
                   "x-acp-internal-token"):
        # the comment documenting the prohibition may name it once
        hits = [ln for ln in src.splitlines() if needle in ln
                and not ln.lstrip().startswith("#")]
        expect(not hits, f"boardctl references {needle}: {hits}")


for fn in (t_review_view, t_review_json_mode, t_review_writes_refused,
           t_review_check_refused,
           t_accept_posts_bound_command, t_accept_retries_revision_conflict,
           t_accept_refuses_non_awaiting, t_accept_refuses_legacy_card,
           t_stop_posts_command, t_stop_refuses_legacy,
           t_lifecycle_refusals, t_set_nonlifecycle_field_allowed,
           t_legacy_review_check_still_writes_file, t_legacy_move_still_works,
           t_managed_unknown_card_fails_closed, t_no_offline_state_or_tokens):
    check(fn.__name__, fn)

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
