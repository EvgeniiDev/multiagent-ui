#!/usr/bin/env python3
"""E2E for the W14 request watchdog in server/acp-ws-bridge.mjs.

The old behaviour was a fixed 60 s RPC budget: a long agent turn was reported
as failed while the agent was still working. The bridge now watches TRAFFIC —
any JSON-RPC frame in either direction is progress — and fails a request only
after the wire has been silent for --idle-timeout-ms. The two failure modes
are worded differently: "no traffic for Ns" (wedged agent) vs "agent CLI
exited" (dead process).

No browser and no npm packages: the suite spawns the real bridge with a stub
CLI (a short Python program written to a temp dir) and speaks WebSocket to it
with a minimal pure-stdlib RFC 6455 client.

Scenarios (own ports 25973-25975):
  1. lively : the stub answers a session/prompt with session/update traffic
     every ~6 s and only sends the response after ~66 s — longer than the OLD
     60 s budget. The request must SUCCEED.
  2. silent : the stub answers nothing ever. The bridge must fail the request
     with an error whose message reads "no traffic for Ns", and the bridge log
     must show the same wording.
  3. exit   : the stub dies immediately after reading the request. The request
     must fail with "exited" wording and the log must show "child exited".

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py
"""

import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "server" / "acp-ws-bridge.mjs"
DEPLOYED = Path.home() / ".hermes" / "acp-ws-bridge.mjs"
NODE_PATH = "/home/hermes/.local/lib/node_modules"

PORT_LIVELY = 25973
PORT_SILENT = 25974
PORT_EXIT = 25975

IDLE_MS = 15000          # shortened idle limit for the test bridges
LIVELY_TICK_S = 6.0      # < IDLE; traffic keeps the request alive
LIVELY_TOTAL_S = 66.0    # > the old fixed 60 s budget

results: list[tuple[str, bool, str]] = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""), flush=True)


def port_free(port):
    """Nothing LISTENING on the port (a TIME_WAIT leftover is fine — ask the
    kernel, do not bind-probe)."""
    try:
        out = subprocess.run(["ss", "-ltn"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 4 and parts[3].rsplit(":", 1)[-1] == str(port):
            return False
    return True


# ---------------------------------------------------------------------------
# Minimal RFC 6455 WebSocket client (stdlib only)
# ---------------------------------------------------------------------------

class WsClient:
    def __init__(self, port, timeout=10.0):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                "Sec-WebSocket-Protocol: acp.v1\r\n\r\n"
            ).encode()
        )
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake eof")
            resp += chunk
        status = resp.split(b"\r\n", 1)[0]
        if b" 101" not in status:
            raise ConnectionError(f"handshake failed: {status!r}")

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("eof")
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        ln = len(payload)
        head = bytes([0x80 | opcode])
        if ln < 126:
            head += bytes([0x80 | ln])
        elif ln < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", ln)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", ln)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def send_text(self, text):
        self._send_frame(0x1, text.encode())

    def send_pong(self, payload=b""):
        self._send_frame(0xA, payload)

    def recv(self, timeout):
        """Return ('text', str) | ('close', (code, reason)) | None on timeout.
        Answers pings with pongs and reassembles fragmented messages."""
        self.sock.settimeout(timeout)
        frags = b""
        try:
            while True:
                h = self._read_exact(2)
                fin, op = h[0] & 0x80, h[0] & 0x0F
                masked, ln = h[1] & 0x80, h[1] & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", self._read_exact(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._read_exact(8))[0]
                mask = self._read_exact(4) if masked else None
                payload = self._read_exact(ln) if ln else b""
                if mask:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if op == 0x9:  # ping
                    self.send_pong(payload)
                    continue
                if op == 0x8:  # close
                    code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                    reason = payload[2:].decode("utf-8", "replace")
                    try:
                        self._send_frame(0x8, payload[:125])
                    except OSError:
                        pass
                    return ("close", (code, reason))
                if op in (0x1, 0x2, 0x0):
                    frags += payload
                    if fin:
                        return ("text", frags.decode("utf-8", "replace"))
        except (socket.timeout, TimeoutError):
            return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Stub CLI + bridge process management
