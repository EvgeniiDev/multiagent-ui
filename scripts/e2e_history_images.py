#!/usr/bin/env python3
"""E2E: images in a session's history must survive a replay (W14).

The bug: text from the agent's session history comes back on `session/load`,
images do not — the panel drops non-text content blocks from `user_message_chunk`
notifications, and agents that never imprint image bytes into the replay leave
the panel with no record at all.

A mock agent (playwright WS route, no bridge needed) owns a stubbed session
inventory (`session/list`) and replays per-session histories on `session/load`:

  * "with image"   — a user turn carrying a REAL image content block
                     ({type:'image', data:<png>, uri:'attachment://cat.png'})
                     -> must render <img> with naturalWidth > 0;
  * "lost images"  — three turns whose bytes are genuinely gone:
                     an `[Attached image: …]` text marker, an EMPTY image
                     block, and a `resource_link` to an unreadable file URI
                     -> each must render an explicit placeholder NAMING the
                     file and saying why (never a silent gap);
  * "text only"    — prose turns only -> zero attachment blocks;
  * "sent"         — the panel sends a turn with an image attached, the page
                     reloads, and the agent replays the turn TEXT-ONLY (the
                     agent lost the image). The panel's own persisted
                     attachment record must restore the <img> — the bytes
                     survive in the record the panel keeps.

Assertions print the transcript contents on failure. Exits non-zero on any
failure. Own port 25980; the live state server on :25900 is blocked via
page.route so the suite falls back to localStorage like the other suites.

Usage:  npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_history_images.py
"""
import base64
import json
import re
import socket
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25980
BASE = f"http://127.0.0.1:{PORT}/"
REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-web"

page_errors: list[str] = []
checks: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def png_bytes(width=64, height=48, rgb=(194, 83, 47)) -> bytes:
    """A real PNG the browser can decode (no PIL) — naturalWidth must be > 0."""
    raw = b"".join(
        b"\x00" + bytes(rgb) * width for _ in range(height)
    )
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


PNG_B64 = base64.b64encode(png_bytes()).decode()
SENT_B64 = base64.b64encode(png_bytes(32, 32, (60, 120, 60))).decode()

# The sessions the stub agent owns (`session/list`) and what each replays.
AGENT_SESSIONS = [
    {"sessionId": "img-session", "title": "with image",
     "cwd": "/home/hermes", "updatedAt": "2026-09-24T09:00:00Z"},
    {"sessionId": "lost-session", "title": "lost images",
     "cwd": "/home/hermes", "updatedAt": "2026-09-24T08:00:00Z"},
    {"sessionId": "text-session", "title": "text only",
     "cwd": "/home/hermes", "updatedAt": "2026-09-24T07:00:00Z"},
    {"sessionId": "sent-session", "title": "sent",
     "cwd": "/home/hermes", "updatedAt": "2026-09-24T06:00:00Z"},
]

# Mock-side state: did a prompt land on sent-session (so its replay grows a
# second user turn — text only, the agent never kept the image)?
sent_prompt_seen: list[str] = []


def chunk(session, kind, content):
    return json.dumps({"jsonrpc": "2.0", "method": "session/update",
                       "params": {"sessionId": session, "update": {
                           "sessionUpdate": kind, "content": content}}})


