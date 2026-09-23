#!/usr/bin/env python3
"""E2E for the W5-B runner (server/acp-runner.mjs): thin board -> CLI layer.

Spins up its OWN state server (server/acp-state-server.mjs from this repo)
on port 25907 with STATE_DIR=<worktree>/tmp-runner-test, seeds a project
(path inside tmp-runner-test), a dev-stage card, and a role whose `cli` is
a stub script (writes 04_impl_log.md with `STATUS: DONE`, exits 0), then:

  1. `--once` run -> claim set and released, 00_brief.md written,
     run-*.log written, activity.json gains an event with exit 0,
     the card stays in `dev` (runner never moves cards);
  2. a live claim held by someone else -> runner does not take the card;
  3. maxConcurrent=1 with two eligible cards -> one run per pass;
  4. a `blocked` card is never taken;
  5. DRY_RUN=1 spawns nothing;
  6. --stop-all releases own claims and leaves no live process.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import os
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
RUNNER = ROOT / "server" / "acp-runner.mjs"
STATE_DIR = ROOT / "tmp-runner-test"
STATE_PORT = 25907
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
PROJ = STATE_DIR / "proj"

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def port_free(port):
    with socket.socket() as s:
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


def put_doc(name, data, rev):
    return api(f"/{name}", "PUT", {"data": data, "rev": rev})


def seed_docs(board, projects, roles, claims=None, activity=None):
    # Fresh revs: docs were just created in a wiped STATE_DIR, so rev chain
    # is 0 -> PUT w/o rev. Use explicit revs read back for updates.
    for name, doc in (("board.json", board), ("projects.json", projects),
                      ("roles.json", roles),
                      ("claims.json", claims or {"version": 1, "claims": {}}),
                      ("activity.json", activity or {"entries": [], "usage": []})):
        status, _ = put_doc(name, doc, 0)
        assert status == 200, f"seed {name} -> {status}"


def run_runner(*args, env_extra=None):
    env = {**os.environ, "STATE_URL": STATE_URL,
           "ROOT_DIR": str(STATE_DIR),
           "RUNNER_ID": "e2e-runner"}
    env.update(env_extra or {})
    return subprocess.run(
        ["node", str(RUNNER), *args], capture_output=True, text=True,
        timeout=120, env=env, cwd=ROOT)


def card_dir(card_id):
    return PROJ / ".acp" / "cards" / card_id


def main():
    if not STATE_SERVER.exists():
        print(f"FAIL  {STATE_SERVER} missing — state server not in repo")
        sys.exit(1)
    if not RUNNER.exists():
        print(f"FAIL  {RUNNER} missing — runner not implemented")
        sys.exit(1)
    if not port_free(STATE_PORT):
        print(f"FAIL  port {STATE_PORT} in use — refusing a stale server")
        sys.exit(1)

    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)
    PROJ.mkdir(parents=True)

    # The stub CLI: stands in for a real agent binary. Like a real agent
    # (see .acp/roles/dev.md), it writes its verdict report into the card
    # dir .acp/cards/<id>/04_impl_log.md and exits 0; argv goes to argv.log
    # so the test can prove the brief path was passed. The brief-path
    # argument ends with /00_brief.md — its dirname is the card dir.
    stub = STATE_DIR / "stub-cli.sh"
    stub.write_text(
        "#!/bin/sh\n"
        "echo \"$@\" >> \"$STUB_ARGV_LOG\"\n"
        "for a in \"$@\"; do case \"$a\" in *00_brief.md*) CARD_DIR=$(dirname \"$(printf '%s' \"$a\" | grep -o '/[^ ]*00_brief.md' | head -1)\");; esac; done\n"
        ": \"${CARD_DIR:?no brief path in argv}\"\n"
        "echo 'did the thing' > \"$CARD_DIR/04_impl_log.md\"\n"
        "echo 'STATUS: DONE' >> \"$CARD_DIR/04_impl_log.md\"\n"
        "echo 'stub stdout line'\n"
        "exit 0\n")
    stub.chmod(0o755)

    state = subprocess.Popen(
        ["node", str(STATE_SERVER)],
        env={**os.environ, "STATE_DIR": str(STATE_DIR),
             "PORT": str(STATE_PORT)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(STATE_PORT):
            print("FAIL  state server did not start")
            sys.exit(1)

        now = int(time.time() * 1000)
        board = {"version": 2, "cards": [{
            "id": "card-dev-1", "title": "E2E dev card",
            "description": "d", "project": "p1", "agent": "",
            "priority": "medium",
            "acceptance": "accepts X", "verification": "run Y",
            "links": [], "session": None,
            "blocked": False, "blockedReason": "", "cancelled": False,
            "touches": [], "dependsOn": [], "blocks": [], "conflictsWith": [],
            "stage": "dev", "status": "in_progress", "statusByStage": {},
            "order": 10, "createdAt": now, "updatedAt": now}]}
        projects = {"version": 1,
                    "projects": [{"id": "p1", "name": "P1",
                                   "path": str(PROJ), "createdAt": now}],
                    "activeProjectId": "all"}
        roles = {"version": 1,
                 "roles": [{"id": "dev", "label": "Dev", "cli": str(stub),
                              "args": [], "promptFile": ".acp/roles/dev.md",
                              "maxConcurrent": 2, "pollIntervalSec": 5,
                              "timeoutMin": 5}],
                 "stageRoles": {"dev": "dev"}}
        seed_docs(board, projects, roles)

        # ---- 1. basic --once run --------------------------------------
        argv_log = STATE_DIR / "argv.log"
        argv_log.write_text("")
        proc = run_runner("--once", env_extra={"STUB_ARGV_LOG": str(argv_log)})
        check("once exits 0", proc.returncode == 0, proc.stderr.strip()[:200])
        try:
            out = json.loads(proc.stdout)
            check("once prints run summary", out.get("ok") is True,
                  proc.stdout[:200])
        except ValueError:
            check("once prints run summary", False, proc.stdout[:200])

        claims, _ = get_doc("claims.json")
        check("claim released after run",
              claims is not None and "card-dev-1" not in (claims.get("claims") or {}),
              json.dumps(claims)[:200])

        brief = card_dir("card-dev-1") / "00_brief.md"
        check("00_brief.md created", brief.exists())
        if brief.exists():
            text = brief.read_text()
            check("brief holds id+title+acceptance+STATUS rule",
                  "card-dev-1" in text and "E2E dev card" in text
                  and "accepts X" in text and "STATUS:" in text,
                  text[:300].replace("\n", " | "))

        logs = sorted(card_dir("card-dev-1").glob("run-*.log")) \
            if card_dir("card-dev-1").exists() else []
        check("run-*.log created", len(logs) == 1,
              ",".join(p.name for p in logs))
        if logs:
            check("run log captures stub stdout",
                  "stub stdout line" in logs[0].read_text(),
                  logs[0].read_text()[:200])

        impl = card_dir("card-dev-1") / "04_impl_log.md"
        check("stub wrote verdict into the card dir (04_impl_log.md)",
              impl.exists() and "STATUS: DONE" in impl.read_text())
        check("stub got the brief path",
              "00_brief.md" in argv_log.read_text(),
              argv_log.read_text()[:200])

        activity, _ = get_doc("activity.json")
        entries = (activity or {}).get("entries") or []
        mine = [e for e in entries
                if e.get("kind") == "card"
                and e.get("agentName") == "e2e-runner:dev"]
        check("activity.json gains a card event", len(mine) >= 1,
              json.dumps(mine[-1])[:300] if mine else f"{len(entries)} entries")
        if mine:
            check("event cites exit 0", "exit=0" in (mine[-1].get("detail") or ""),
                  (mine[-1].get("detail") or "")[:200])
            check("event cites verdict STATUS",
                  "STATUS: DONE" in (mine[-1].get("detail") or ""),
                  (mine[-1].get("detail") or "")[:200])

        board_now, _ = get_doc("board.json")
        stages = [c.get("stage") for c in (board_now or {}).get("cards", [])]
        check("card NOT moved (still dev)", stages == ["dev"],
              ",".join(stages))

        # ---- 2. live foreign claim blocks pickup -----------------------
        claims, rev = get_doc("claims.json")
        claims["claims"]["card-dev-1"] = {
            "agentName": "someone-else", "sessionId": "",
            "leaseUntil": int(time.time() * 1000) + 600_000,
            "startedAt": now, "claimedAt": now}
        status, _ = put_doc("claims.json", claims, rev)
        assert status == 200, f"plant claim -> {status}"
        n_logs_before = len(list(card_dir("card-dev-1").glob("run-*.log")))
        proc = run_runner("--once")
        check("live foreign claim: once still exits 0", proc.returncode == 0)
        try:
            runs = json.loads(proc.stdout).get("runs", [])
        except ValueError:
            runs = None
        check("live foreign claim: no run started",
              runs == [], proc.stdout[:200])
        check("live foreign claim: no new log",
              len(list(card_dir("card-dev-1").glob("run-*.log"))) == n_logs_before)
        # Release the planted claim for the next legs.
        claims, rev = get_doc("claims.json")
        claims["claims"].pop("card-dev-1", None)
        put_doc("claims.json", claims, rev)

        # ---- 3. maxConcurrent=1, two cards -> one run ------------------
        board_now, rev = get_doc("board.json")
        card2 = dict(board_now["cards"][0])
        card2["id"] = "card-dev-2"
        card2["title"] = "Second dev card"
        board_now["cards"].append(card2)
        put_doc("board.json", board_now, rev)
        roles_now, rev = get_doc("roles.json")
        roles_now["roles"][0]["maxConcurrent"] = 1
        put_doc("roles.json", roles_now, rev)
        for c in ("card-dev-1", "card-dev-2"):
            shutil.rmtree(card_dir(c), ignore_errors=True)
        proc = run_runner("--once")
        try:
            runs = json.loads(proc.stdout).get("runs", [])
        except ValueError:
            runs = None
        ran_ids = sorted(r.get("card") for r in (runs or []) if not r.get("skipped"))
        check("maxConcurrent=1: exactly one card runs", ran_ids == ["card-dev-1"]
              or ran_ids == ["card-dev-2"], json.dumps(runs)[:300])
        other = "card-dev-2" if ran_ids == ["card-dev-1"] else "card-dev-1"
        check("maxConcurrent=1: the other card untouched",
              not card_dir(other).exists(), other)

        # ---- 4. blocked card never taken -------------------------------
        board_now, rev = get_doc("board.json")
        for c in board_now["cards"]:
            if c["id"] == other:
                c["blocked"] = True
                c["blockedReason"] = "waiting on X"
        # Reset: only the blocked card is eligible-looking; also drop the
        # maxConcurrent pressure by removing the already-run card's dir only
        # (card stays in dev — runner never moves cards — but give it a
        # foreign claim so it is ineligible too).
        claims, crev = get_doc("claims.json")
        ran = ran_ids[0]
        claims["claims"][ran] = {
            "agentName": "someone-else", "sessionId": "",
            "leaseUntil": int(time.time() * 1000) + 600_000,
            "startedAt": now, "claimedAt": now}
        put_doc("claims.json", claims, crev)
        put_doc("board.json", board_now, rev)
        shutil.rmtree(card_dir(other), ignore_errors=True)
        proc = run_runner("--once")
        try:
            runs = json.loads(proc.stdout).get("runs", [])
        except ValueError:
            runs = None
        check("blocked card: no run started", runs == [], proc.stdout[:300])
        check("blocked card: no brief written", not card_dir(other).exists())
        claims, crev = get_doc("claims.json")
        claims["claims"].pop(ran, None)
        put_doc("claims.json", claims, crev)

        # ---- 5. DRY_RUN=1 spawns nothing --------------------------------
        board_now, rev = get_doc("board.json")
        for c in board_now["cards"]:
            c["blocked"] = False
        put_doc("board.json", board_now, rev)
        for c in ("card-dev-1", "card-dev-2"):
            shutil.rmtree(card_dir(c), ignore_errors=True)
        proc = run_runner("--once", env_extra={"DRY_RUN": "1",
                                               "STUB_ARGV_LOG": str(argv_log)})
        check("dry run exits 0", proc.returncode == 0)
        check("dry run prints the command", "[dry-run]" in proc.stdout,
              proc.stdout[:200])
        check("dry run spawns nothing (no 04_impl_log.md)",
              not (card_dir("card-dev-1") / "04_impl_log.md").exists()
              and not (card_dir("card-dev-2") / "04_impl_log.md").exists())
        check("dry run leaves no claim", (
            lambda cl: "card-dev-1" not in cl and "card-dev-2" not in cl)(
            (get_doc("claims.json")[0] or {}).get("claims", {})))

        # ---- 6. --stop-all ----------------------------------------------
        claims, rev = get_doc("claims.json")
        claims["claims"]["card-dev-1"] = {
            "agentName": "e2e-runner:dev", "sessionId": "",
            "leaseUntil": int(time.time() * 1000) + 600_000,
            "startedAt": now, "claimedAt": now,
            "pid": 999999999, "roleId": "dev", "runnerId": "e2e-runner"}
        put_doc("claims.json", claims, rev)
        proc = run_runner("--stop-all")
        check("stop-all exits 0", proc.returncode == 0, proc.stderr[:200])
        claims, _ = get_doc("claims.json")
        check("stop-all releases own claims",
              "card-dev-1" not in (claims or {}).get("claims", {}))

    finally:
        state.terminate()
        try:
            state.wait(timeout=5)
        except subprocess.TimeoutExpired:
            state.kill()
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
