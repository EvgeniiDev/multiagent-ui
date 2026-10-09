"""Shared harness for the scripts/e2e_*.py suites.

Every suite starts what it needs itself; this module holds the common
pieces so they stop re-implementing them in different dialects:

  * `port_free` — True when nothing is LISTENING on the port. Asks
    `ss -ltn` (never a bare bind-probe): a port with only TIME_WAIT
    sockets left over from the previous run is FREE.
  * `serve_web(port, dist)` — serve `dist` over the production
    `server/web-server.py` (its SPA entry routes matter: the app
    navigates with history-mode URLs like `/chat?s=…`, which a bare
    `python -m http.server` would 404 on reload).
  * `serve_state(port, state_dir)` — spawn server/acp-state-server.mjs.

Both serve helpers take a PREFERRED port. When it is already taken (e.g.
a stale server from another worktree — a real hazard on shared hosts)
the next free port is used and a notice is printed: silently pointing
the suite at the foreign server would test someone else's build, and
refusing to run just moves the flake. The helpers return the actual
port/base URL, so callers must use the returned value, not the constant.
"""

import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
WEB_SERVER = ROOT / "server" / "web-server.py"
STATE_SERVER = ROOT / "server" / "acp-state-server.mjs"
PORT_SPAN = 50  # how far above the preferred port to scan for a free one


def listening_ports() -> set[int]:
    """Ports with a LISTEN socket, per `ss -ltn` (empty set if ss missing)."""
    try:
        out = subprocess.run(
            ["ss", "-ltn"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    ports = set()
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 4:
            try:
                ports.add(int(parts[3].rsplit(":", 1)[-1]))
            except ValueError:
                continue
    return ports


def port_free(port: int, listening: set[int] | None = None) -> bool:
    """True when nothing is LISTENING on `port` (TIME_WAIT is free)."""
    if listening is None:
        listening = listening_ports()
    if listening:
        return port not in listening
    # No `ss`: bind probe that tolerates TIME_WAIT leftovers.
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def wait_port(port: int, timeout: float = 10.0) -> bool:
    """Wait until something accepts TCP connections on `port`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def _candidates(preferred: int, span: int = PORT_SPAN) -> list[int]:
    listening = listening_ports()
    return [p for p in range(preferred, preferred + span + 1)
            if port_free(p, listening)]


def stop(proc: subprocess.Popen, timeout: float = 5.0) -> None:
    """Terminate a helper process; kill it if it ignores SIGTERM."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=timeout)


def serve_web(preferred: int, dist: Path | str = DIST):
    """Serve `dist` on a free port; returns (proc, base_url).

    `preferred` is used when free, else the first free port above it.
    Exits non-zero when no candidate port can be bound and served.
    """
    dist = Path(dist)
    if not (dist / "index.html").exists():
        print(f"FAIL  {dist} missing — run `npm run build:web` first")
        sys.exit(1)
    import os
    for port in _candidates(preferred):
        proc = subprocess.Popen(
            [sys.executable, str(WEB_SERVER)],
            cwd=str(dist),
            env={**os.environ, "PORT": str(port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}/"
        for _ in range(100):
            if proc.poll() is not None:
                break  # lost the bind race — try the next candidate port
            try:
                urllib.request.urlopen(base, timeout=1)
                if proc.poll() is None:
                    if port != preferred:
                        print(f"NOTE  port {preferred} busy — serving {dist} "
                              f"on {port} instead")
                    return proc, base
            except Exception:  # noqa: BLE001 — server not up yet
                time.sleep(0.1)
        stop(proc)
    print(f"FAIL  could not serve {dist} on any port "
          f"{preferred}..{preferred + PORT_SPAN}")
    sys.exit(1)


def serve_state(preferred: int, state_dir: Path | str):
    """Spawn server/acp-state-server.mjs on a free port; returns (proc, port).

    Same preferred-port policy as serve_web. `state_dir` is created by the
    caller (it owns wiping/seeding semantics).
    """
    import os
    for port in _candidates(preferred):
        proc = subprocess.Popen(
            ["node", str(STATE_SERVER)],
            env={**os.environ, "STATE_DIR": str(state_dir), "PORT": str(port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            if proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health", timeout=1)
                if proc.poll() is None:
                    if port != preferred:
                        print(f"NOTE  port {preferred} busy — state server "
                              f"on {port} instead")
                    return proc, port
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        stop(proc)
    print(f"FAIL  could not start acp-state-server on any port "
          f"{preferred}..{preferred + PORT_SPAN}")
    sys.exit(1)