def replay_lines(session_id: str) -> list[str]:
    """The history the agent streams back for `session/load`, as NDJSON."""
    u = "user_message_chunk"
    a = "agent_message_chunk"
    if session_id == "img-session":
        return [
            chunk(session_id, u, {"type": "text", "text": "what is in this image?"}),
            chunk(session_id, u, {"type": "image", "data": PNG_B64,
                                  "mimeType": "image/png",
                                  "uri": "attachment://cat.png"}),
            chunk(session_id, a, {"type": "text", "text": "it is a cat."}),
        ]
    if session_id == "lost-session":
        return [
            # Turn 1: the agent echoed the marker in prose — no bytes.
            chunk(session_id, u, {"type": "text",
                                  "text": "see this [Attached image: ghost.png]"}),
            chunk(session_id, a, {"type": "text", "text": "looked."}),
            # Turn 2: an image block that carried no bytes at all.
            chunk(session_id, u, {"type": "text", "text": "and this one?"}),
            chunk(session_id, u, {"type": "image", "data": "",
                                  "mimeType": "image/png",
                                  "uri": "attachment://gone.png"}),
            chunk(session_id, a, {"type": "text", "text": "cannot see it."}),
            # Turn 3: only a link the panel cannot read.
            chunk(session_id, u, {"type": "text", "text": "last one"}),
            chunk(session_id, u, {"type": "resource_link",
                                  "uri": "file:///home/hermes/shot.png",
                                  "name": "shot.png", "mimeType": "image/png"}),
            chunk(session_id, a, {"type": "text", "text": "nope."}),
        ]
    if session_id == "sent-session":
        lines = [
            chunk(session_id, u, {"type": "text", "text": "earlier plain turn"}),
            chunk(session_id, a, {"type": "text", "text": "ack"}),
        ]
        if sent_prompt_seen:
            # The agent replays the sent turn's TEXT but never imprinted the
            # image bytes — the panel's own record is the only place they live.
            lines += [
                chunk(session_id, u, {"type": "text", "text": "describe it"}),
                chunk(session_id, a, {"type": "text", "text": "saw image:" +
                                      sent_prompt_seen[-1]}),
            ]
        return lines
    # text-session: prose only.
    return [
        chunk(session_id, u, {"type": "text", "text": "hello there"}),
        chunk(session_id, a, {"type": "text", "text": "hi — no files here."}),
    ]


# --------------------------------------------------------------------------
# Mock agent
# --------------------------------------------------------------------------

def acp_ws(ws):
    def on_message(message):
        for line in str(message).split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                continue
            if not isinstance(req, dict) or "method" not in req:
                continue
            method, rid = req["method"], req.get("id")
            if method == "initialize":
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": True,
                        "sessionCapabilities": {"list": {}},
                        "promptCapabilities": {"image": True},
                    },
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"}}}))
            elif method == "session/list":
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                    "sessions": AGENT_SESSIONS, "nextCursor": None}}))
            elif method == "session/load":
                sid = req.get("params", {}).get("sessionId", "")
                for n in replay_lines(sid):
                    ws.send(n)
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}))
            elif method == "session/prompt":
                sid = req.get("params", {}).get("sessionId", "")
                names = [b.get("uri", "") for b in
                         (req.get("params", {}).get("prompt") or [])
                         if isinstance(b, dict) and b.get("type") == "image"]
                if sid == "sent-session":
                    sent_prompt_seen.append(names[0] if names else "")
                ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                    "params": {"sessionId": sid, "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text":
                            "saw image:" + (names[0] if names else "NONE")}}}}))
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                    "result": {"stopReason": "end_turn"}}))
            else:
                if rid is not None:
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                        "result": {}}))
    ws.on_message(on_message)


def fs_api(route):
    body = ({"root": "/home/hermes"} if "/api/fs/root" in route.request.url else
            {"path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
             "dirs": [{"name": "projects", "path": "/home/hermes/projects"}]})
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps(body))


def seed(context):
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                      "url": "ws://127.0.0.1:25980/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes"}
    for key, val in (("acp-ui:agents", agents),
                     ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")


def start_server():
    for _ in range(30):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", PORT))
            break
        except OSError:
            time.sleep(1)
        finally:
            s.close()
    else:
        print(f"FAIL  port {PORT} busy — refusing a stale server")
        sys.exit(1)
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT),
                             "--bind", "127.0.0.1"], cwd=str(DIST),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on {PORT}")
    sys.exit(1)


# What the transcript actually contains — dumped into every failed assertion.
TRANSCRIPT = """() => {
  const blocks = [...document.querySelectorAll('.attachment-block')].map(b => ({
    text: b.textContent.replace(/\\s+/g, ' ').trim(),
    note: (b.querySelector('.attachment-note') || {}).textContent || '',
  }));
  const imgs = [...document.querySelectorAll('.attachment-image')].map(i => ({
    alt: i.alt, w: i.naturalWidth, src: (i.src || '').slice(0, 40),
  }));
  return {
    messages: [...document.querySelectorAll('.messages .message')].map(m =>
      m.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)),
    blocks, imgs,
    html: (document.querySelector('.messages') || {innerHTML: ''}).innerHTML.slice(0, 900),
  };
}"""


