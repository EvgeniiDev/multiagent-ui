#!/usr/bin/env python3
"""u7_pi_boundary_selftest.py — regression for deploy/pi-rpc-boundary.mjs.

Listener-free. Two levels, no services:

  wire     — spawn the shim directly (PI_RPC_BOUNDARY_REAL_CLI=<stub>) and
             assert the transformed event stream: no `turn_end` may reach the
             reader until the real `agent_end`/`agent_settled` boundary;
             suppressed frames appear as `turn_boundary` with the original
             payload; a crash without agent_end NEVER surfaces `turn_end`.
  adapter  — drive the REAL installed PiAdapter (binary=<shim>) against the
             stub pi, proving porch completes on the real boundary with real
             final text, cancel/abort reaches stdin, crashes are honest
             failures (never success), and `child_pid` is the pi process
             itself (same-process identity — no wrapper child).

The primary replay fixture is the captured upstream stream of the REAL
failure: run_stony-pine-8669 / att-run_3d8bc803-9c3a-4d57-9b43-b56d37e47c7d-1
(porch aborted turn 2 after treating the tool-use turn_end as completion).

Stub pi protocol: scenario JSON drives emitted frames per trigger
(prompt #n / abort / steer / eof / start); every stdin command is logged to
STUB_CMDLOG; commands with `id` get {id,type:response,success:true} acks;
get_last_assistant_text returns scenario finalText.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SHIM = REPO / "deploy" / "pi-rpc-boundary.mjs"
WRAPPER = REPO / "deploy" / "porch-pi-boundary.sh"
FIXTURE = REPO / "scripts" / "fixtures" / "u7_pi_run_stony_pine_upstream.jsonl"
PORCH_LIB = Path.home() / ".pi/agent/skills/pragmatic-orchestration/scripts/lib"

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL {name} — {detail}")


# --------------------------------------------------------------------------
# stub pi
# --------------------------------------------------------------------------

STUB_CLI = r"""
// Stub pi CLI imported by the boundary shim. Reads scenario from
// STUB_SCENARIO; every stdin command is appended to STUB_CMDLOG and acked;
// frames are emitted per trigger after the ack, one per tick so readers
// observe real streaming.
import fs from 'node:fs';
import readline from 'node:readline';
const scenario = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, 'utf8'));
const cmdlog = process.env.STUB_CMDLOG;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let promptCount = 0;
async function emit(frames) {
  for (const f of frames || []) {
    if (f && f.chunks) {          // split-write frame: raw chunks, no framing
      for (const c of f.chunks) { process.stdout.write(c); await sleep(2); }
    } else {
      process.stdout.write(JSON.stringify(f) + '\n');
      await sleep(2);
    }
  }
}
async function main() {
  await emit(scenario.onStart);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (cmdlog) fs.appendFileSync(cmdlog, line + '\n');
    let msg = {}; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined) {
      const resp = { id: msg.id, type: 'response', command: msg.type, success: true };
      if (msg.type === 'get_last_assistant_text') resp.data = { text: scenario.finalText || '' };
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
    if (msg.type === 'prompt') { promptCount += 1; await emit((scenario.onPrompt || [])[promptCount - 1]); }
    else if (msg.type === 'abort') await emit(scenario.onAbort);
    else if (msg.type === 'steer') await emit(scenario.onSteer);
    if (scenario.exitAfter && promptCount >= scenario.exitAfter) process.exit(scenario.exitCode ?? 0);
  }
  await emit(scenario.onEof);
  process.exit(scenario.exitCode ?? 0);
}
main();
"""


def make_stub(workdir: Path, scenario: dict) -> Path:
    stub = workdir / "stub-cli.mjs"
    stub.write_text(STUB_CLI)
    (workdir / "scenario.json").write_text(json.dumps(scenario))
    return stub


def shim_env(stub: Path, workdir: Path) -> dict:
    env = dict(os.environ)
    env["PI_RPC_BOUNDARY_REAL_CLI"] = str(stub)
    env["PI_RPC_BOUNDARY_ALLOW_ANY_PI"] = "1"  # stub has no package.json
    env["STUB_SCENARIO"] = str(workdir / "scenario.json")
    env["STUB_CMDLOG"] = str(workdir / "cmdlog.jsonl")
    return env


def read_events(stdout: str):
    evts = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evts.append(json.loads(line))
        except json.JSONDecodeError:
            evts.append({"type": "_non_json", "line": line})
    return evts


def boundary_invariant_ok(evts):
    """Every emitted turn_end must be a closing turn: the next turn_start may
    only appear after an agent_end/agent_settled. Returns list of violations."""
    bad = []
    for i, e in enumerate(evts):
        if e.get("type") != "turn_end":
            continue
        ok = False
        for f in evts[i + 1:]:
            t = f.get("type")
            if t in ("agent_end", "agent_settled"):
                ok = True
                break
            if t in ("turn_start", "turn_end"):
                break
        if not ok:
            bad.append(i)
    return bad


def boundary_payload_preserved(in_frames, out_evts):
    """Every input turn_end must appear in the output exactly once — either
    verbatim as turn_end or as turn_boundary with identical payload."""
    src = sorted(json.dumps(f, sort_keys=True)
                 for f in in_frames if isinstance(f, dict) and f.get("type") == "turn_end")
    dst = sorted(json.dumps(dict(e, type="turn_end"), sort_keys=True)
                 for e in out_evts if e.get("type") in ("turn_end", "turn_boundary"))
    return src == dst


def cmdlog(w: Path):
    p = w / "cmdlog.jsonl"
    if not p.exists():
        return []
    return [json.loads(l).get("type") for l in p.read_text().splitlines() if l.strip()]


# --------------------------------------------------------------------------
# wire-level cases
# --------------------------------------------------------------------------

def wire_case(name, scenario, argv=None, stdin_lines=None):
    """Spawn shim with stub; assert the universal boundary invariant.
    Returns (events, proc) for case-specific assertions."""
    print(f"wire: {name}")
    with tempfile.TemporaryDirectory() as td:
        w = Path(td)
        stub = make_stub(w, scenario)
        cmd = [str(SHIM)] + (argv or ["--mode", "rpc", "--session-id", "t"])
        inp = "\n".join(json.dumps(l) for l in (stdin_lines or []))
        inp = inp + "\n" if inp else ""  # closed stdin -> EOF drives stub exit
        p = subprocess.run(cmd, input=inp, capture_output=True, text=True,
                           env=shim_env(stub, w), timeout=30)
        evts = read_events(p.stdout)
        bad = boundary_invariant_ok(evts)
        check(f"{name}: no turn_end before agent boundary", not bad,
              f"violations at output indices {bad}: {[e.get('type') for e in evts]}")
        return evts, p


def case_replay_capture():
    frames = [json.loads(l) for l in FIXTURE.read_text().splitlines() if l.strip()]
    name = "replay run_stony-pine-8669"
    evts, p = wire_case(name, {"onStart": frames})
    types = [e.get("type") for e in evts]
    check(f"{name}: boundary frames replace mid-loop turn_end",
          types.count("turn_boundary") == 1 and types.count("turn_end") == 1,
          str(types))
    check(f"{name}: verbatim turn_end precedes agent_end",
          types.index("turn_end") < types.index("agent_end")
          and "turn_start" not in types[types.index("turn_end"):types.index("agent_end")],
          str(types))
    check(f"{name}: boundary preserves payload", boundary_payload_preserved(frames, evts),
          "payload mismatch")
    check(f"{name}: exit code passthrough", p.returncode == 0, f"rc={p.returncode}")
    check(f"{name}: version marker on stderr",
          "pi-rpc-boundary: active" in p.stderr, p.stderr[:120])


def case_crash_no_agent_end():
    frames = [
        {"type": "agent_start"}, {"type": "turn_start"},
        {"type": "tool_execution_start", "tool": "bash"},
        {"type": "turn_end", "message": {"stopReason": "toolUse",
         "content": [{"type": "text", "text": "partial answer"}]}},
    ]
    name = "crash without agent_end"
    evts, p = wire_case(name, {"onStart": frames, "exitCode": 1})
    types = [e.get("type") for e in evts]
    check(f"{name}: held turn_end never emitted verbatim on crash",
          "turn_end" not in types, str(types))
    check(f"{name}: held frame kept as boundary evidence",
          "turn_boundary" in types, str(types))
    check(f"{name}: real exit code propagated", p.returncode == 1,
          f"rc={p.returncode}")


def case_empty_final():
    frames = [
        {"type": "agent_start"}, {"type": "turn_start"},
        {"type": "turn_end", "message": {"stopReason": "stop", "content": []}},
        {"type": "agent_end"}, {"type": "agent_settled"},
    ]
    name = "honest empty final"
    evts, p = wire_case(name, {"onStart": frames})
    types = [e.get("type") for e in evts]
    check(f"{name}: empty final turn_end passes verbatim at boundary",
          "turn_end" in types and types.index("turn_end") < types.index("agent_end"),
          str(types))


def case_partial_frame():
    line = json.dumps({"type": "turn_end", "message": {"stopReason": "stop",
                       "content": [{"type": "text", "text": "T"}]}})
    mid = len(line) // 2
    frames = [
        {"type": "turn_start"},
        {"chunks": [line[:mid], line[mid:], "\n"]},   # one frame, 3 writes
        {"type": "agent_end"},
    ]
    name = "split turn_end frame"
    evts, p = wire_case(name, {"onStart": frames})
    types = [e.get("type") for e in evts]
    check(f"{name}: reassembled turn_end verbatim before agent_end",
          types == ["turn_start", "turn_end", "agent_end"], str(types))


def case_double_turn_end():
    frames = [
        {"type": "turn_start"},
        {"type": "turn_end", "message": {"stopReason": "toolUse"}},
        {"type": "turn_end", "message": {"stopReason": "toolUse"}},
        {"type": "turn_start"},
        {"type": "turn_end", "message": {"stopReason": "stop",
         "content": [{"type": "text", "text": "final"}]}},
        {"type": "agent_end"},
    ]
    name = "consecutive turn_ends"
    evts, p = wire_case(name, {"onStart": frames})
    types = [e.get("type") for e in evts]
    check(f"{name}: back-to-back turn_ends demoted to boundary",
          types == ["turn_start", "turn_boundary", "turn_boundary",
                    "turn_start", "turn_end", "agent_end"], str(types))


def case_non_rpc_passthrough():
    print("wire: non-rpc passthrough")
    with tempfile.TemporaryDirectory() as td:
        w = Path(td)
        frames = [{"type": "turn_end", "message": {"stopReason": "toolUse"}},
                  {"type": "turn_start"}]
        stub = make_stub(w, {"onStart": frames})
        p = subprocess.run([str(SHIM), "-p", "hi"], capture_output=True, text=True,
                           env=shim_env(stub, w), timeout=30)
        evts = read_events(p.stdout)
        check("non-rpc: frames untouched (no boundary rewrite)",
              [e.get("type") for e in evts] == ["turn_end", "turn_start"],
              str([e.get("type") for e in evts]))


# --------------------------------------------------------------------------
# adapter-level cases (real installed PiAdapter)
# --------------------------------------------------------------------------

def load_adapter():
    sys.path.insert(0, str(PORCH_LIB))
    from steer.adapters.pi import PiAdapter  # noqa: E402
    return PiAdapter


def drive(a, timeout=20.0, until=None):
    """Poll adapter events until done or `until(events)` fires. Returns events."""
    events = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        for ev in a.poll_events():
            events.append(ev)
            if until and until(events):
                return events
        if a._done:
            for ev in a.poll_events():
                events.append(ev)
            return events
        time.sleep(0.01)
    return events


def turn1_frames():
    """Real captured frames up to and including the tool-use turn_end —
    run_stony-pine-8669 turn 1, verbatim."""
    frames = [json.loads(l) for l in FIXTURE.read_text().splitlines() if l.strip()]
    out = []
    for f in frames:
        out.append(f)
        if f.get("type") == "turn_end":
            break
    return [f for f in out if f.get("type") != "response"]


def success_tail(final_text="Done — VALUE = 42"):
    return [
        {"type": "turn_start", "turn": 2},
        {"type": "message_start", "message": {"role": "assistant"}},
        {"type": "message_update", "assistantMessageEvent":
            {"type": "text_delta", "delta": final_text}},
        {"type": "message_end", "message": {"role": "assistant"}},
        {"type": "turn_end", "message": {"stopReason": "stop",
            "content": [{"type": "text", "text": final_text}]}},
        {"type": "agent_end"},
        {"type": "agent_settled"},
    ]


def adapter_case(name, scenario, drive_fn, expect_fn):
    print(f"adapter: {name}")
    PiAdapter = load_adapter()
    with tempfile.TemporaryDirectory() as td:
        w = Path(td)
        stub = make_stub(w, scenario)
        art = w / "artifacts"
        env = shim_env(stub, w)
        os.environ.update({k: env[k] for k in
                           ("PI_RPC_BOUNDARY_REAL_CLI", "PI_RPC_BOUNDARY_ALLOW_ANY_PI",
                            "STUB_SCENARIO", "STUB_CMDLOG")})
        try:
            a = PiAdapter(binary=str(SHIM), model="", cwd=str(w),
                          artifacts_dir=str(art), agent_id="u7-boundary")
            a.start("implement the task")
            events = drive_fn(a)
            expect_fn(name, a, events, w)
        finally:
            try:
                a.close()
            except Exception:
                pass


def adapter_completes():
    scenario = {"onPrompt": [turn1_frames() + success_tail()]}

    def drive_fn(a):
        return drive(a)

    def expect(name, a, events, w):
        check(f"{name}: exit 0", a._exit_code == 0, f"exit={a._exit_code} err={a._error}")
        check(f"{name}: real final text", a.final_text() == "Done — VALUE = 42",
              repr(a.final_text()))
        done = [e for e in events if e.kind == "done"]
        check(f"{name}: exactly one done", len(done) == 1,
              [e.data for e in done])
        kinds = [e.data for e in events if e.kind == "turn_completed"]
        check(f"{name}: completion only at agent boundary",
              kinds == ["turn_end", "agent_end"], str(kinds))
        check(f"{name}: mid-loop turn_end surfaced as progress boundary",
              any(e.kind == "progress" and e.data == "turn_boundary" for e in events),
              str([e.kind + ':' + str(e.data) for e in events]))
        cmds = cmdlog(w)
        check(f"{name}: no abort sent by porch", "abort" not in cmds, str(cmds))
        # Identity: child_pid IS the pi process — same-process bootstrap.
        pid = a.child_pid()
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
            check(f"{name}: child_pid cmdline is the boundary process itself",
                  "pi-rpc-boundary" in cmdline, cmdline[:160])
            check(f"{name}: own process group", os.getpgid(pid) == pid,
                  f"pgid={os.getpgid(pid)} pid={pid}")
        except FileNotFoundError:
            check(f"{name}: child_pid existed (already reaped is acceptable)",
                  isinstance(pid, int) and pid > 0, str(pid))
    adapter_case("multi-tool turn completes", scenario, drive_fn, expect)


def adapter_cancel():
    # Turn 1 completes tool-use boundary; turn 2 starts and hangs (no further
    # frames) until abort arrives.
    scenario = {
        "onPrompt": [turn1_frames() + [{"type": "turn_start", "turn": 2}]],
        "onAbort": [
            {"type": "turn_end", "message": {"stopReason": "aborted", "content": []}},
            {"type": "agent_end"}, {"type": "agent_settled"},
        ],
    }

    def drive_fn(a):
        events = []
        def saw_boundary(evs):
            return any(e.kind == "progress" and e.data == "turn_boundary" for e in evs)
        events = drive(a, until=saw_boundary)
        a.cancel()
        events += [e for e in a.poll_events()]
        time.sleep(0.2)
        events += [e for e in a.poll_events()]
        return events

    def expect(name, a, events, w):
        check(f"{name}: cancelled exit 130", a._exit_code == 130,
              f"exit={a._exit_code} err={a._error}")
        cmds = cmdlog(w)
        check(f"{name}: abort reached pi stdin", "abort" in cmds, str(cmds))
    adapter_case("cancel mid second turn", scenario, drive_fn, expect)


def adapter_crash():
    scenario = {"onPrompt": [turn1_frames()],
                "exitAfter": 1, "exitCode": 1}

    def drive_fn(a):
        return drive(a)

    def expect(name, a, events, w):
        check(f"{name}: nonzero exit, never success", a._exit_code not in (None, 0),
              f"exit={a._exit_code}")
        check(f"{name}: honest error recorded",
              bool(a._error), f"err={a._error}")
    adapter_case("crash mid tool turn", scenario, drive_fn, expect)


def adapter_empty_final():
    tail = [
        {"type": "turn_end", "message": {"stopReason": "stop", "content": []}},
        {"type": "agent_end"}, {"type": "agent_settled"},
    ]
    scenario = {"onPrompt": [tail]}

    def drive_fn(a):
        return drive(a)

    def expect(name, a, events, w):
        check(f"{name}: empty final is honest failure", a._exit_code == 1,
              f"exit={a._exit_code}")
        check(f"{name}: error is empty final text",
              "empty" in (a._error or ""), repr(a._error))
    adapter_case("empty final stays failure", scenario, drive_fn, expect)


def adapter_interrupt_steer():
    # abort-for-steer: aborted turn_end + agent_end arrive while
    # _pending_interrupt>0; replacement prompt then runs to completion.
    scenario = {
        "onPrompt": [
            turn1_frames() + [{"type": "turn_start", "turn": 2}],
            [{"type": "turn_start", "turn": 3}] + success_tail("Steered — VALUE = 42"),
        ],
        "onAbort": [
            {"type": "turn_end", "message": {"stopReason": "aborted", "content": []}},
            {"type": "agent_end"}, {"type": "agent_settled"},
        ],
    }

    def drive_fn(a):
        events = drive(a, until=lambda evs: any(
            e.kind == "progress" and e.data == "turn_boundary" for e in evs))
        res = a.steer("replace with steered instruction", mode="interrupt",
                      client_id="steer-1")
        events += drive(a)
        marker = type("E", (), {})()
        marker.kind, marker.data, marker.raw = "steer_result", res.status, {"ok": res.ok}
        return events + [marker]

    def expect(name, a, events, w):
        cmds = cmdlog(w)
        check(f"{name}: abort + second prompt reached pi",
              cmds.count("abort") >= 1 and cmds.count("prompt") == 2, str(cmds))
        sr = [e for e in events if e.kind == "steer_result"]
        check(f"{name}: steer request_sent", bool(sr) and sr[0].raw.get("ok"),
              repr(sr[0].data if sr else None))
        # Honest either way upstream races; must never fake success on empty.
        if a._exit_code == 0:
            check(f"{name}: success carries real text", bool(a.final_text()),
                  repr(a.final_text()))
        else:
            check(f"{name}: failure is honest (not fabricated success)",
                  a._exit_code in (1, 130), f"exit={a._exit_code} err={a._error}")
    adapter_case("interrupt steer cycle", scenario, drive_fn, expect)


def adapter_identity_live():
    # Separate light case: identity while the child is actually running.
    print("adapter: live process identity")
    PiAdapter = load_adapter()
    with tempfile.TemporaryDirectory() as td:
        w = Path(td)
        stub = make_stub(w, {"onPrompt": [[{"type": "agent_start"},
                                           {"type": "turn_start"}]],
                             "onAbort": [{"type": "agent_end"}]})
        env = shim_env(stub, w)
        os.environ.update({k: env[k] for k in
                           ("PI_RPC_BOUNDARY_REAL_CLI", "PI_RPC_BOUNDARY_ALLOW_ANY_PI",
                            "STUB_SCENARIO", "STUB_CMDLOG")})
        a = PiAdapter(binary=str(SHIM), model="", cwd=str(w),
                      artifacts_dir=str(w / "a"), agent_id="u7-ident")
        a.start("hold")
        try:
            pid = a.child_pid()
            check("identity: pid alive", pid and Path(f"/proc/{pid}").exists(),
                  str(pid))
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
            check("identity: pid is boundary process (no wrapper child)",
                  "pi-rpc-boundary" in cmdline and "stub-cli" not in cmdline,
                  cmdline[:200])
            check("identity: own pgid (porch killpg reaches pi)",
                  os.getpgid(pid) == pid, f"pgid={os.getpgid(pid)}")
        finally:
            a.close()


# --------------------------------------------------------------------------

def main():
    if not FIXTURE.exists():
        print(f"fixture missing: {FIXTURE}", file=sys.stderr)
        return 2
    for f in (SHIM, WRAPPER):
        st = f.stat().st_mode
        check(f"{f.name} executable", bool(st & stat.S_IXUSR), oct(st))
    wire_only = "--wire-only" in sys.argv
    case_replay_capture()
    case_crash_no_agent_end()
    case_empty_final()
    case_partial_frame()
    case_double_turn_end()
    case_non_rpc_passthrough()
    if not wire_only:
        adapter_completes()
        adapter_cancel()
        adapter_crash()
        adapter_empty_final()
        adapter_interrupt_steer()
        adapter_identity_live()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURES:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("pi boundary selftest: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
