"""Compose-backed harness for U7 e2e suites — replaces _e2e_harness.py.

Runtime rules (AGENTS.md): services exist ONLY via docker compose on the
fixed ports. This module therefore:

  * NEVER spawns `node`/`python -m http.server` or any listener itself;
  * NEVER scans for or falls back to an adjacent port — the fixed port is
    either owned by the test stack or the suite fails closed;
  * REFUSES every state-changing helper until it has proven the server on
    the fixed port is the isolated U7 instance. Proof = BOTH:
      - `GET /health` reports `dir` == the exact test STATE_DIR, and
      - `GET /api/state/u7-test-marker.json` returns the marker whose
        `nonce` equals the value SEEDED ON DISK before transition
        (scripts/u7_transition.py writes the doc file directly into the
        test STATE_DIR; the marker never enters via HTTP, so a live or
        foreign server can never satisfy this check).

No environment overrides for ports/project/state — the fixed ownership
map is the contract, and an env knob would be an adjacent-port loophole.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "acp-ui"
COMPOSE_FILES = [ROOT / "compose.yaml", ROOT / "compose.u7.yaml"]
STATE_URL = "http://127.0.0.1:25900"
WEB_URL = "http://127.0.0.1:25808/"

# Isolated test state root — must equal compose.u7.yaml state.STATE_DIR and
# the value /health reports back.
TEST_STATE_DIR = Path("/home/hermes/.hermes/acp-ui-state-u7")
MARKER_DOC = "u7-test-marker.json"
MARKER_FILE = TEST_STATE_DIR / f"{MARKER_DOC}.json"   # doc name + ".json"

# Services the managed-execution suites need on their fixed ports.
REQUIRED = ("state", "runner", "web")

_verified = False


class HarnessError(RuntimeError):
    """Failed-closed precondition — the suite must not run."""


def _run(cmd: list[str], timeout: float = 20.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def compose(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    """docker compose pinned to the ONE owner project and the test overlay."""
    cmd = ["docker", "compose", "-p", PROJECT]
    for f in COMPOSE_FILES:
        cmd += ["-f", str(f)]
    return _run(cmd + list(args), timeout=timeout)


def service_running(name: str) -> bool:
    """True when the service is running under the owner project."""
    res = compose("ps", "--status", "running", "--format", "json", name)
    if res.returncode != 0:
        raise HarnessError(f"docker compose ps {name}: {res.stderr.strip()}")
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("Service") == name or row.get("Name", "").endswith(
                f"-{name}-1"):
            return row.get("State", "").lower() == "running"
    return False


def http_json(method: str, url: str, body=None, timeout: float = 8.0):
    """(status, parsed-json|raw-text). Never raises for HTTP errors."""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw.decode("utf-8", "replace")
    except OSError as e:
        raise HarnessError(f"{method} {url}: {e}") from e


def wait_http(url: str, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                return True
        except Exception:  # noqa: BLE001 — not up yet
            time.sleep(0.1)
    return False


def state_url() -> str:
    return STATE_URL


def web_url() -> str:
    return WEB_URL


def expected_marker():
    """The nonce/identity the isolated server MUST report, read from the
    on-disk seed — never from HTTP, so a foreign responder cannot pass."""
    try:
        raw = json.loads(MARKER_FILE.read_text())
    except OSError as e:
        raise HarnessError(
            f"test marker not seeded on disk ({MARKER_FILE}: {e}) — "
            "run scripts/u7_transition.py plan first") from e
    except json.JSONDecodeError as e:
        raise HarnessError(f"test marker file corrupt: {e}") from e
    data = raw.get("data") or {}
    if data.get("stateDir") != "acp-ui-state-u7" or not data.get("nonce"):
        raise HarnessError("test marker file present but malformed")
    return {"nonce": data["nonce"], "rev": raw.get("rev")}


def verify_isolation() -> None:
    """Prove the fixed-port server is the isolated U7 state instance.

    Both legs are required: /health reports the exact test dir (effective
    env of the running process, not a label), and the marker doc returns
    the nonce that was seeded on disk before transition — a live/foreign
    server fails at least one of them by construction.
    """
    global _verified
    status, health = http_json("GET", f"{STATE_URL}/health")
    if status != 200 or not isinstance(health, dict) \
            or health.get("dir") != str(TEST_STATE_DIR):
        raise HarnessError(
            f"/health reports dir={health.get('dir') if isinstance(health, dict) else health!r} "
            f"(status {status}), expected {TEST_STATE_DIR} — refusing to "
            "touch a foreign/live state server")
    status, body = http_json("GET", f"{STATE_URL}/api/state/{MARKER_DOC}")
    want = expected_marker()
    got = body.get("data") if isinstance(body, dict) else None
    if status != 200 or not isinstance(got, dict) \
            or got.get("nonce") != want["nonce"] \
            or got.get("stateDir") != "acp-ui-state-u7":
        raise HarnessError(
            f"marker {MARKER_DOC} missing/mismatched over HTTP "
            f"(status={status}) — refusing to run against this server")
    _verified = True


def require_stack(services=REQUIRED, timeout: float = 15.0) -> None:
    """Fail closed unless the fixed-port test stack is up AND isolated."""
    try:
        for svc in services:
            if not service_running(svc):
                raise HarnessError(
                    f"service {svc} not running in project {PROJECT}")
        if not wait_http(f"{STATE_URL}/health", timeout):
            raise HarnessError(
                f"{STATE_URL}/health did not answer in {timeout}s")
        verify_isolation()
        if not wait_http(WEB_URL, timeout):
            raise HarnessError(f"{WEB_URL} did not answer in {timeout}s")
    except HarnessError as e:
        print(f"FAIL  {e}")
        sys.exit(1)


def _guarded() -> None:
    """Every state-changing helper goes through the live proof each call —
    a process that raced a restore hits the fresh marker check, not a
    stale latch."""
    verify_isolation()


def get_doc(name: str, timeout: float = 8.0):
    """GET /api/state/<name> -> (status, body)."""
    return http_json("GET", f"{STATE_URL}/api/state/{name}",
                     timeout=timeout)


def seed_doc(name: str, data, rev: int | None = None, timeout: float = 8.0):
    """PUT /api/state/<name> {data, rev?} — only into verified test state."""
    _guarded()
    payload = {"data": data}
    if rev is not None:
        payload["rev"] = rev
    return http_json("PUT", f"{STATE_URL}/api/state/{name}",
                     body=payload, timeout=timeout)


def post(url_path: str, body=None, timeout: float = 15.0):
    """POST <STATE_URL><url_path> — guarded like seed_doc."""
    _guarded()
    return http_json("POST", f"{STATE_URL}{url_path}", body=body,
                     timeout=timeout)


def exec_in(service: str, *cmd: str, timeout: float = 60.0):
    """`docker compose exec -T <service> <cmd...>` — CompletedProcess."""
    return compose("exec", "-T", service, *cmd, timeout=timeout)


def proc_rows(service: str) -> list[str]:
    """Process rows inside the container via `docker top` — stable columns
    (UID PID PPID C STIME TTY TIME CMD), no service/name section headers."""
    res = _run(["docker", "top", f"{PROJECT}-{service}-1"], timeout=20)
    if res.returncode != 0:
        raise HarnessError(f"docker top {service}: {res.stderr.strip()}")
    return [ln for ln in res.stdout.splitlines()[1:] if ln.strip()]


def only_service_process(service: str, proc_name: str) -> bool:
    """True when the container runs exactly one process and it is
    proc_name — i.e. no spawned agent/check children."""
    rows = proc_rows(service)
    return len(rows) == 1 and proc_name in rows[0]
