#!/usr/bin/env python3
"""E2E: the panel must be fully usable over HTTPS — zero mixed content.

The panel uses LAN service ports (state :25900, bridges :25901-4,
transcriber API :8099). Over https:// state and bridges use TLS twins on
`https-front`; the transcriber API is proxied through TLS port :25906.
`src/lib/host/secure.ts` handles the panel's state and bridge rules.

This suite exercises the REAL pieces, nothing re-implemented:

  * `server/https-front.mjs` runs with `ACP_FRONT_TARGETS` pointing its
    listen ports at this suite's stub upstreams;
  * the panel bundle (`dist-web`) is served over plain http by python's
    `http.server`, and reached over TLS THROUGH that front;
  * the shared-state stub is the real `server/acp-state-server.mjs` with its
    own STATE_DIR; the bridge stub (`scripts/https_panel_stubs.mjs`) answers
    `/api/fs/*` and completes a real ACP handshake over ws; the transcriber
    stub answers `/openapi.json` and the transcription path.

The one shim is a tiny CONNECT proxy the browser is pointed at
(`proxy={server}` launch option). The page and every fetch/ws keep their
production URLs — `https://acp.local:25809/`, `https://acp.local:25910`,
`wss://acp.local:25911/` — while the proxy relays the TCP hop to this
suite's own listeners:

    acp.local:25809 -> PANEL_TLS   acp.local:25808 -> PANEL_UP
    acp.local:25910 -> STATE_TLS   acp.local:25900 -> STATE_UP
    acp.local:25911..25914 -> BRIDGE_TLS   acp.local:25901..25904 -> BRIDGE_UP
    acp.local:25906 -> STT_TLS     acp.local:8099 -> STT_UP

The production ports on this host are never touched: nothing the browser
opens leaves the proxy except to the mapped test sockets.

Asserted, https leg (page at https://acp.local:25809/):
  * secure context; seeded agents dial `wss://acp.local:25911/` — the stub
    logs the real upgrade that traversed the front's wsProxy;
  * `sessions.json` loaded through the front drives a session restore
    (transcript marker rendered);
  * `board.json` loaded through the front renders its card in the Board
    view (not just a URL check);
  * the transcriber probe fetches `https://acp.local:25906/openapi.json`;
  * ZERO requests/ws to `http://` or `ws://` (the mixed-content proof);
  * zero pageerrors.

Asserted, http control leg (page at http://acp.local:25808/):
  * the panel still builds `http://acp.local:8099/openapi.json` for the
    transcription probe and `ws://acp.local:25901/` for the agent;
  * the same restore + board assertions hold over plain http;
  * no `https://`/`wss://` requests to service ports at all.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_https_panel.py
"""

import json
import os
import re
import select
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import (
    listening_ports, port_free, serve_state, serve_web, stop, wait_port,
)

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
FRONT = ROOT / "server" / "https-front.mjs"
STUBS = ROOT / "scripts" / "https_panel_stubs.mjs"
TLS_DIR = Path.home() / ".hermes" / "acp-tls"
WORK = ROOT / "tmp-https-e2e"
STATE_DIR = WORK / "state"
MARKER_FILE = WORK / "stub-markers.log"

HOST = "acp.local"
AGENT = "Hermes Agent"          # first BRIDGE_PORTS entry: 25901 -> wss 25911
SID = "e2e-https-session"
SAVED_ID = "saved-https-1"
TRANSCRIPT = "HTTPS-TRANSCRIPT-MARKER"
CARD_TITLE = "HTTPS-BOARD-MARKER"

