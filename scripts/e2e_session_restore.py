#!/usr/bin/env python3
"""E2E for session restore across a page reload (F5) + scroll-to-bottom.

Two bugs are covered here:

1) F5 dropped the user to the welcome screen — `sessions.json` kept
   the session list, but the *pointer* to the open session (`currentSession`)
   lived only in memory, so after reload nothing reconnected.

2) Opening a session from the sidebar while the chat view was mounted
   landed on the FIRST message instead of the newest. `resumeSession`
   clears the feed, the container clamps to scrollTop 0, and the old
   auto-follow watch only re-pinned an already-pinned feed — the first
   replayed chunk taller than 40px killed the pin for good. The fix is a
   `followBottom` INTENT in ChatView: true on mount/session-switch/send,
   false only on a user scroll away from the bottom.

Serves dist-web on http://127.0.0.1:25987/ and stubs the ACP websocket.
The mock answers `initialize` (loadSession + session/list), `session/new`,
`session/list` (three sessions), `session/load` (a LONG replayed history,
>=25 turn pairs, dripped over time for B and C), and `session/prompt`.
Drip sends run on a daemon thread — a blocking sleep inside the on_message
handler starves the playwright dispatcher itself (verified: ws.send from a
thread delivers fine).

Asserts:
  * connect to a session, reload -> the chat view is back (`.input-row`),
    not the welcome screen; the agent selector still shows the agent;
  * the replayed transcript is visible (the assistant's text);
  * after F5 the feed is pinned to the bottom (fromBottom <= 2) and the
    LAST replayed message is inside the feed's viewport;
  * opening ANOTHER session from the sidebar (chat stays mounted) ends
    with the same two facts — this is the case that used to sit at the
    top with fromBottom ~= the whole feed height;
  * scrolling UP mid-replay is respected: more chunks arrive and the
    feed is not yanked back down;
  * when the replay finishes the newest message is in the viewport;
  * sending a message from a scrolled-up position returns the feed to
    the bottom;
  * starting a NEW session from the list's "+" and reloading -> the chat is
    connected again and the persisted pointer follows the new session, not
    the one it replaced (the Disconnect button no longer exists — that is the
    only manual close left, so a zombie auto-resume would be its failure);
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_session_restore.py

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
PORT = 25987
BASE = f"http://127.0.0.1:{PORT}/"

AGENT_NAME = "E2E Mock"

# Three sessions the mock agent knows about. A is created through the UI
# (`session/new` returns SID_A); B and C exist only in the agent's own
# inventory and surface in the sidebar via `session/list`.
SID_A = "e2e-restore-session"
SID_B = "e2e-scroll-session-b"
SID_C = "e2e-scroll-session-c"
# The shared ws bridge feeds one agent process to every open tab, so a
# session/update can name a session this client never opened — the store
# must drop those frames instead of rendering them into the open chat.
SID_FOREIGN = "e2e-foreign-session"

PAIRS_A = 28
PAIRS_B = 30
PAIRS_C = 26
DRIP_B = 0.060   # seconds between replayed turns while loading B
DRIP_C = 0.080   # seconds between replayed turns while loading C
TAIL_WINDOW = 30  # FEED_WINDOW_INIT in ChatView.vue — long histories mount
                  # only the tail until scrolling to the top grows the window

A_LAST = "RESTORED-HISTORY-MARKER"
B_LAST = "B-LAST-MARKER"
C_LAST = "C-LAST-MARKER"
C_REPLY = "C-REPLY-MARKER"
FOREIGN_TEXT = "FOREIGN-LEAK-MARKER"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def chunk(session_id, kind, content):
    return json.dumps({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": session_id,
                   "update": {"sessionUpdate": kind, "content": content}},
    })


def history(sid, pairs, tag, last_text):
    """`pairs` user+assistant turns; the last assistant message is `last_text`."""
    out = []
    for i in range(1, pairs + 1):
        out.append(chunk(sid, "user_message_chunk",
                         {"type": "text", "text": f"remember me ({tag} turn {i})"}))
        body = (last_text if i == pairs else
                f"{tag} history chunk {i} — sed do eiusmod tempor incididunt "
                f"ut labore et dolore magna aliqua enim ad minim")
        out.append(chunk(sid, "agent_message_chunk",
                         {"type": "text", "text": body}))
    return out


def drip_load(ws, sid, rid, pairs, tag, last_text, interval, foreign_every=0):
    """Stream a long replay, then the session/load response — a real agent
    keeps `session/load` open while history streams. Runs on a thread: the
    playwright dispatcher must never sleep inside on_message.
    `foreign_every`>0 interleaves session/update frames for SID_FOREIGN —
    cross-talk the shared bridge would deliver to this socket."""
    def run():
        for idx, note in enumerate(history(sid, pairs, tag, last_text)):
            try:
                ws.send(note)
                if foreign_every and idx % foreign_every == foreign_every - 1:
                    ws.send(chunk(SID_FOREIGN, "agent_message_chunk",
                                  {"type": "text", "text": FOREIGN_TEXT}))
            except Exception as e:  # noqa: BLE001 — page closed mid-drip
                print(f"NOTE  drip {sid} stopped early: {e}")
                return
            time.sleep(interval)
        try:
            ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}))
        except Exception as e:  # noqa: BLE001
            print(f"NOTE  drip {sid} result not sent: {e}")
    threading.Thread(target=run, daemon=True).start()


def acp_ws(ws):
    """Mock agent: handshake + new/list + long replayed histories + prompt."""
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
            elif method == "session/new":
                result = {"sessionId": SID_A}
            elif method == "session/list":
                stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                result = {"sessions": [
                    {"sessionId": SID_A, "title": "HistA",
                     "cwd": "/home/hermes/projects", "updatedAt": stamp},
                    {"sessionId": SID_B, "title": "HistB",
                     "cwd": "/home/hermes/projects", "updatedAt": stamp},
                    {"sessionId": SID_C, "title": "HistC",
                     "cwd": "/home/hermes/projects", "updatedAt": stamp},
                ]}
            elif method == "session/load":
                sid = (req.get("params") or {}).get("sessionId")
                if sid == SID_A:
                    for note in history(SID_A, PAIRS_A, "A", A_LAST):
                        ws.send(note)
                    result = {}
                elif sid == SID_B:
                    # Response rides the end of the drip thread.
                    drip_load(ws, SID_B, req["id"], PAIRS_B, "B", B_LAST, DRIP_B)
                    continue
                elif sid == SID_C:
                    drip_load(ws, SID_C, req["id"], PAIRS_C, "C", C_LAST,
                              DRIP_C, foreign_every=7)
                    continue
                else:
                    result = {}
            elif method == "session/prompt":
                sid = (req.get("params") or {}).get("sessionId") or SID_C
                ws.send(chunk(sid, "agent_message_chunk",
                              {"type": "text", "text": C_REPLY}))
                result = {"stopReason": "end_turn"}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def fs_api(route):
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker."""
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    else:
        body = {
            "path": "/home/hermes",
            "parent": "/home",
            "root": "/home/hermes",
            "dirs": [{"name": "projects", "path": "/home/hermes/projects"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    """localStorage: one ws agent + telemetry off + a cwd for New session."""
    agents = {"agents": {AGENT_NAME: {"transport": "websocket",
                                     "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def wire(page, tag):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))


# Tabs keep every open session's ChatView mounted (v-show), so DOM queries
# must pick the VISIBLE feed — hidden tab containers still match a plain
# selector. `offsetParent !== null` is the cheapest display:none test.
VISIBLE_FEED = """[...document.querySelectorAll('.messages-container')]
  .find(e => e.offsetParent !== null)"""

# Distance in px between the feed's scroll position and its newest message.
FROM_BOTTOM = """() => {
  const f = %s;
  return f ? f.scrollHeight - f.scrollTop - f.clientHeight : -1;
}""" % VISIBLE_FEED

# Is the last `.message` element fully inside the feed's viewport?
LAST_IN_VIEW = """() => {
  const f = %s;
  if (!f) return 'no-feed';
  const msgs = f.querySelectorAll('.messages .message');
  if (!msgs.length) return 'no-messages';
  const last = msgs[msgs.length - 1].getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  return last.top >= fr.top - 1 && last.bottom <= fr.bottom + 1;
}""" % VISIBLE_FEED

MESSAGE_COUNT = (
    "(() => { const f = " + VISIBLE_FEED + ";"
    "  return f ? f.querySelectorAll('.messages .message').length : 0; })()"
)


def from_bottom(page):
    return page.evaluate(FROM_BOTTOM)


def wheel_up(page, px):
    """A real user scroll-up over the feed (cursor stays parked on it)."""
    box = page.locator(".messages-container:visible").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, -px)


def click_session(page, title):
    page.locator(".session-row", has_text=title).first.click()


def poll_eval(page, expr, timeout=30.0, interval=0.15):
    """Evaluate `expr` until truthy. Polls via page.wait_for_timeout +
    page.evaluate, never wait_for_function: the app's replay re-renders
    saturate the main thread (markdown per message per chunk), and
    wait_for_function's rAF-driven polling can starve for seconds while
    the DOM is already where it needs to be. Driver-side polling always
    gets a slot between renders."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr):
            return True
        page.wait_for_timeout(int(interval * 1000))
    return page.evaluate(expr)


def wait_replay_done(page, marker, timeout=30.0):
    """Last chunk is in the DOM and `session/load` has resolved (the
    `Working…` indicator detaches when isLoading drops)."""
    ok = poll_eval(
        page,
        f"document.body.textContent.includes({json.dumps(marker)})"
        " && ![...document.querySelectorAll('.loading-indicator')]"
        "    .find(e => e.offsetParent !== null)",
        timeout=timeout,
    )
    page.wait_for_timeout(250)  # let the final pin + indicator removal settle
    return ok


def expand_feed(page, timeout=15.0):
    """Grow the render window until the whole transcript is in the DOM by
    scrolling the feed to the top — the window auto-extends once the scroll
    enters the trigger zone near the hidden history. A synthetic scrollTop
    write (not a wheel): it lands exactly where the trigger reads without
    parking a cursor over the feed."""
    deadline = time.time() + timeout
    prev = -1
    while time.time() < deadline:
        page.evaluate(
            "(() => { const f = " + VISIBLE_FEED + ";"
            "  if (f) f.scrollTop = 0; })()")
        page.wait_for_timeout(150)
        n = page.evaluate(MESSAGE_COUNT)
        at_top = page.evaluate(
            "(() => { const f = " + VISIBLE_FEED + ";"
            "  return !!f && f.scrollTop === 0; })()")
        # Converged: truly at the top and no new rows mounted.
        if at_top and n == prev:
            # Return the feed to where the pin-asserts expect it: the
            # newest message (same as a user scrolling back down).
            page.evaluate(
                "(() => { const f = " + VISIBLE_FEED + ";"
                "  if (f) f.scrollTop = f.scrollHeight; })()")
            page.wait_for_timeout(150)
            return True
        prev = n
    return False


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        wire(page, "restore")
        page.goto(BASE, wait_until="load")

        # Fresh boot shows the welcome screen (nothing to restore yet).
        page.wait_for_selector(".welcome-screen", timeout=10000)
        check("fresh boot shows the welcome screen", True)

        # Connect a session like a user would.
        page.wait_for_selector(".list-new-session:not([disabled])", timeout=10000)
        page.click(".list-new-session")
        page.wait_for_selector(".input-row:visible", timeout=15000)
        check("session connects before reload", True)

        # The agent's own inventory surfaces in the sidebar (session/list).
        page.wait_for_selector(".session-row", timeout=10000)
        titles = page.eval_on_selector_all(
            ".session-row .row-title", "els => els.map(e => e.textContent.trim())")
        check("sidebar lists the agent's sessions",
              all(t in titles for t in ("HistA", "HistB", "HistC")), repr(titles))

        # F5: the chat must come back by itself, with the replayed history.
        page.reload(wait_until="load")
        page.wait_for_selector(".input-row:visible", timeout=15000)
        check("reload restores the chat view, not the welcome screen",
              page.locator(".welcome-screen").count() == 0)
        agent = page.eval_on_selector("#agent-select", "el => el.value")
        check("agent selection survives the reload",
              agent == AGENT_NAME, repr(agent))
        wait_replay_done(page, A_LAST)
        check("replayed transcript visible after reload", True)
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:sessions.json') || '{}')")
        check("open-session pointer persisted",
              stored.get("currentSessionId") is not None,
              repr(stored.get("currentSessionId")))

        # --- F5 landing: pinned to the bottom, newest message visible ------
        n_msgs = page.evaluate(MESSAGE_COUNT)
        check("F5: long history mounts as a tail window",
              n_msgs == TAIL_WINDOW, f"{n_msgs} messages")
        expand_feed(page)
        n_msgs = page.evaluate(MESSAGE_COUNT)
        fb_a = from_bottom(page)
        check("F5: replayed a long history", n_msgs >= PAIRS_A * 2,
              f"{n_msgs} messages")
        check("F5: feed pinned to the bottom", fb_a >= 0 and fb_a <= 2,
              f"fromBottom={fb_a}px")
        last_ok = page.evaluate(LAST_IN_VIEW)
        check("F5: last replayed message inside the viewport",
              last_ok is True, repr(last_ok))

        # --- Sidebar open of ANOTHER session (chat stays mounted) ----------
        # The failing case: the clear collapses the feed, the old heuristic
        # died on the first >40px chunk, and the user watched the top.
        click_session(page, "HistB")
        wait_replay_done(page, B_LAST)
        n_b = page.evaluate(MESSAGE_COUNT)
        check("sidebar open: window resets to the tail on switch",
              n_b == TAIL_WINDOW, f"{n_b} messages")
        expand_feed(page)
        n_b = page.evaluate(MESSAGE_COUNT)
        fb_b = from_bottom(page)
        check("sidebar open: replayed a long history", n_b >= PAIRS_B * 2,
              f"{n_b} messages")
        check("sidebar open: feed lands on the bottom", fb_b >= 0 and fb_b <= 2,
              f"fromBottom={fb_b}px")
        last_b = page.evaluate(LAST_IN_VIEW)
        check("sidebar open: last replayed message inside the viewport",
              last_b is True, repr(last_b))

        # --- User scroll UP during a replay must be respected --------------
        click_session(page, "HistC")
        # Wait until C's OWN history has real scroll room. A raw message
        # count races the clear: session B's rows still sit in the DOM until
        # `messages = []` re-renders, so counting `.message` can pass before
        # a single replayed chunk has landed — the wheel then hits a feed
        # with nothing to scroll. 'C turn 12' only exists once C's replay
        # is ~24 messages deep (~1.5 viewports), guaranteed scrollable.
        enough = poll_eval(
            page, "document.body.textContent.includes('C turn 12')",
            timeout=15.0)
        check("replay streams in (enough messages to scroll)", enough)
        wheel_up(page, 700)
        page.wait_for_timeout(80)
        fb_up1 = from_bottom(page)
        # More replay chunks keep arriving below; the feed must stay put.
        page.wait_for_timeout(550)
        fb_up2 = from_bottom(page)
        check("scroll up mid-replay leaves the bottom",
              fb_up1 > 200, f"fromBottom={fb_up1}px right after the wheel")
        check("scroll up mid-replay is not yanked back",
              fb_up2 > 200 and fb_up2 >= fb_up1,
              f"fromBottom {fb_up1}px -> {fb_up2}px while chunks arrived")

        # The replay still lands on the newest once it finishes.
        wait_replay_done(page, C_LAST)
        fb_c = from_bottom(page)
        check("replay end lands on the newest message",
              fb_c >= 0 and fb_c <= 2, f"fromBottom={fb_c}px")
        last_c = page.evaluate(LAST_IN_VIEW)
        check("replay end: last message inside the viewport",
              last_c is True, repr(last_c))

        # Cross-talk that rode the same socket: foreign session/update
        # frames (another tab's traffic on the shared bridge) must never
        # render into the open chat or its history cache.
        check("foreign session/update frames never render",
              not page.evaluate(
                  f"document.body.textContent.includes({json.dumps(FOREIGN_TEXT)})"))
        check("foreign frames did not grow the transcript",
              expand_feed(page) and page.evaluate(MESSAGE_COUNT) == PAIRS_C * 2,
              f"{page.evaluate(MESSAGE_COUNT)} messages")

        # --- Sending from a scrolled-up position returns to the bottom -----
        wheel_up(page, 700)
        page.wait_for_timeout(80)
        fb_pre = from_bottom(page)
        check("scrolled up before sending", fb_pre > 200,
              f"fromBottom={fb_pre}px")
        page.fill(".composer-box textarea:visible", "ping")
        page.click(".send-btn:visible")
        poll_eval(page, f"document.body.textContent.includes({json.dumps(C_REPLY)})",
                  timeout=10.0)
        page.wait_for_timeout(200)
        fb_send = from_bottom(page)
        check("sending a message returns the feed to the bottom",
              fb_send >= 0 and fb_send <= 2, f"fromBottom={fb_send}px")

        # Closing the open session from the list's "+" (New session). There is
        # no Disconnect button any more — this is the only manual close left,
        # and it must not leave the reload pointing at the session it replaced.
        pointer_before = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:sessions.json') || '{}')"
        ).get("currentSessionId")
        page.click(".list-new-session")
        page.wait_for_selector(".input-row:visible", timeout=15000)
        page.reload(wait_until="load")
        page.wait_for_selector(".input-row:visible", timeout=15000)
        check("new session + reload comes back connected, not the welcome screen",
              page.locator(".input-row:visible").count() == 1)
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('acp-ui:sessions.json') || '{}')")
        check("the persisted pointer follows the new session",
              stored.get("currentSessionId") not in (None, "", pointer_before),
              f"{pointer_before!r} -> {stored.get('currentSessionId')!r}")

        ctx.close()
        browser.close()


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
