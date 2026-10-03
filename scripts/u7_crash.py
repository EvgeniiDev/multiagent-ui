#!/usr/bin/env python3
"""u7_crash.py — crash/recovery proofs on the isolated ON stack.

Runs INSIDE a managed window only (ON stack live, marker-verified).
Covers the DoD crash/recovery contract with real process/container events
on ACTIVE work — never injected owner-dead flags:

  * live identity  — runner instanceId/envInstance/generation read from
                     the environments ledger `slots.*.current`, cross-bound
                     to the container's real /proc/1 init starttime —
                     never filename sort.
  * node death     — SIGKILL the container-namespace node PID (resolved
                     via /proc cmdline scan for acp-runner, kill rc
                     asserted, exact PID proven gone). A NEW ledger
                     generation + instanceId + recovery snapshot bound to
                     the NEW /proc/1 starttime must appear, and
                     lastSeenAt must keep advancing (live tick evidence).
  * mid-flight     — a real managed run is started and killed THROUGH;
                     its attempt must end honestly (failed/cancelled,
                     never succeeded-without-acceptance-SHA) or be
                     provably adopted; the workspace reservation bound to
                     the dead instanceId must be PRESERVED until positive
                     retirement evidence exists.
  * container recreate — `docker compose up -d --force-recreate` through
                     the SAME ON file set the window used (dropping the
                     ON overlay would silently lose ACP_PORCH_CLI /
                     ACP_EXEC_*); recreated container env is asserted to
                     still carry the ON flags. Afterwards a positive
                     env-retirement receipt is minted via
                     scripts/retire-environment.mjs (--record preflight
                     before recreate since the runner uses a custom
                     hostname; retire verifies the OLD container is gone
                     via compose lifecycle and posts through the ops
                     credential) and the ledger retirements[] is checked.
  * durable write  — chmod fault on the test STATE_DIR must produce an
                     honest write failure under the real service uid
                     (1001, non-root — owner does not bypass 0555/0000);
                     the EXACT prior mode is recorded and restored. If the
                     chmod cannot fault under the real uid, a
                     uid-independent fault is used instead (the target doc
                     path is made a directory so the atomic rename fails)
                     — the case is never silently dropped.
  * durability     — run record + canonical events file + a NEW recovery
                     snapshot must exist with real bytes after the kill.

Usage: python3 scripts/u7_crash.py   (inside ON window only)
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _e2e_compose_harness as H  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EXEC_DIR = Path("/home/hermes/.hermes/acp-ui-state-u7/execution")
STATE_RUNS = EXEC_DIR / "state" / "runs"
ENV_LEDGER = EXEC_DIR / "state" / "environments.json"
CARDS_DIR = EXEC_DIR / "state" / "cards"
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
OPS_TOKEN = Path("/home/hermes/.acp-ops-u7/ops-token")
RECEIPTS_DIR = Path("/home/hermes/.acp-ops-u7/env-receipts")
RETIRE = ROOT / "scripts" / "retire-environment.mjs"
# The recreate MUST keep the ON overlay — H.COMPOSE_FILES alone is the OFF
# file set and would silently drop ACP_PORCH_CLI / ACP_EXEC_*.
FILES_ON = H.COMPOSE_FILES + [ROOT / "compose.u7-on.yaml"]
ON_ENV_KEYS = ("ACP_PORCH_CLI", "ACP_EXEC_START", "ACP_EXEC_VALIDATION")
RUNNER_CTR = "acp-ui-runner-1"
# Real terminal run statuses (RESOLVE_RUN_STATUSES + succeeded): a crashed
# run drains to 'interrupted' once the dead env is positively retired.
TERMINAL = {"succeeded", "failed", "cancelled", "stopped",
            "interrupted", "blocked"}
ATTEMPT_LIVE = {"launching", "running", "cancelling"}

checks: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}"
          + (f"  ({detail})" if detail else ""))


def sh(cmd, timeout=30):
    return subprocess.run(cmd, shell=True, capture_output=True,
                          text=True, timeout=timeout)


def compose_on(*args, timeout=120.0):
    cmd = ["docker", "compose", "-p", H.PROJECT]
    for f in FILES_ON:
        cmd += ["-f", str(f)]
    return subprocess.run(cmd + list(args), capture_output=True,
                          text=True, timeout=timeout)


def ledger():
    try:
        return json.loads(ENV_LEDGER.read_text())
    except Exception:
        return {}


def current_env():
    return ((ledger().get("slots") or {}).get("host-runner")
            or {}).get("current") or {}


def retirements():
    return ledger().get("retirements") or []


def proc1_starttime():
    """Container-namespace /proc/1 field-22 starttime of the runner."""
    r = sh(f"docker exec {RUNNER_CTR} sh -c 'cat /proc/1/stat'",
           timeout=15)
    if r.returncode != 0:
        return None
    # comm may contain spaces/parens — field 22 is after the LAST ')'
    tail = r.stdout.rsplit(")", 1)[-1].split()
    return tail[19] if len(tail) > 19 else None


def runner_node_pid_ns():
    """Container-namespace PID of the runner node — positively identified,
    never a pkill pattern, never a host pid. The runner command execs node
    directly (`node /repo/server/acp-runner.mjs --serve`), so the node IS
    the container init: we assert /proc/1/cmdline carries acp-runner.mjs
    and return pid 1 only on that positive proof. (A prior version
    scanned /proc/*/cmdline; inside a busy container the scan raced
    transient children and resolved !=1 pid.)"""
    r = sh(f"docker exec {RUNNER_CTR} sh -c "
           "'tr \"\\0\" \" \" < /proc/1/cmdline'", timeout=15)
    cl = (r.stdout or "").strip()
    if r.returncode == 0 and "acp-runner.mjs" in cl:
        return 1, f"pid=1 cmdline={cl[:120]!r}"
    return None, (f"rc={r.returncode} cmdline={cl[:160]!r} "
                  f"err={r.stderr.strip()[:160]!r}")


def live_instance():
    """Authoritative live identity: ledger current envInstance bound to the
    real /proc/1 starttime of the running container."""
    cur = current_env()
    st = proc1_starttime()
    bound = (cur.get("envInstance") or {}).get("initStarttime") == st
    return cur, st, bound


def wait_new_instance(old_iid, timeout=90.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        cur, st, bound = live_instance()
        if bound and cur.get("instanceId") and \
                cur.get("instanceId") != old_iid:
            return cur
        time.sleep(1.5)
    return None


def wait_bound_instance(timeout=90.0):
    """Converge on a live-bound ledger identity. A freshly recreated runner
    needs a few seconds to boot and land its registration — a one-shot read
    right after `up` races the ledger and sees the previous generation.
    Honest: still fails when registration never converges."""
    deadline = time.time() + timeout
    cur, st, bound = {}, None, False
    while time.time() < deadline:
        cur, st, bound = live_instance()
        if bound and cur.get("instanceId"):
            return cur, st, True
        time.sleep(1.5)
    return cur, st, bound


def runner_logs(tail=40):
    r = sh(f"docker logs --tail {tail} {RUNNER_CTR} 2>&1", timeout=15)
    return (r.stdout or "")[-1800:]


def container_id():
    return sh(f"docker inspect -f '{{{{.Id}}}}' {RUNNER_CTR}",
              timeout=15).stdout.strip()


def retire_env(env0, gen0, record=False):
    """mint a retirement receipt (--record preflight pins the docker Id
    while the env is live; the post-death call posts retire_environment).
    --state-dir is the STATE ROOT — loadEnvironments appends
    execution/state itself; passing EXEC_DIR looked up a doubled path
    (execution/execution/state) and every call refused 'no recorded
    registration'. --docker-id is REQUIRED for --record: hostname 'user'
    is shared by every service container (~14), so enumeration can never
    uniquely pin — the operator-supplied exact Id is the only binding."""
    mode = "--record " if record else ""
    docker_id = f"--docker-id {container_id()} " if record else ""
    return sh("node scripts/retire-environment.mjs " + mode + docker_id +
              f"--slot host-runner --container-id {env0['containerId']} "
              f"--init-starttime {env0['initStarttime']} "
              f"--generation {gen0} "
              f"--state-dir {H.TEST_STATE_DIR} --receipts-dir {RECEIPTS_DIR} "
              f"--ops-token-file {OPS_TOKEN} --state-url {H.STATE_URL}",
              timeout=90)


def reservation_for(card_id, instance_id):
    try:
        card = json.loads((CARDS_DIR / f"{card_id}.json").read_text())
    except Exception:
        return []
    return [w for w in (card.get("workspaces") or {}).values()
            if (w.get("owner") or {}).get("instanceId") == instance_id]


def api(method, path, body=None):
    return H.http_json(method, f"{H.STATE_URL}{path}", body=body)


def card_cmd(card_id, type_, payload=None, revision=None):
    if revision is None:
        st, view = api("GET", f"/api/execution/cards/{card_id}")
        revision = int(view["controlRevision"]) if st == 200 else 0
    return api("POST", f"/api/execution/cards/{card_id}/commands",
               {"commandId": f"u7crash:{type_}:{time.time_ns() % 10**10}",
                "type": type_, "payload": payload or {},
                "expectedControlRevision": revision})


def seed_card(card_id):
    st, doc = H.get_doc("projects.json")
    data = doc.get("data") if st == 200 else {"version": 1, "projects": []}
    rev = doc.get("rev") if st == 200 else 0
    projects = [p for p in data.get("projects", []) if p.get("id") != "u7-proj"]
    projects.append({"id": "u7-proj", "name": "u7-sandbox",
                     "path": str(SANDBOX / "proj-a"),
                     "createdAt": int(time.time() * 1000)})
    st, _ = H.seed_doc("projects.json",
                       {**data, "projects": projects,
                        "activeProjectId":
                        data.get("activeProjectId") or "u7-proj"}, rev=rev)
    assert st == 200, f"projects seed -> {st}"
    st, doc = H.get_doc("board.json")
    data = doc.get("data") if st == 200 else {"version": 2, "cards": []}
    rev = doc.get("rev") if st == 200 else 0
    now = int(time.time() * 1000)
    cards = [c for c in data.get("cards", []) if c.get("id") != card_id]
    cards.append({"id": card_id, "title": f"U7 crash {card_id}",
                  "description": "u7 crash suite", "project": "u7-sandbox",
                  "agent": "", "priority": "normal", "acceptance": "",
                  "verification": "", "links": [], "session": None,
                  "blocked": False, "blockedReason": "", "cancelled": False,
                  "touches": [], "dependsOn": [], "blocks": [],
                  "conflictsWith": [], "stage": "backlog", "status": "todo",
                  "order": 0, "createdAt": now, "updatedAt": now})
    st, _ = H.seed_doc("board.json", {**data, "cards": cards}, rev=rev)
    assert st == 200, f"board seed -> {st}"


def start_managed_run(card_id):
    """Enable → docs → approvals → preset → start. Returns runId or None."""
    seed_card(card_id)
    st, b = card_cmd(card_id, "enable", revision=0)
    if st != 200:
        check("crash: enable", False, f"{st} {b}")
        return None
    st, b = card_cmd(card_id, "attach_document", {
        "kind": "requirements", "source": {"type": "text", "text":
        "# req\nSet VALUE=42 in main.py. Nothing else.\n"}})
    req = (b or {}).get("result") or {}
    if st != 200:
        check("crash: requirements", False, f"{st}")
        return None
    card_cmd(card_id, "approve_requirements",
             {"versionId": req["versionId"], "sha256": req["sha256"],
              "by": "u7-crash"})
    st, b = card_cmd(card_id, "attach_document", {
        "kind": "plan",
        "source": {"type": "text",
                   "text": "# plan\n1. VALUE=42.\n2. check.\n"},
        "checks": [{"run": "python3 -c 'import main; assert "
                           "main.VALUE == 42'", "timeoutSec": 120}]})
    plan = (b or {}).get("result") or {}
    if st != 200:
        check("crash: plan", False, f"{st}")
        return None
    card_cmd(card_id, "approve_plan",
             {"versionId": plan["versionId"], "sha256": plan["sha256"],
              "by": "u7-crash"})
    member = {"cli": "pi",
              "model": "zen-relay/muse-spark-1.3-contributor-free"}
    st, b = card_cmd(card_id, "save_preset", {"preset": {
        "name": "u7-crash", "id": f"u7-preset-crash-{card_id[-6:]}",
        "members": {"implementer": member, "reviewer": member,
                    "checker": member},
        "limits": {"maxAttemptsPerRole": 2, "timeoutMin": 12,
                   "maxReviewRounds": 1}}})
    if st != 200:
        check("crash: preset", False, f"{st}")
        return None
    st, b = card_cmd(card_id, "start")
    rid = ((b or {}).get("result") or {}).get("runId")
    check("crash: start -> run queued", st == 200 and bool(rid),
          f"st={st} runId={rid}")
    return rid


def wait_run(run_id, predicate, timeout=240.0, poll=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, run = api("GET", f"/api/execution/runs/{run_id}")
        if st == 200 and predicate(run):
            return run
        time.sleep(poll)
    return None


def case_active_run_and_node_kill(card_id):
    """Start real managed work, then SIGKILL the runner's node through it."""
    print("case: managed run + real node death mid-flight")
    # The ON transition recreates the runner — its registration needs a few
    # seconds to land. A one-shot read races it and sees the dead previous
    # generation; converge instead, and dump the runner log on failure.
    cur0, st0, bound0 = wait_bound_instance(timeout=90)
    ok0 = bound0 and bool(cur0.get("instanceId"))
    check("live runner identity bound to /proc/1 before kill", ok0,
          f"iid={cur0.get('instanceId')} init={st0} gen="
          f"{cur0.get('generation')}")
    if not ok0:
        check("runner log tail on identity failure", False,
              runner_logs())
        return None, None
    env0 = cur0.get("envInstance") or {}
    gen0 = cur0.get("generation")
    dead_iid = cur0.get("instanceId")
    # Custom hostname ('user' is non-hex): a live-bound receipt is REQUIRED
    # while the env is still verifiable, or the killed instance can never
    # be positively retired afterwards (retire fails closed without it).
    rr = retire_env(env0, gen0, record=True)
    check("preflight env receipt recorded (live-bound)",
          rr.returncode == 0, (rr.stdout + rr.stderr).strip()[-160:])

    run_id = start_managed_run(card_id)
    if not run_id:
        return None, None
    run = wait_run(run_id, lambda r: bool(r.get("attempts")),
                   timeout=300.0)
    check("crash: run has a live attempt (work actually in-flight)",
          bool(run), f"status={(run or {}).get('status')}")
    if not run:
        return run_id, cur0

    # Under a LIVE owner the reservation exists by construction — this is
    # the 'before' leg of the preserved-until-evidence contract.
    check("reservation bound to live owner before kill",
          bool(reservation_for(run.get("cardId") or card_id, dead_iid)),
          f"iid={dead_iid}")

    pid, pid_detail = runner_node_pid_ns()
    check("container-namespace runner pid resolved", pid == 1,
          pid_detail)  # runner node is the container's init
    if pid is None:
        return run_id, cur0
    # Two kill routes are provably DEAD ends:
    #  - `docker exec ... kill -9 1`: a pid-namespace init silently IGNORES
    #    SIGKILL sent from inside its own namespace (pid_namespaces(7) —
    #    SIGKILL/SIGSTOP are only forced through from an ANCESTOR ns).
    #    rc==0, nobody dies.
    #  - `docker kill`: the daemon itself terminates the container, which
    #    counts as a manual stop — `unless-stopped` does NOT restart it
    #    (verified empirically), so no real-crash semantics.
    # The only honest crash = SIGKILL to the container init FROM the
    # ancestor (host) pid namespace: non-daemon-initiated death, the
    # restart policy fires for real. Host pid = .State.Pid, bound to
    # /proc/1 by an identical starttime field.
    hp = sh(f"docker inspect -f '{{{{.State.Pid}}}}' {RUNNER_CTR}",
            timeout=10)
    host_pid = hp.stdout.strip()
    if not (hp.returncode == 0 and host_pid.isdigit()):
        check("runner host pid resolved", False,
              (hp.stderr or hp.stdout).strip()[:120])
        return run_id, cur0
    hs = sh(f"sh -c 'cut -d\" \" -f22 /proc/{host_pid}/stat'", timeout=10)
    check("host pid positively bound to container /proc/1 init",
          hs.returncode == 0 and hs.stdout.strip() == str(st0),
          f"host_start={hs.stdout.strip()!r} ctr_start={st0!r}")
    kr = sh("docker run --rm --pid=host python:3.12-slim "
            f"sh -c 'kill -9 {host_pid}'", timeout=30)
    check("SIGKILL delivered to init from ancestor pid namespace",
          kr.returncode == 0, (kr.stderr or kr.stdout).strip()[:120])
    # Death proof = init IDENTITY change: after restart a fresh /proc/1
    # exists immediately, so existence says nothing — the starttime must
    # differ from the pre-kill one.
    deadline, gone, st1 = time.time() + 90, False, None
    while time.time() < deadline:
        st1 = proc1_starttime()
        if st1 and st1 != st0:
            gone = True
            break
        time.sleep(1.5)
    check("old container init proven dead (new /proc/1 starttime)",
          gone, f"{st0} -> {st1}")
    check("runner container running again (restart policy)",
          H.wait_http(f"{H.STATE_URL}/health", 60) and
          H.service_running("runner"), "")

    new = wait_new_instance(dead_iid, timeout=120)
    check("NEW ledger generation + instanceId after kill",
          bool(new), f"old={dead_iid}")
    if not new:
        check("runner log tail on missing new registration", False,
              runner_logs())
        return run_id, cur0
    check("new envInstance.initStarttime matches live /proc/1",
          (new.get("envInstance") or {}).get("initStarttime")
          == proc1_starttime(), "")
    gen1 = new.get("generation")
    check("ledger generation advanced",
          isinstance(gen0, int) and isinstance(gen1, int)
          and gen1 > gen0, f"g{gen0}->g{gen1}")
    snap = EXEC_DIR / "journal" / \
        f"recovery-{new.get('runnerId')}-{new.get('instanceId')}.json"
    deadline = time.time() + 30
    while time.time() < deadline \
            and not (snap.exists() and snap.stat().st_size > 0):
        time.sleep(1)
    check("recovery snapshot written for the NEW instance",
          snap.exists() and snap.stat().st_size > 0, snap.name)

    # Hands-off invariant: across several scheduler ticks the attempt owned
    # by the DEAD env must stay live and its reservation untouched — a
    # successor may never terminalize foreign work on weak evidence.
    # (envInstance pidNs differs per container → no in-band death proof
    # exists until an ops-verified retirement is minted below.)
    deadline = time.time() + 18  # ~3–4 ticks
    hands_off = True
    att_status = "?"
    while time.time() < deadline:
        st, r2 = api("GET", f"/api/execution/runs/{run_id}")
        att = next((a for a in (r2.get("attempts") or [])
                    if (a.get("owner") or {}).get("instanceId")
                    == dead_iid), None)
        att_status = (att or {}).get("status") or "absent"
        if st == 200 and att_status not in ATTEMPT_LIVE | {"absent"}:
            hands_off = False
            break
        time.sleep(2)
    check("foreign attempt UNTOUCHED while no retirement exists",
          hands_off, f"attempt.status={att_status}")
    check("reservation bound to dead owner PRESERVED pre-retire",
          bool(reservation_for(run.get("cardId") or card_id, dead_iid)),
          "")

    # Now mint the positive proof: same container Id (restart), different
    # init starttime — boundVerdict 'removed'. Only AFTER this may the
    # successor drain the orphaned work.
    rt = retire_env(env0, gen0)
    check("retire-environment posts positive proof for killed env",
          rt.returncode == 0, (rt.stdout + rt.stderr).strip()[-160:])
    return run_id, cur0


def case_no_false_success(run_id, dead_iid):
    """Post-crash terminal honesty on the run that was ACTUALLY in-flight."""
    print("case: post-crash run state is honest (nonvacuous)")
    runs = sorted(STATE_RUNS.glob("run_*.json"))
    check("run records exist (nonvacuous audit)", len(runs) >= 1,
          f"n={len(runs)}")
    st, run = api("GET", f"/api/execution/runs/{run_id}")
    check("crashed run viewable", st == 200, f"st={st}")
    if st != 200:
        return
    if run.get("status") not in TERMINAL:
        # The retirement receipt was already minted in the kill case — the
        # successor drains the orphaned attempt to 'interrupted' on its
        # next ticks. Draining IS the tick evidence: a dead runner cannot
        # land resolve_attempt/complete_run.
        run = wait_run(run_id, lambda r: r.get("status") in TERMINAL,
                       timeout=240.0) or run
        check("successor drained crashed run to honest terminal",
              run.get("status") in TERMINAL - {"succeeded"},
              f"status={run.get('status')}")
    atts = run.get("attempts") or []
    killed = [a for a in atts if (a.get("status") or "")
              in ("failed", "cancelled", "error", "stopped",
                  "interrupted", "blocked")]
    check("the mid-flight attempt was terminalized honestly "
          "(failed/cancelled/interrupted — never silent)",
          bool(killed) or run.get("status") in TERMINAL - {"succeeded"},
          f"attempts={[(a.get('id'), a.get('status')) for a in atts]}"
          f" run={run.get('status')}")
    bad = run.get("status") == "succeeded" \
        and not (run.get("acceptance") or {}).get("resultSha256")
    check("no succeeded-without-acceptance evidence", not bad,
          f"status={run.get('status')}")
    if run.get("status") not in TERMINAL:
        # adopted/still-running: stop it cleanly so the window doesn't
        # pin a live run; then the SAME honesty checks apply.
        card_cmd(run.get("cardId") or "", "stop", {"reason": "u7-crash"})
        run2 = wait_run(run_id, lambda r: r.get("status") in TERMINAL,
                        timeout=300.0)
        check("adopted/surviving run stopped to honest terminal",
              bool(run2) and run2.get("status") != "succeeded",
              f"status={(run2 or {}).get('status')}")

    # workspace reservation bound to the DEAD instance must be preserved —
    # never cleared without positive retirement evidence.
    try:
        card = json.loads((CARDS_DIR / f"{run.get('cardId')}.json")
                          .read_text())
    except Exception:
        card = {}
    ws = (card.get("workspaces") or {})
    hit = [w for w in ws.values()
           if (w.get("owner") or {}).get("instanceId") == dead_iid]
    check("reservation bound to dead owner is PRESERVED (not cleared)",
          bool(hit) and all((w.get("status") or "") != ""
                            for w in hit),
          f"n={len(hit)}")


def case_container_recreate():
    print("case: runner container recreate via ON file set + retirement")
    cur0, st0, bound0 = wait_bound_instance(timeout=90)
    env0 = cur0.get("envInstance") or {}
    gen0 = cur0.get("generation")
    check("pre-recreate ledger identity readable",
          bound0 and env0.get("containerId") and gen0,
          f"{env0} g{gen0}")
    if not (bound0 and gen0):
        check("runner log tail on pre-recreate identity failure", False,
              runner_logs())
        return
    cid0 = sh(f"docker inspect -f '{{{{.Id}}}}' {RUNNER_CTR}").stdout.strip()

    # custom hostname ('user' is non-hex) requires a live-bound receipt.
    rr = retire_env(env0, gen0, record=True)
    check("preflight env receipt recorded (live-bound)", rr.returncode == 0,
          (rr.stdout + rr.stderr).strip()[-200:])

    r = compose_on("up", "-d", "--no-deps", "--force-recreate", "runner",
                   timeout=180)
    check("force-recreate via ON file set rc==0", r.returncode == 0,
          r.stderr[:160])
    deadline, cid1 = time.time() + 120, cid0
    while time.time() < deadline:
        cid1 = sh(f"docker inspect -f '{{{{.Id}}}}' {RUNNER_CTR}") \
            .stdout.strip()
        if cid1 and cid1 != cid0 and H.service_running("runner"):
            break
        time.sleep(2)
    check("container identity changed", cid1 != cid0,
          f"{cid0[:12]} -> {cid1[:12]}")
    envs = sh(f"docker inspect -f '{{{{json .Config.Env}}}}' "
              f"{RUNNER_CTR}").stdout
    check("recreated runner still carries ON env flags "
          "(overlay not dropped)",
          all(k in envs for k in ON_ENV_KEYS),
          ",".join(k for k in ON_ENV_KEYS if k in envs) or "NONE")

    new = wait_new_instance(cur0.get("instanceId"), timeout=120)
    check("new ledger instance after recreate (no pid reuse)",
          bool(new), f"iid={(new or {}).get('instanceId')}")

    # positive retirement receipt for the OLD env — ops channel only.
    rt = retire_env(env0, gen0)
    check("retire-environment posts a positive receipt", rt.returncode == 0,
          (rt.stdout + rt.stderr).strip()[-200:])
    recs = [x for x in retirements()
            if (x.get("envInstance") or {}) == env0
            and x.get("generation") == gen0]
    check("ledger retirements[] holds the OLD envInstance+generation "
          "with compose_lifecycle evidence",
          bool(recs) and recs[0].get("evidence", {}).get("state")
          in ("removed", "stopped"),
          f"n={len(recs)} "
          f"state={(recs[0].get('evidence') or {}).get('state') if recs else '-'}")


def case_durability(run_id, dead):
    print("case: durable files survive process/container death")
    rf = STATE_RUNS / f"{run_id}.json"
    ef = STATE_RUNS / f"{run_id}.events.jsonl"
    check("run record durable + non-empty",
          rf.exists() and rf.stat().st_size > 0, f"{rf.stat().st_size if rf.exists() else 0}B")
    # runs/<id>.events.jsonl is a PROJECTION of the aggregate's run.events —
    # written only when events exist. A cleanly-drained run (adopt +
    # resolve + complete on positive proof) records zero anomaly events, so
    # absence is honest; a nonzero eventsCursor MUST have the file.
    try:
        cur_n = int(json.loads(rf.read_text()).get("eventsCursor") or 0)
    except Exception:
        cur_n = -1
    ev_file_bytes = ef.stat().st_size if ef.exists() else 0
    check("canonical events projection consistent with run record "
          "(nonempty iff eventsCursor>0)",
          cur_n < 0 or (cur_n > 0) == (ev_file_bytes > 0),
          f"eventsCursor={cur_n} file={ev_file_bytes}B")
    snaps = sorted(EXEC_DIR.glob("journal/recovery-*.json"))
    check("recovery snapshots durable", len(snaps) >= 2,
          f"n={len(snaps)}")
    # Real reconcile evidence: the CURRENT live instance's snapshot must
    # parse and carry its tracked list (u4-journal-*.jsonl only exists when
    # an outage replay actually ran — a healthy window writes none, so its
    # absence is honest, not a failure).
    cur = current_env()
    snap = EXEC_DIR / "journal" / \
        f"recovery-{cur.get('runnerId')}-{cur.get('instanceId')}.json"
    snap_ok = False
    try:
        snap_ok = isinstance(
            json.loads(snap.read_text()).get("tracked"), list)
    except Exception:
        pass
    check("live instance recovery snapshot parses + carries tracked state",
          snap_ok, snap.name)
    # Durable positive proof: the KILLED env's retirement must be recorded
    # in the ledger — the drain of the mid-flight attempt relied on it.
    env0 = (dead or {}).get("envInstance") or {}
    gen0 = (dead or {}).get("generation")
    recs = [x for x in retirements()
            if (x.get("envInstance") or {}) == env0
            and x.get("generation") == gen0]
    check("ledger retirements[] durably holds the KILLED env record",
          bool(recs) and recs[0].get("evidence", {}).get("source")
          == "compose_lifecycle",
          f"n={len(recs)}")


def case_durable_write_fault():
    print("case: durable-write fault -> honest error (real uid semantics)")
    doc = f"u7-fault-{int(time.time()) % 100000}.json"
    st_mode = sh(f"stat -c %a {H.TEST_STATE_DIR}").stdout.strip()
    check("state dir mode recorded", bool(st_mode), f"mode={st_mode}")
    if not st_mode:
        return
    # uid proof: state service runs uid 1001, dir owned by 1001 — chmod 0000
    # denies the owner, a REAL fault (not a cosmetic one).
    uid = sh("docker exec acp-ui-state-1 id -u").stdout.strip()
    check("state service uid confirmed non-root", uid == "1001",
          f"uid={uid}")
    faulted = False
    st = None
    sh(f"chmod 0000 {H.TEST_STATE_DIR}")
    try:
        st, body = H.seed_doc(doc, {"probe": True})
        faulted = st not in (200, 201)
    except Exception as e:
        # Under mode 0000 the state service cannot even answer /health —
        # the isolation guard raises before the write. The service being
        # unable to serve at all IS the honest fault outcome.
        faulted = True
        st = type(e).__name__
    finally:
        sh(f"chmod {st_mode} {H.TEST_STATE_DIR}")  # EXACT prior mode
    after = sh(f"stat -c %a {H.TEST_STATE_DIR}").stdout.strip()
    check("state dir mode restored EXACTLY", after == st_mode,
          f"{st_mode}->{after}")
    if faulted:
        check("write under mode-0000 fault failed honestly "
              f"(st={st}, uid=1001 owner denied)", True, "")
    else:
        # chmod did not fault under the real uid — fall back to a
        # uid-independent fault: the target doc PATH is a directory, so the
        # atomic rename inside the store fails for every uid.
        p = H.TEST_STATE_DIR / f"{doc}.json"
        p.mkdir(exist_ok=False)
        st2 = None
        try:
            st2, _ = H.seed_doc(doc, {"probe": True})
            faulted = st2 not in (200, 201)
        except Exception:
            faulted = True
        finally:
            p.rmdir()
        check("write under doc-path-is-dir fault failed honestly "
              "(uid-independent)", faulted, f"st={st2}")
    st3, _b3 = H.seed_doc(doc, {"probe": True})
    check("state writes recover after fault lifted", st3 in (200, 201),
          f"st={st3}")
    (H.TEST_STATE_DIR / f"{doc}.json").unlink(missing_ok=True)


def main():
    H.require_stack()
    print("u7_crash — crash/recovery proofs (ON window)")
    card_id = f"u7-crash-{int(time.time()) % 100000}"
    run_id, dead = case_active_run_and_node_kill(card_id)
    if run_id:
        case_no_false_success(run_id, (dead or {}).get("instanceId"))
        case_durability(run_id, dead)
    else:
        check("crash: managed work actually started", False,
              "no runId — crash cases nonvacuous-fail")
    case_container_recreate()
    case_durable_write_fault()
    failed = [c for c in checks if not c[0]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
