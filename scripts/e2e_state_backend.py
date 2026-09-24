#!/usr/bin/env python3
"""E2E for the shared-state backend in src/lib/host/storage.ts.

The web panel probes `http://<hostname>:25900/health` once per session and,
when it answers, reads/writes every KV document (sessions.json,
projects.json, preferences.json, ...) through the state server. This test
proves that end-to-end with two independent browser contexts — a "laptop"
and a "phone" — plus a third context for the server-down fallback.

Setup:
  * a real `server/acp-state-server.mjs` runs with
    STATE_DIR=<worktree>/tmp-state-test PORT=25908 (test data stays inside
    the worktree; the production :25900 instance is untouched);
  * the `dist-web` bundle is served on http://127.0.0.1:25982/;
  * each context routes `**:25900/**` to the test server — the app exercises
    its production code path (probe on :25900) while the bytes land on
    :25908 — except context C, whose route answers 500 to force the
    localStorage fallback.

Asserted:
  A (laptop): session sync pushes sessions.json to the server; the seeded
    projects/preferences documents are migrated up on first contact.
  server: a marker session + a `Gamma` project are PUT directly into the
    shared documents (state only the server can know).
  B (phone): clean profile — the sidebar shows the marker session and the
    scope selector shows `Gamma`, i.e. B read A's server-side state; B's
    localStorage mirror and the server document agree key-for-key.
  C: `:25900` -> 500 — the panel still boots, lists sessions, shows the
    seeded registry and persists scope changes to localStorage, all with
    zero `pageerror`.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_state_backend.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_state, serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
STATE_DIR = ROOT / "tmp-state-test"
WEB_PORT = 25982                 # preferred; harness falls back when busy
BASE = f"http://127.0.0.1:{WEB_PORT}/"      # rebased in main()
PROD_STATE_PORT = 25900          # the port the panel probes
STATE_PORT = 25908               # the test server actually listening
STATE_API = f"http://127.0.0.1:{STATE_PORT}/api/state"  # rebased in main()

ALPHA_PATH = "/home/hermes/projects/alpha"
BETA_PATH = "/home/hermes/projects/beta"
COMMON_PATH = "/home/hermes/projects"

MARKER_TITLE = "shared from laptop"
GAMMA = {"id": "p-gamma", "name": "Gamma", "path": BETA_PATH + "/gamma",
         "createdAt": 1700000003000}

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fixtures — same mocked agent + registry as scripts/e2e_project_scope.py
# --------------------------------------------------------------------------

def session_infos():
    now = int(time.time() * 1000)

    def iso(ms):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))

    return [
        {"sessionId": "sess-alpha-1", "cwd": ALPHA_PATH,
         "title": "alpha one", "updatedAt": iso(now - 3600_000)},
        {"sessionId": "sess-alpha-2", "cwd": ALPHA_PATH + "/sub",
         "title": "alpha two", "updatedAt": iso(now - 2 * 3600_000)},
        {"sessionId": "sess-beta-1", "cwd": BETA_PATH,
         "title": "beta one", "updatedAt": iso(now - 3 * 3600_000)},
        {"sessionId": "sess-loose-1", "cwd": COMMON_PATH + "/loose",
         "title": "loose work", "updatedAt": iso(now - 4 * 3600_000)},
        {"sessionId": "sess-orphan-1", "cwd": "/opt/outside",
         "title": "orphan job", "updatedAt": iso(now - 5 * 3600_000)},
    ]


FIXTURE_TITLES = sorted(i["title"] for i in session_infos())

REGISTRY = {
    "version": 1,
    "projects": [
        {"id": "p-common", "name": "Common", "path": COMMON_PATH,
         "createdAt": 1700000000000},
        {"id": "p-alpha", "name": "Alpha", "path": ALPHA_PATH,
         "createdAt": 1700000001000},
        {"id": "p-beta", "name": "Beta", "path": BETA_PATH,
         "createdAt": 1700000002000},
    ],
    "activeProjectId": "all",
}


def acp_ws(ws):
    """Answer the app's ACP JSON-RPC as a minimal agent (no real server)."""
    def on_message(message):
        for line in str(message).split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                continue
            if not isinstance(req, dict) or "method" not in req or req.get("id") is None:
                continue  # notification (e.g. $/ping heartbeat)
            method = req["method"]
            if method == "initialize":
                result = {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": True,
                        "sessionCapabilities": {"list": {}},
                    },
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                result = {"sessionId": "e2e-new-session"}
            elif method == "session/list":
                result = {"sessions": session_infos()}
            elif method == "session/load":
                result = {}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker."""
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    elif "/api/fs/mkdir" in route.request.url:
        body = {"path": "/home/hermes/projects", "created": True}
    else:
        body = {
            "path": "/home/hermes",
            "parent": "/home",
            "root": "/home/hermes",
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def proxy_state(route):
    """Forward the panel's :25900 state calls to the test server on :25908."""
    url = route.request.url.replace(f":{PROD_STATE_PORT}", f":{STATE_PORT}", 1)
    route.continue_(url=url)