def click_session(page, title, expect):
    """Open one sidebar session row and wait until ITS replayed text is in
    the transcript — guards against reading the previous session's rows."""
    row = page.locator(".session-row", has_text=title).first
    row.wait_for(timeout=15000)
    row.click()
    page.wait_for_function(
        "() => (document.querySelector('.messages') || {textContent: ''})"
        f".textContent.includes({json.dumps(expect)})", timeout=15000)
    page.wait_for_timeout(400)  # let the last chunk/attachment render


def run_checks():
    proc = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            seed(ctx)
            # Context-level routes survive page.reload() for the send leg.
            ctx.route(re.compile(r"/api/fs/"), fs_api)
            # The host state server is live on :25900 and would restore the
            # last view (and the real board) into this context — cut it off so
            # the run starts clean and falls back to localStorage.
            ctx.route(re.compile(r":25900/"), lambda r: r.abort())
            ctx.route_web_socket(re.compile(r"^wss?://"), acp_ws)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))

            page.goto(BASE, wait_until="load")
            # Auto-selected agent -> session/list -> sidebar rows.
            page.wait_for_selector(".session-row", timeout=15000)

            # --- 1. replayed image content block renders real bytes ---------
            click_session(page, "with image", "what is in this image?")
            snap = page.evaluate(TRANSCRIPT)
            check("replayed image block renders an <img>",
                  len(snap["imgs"]) >= 1, json.dumps(snap))
            if snap["imgs"]:
                check("replayed <img> has real bytes (naturalWidth > 0)",
                      snap["imgs"][0]["w"] > 0, json.dumps(snap["imgs"]))
                check("replayed <img> is the sent file (cat.png)",
                      snap["imgs"][0]["alt"] == "cat.png",
                      json.dumps(snap["imgs"]))

            # --- 2. unrecoverable images get explicit named placeholders ----
            click_session(page, "lost images", "see this")
            snap = page.evaluate(TRANSCRIPT)
            named = {n: any(n in b["text"] and b["note"] for b in snap["blocks"])
                     for n in ("ghost.png", "gone.png", "shot.png")}
            check("3 lost images each render a named placeholder",
                  all(named.values()),
                  f"blocks={json.dumps(snap['blocks'])} msgs={json.dumps(snap['messages'])}")
            check("no lost image pretends to render",
                  all(i["w"] == 0 for i in snap["imgs"]) or not snap["imgs"],
                  json.dumps(snap["imgs"]))

            # --- 3. a text-only history shows no placeholders ---------------
            click_session(page, "text only", "hello there")
            snap = page.evaluate(TRANSCRIPT)
            check("text-only session has no attachment blocks",
                  snap["blocks"] == [] and snap["imgs"] == [],
                  json.dumps(snap))

            # --- 4. image the PANEL sent survives a reload ------------------
            click_session(page, "sent", "earlier plain turn")
            page.set_input_files("input[type=file]", {
                "name": "cat.png", "mimeType": "image/png",
                "buffer": base64.b64decode(SENT_B64)})
            page.wait_for_selector(".attach-chip", timeout=10000)
            page.click(".send-btn")
            page.wait_for_function(
                "() => (document.querySelector('.messages') || {textContent: ''})"
                ".textContent.includes('saw image:')", timeout=10000)
            page.wait_for_timeout(300)
            snap = page.evaluate(TRANSCRIPT)
            check("sent image block reached the agent",
                  any("saw image:attachment://cat.png" in m
                      for m in snap["messages"]), json.dumps(snap["messages"]))

            page.reload(wait_until="load")
            page.wait_for_selector(".session-row", timeout=15000)
            click_session(page, "sent", "describe it")
            snap = page.evaluate(TRANSCRIPT)
            check("after reload the panel record restores the <img>",
                  any(i["alt"] == "cat.png" and i["w"] > 0
                      for i in snap["imgs"]), json.dumps(snap))

            check("zero pageerrors", page_errors == [], repr(page_errors[:2]))
            browser.close()
    finally:
        proc.terminate()

    passed = sum(1 for ok, _, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} assertions passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    if not DIST.is_dir():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    sys.exit(run_checks())