# ---------------------------------------------------------------------------

STUB = '''\
import json, sys, time
mode, tick, total = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
line = sys.stdin.readline()
rid = 0
try:
    rid = json.loads(line).get("id", 0)
except Exception:
    pass
if mode == "exit":
    sys.exit(3)
if mode == "silent":
    time.sleep(3600)
elif mode == "lively":
    t0 = time.time()
    while time.time() - t0 < total:
        time.sleep(tick)
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": "s", "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text",
                            "text": "tick %.0f" % (time.time() - t0)}}}}),
              flush=True)
    print(json.dumps({"jsonrpc": "2.0", "id": rid,
                      "result": {"stopReason": "end_turn"}}), flush=True)
    time.sleep(10)
'''


def node_bin():
    return shutil.which("node") or "/home/hermes/.local/bin/node"


def spawn_bridge(port, stub, mode, tick=0.0, total=0.0, idle_ms=IDLE_MS):
    """Start server/acp-ws-bridge.mjs against the stub CLI. Returns
    (proc, log_path); the child CLI spawns lazily on the first WS client."""
    log = Path(tempfile.mkdtemp(prefix="e2e-bridge-")) / "bridge.log"
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_PATH
    cmd = f"{sys.executable} {stub} {mode} {tick} {total}"
    fh = open(log, "w")
    proc = subprocess.Popen(
        [node_bin(), str(BRIDGE), "--port", str(port), "--cmd", cmd,
         "--idle-timeout-ms", str(idle_ms)],
        stdout=fh, stderr=subprocess.STDOUT, env=env,
    )
    proc._log_fh = fh  # keep the handle alive with the process
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"bridge exited early: {log.read_text()[-500:]}")
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return proc, log
        except OSError:
            time.sleep(0.15)
    proc.kill()
    raise RuntimeError(f"bridge on :{port} did not start; log: {log.read_text()[-500:]}")