def down_state(route):
    """Every state call fails -> the panel must fall back to localStorage."""
    route.fulfill(status=500, content_type="application/json",
                  body=json.dumps({"error": "state server down"}))


def seed(context, with_registry=True):
    """localStorage: one ws agent + telemetry off (+ the projects registry).

    `acp-ui:agents` is not a KV document (the config layer owns it), so every
    context needs it locally; the KV documents are what the server shares.
    """
    agents = {
        "agents": {
            "E2E Mock": {"transport": "websocket", "url": "ws://127.0.0.1:25993/"},
        }
    }
    pairs = [
        ("acp-ui:agents", agents),
        ("acp-ui:preferences.json", {"telemetryEnabled": False}),
    ]
    if with_registry:
        pairs.append(("acp-ui:projects.json", REGISTRY))
    for key, val in pairs:
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def wire(page, state_route):
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.route(re.compile(r":25900/"), state_route)
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)


# --------------------------------------------------------------------------
# Tiny state-server client (stdlib urllib)
# --------------------------------------------------------------------------

def start_servers():
    """Spawn the suite's own state server + web server on free ports."""
    global BASE, STATE_PORT, STATE_API
    shutil.rmtree(STATE_DIR, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)
    state, STATE_PORT = serve_state(STATE_PORT, STATE_DIR)
    STATE_API = f"http://127.0.0.1:{STATE_PORT}/api/state"
    web, BASE = serve_web(WEB_PORT, DIST)
    return state, web