# Preferred test ports; each `pick_port` call shifts up when busy.
PREF = {
    "panel_up": 26980, "panel_tls": 26981,
    "state_up": 26982, "state_tls": 26983,
    "bridge_up": 26984, "bridge_tls": 26985,
    "stt_up": 26986, "stt_tls": 26987,
    "proxy": 26988,
}

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def pick_port(preferred: int) -> int:
    listening = listening_ports()
    for p in range(preferred, preferred + 51):
        if port_free(p, listening):
            return p
    print(f"FAIL  no free port in {preferred}..{preferred + 50}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# CONNECT proxy — the only shim. Chromium sends `CONNECT acp.local:PORT`
# (https/wss) or an absolute-URI request (http/ws) for every fetch; we map the
# production port to the suite's listener and pipe raw TCP both ways.
# ---------------------------------------------------------------------------

class PortProxy:
    def __init__(self, listen_port: int, mapping: dict[int, int]):
        self.mapping = mapping
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", listen_port))
        self.sock.listen(64)
        self.sock.settimeout(1.0)
        self.alive = True
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    def _accept(self):
        while self.alive:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _map(self, port: int) -> int:
        return self.mapping.get(port, port)

    def _handle(self, conn: socket.socket):
        try:
            conn.settimeout(20)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
                if len(data) > 1 << 20:
                    return
            head, sep, rest = data.partition(b"\r\n\r\n")
            first = head.split(b"\r\n", 1)[0]
            parts = first.split(b" ")
            method, target = parts[0], parts[1] if len(parts) > 1 else b""

            if method == b"CONNECT":
                host, _, port_b = target.rpartition(b":")
                if host.decode(errors="replace") != HOST:
                    conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                    return
                upstream = socket.create_connection(
                    ("127.0.0.1", self._map(int(port_b))), 5)
                conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if rest:
                    upstream.sendall(rest)
            else:
                # Plain http/ws arrive as absolute-URI requests. Rewrite the
                # request line to origin-form — the python http.server and
                # the node stubs only understand `GET /path`, and a correct
                # forward proxy sends origin-form to the upstream anyway.
                m = re.match(rb"https?://([^/:]+)(?::(\d+))?(/[^ ]*)?$", target)
                if not m or m.group(1).decode(errors="replace") != HOST:
                    conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                    return
                port = int(m.group(2)) if m.group(2) else 80
                path = m.group(3) or b"/"
                upstream = socket.create_connection(
                    ("127.0.0.1", self._map(port)), 5)
                head_rest = head.split(b"\r\n", 1)[1] if b"\r\n" in head else b""
                upstream.sendall(
                    b" ".join([method, path, parts[2]]) + b"\r\n" +
                    head_rest + sep + rest)

            conn.settimeout(None)
            upstream.settimeout(None)
            self._relay(conn, upstream)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _relay(self, a: socket.socket, b: socket.socket):
        deadline = time.time() + 180
        while time.time() < deadline:
            try:
                r, _, _ = select.select([a, b], [], [], 30)
            except Exception:
                break
            if not r:
                break
            for s in r:
                try:
                    d = s.recv(65536)
                except OSError:
                    return
                if not d:
                    return
                other = b if s is a else a
                try:
                    other.sendall(d)
                except OSError:
                    return
        try:
            b.close()
        except Exception:
            pass

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def seed_state_docs(state_port: int):
    """Put the board + sessions + preferences docs on the stub state server —
    straight to its plain-http upstream (fixture setup, not the thing under
    test). The page must read them back through the TLS front."""
    def put(name, data):
        req = urllib.request.Request(
            f"http://127.0.0.1:{state_port}/api/state/{name}",
            method="PUT",
            data=json.dumps({"data": data}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status

    now = int(time.time() * 1000)
    check("setup: sessions.json seeded",
          put("sessions.json", {
              "sessions": [{
                  "id": SAVED_ID, "agentName": AGENT, "sessionId": SID,
                  "title": "https restore", "lastUpdated": now,
                  "cwd": "/home/hermes", "supportsLoadSession": True,
                  "origin": "agent",
              }],
              "currentSessionId": SAVED_ID,
              "lastAgent": AGENT,
          }) == 200)
    check("setup: board.json seeded",
          put("board.json", {
              "version": 2,
              "cards": [{
                  "id": "card-https-1", "title": CARD_TITLE,
                  "stage": "backlog", "status": None, "order": 0,
                  "createdAt": now, "updatedAt": now,
              }],
          }) == 200)
    check("setup: preferences.json seeded",
          put("preferences.json", {"telemetryEnabled": False}) == 200)


def start_infra():
    """Spawn: dist over http, real state server, bridge+stt stubs, REAL front."""
    shutil.rmtree(WORK, ignore_errors=True)
    STATE_DIR.mkdir(parents=True)

    panel_up = pick_port(PREF["panel_up"])
    state_up = pick_port(PREF["state_up"])
    bridge_up = pick_port(PREF["bridge_up"])
    stt_up = pick_port(PREF["stt_up"])
    panel_tls = pick_port(PREF["panel_tls"])
    state_tls = pick_port(PREF["state_tls"])
    bridge_tls = pick_port(PREF["bridge_tls"])
    stt_tls = pick_port(PREF["stt_tls"])
    proxy_port = pick_port(PREF["proxy"])

    procs = {}

    # dist-web over plain http — the front's panel upstream.
    web, web_base = serve_web(panel_up, DIST)
    panel_up = int(web_base.rstrip("/").rsplit(":", 1)[1])
    procs["web"] = web

    # Real state server, isolated STATE_DIR.
    state, state_up = serve_state(state_up, STATE_DIR)
    procs["state"] = state

    # Stub bridge (HTTP /api/fs/* + WS ACP) and stub STT (/health).
    env = dict(os.environ, BRIDGE_PORT=str(bridge_up), STT_PORT=str(stt_up),
               MARKER_FILE=str(MARKER_FILE))
    stubs = subprocess.Popen(
        ["node", str(STUBS)], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    procs["stubs"] = stubs
    if not (wait_port(bridge_up) and wait_port(stt_up)):
        print("FAIL  stub servers did not bind")
        sys.exit(1)

    # The REAL terminator: test listen ports -> test upstreams.
    targets = {
        str(panel_tls): panel_up,
        str(state_tls): state_up,
        str(bridge_tls): bridge_up,
        str(stt_tls): stt_up,
    }
    env = dict(os.environ,
               ACP_FRONT_TARGETS=json.dumps(targets),
               ACP_TLS_DIR=str(TLS_DIR))
    front = subprocess.Popen(
        ["node", str(FRONT)], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs["front"] = front
    for p in (panel_tls, state_tls, bridge_tls, stt_tls):
        if not wait_port(p):
            print(f"FAIL  https-front did not bind :{p}")
            sys.exit(1)

    # Browser-facing port map: the production ports the panel builds -> our
    # test listeners. Both scheme families share one proxy.
    mapping = {
        25809: panel_tls,                      # https panel entry
        25808: panel_up,                       # http panel entry
        25906: stt_tls, 8099: stt_up,          # transcriber secure / plain
        25910: state_tls, 25900: state_up,     # state secure / plain
    }
    for insecure in (25901, 25902, 25903, 25904):
        mapping[insecure] = bridge_up          # ws leg
        mapping[insecure + 10] = bridge_tls    # wss leg
    proxy = PortProxy(proxy_port, mapping)

    return procs, proxy, proxy_port


def marker_lines():
    try:
        return MARKER_FILE.read_text().splitlines()
    except OSError:
        return []


class Recorder:
    """Collects every URL the page touches — requests and websockets alike —
    tagged by leg name."""
    def __init__(self):
        self.urls = []
        self.lock = threading.Lock()

    def attach(self, page, tag):
        def req(r):
            with self.lock:
                self.urls.append((tag, "req", r.url))
        def ws(w):
            with self.lock:
                self.urls.append((tag, "ws", w.url))
        page.on("request", req)
        page.on("requestfailed", req)
        page.on("websocket", ws)
        page.on("pageerror",
                lambda exc: page_errors.append(f"{tag}: {exc}"))


def urls_of(rec, tag):
    with rec.lock:
        return [u for (t, _k, u) in rec.urls if t == tag]


def insecure_urls(rec, tag):
    """Anything the page tried over a plaintext scheme — the mixed-content
    list. `requestfailed` covers browser-blocked dials too."""
    with rec.lock:
        return [u for (t, _k, u) in rec.urls
                if t == tag and (u.startswith("http://") or u.startswith("ws://"))]


def secure_service_urls(rec, tag):
    with rec.lock:
        return [u for (t, _k, u) in rec.urls
                if t == tag and (u.startswith("https://") or u.startswith("wss://"))]


def seed_browser(context):
    """Only preferences (telemetry off). `acp-ui:agents` stays EMPTY on
    purpose — the panel must run `defaultWebConfig()` itself, which is the
    code under test."""
    context.add_init_script(
        "if (!localStorage.getItem('acp-ui:preferences.json'))"
        " localStorage.setItem('acp-ui:preferences.json',"
        " '{\"telemetryEnabled\":false}');"
    )


def poll(fn, timeout=12.0, interval=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fn():
            return True
        time.sleep(interval)
    return fn()


def exercise_panel(page, tag, rec, entry):
    """Shared assertions for one leg: boot, restore via bridge, board doc,
    service URLs seen on the wire."""
    page.goto(entry, wait_until="load")

    # Session restore: sessions.json came from the state server (through the
    # front on https, direct on http) and the ws dial reached the stub
    # bridge through its own leg.
    connected = poll(lambda: page.locator(".input-row").count() > 0, 15.0)
    check(f"{tag}: session restores (bridge reachable)", connected)
    if connected:
        check(f"{tag}: replayed transcript rendered",
              poll(lambda: TRANSCRIPT in
                   (page.text_content(".messages-container") or ""), 10.0))

    # Board doc: the card exists only inside the stub STATE_DIR — seeing it
    # proves the shared-state document really traversed this leg's path.
    page.locator('.rail-btn[aria-label="Board"]').click()
    card_ok = poll(lambda: CARD_TITLE in (page.text_content("body") or ""),
                   12.0)
    check(f"{tag}: board doc from the state server shows in the UI", card_ok)
    page.locator('.rail-btn[aria-label="Chat"]').click()
    page.wait_for_timeout(300)


def run_https_leg(browser, rec):
    ctx = browser.new_context(ignore_https_errors=True,
                              viewport={"width": 1440, "height": 900})
    seed_browser(ctx)
    page = ctx.new_page()
    rec.attach(page, "https")
    exercise_panel(page, "https", rec, f"https://{HOST}:25809/")

    check("https: page is a secure context",
          page.evaluate("() => window.isSecureContext") is True)

    # Wait for the OpenAPI transcription probe (VoiceInput probes on ChatView mount).
    stt_probe = f"https://{HOST}:25906/openapi.json"
    stt_seen = poll(lambda: stt_probe in urls_of(rec, "https"), 12.0)
    check("https: transcriber probe uses the exact OpenAPI endpoint",
          stt_seen,
          next((u for u in urls_of(rec, "https") if ":8099" in u or ":25906" in u),
               "no transcriber request seen"))

    ws_urls = [u for u in urls_of(rec, "https") if u.startswith("ws")]
    check("https: agent dialed wss://acp.local:25911/",
          f"wss://{HOST}:25911/" in ws_urls, repr(ws_urls))

    upgrades = [l for l in marker_lines() if l.startswith("UPGRADE")]
    check("https: stub bridge saw the real ws upgrade through the front",
          any(l == "UPGRADE /" for l in upgrades), repr(upgrades))

    check("https: state probed at https://acp.local:25910",
          any(u.startswith(f"https://{HOST}:25910/health") or
              u.startswith(f"https://{HOST}:25910/api/state/")
              for u in urls_of(rec, "https")))

    bad = insecure_urls(rec, "https")
    check("https: ZERO http:// or ws:// requests (no mixed content)",
          len(bad) == 0, repr(bad[:5]))
    ctx.close()


def run_http_leg(browser, rec):
    ctx = browser.new_context(ignore_https_errors=True,
                              viewport={"width": 1440, "height": 900})
    seed_browser(ctx)
    page = ctx.new_page()
    rec.attach(page, "http")
    exercise_panel(page, "http", rec, f"http://{HOST}:25808/")

    urls = urls_of(rec, "http")
    check("http: state probed at the OLD http://acp.local:25900",
          any(u.startswith(f"http://{HOST}:25900/health") for u in urls),
          repr([u for u in urls if ":259" in u][:6]))

    ws_urls = [u for u in urls if u.startswith("ws")]
    check("http: agent dialed the OLD ws://acp.local:25901/",
          f"ws://{HOST}:25901/" in ws_urls, repr(ws_urls))

    check("http: transcriber probe uses http://acp.local:8099/openapi.json",
          any(u.startswith(f"http://{HOST}:8099/openapi.json") for u in urls),
          repr([u for u in urls if ":8099" in u]))

    check("http: no https:// or wss:// requests to services",
          not any(re.match(r"^(https|wss)://", u) for u in urls),
          repr([u for u in urls if re.match(r"^(https|wss)://", u)][:5]))
    ctx.close()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    if not (TLS_DIR / "acp.crt").exists():
        print(f"FAIL  {TLS_DIR}/acp.crt missing")
        sys.exit(1)

    procs, proxy, proxy_port = start_infra()
    # The state upstream port is the map value of 25900 — seed fixtures go
    # straight there, not through the front.
    state_up = proxy.mapping[25900]
    try:
        seed_state_docs(state_up)
        rec = Recorder()
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                proxy={"server": f"http://127.0.0.1:{proxy_port}"},
                args=[
                    # VoiceInput probes STT only when getUserMedia exists —
                    # force the page origin secure so the mic API shows up
                    # under a self-signed cert.
                    f"--unsafely-treat-insecure-origin-as-secure=https://{HOST}:25809",
                ],
            )
            run_https_leg(browser, rec)
            run_http_leg(browser, rec)
            browser.close()
    finally:
        proxy.close()
        for proc in procs.values():
            stop(proc)
        shutil.rmtree(WORK, ignore_errors=True)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
