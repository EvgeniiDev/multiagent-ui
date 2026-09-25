#!/usr/bin/env python3
"""E2E for the localStorage history tail cache (instant open on the newest).

The work: `src/lib/historyCache.ts` keeps the last ~100 rendered messages per
session under `acp-ui:history:<agent>::<sessionId>`; `resumeSession` paints
that tail BEFORE the `session/load` replay (which streams into a side buffer
and swaps in wholesale at resolve); a dead replay keeps the tail, marked
stale; a diverged replay drops the entry.

Serves dist-web on its own port and stubs the ACP websocket. The mock agent
replays a 62-pair history (124 messages — over the 100-entry cache cap) as
NDJSON chunks on a drip thread (same reason as e2e_session_restore.py: a
blocking sleep in on_message starves the playwright dispatcher). A module
`state` dict switches what `session/load` does between page reloads in the
same browser context — localStorage persists, the mock does not have to.

Scenarios:
  A  cold open (no cache)  -> full replay, cache written, eviction ran
  B  reload, warm cache    -> last message in view <1s after first paint,
                              WHILE the replay is still streaming; marker
                              clears at settle; no duplicate rows
  C  reload, ws dies after 10 pairs -> cached tail stays, marked 'stale',
                              feed pinned, composer disabled, error banner
  D  reload, replay has NEWER turns (other device) -> tail grows below the
                              cache, no duplicates, cache rewritten
  E  reload, diverged replay (compressed) -> cache dropped, fresh replay
                              renders, no stale text
  F  fresh context, localStorage.setItem throws on history keys -> chat
                              opens and replays normally

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_history_cache.py

Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
PORT = 25977
BASE = f"http://127.0.0.1:{PORT}/"

AGENT_NAME = "E2E Mock"
SID = "e2e-cache-session"
PAIRS = 62                 # 124 messages -> exceeds the 100-entry cache cap
KILL_AFTER_PAIRS = 10
DRIP_S = 0.022             # ~2.7s of replay — a real window to assert inside

LAST = "HC-LAST-MARKER"
NEWEST = "HC-NEWEST-MARKER"
DIVERGED_LAST = "HC-DIVERGED-LAST"
MID_TEXT = "remember me (cache turn 30)"   # inside the cached tail
ANCHOR_TEXT = "remember me (cache turn 62)"  # last cached USER message

# Mutated between reloads; every ws connection reads it live.
state = {"mode": "full", "drip": DRIP_S}

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def chunk(sid, kind, content):
    return json.dumps({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": sid,
                   "update": {"sessionUpdate": kind, "content": content}},
    })


def tool_call(sid, tc_id, title, kind, status):
    return json.dumps({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": sid, "update": {
            "sessionUpdate": "tool_call", "toolCallId": tc_id,
            "title": title, "kind": kind, "status": status}},
    })


def replay_notes(sid):
    """The transcript the mock streams for `session/load`, by `state['mode']`."""
    mode = state["mode"]
    if mode == "diverged":
        # A compressed transcript: nothing matches the cached anchor.
        return [
            chunk(sid, "user_message_chunk",
                  {"type": "text", "text": "earlier context compacted away"}),
            chunk(sid, "agent_message_chunk",
                  {"type": "text", "text": "SUMMARY: sixty turns folded into one"}),
            chunk(sid, "user_message_chunk", {"type": "text", "text": "continue"}),
            chunk(sid, "agent_message_chunk", {"type": "text", "text": DIVERGED_LAST}),
        ]
    out = []
    for i in range(1, PAIRS + 1):
        out.append(chunk(sid, "user_message_chunk",
                         {"type": "text", "text": f"remember me (cache turn {i})"}))
        if i == 40:
            # A tool call inside the cached tail — exercises toolCallId dedupe.
            out.append(tool_call(sid, "tc-40", "scan logs", "search", "completed"))
        out.append(chunk(sid, "agent_message_chunk", {"type": "text", "text": (
            LAST if i == PAIRS else
            f"cache history chunk {i} — lorem ipsum dolor sit amet, consectetur "
            f"adipiscing elit sed do eiusmod")}))
    if mode == "extra":
        # Turns written from a second device while this client was away.
        out.append(chunk(sid, "user_message_chunk",
                         {"type": "text", "text": "from telegram: status?"}))
        out.append(chunk(sid, "agent_message_chunk",
                         {"type": "text", "text": "all green"}))
        out.append(chunk(sid, "user_message_chunk",
                         {"type": "text", "text": "and the deploy?"}))
        out.append(tool_call(sid, "tc-extra", "check deploy", "execute", "completed"))
        out.append(chunk(sid, "agent_message_chunk", {"type": "text", "text": NEWEST}))
    return out


def drip_load(ws, rid):
    """Stream the replay on a daemon thread, then answer `session/load`.
    In 'kill10' mode the socket closes mid-replay and no response is sent."""
    def run():
        notes = replay_notes(SID)
        kill_at = KILL_AFTER_PAIRS * 2 if state["mode"] == "kill10" else None
        for idx, note in enumerate(notes):
            try:
                ws.send(note)
            except Exception as e:  # noqa: BLE001 — page closed mid-drip
                print(f"NOTE  drip stopped early: {e}")
                return
            if kill_at is not None and idx + 1 >= kill_at:
                time.sleep(0.05)
                try:
                    ws.close()
                except Exception:  # noqa: BLE001
                    pass
                print("NOTE  ws closed mid-replay (kill10)")
                return
            time.sleep(state["drip"])
        try:
            ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}))
        except Exception as e:  # noqa: BLE001
            print(f"NOTE  load result not sent: {e}")
    threading.Thread(target=run, daemon=True).start()


def acp_ws(ws):
    """Mock agent: initialize + session/list + a mode-driven replay."""
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
                continue
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
            elif method == "session/list":
                stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                result = {"sessions": [{
                    "sessionId": SID, "title": "CachedHist",
                    "cwd": "/home/hermes/projects", "updatedAt": stamp}]}
            elif method == "session/load":
                drip_load(ws, req["id"])
                continue
            elif method == "session/prompt":
                ws.send(chunk(SID, "agent_message_chunk",
                              {"type": "text", "text": "ack"}))
                result = {"stopReason": "end_turn"}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    else:
        body = {
            "path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


SAVED = {
    "sessions": [{
        "id": "saved-s", "agentName": AGENT_NAME, "sessionId": SID,
        "title": "CachedHist", "lastUpdated": 1,
        "cwd": "/home/hermes/projects", "supportsLoadSession": True,
    }],
    "currentSessionId": "saved-s",
    "lastAgent": AGENT_NAME,
}


def seed(context):
    """localStorage: ws agent + prefs + the saved session + two junk cache
    entries (8-day-old tail, corrupt JSON) that init-time eviction must drop."""
    agents = {"agents": {AGENT_NAME: {"transport": "websocket",
                                     "url": f"ws://127.0.0.1:{PORT}/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents),
                     ("acp-ui:preferences.json", prefs),
                     ("acp-ui:sessions.json", SAVED)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )
    # Eviction bait: re-seeded on every load (guarded by absence), evicted at
    # every init — the assertions read them after initStore ran.
    context.add_init_script(
        "(() => {"
        f" const staleKey = {json.dumps(f'acp-ui:history:{AGENT_NAME}::e2e-stale-old')};"
        "  if (!localStorage.getItem(staleKey)) localStorage.setItem(staleKey, JSON.stringify({"
        "    version: 1, savedAt: Date.now() - 8*24*60*60*1000,"
        "    messages: [{id: 'x', role: 'user', content: 'stale', timestamp: 1}]"
        "  }));"
        f" const corruptKey = {json.dumps(f'acp-ui:history:{AGENT_NAME}::e2e-corrupt')};"
        "  if (!localStorage.getItem(corruptKey)) localStorage.setItem(corruptKey, '{nope');"
        "})();"
    )


def seed_quota(context):
    """Same seeds, then a quota-full setItem stub scoped to history keys."""
    agents = {"agents": {AGENT_NAME: {"transport": "websocket",
                                     "url": f"ws://127.0.0.1:{PORT}/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents),
                     ("acp-ui:preferences.json", prefs),
                     ("acp-ui:sessions.json", SAVED)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )
    context.add_init_script(
        "(() => { const orig = Storage.prototype.setItem;"
        " Storage.prototype.setItem = function (k, v) {"
        "   if (String(k).startsWith('acp-ui:history:'))"
        "     throw new DOMException('quota', 'QuotaExceededError');"
        "   return orig.call(this, k, v);"
        " };})();"
    )


def wire(page, tag):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))


CACHE_KEY = f"acp-ui:history:{AGENT_NAME}::{SID}"
STALE_KEY = f"acp-ui:history:{AGENT_NAME}::e2e-stale-old"
CORRUPT_KEY = f"acp-ui:history:{AGENT_NAME}::e2e-corrupt"

MESSAGE_COUNT = "document.querySelectorAll('.messages .message').length"
NOTE_STATE = ("() => { const n = document.querySelector('.history-note');"
              " return n ? n.dataset.state : null; }")
FROM_BOTTOM = """() => {
  const f = document.querySelector('.messages-container');
  return f ? f.scrollHeight - f.scrollTop - f.clientHeight : -1;
}"""
LAST_IN_VIEW = """() => {
  const f = document.querySelector('.messages-container');
  if (!f) return 'no-feed';
  const msgs = f.querySelectorAll('.messages .message');
  if (!msgs.length) return 'no-messages';
  const last = msgs[msgs.length - 1].getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  return last.top >= fr.top - 1 && last.bottom <= fr.bottom + 1;
}"""
READ_CACHE = ("(k) => { const r = localStorage.getItem(k);"
              " return r ? JSON.parse(r) : null; }")


def poll_eval(page, expr, timeout=30.0, interval=0.12):
    """Poll page.evaluate until truthy — never wait_for_function: replay
    re-renders saturate the main thread and starve rAF-driven polling."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr):
            return True
        page.wait_for_timeout(int(interval * 1000))
    return page.evaluate(expr)