def api(path="", method="GET", body=None):
    req = urllib.request.Request(
        STATE_API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def wait_for_doc(name, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body = api(f"/{name}")
        if status == 200:
            return body
        time.sleep(0.25)
    return None


def scope_options(page):
    return page.eval_on_selector_all(
        ".scope-select option", "els => els.map(e => e.textContent.trim())"
    )


def session_titles(page):
    return sorted(
        page.eval_on_selector_all(
            ".session-row .row-title", "els => els.map(e => e.textContent.trim())"
        )
    )


def stored(page, key):
    raw = page.evaluate(f"() => localStorage.getItem({json.dumps(key)})")
    return json.loads(raw) if raw else None


# --------------------------------------------------------------------------
# The two devices + the offline leg
# --------------------------------------------------------------------------

def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ------------- context A — the laptop ------------------------------
        a = browser.new_context(ignore_https_errors=True,
                                viewport={"width": 1440, "height": 900})
        seed(a)
        pa = a.new_page()
        wire(pa, proxy_state)
        pa.goto(BASE, wait_until="load")
        pa.wait_for_selector(".scope-select", timeout=10000)
        pa.wait_for_selector(".session-row", timeout=10000)
        check("A: session list synced through mocked agent",
              session_titles(pa) == FIXTURE_TITLES, ",".join(session_titles(pa)))

        sessions_doc = wait_for_doc("sessions.json")
        check("A: sessions.json reached the state server",
              sessions_doc is not None)
        titles = sorted(
            s.get("title", "") for s in (sessions_doc or {}).get("data", {}).get("sessions", [])
        )
        check("A: server sessions.json holds the synced inventory",
              titles == FIXTURE_TITLES, ",".join(titles))

        projects_doc = wait_for_doc("projects.json")
        check("A: localStorage projects.json migrated to the server",
              projects_doc is not None)
        names = sorted(
            pr.get("name", "") for pr in (projects_doc or {}).get("data", {}).get("projects", [])
        )
        check("A: server projects.json carries the seeded registry",
              names == ["Alpha", "Beta", "Common"], ",".join(names))

        check("A: preferences.json migrated to the server",
              wait_for_doc("preferences.json") is not None)

        # State only the server can know: a session row and a project that
        # no browser localStorage ever held.
        marker = {
            "id": "marker-0001", "agentName": "E2E Mock",
            "sessionId": "sess-marker-1", "title": MARKER_TITLE,
            "lastUpdated": int(time.time() * 1000), "cwd": ALPHA_PATH,
            "supportsLoadSession": True, "origin": "agent",
        }
        sdata = sessions_doc["data"]
        sdata["sessions"] = sdata.get("sessions", []) + [marker]
        st, _ = api("/sessions.json", method="PUT", body={"data": sdata})
        check("setup: marker session PUT into shared sessions.json", st == 200)
        pdata = projects_doc["data"]
        pdata["projects"] = pdata.get("projects", []) + [GAMMA]
        st, _ = api("/projects.json", method="PUT", body={"data": pdata})
        check("setup: Gamma project PUT into shared projects.json", st == 200)

        # ------------- context B — the phone (clean profile) ---------------
        b = browser.new_context(ignore_https_errors=True,
                                viewport={"width": 1440, "height": 900})
        seed(b, with_registry=False)   # no projects.json in localStorage
        pb = b.new_page()
        wire(pb, proxy_state)
        pb.goto(BASE, wait_until="load")
        pb.wait_for_selector(".scope-select", timeout=10000)
        pb.wait_for_selector(".session-row", timeout=10000)
        pb.wait_for_timeout(400)

        check("B: sidebar shows the server-only marker session",
              session_titles(pb) == sorted(FIXTURE_TITLES + [MARKER_TITLE]),
              ",".join(session_titles(pb)))
        check("B: scope selector shows server-only project Gamma",
              scope_options(pb) == ["All", "Common", "Alpha", "Beta", "Gamma"],
              ",".join(scope_options(pb)))

        mirror_sessions = stored(pb, "acp-ui:sessions.json") or {}
        mirror_titles = sorted(s.get("title", "") for s in mirror_sessions.get("sessions", []))
        check("B: localStorage mirror of sessions.json matches server state",
              MARKER_TITLE in mirror_titles, ",".join(mirror_titles))
        mirror_projects = stored(pb, "acp-ui:projects.json") or {}
        mirror_names = sorted(pr.get("name", "") for pr in mirror_projects.get("projects", []))
        check("B: localStorage mirror of projects.json matches server state",
              mirror_names == ["Alpha", "Beta", "Common", "Gamma"],
              ",".join(mirror_names))

        # B and the server agree on every shared document key-for-key.
        st, remote_sessions = api("/sessions.json")
        remote_titles = sorted(
            s.get("title", "") for s in remote_sessions.get("data", {}).get("sessions", [])
        )
        check("B: server sessions.json still matches the shared inventory",
              st == 200 and remote_titles == mirror_titles)
        st, remote_projects = api("/projects.json")
        remote_names = sorted(
            pr.get("name", "") for pr in remote_projects.get("data", {}).get("projects", [])
        )
        check("B: server projects.json still matches the shared registry",
              st == 200 and remote_names == mirror_names)

        a.close()
        b.close()

        # ------------- context C — server unreachable ----------------------
        c = browser.new_context(ignore_https_errors=True,
                                viewport={"width": 1440, "height": 900})
        seed(c)
        pc = c.new_page()
        wire(pc, down_state)
        pc.goto(BASE, wait_until="load")
        pc.wait_for_selector(".scope-select", timeout=10000)
        pc.wait_for_selector(".session-row", timeout=10000)
        check("C (server down): sidebar still syncs via the agent",
              session_titles(pc) == FIXTURE_TITLES, ",".join(session_titles(pc)))
        check("C (server down): seeded registry read from localStorage",
              scope_options(pc) == ["All", "Common", "Alpha", "Beta"],
              ",".join(scope_options(pc)))
        pc.select_option(".scope-select", label="Alpha")
        pc.wait_for_timeout(300)
        stored_scope = (stored(pc, "acp-ui:projects.json") or {}).get("activeProjectId")
        check("C (server down): writes persist to localStorage",
              stored_scope == "p-alpha", str(stored_scope))
        c.close()

        browser.close()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    state, web = start_servers()
    try:
        run_checks()
    finally:
        stop(state)
        stop(web)
        shutil.rmtree(STATE_DIR, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