def stop_bridge(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def request_frame(rid=1):
    return json.dumps({
        "jsonrpc": "2.0", "id": rid, "method": "session/prompt",
        "params": {"sessionId": "s", "prompt": [{"type": "text", "text": "hi"}]},
    })


def collect(ws, rid, budget_s):
    """Read frames until the response for `rid` (or a close/timeout). Returns
    (response_msg|None, close_info|None, notifications, elapsed)."""
    t0 = time.time()
    notes, response, closed = [], None, None
    while time.time() - t0 < budget_s:
        item = ws.recv(max(0.5, budget_s - (time.time() - t0)))
        if item is None:
            break
        kind, payload = item
        if kind == "close":
            closed = payload
            break
        for line in payload.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("method") == "session/update":
                notes.append(msg)
            elif msg.get("id") == rid and "method" not in msg:
                response = msg
                return response, closed, notes, time.time() - t0
    return response, closed, notes, time.time() - t0


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def scenario_lively(stub):
    """Traffic every ~6 s for 66 s: outlives the old fixed 60 s budget and
    must SUCCEED because the wire never goes idle."""
    if not port_free(PORT_LIVELY):
        check("lively: port free", False, f":{PORT_LIVELY} listening")
        return
    proc, log = spawn_bridge(PORT_LIVELY, stub, "lively",
                             LIVELY_TICK_S, LIVELY_TOTAL_S)
    try:
        ws = WsClient(PORT_LIVELY)
        ws.send_text(request_frame(1))
        response, closed, notes, elapsed = collect(ws, 1, budget_s=90)
        ws.close()
        check("lively: request succeeds past the old 60 s budget",
              response is not None and "error" not in response
              and response.get("result", {}).get("stopReason") == "end_turn",
              f"elapsed={elapsed:.1f}s response={json.dumps(response)[:160]}")
        check("lively: actually ran longer than 60 s", elapsed > 60,
              f"elapsed={elapsed:.1f}s")
        check("lively: progress traffic flowed meanwhile", len(notes) >= 3,
              f"session/update notifications seen: {len(notes)}")
        check("lively: socket stayed open (no wedged-kill)", closed is None,
              f"closed={closed}")
        time.sleep(0.3)  # let the log flush
        check("lively: no watchdog fire in bridge log",
              "watchdog:" not in log.read_text(),
              "\n".join(log.read_text().splitlines()[-4:]))
    finally:
        stop_bridge(proc)


def scenario_silent(stub):
    """No output at all: the bridge must fail the pending request with the
    'no traffic for Ns' wording and log the same."""
    if not port_free(PORT_SILENT):
        check("silent: port free", False, f":{PORT_SILENT} listening")
        return
    proc, log = spawn_bridge(PORT_SILENT, stub, "silent")
    try:
        ws = WsClient(PORT_SILENT)
        ws.send_text(request_frame(1))
        response, closed, notes, elapsed = collect(ws, 1, budget_s=45)
        # The watchdog SIGKILLs the wedged child; its exit then closes the
        # socket. Give the close frame a moment to arrive.
        if closed is None and response is not None:
            item = ws.recv(15)
            if item is not None and item[0] == "close":
                closed = item[1]
        ws.close()
        msg = str((response or {}).get("error", {}).get("message", ""))
        check("silent: request failed with 'no traffic for Ns' wording",
              response is not None and re.search(r"no traffic for \d+s", msg) is not None,
              f"elapsed={elapsed:.1f}s msg={msg[:120]!r}")
        check("silent: failure arrived near the idle limit, not at 60 s",
              0 < elapsed < 40, f"elapsed={elapsed:.1f}s")
        check("silent: wedged child kill closed the socket",
              closed is not None, f"closed={closed}")
        time.sleep(0.3)
        check("silent: bridge log distinguishes the idle kill",
              re.search(r"watchdog: no traffic for \d+s", log.read_text()) is not None,
              "\n".join(log.read_text().splitlines()[-4:]))
    finally:
        stop_bridge(proc)


def scenario_exit(stub):
    """The CLI dies right after reading the request: the failure must read
    'exited', not 'no traffic' — in the error, the close reason, and the log."""
    if not port_free(PORT_EXIT):
        check("exit: port free", False, f":{PORT_EXIT} listening")
        return
    proc, log = spawn_bridge(PORT_EXIT, stub, "exit")
    try:
        ws = WsClient(PORT_EXIT)
        ws.send_text(request_frame(1))
        # read until the close frame (error response precedes it)
        t0, response, closed = time.time(), None, None
        while time.time() - t0 < 20 and closed is None:
            item = ws.recv(10)
            if item is None:
                continue
            kind, payload = item
            if kind == "close":
                closed = payload
                break
            for line in payload.split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("id") == 1 and "method" not in msg:
                    response = msg
        ws.close()
        msg = str((response or {}).get("error", {}).get("message", ""))
        check("exit: request failed with 'exited' wording",
              response is not None and "exited" in msg,
              f"msg={msg[:120]!r}")
        check("exit: socket close reason says the child exited",
              closed is not None and "exited" in closed[1],
              f"closed={closed}")
        time.sleep(0.3)
        check("exit: bridge log shows 'child exited'",
              "child exited" in log.read_text(),
              "\n".join(log.read_text().splitlines()[-4:]))
        check("exit: failure is NOT the idle wording",
              "no traffic" not in msg, f"msg={msg[:120]!r}")
    finally:
        stop_bridge(proc)


def main():
    if not BRIDGE.is_file():
        print(f"FAIL  {BRIDGE} missing")
        return 1
    check("repo bridge copy matches the deployed file",
          DEPLOYED.is_file() and BRIDGE.read_bytes() == DEPLOYED.read_bytes(),
          f"{BRIDGE} vs {DEPLOYED}")
    with tempfile.TemporaryDirectory(prefix="e2e-bridge-stub-") as td:
        stub = Path(td) / "stub_cli.py"
        stub.write_text(STUB)
        scenario_lively(stub)
        scenario_silent(stub)
        scenario_exit(stub)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} assertions passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