def poll_value(page, expr, timeout=30.0, interval=0.12):
    """Same, but returns the evaluated value (for non-boolean probes)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = page.evaluate(expr)
        if v:
            return v
        page.wait_for_timeout(int(interval * 1000))
    return page.evaluate(expr)


def wait_settled(page, timeout=30.0):
    """Replay done: no loading indicator and no cache marker."""
    return poll_eval(
        page,
        "!document.querySelector('.loading-indicator')"
        " && !document.querySelector('.history-note')",
        timeout=timeout)


def occurrences(page, text):
    """How many .message nodes contain the text (duplicate detector)."""
    return page.evaluate(
        "(t) => [...document.querySelectorAll('.messages .message')]"
        ".filter(m => m.textContent.includes(t)).length", text)


def run_checks():
    timings = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        wire(page, "cache")

        # ---- A: cold open — no cache, full drip replay -------------------
        state["mode"] = "full"
        t_nav = time.time()
        page.goto(BASE, wait_until="load")
        ok = poll_eval(
            page,
            f"document.body.textContent.includes({json.dumps(LAST)})"
            " && !document.querySelector('.loading-indicator')",
            timeout=30.0)
        timings["cold_open_s"] = round(time.time() - t_nav, 3)
        check("cold open: full replay renders", ok)
        n = page.evaluate(MESSAGE_COUNT)
        check("cold open: all 62 pairs in the feed", n == PAIRS * 2, f"{n} messages")
        check("cold open: feed pinned to bottom",
              0 <= page.evaluate(FROM_BOTTOM) <= 2, f"fromBottom={page.evaluate(FROM_BOTTOM)}")

        entry = page.evaluate(READ_CACHE, CACHE_KEY)
        check("cache entry written under acp-ui:history:<agent>::<sid>",
              isinstance(entry, dict) and entry.get("version") == 1)
        if isinstance(entry, dict):
            msgs = entry.get("messages") or []
            check("cache capped at the last 100 messages", len(msgs) == 100,
                  f"{len(msgs)} cached")
            check("cache tail is the newest message",
                  msgs and msgs[-1].get("content") == LAST,
                  repr(msgs[-1].get("content") if msgs else None))
            check("cache tracks the tail's user-turn offset",
                  entry.get("userTurnBase") == PAIRS - sum(
                      1 for m in msgs if m.get("role") == "user"),
                  f"userTurnBase={entry.get('userTurnBase')}")
        check("stale + corrupt entries evicted on init",
              page.evaluate("(k) => localStorage.getItem(k)", STALE_KEY) is None
              and page.evaluate("(k) => localStorage.getItem(k)", CORRUPT_KEY) is None)

        # ---- B: reload — warm cache, replay still dripping ---------------
        page.reload(wait_until="load")
        t_mount = poll_value(
            page,
            "(() => document.querySelectorAll('.messages .message').length > 0"
            "     ? performance.now() : 0)()",
            timeout=15.0)
        check("cached open: tail paints before any replay chunk", bool(t_mount))
        t_seen = 0.0
        note_at_seen = None
        deadline = time.time() + 15.0
        while time.time() < deadline:
            if page.evaluate(
                    f"document.body.textContent.includes({json.dumps(LAST)})"
            ) and page.evaluate(LAST_IN_VIEW) is True:
                t_seen = page.evaluate("performance.now()")
                note_at_seen = page.evaluate(NOTE_STATE)
                break
            page.wait_for_timeout(50)
        open_ms = (t_seen - t_mount) if t_seen and t_mount else -1
        timings["warm_last_visible_ms"] = round(open_ms, 1)
        check("cached open: last message in view <1s after first paint",
              0 <= open_ms <= 1000, f"{open_ms:.0f}ms")
        check("cached open: newest visible WHILE the replay still streams",
              note_at_seen == "loading", f"note={note_at_seen}")
        check("cached open: loading-history marker shown",
              page.evaluate("() => !!document.querySelector('.history-note')"))
        check("cached open: feed pinned to the cached newest",
              0 <= page.evaluate(FROM_BOTTOM) <= 2,
              f"fromBottom={page.evaluate(FROM_BOTTOM)}")

        check("replayed replay settles (marker clears)", wait_settled(page))
        n = page.evaluate(MESSAGE_COUNT)
        check("settled: full history rendered once", n == PAIRS * 2,
              f"{n} messages")
        check("settled: no duplicated rows",
              occurrences(page, MID_TEXT) == 1,
              f"'{MID_TEXT}' x{occurrences(page, MID_TEXT)}")
        check("settled: cached tool-call chip not duplicated",
              page.evaluate(
                  "document.querySelectorAll('.tool-call-inline').length") == 1,
              repr(page.evaluate(
                  "document.querySelectorAll('.tool-call-inline').length")))

        # ---- C: reload — mock dies after 10 pairs -------------------------
        state["mode"] = "kill10"
        page.reload(wait_until="load")
        got_stale = poll_eval(
            page,
            "(() => { const n = document.querySelector('.history-note');"
            "  return n && n.dataset.state === 'stale'; })()",
            timeout=20.0)
        check("killed replay: tail stays, marked 'stale'", got_stale,
              f"note={page.evaluate(NOTE_STATE)}")
        n = page.evaluate(MESSAGE_COUNT)
        check("killed replay: cached 100 messages render", n == 100,
              f"{n} messages")
        check("killed replay: newest known message still last",
              page.evaluate(LAST_IN_VIEW) is True,
              repr(page.evaluate(LAST_IN_VIEW)))
        check("killed replay: feed pinned to cached newest",
              0 <= page.evaluate(FROM_BOTTOM) <= 2,
              f"fromBottom={page.evaluate(FROM_BOTTOM)}")
        check("killed replay: error banner instead of a fake 'live' view",
              page.evaluate("() => !!document.querySelector('.error-banner')"))
        check("killed replay: composer disabled while offline",
              page.evaluate("() => document.querySelector('.composer-box textarea').disabled"))
        state["mode"] = "full"   # restore before the next reload

        # ---- D: reload — agent replays EXTRA newer turns ------------------
        state["mode"] = "extra"
        page.reload(wait_until="load")
        check("cache renders while extended replay streams",
              poll_eval(page,
                        "(() => { const n = document.querySelector('.history-note');"
                        "  return n && n.dataset.state === 'loading'; })()",
                        timeout=15.0))
        check("second device: replay settles", wait_settled(page))
        n = page.evaluate(MESSAGE_COUNT)
        # +4 rows: user, assistant, user, assistant-carrying-the-tool-call.
        check("second device: tail grew below the cache",
              n == PAIRS * 2 + 4, f"{n} messages")
        check("second device: newest turn is last and in view",
              page.evaluate(LAST_IN_VIEW) is True and
              page.evaluate(f"document.body.textContent.includes({json.dumps(NEWEST)})"))
        check("second device: no duplicated rows",
              occurrences(page, MID_TEXT) == 1
              and occurrences(page, ANCHOR_TEXT) == 1,
              f"mid x{occurrences(page, MID_TEXT)} anchor x{occurrences(page, ANCHOR_TEXT)}")
        check("second device: both tool-call chips, no dupes",
              page.evaluate("document.querySelectorAll('.tool-call-inline').length") == 2)
        entry = page.evaluate(READ_CACHE, CACHE_KEY)
        check("second device: cache rewritten to the extended tail",
              isinstance(entry, dict) and (entry.get("messages") or [{}])[-1]
              .get("content") == NEWEST)

        # ---- E: reload — diverged (compressed) replay ---------------------
        state["mode"] = "diverged"
        page.reload(wait_until="load")
        check("diverged: replay settles", wait_settled(page))
        n = page.evaluate(MESSAGE_COUNT)
        check("diverged: fresh transcript renders", n == 4, f"{n} messages")
        check("diverged: newest live text visible",
              page.evaluate(f"document.body.textContent.includes({json.dumps(DIVERGED_LAST)})"))
        check("diverged: stale anchor text is GONE",
              occurrences(page, ANCHOR_TEXT) == 0,
              f"anchor x{occurrences(page, ANCHOR_TEXT)}")
        entry = page.evaluate(READ_CACHE, CACHE_KEY)
        check("diverged: stale cache entry replaced by the fresh tail",
              isinstance(entry, dict)
              and len(entry.get("messages") or []) == 4
              and entry["messages"][-1].get("content") == DIVERGED_LAST,
              repr((entry or {}).get("messages", [{}])[-1:] if isinstance(entry, dict) else entry))
        keys = page.evaluate(
            "Object.keys(localStorage).filter(k => k.startsWith('acp-ui:history:'))")
        check("cache does not grow unboundedly (one live entry)",
              keys == [CACHE_KEY], repr(keys))

        ctx.close()

        # ---- F: quota-full localStorage -----------------------------------
        ctx2 = browser.new_context(ignore_https_errors=True,
                                   viewport={"width": 1440, "height": 900})
        seed_quota(ctx2)
        page2 = ctx2.new_page()
        wire(page2, "quota")
        state["mode"] = "full"
        page2.goto(BASE, wait_until="load")
        ok = poll_eval(
            page2,
            f"document.body.textContent.includes({json.dumps(LAST)})"
            " && !document.querySelector('.loading-indicator')",
            timeout=30.0)
        check("quota-full setItem: chat still opens and replays", ok)
        n = page2.evaluate(MESSAGE_COUNT)
        check("quota-full: full replay rendered", n == PAIRS * 2, f"{n} messages")
        check("quota-full: no history entry written, no crash",
              page2.evaluate("(k) => localStorage.getItem(k)", CACHE_KEY) is None)
        ctx2.close()
        browser.close()

    print("\n-- timings --")
    for k, v in timings.items():
        print(f"NOTE  {k} = {v}")


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        run_checks()
    finally:
        stop(server)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
