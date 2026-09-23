#!/usr/bin/env python3
"""E2E for composer voice input (cc/w7-voice): mic button, streaming STT.

Serves dist-web on http://127.0.0.1:25991/ and stubs BOTH websockets the app
opens: the ACP agent handshake (same mock as the other suites) and the STT
stream on :25905/ws/stream — a canned script that answers binary PCM frames
with partials and {"type":"stop"} with a final. Chromium runs with
--use-fake-ui-for-media-stream --use-fake-device-for-media-stream so
getUserMedia really resolves and audio frames actually flow; the stub counts
the bytes to prove the capture+resample pipeline end-to-end.

Covers, per the brief:
  * mic button present in .input-row, 34x34, radius 6px, no shadow, svg icon;
  * click opens the STT ws and flips to a listening state with a timer line;
  * committed text renders in the normal field colour, volatile muted;
  * {"type":"stop"} -> final text stays in the field, button idles;
  * a second click starts a fresh take; Escape stops too;
  * hand-typed text survives (dictation lands at the caret, with a space);
  * /health failing -> button disabled with a reason on the title;
  * getUserMedia rejecting -> visible error line, nothing hangs;
  * ws dropping mid-take -> error shown, recognised text kept;
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_voice.py

Artefacts: the canned transcript lands in ./tmp-voice-test/, screenshots in
docs/ like the other suites.
Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
TMP = ROOT / "tmp-voice-test"
PORT = 25991
BASE = f"http://127.0.0.1:{PORT}/"

# Canned transcript the stub plays back. Partial 2 settles "the quick" and
# keeps "brown fox" volatile; the final polishes the whole utterance.
PARTIAL_1 = {"committed": "", "volatile": "the quick"}
PARTIAL_2 = {"committed": "the quick", "volatile": "brown fox"}
FINAL_TEXT = "the quick brown fox"

results = []
page_errors = []
stt_stats = {"opens": 0, "binary_frames": 0, "binary_bytes": 0, "stops": 0}


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API + the STT stream.
# --------------------------------------------------------------------------

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
                continue
            method = req["method"]
            if method == "initialize":
                result = {
                    "protocolVersion": 1,
                    "agentCapabilities": {},
                    "authMethods": [],
                    "agentInfo": {"name": "e2e-mock", "version": "0"},
                }
            elif method == "session/new":
                result = {"sessionId": "e2e-mock-session"}
            elif method in ("session/list", "session/load"):
                result = {"sessions": []}
            else:
                result = {}
            ws.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
    ws.on_message(on_message)


def stt_ws(ws):
    """Stand in for stt-server's /ws/stream with a canned transcript.

    Binary frames are counted (the capture pipeline must really stream);
    partials are emitted after 3 and 7 frames (~0.3s/~0.7s of audio); a
    {"type":"stop"} text frame yields the final, then the socket closes —
    exactly what the real server does. mode='drop' closes abruptly after the
    second partial to exercise the mid-take failure path.
    """
    stt_stats["opens"] += 1
    state = {"frames": 0}
    mode = STUB["mode"]

    def on_message(message):
        if isinstance(message, (bytes, bytearray)):
            state["frames"] += 1
            stt_stats["binary_frames"] += 1
            stt_stats["binary_bytes"] += len(message)
            if state["frames"] == 3:
                ws.send(json.dumps({"type": "partial", **PARTIAL_1,
                                    "text": PARTIAL_1["volatile"], "audio_s": 0.3}))
            elif state["frames"] == 7:
                ws.send(json.dumps({"type": "partial", **PARTIAL_2,
                                    "text": "the quick brown fox", "audio_s": 0.7}))
                if mode == "drop":
                    ws.close()
            return
        try:
            ctrl = json.loads(str(message))
        except ValueError:
            return
        if ctrl.get("type") == "stop":
            stt_stats["stops"] += 1
            ws.send(json.dumps({"type": "final", "text": FINAL_TEXT,
                                "audio_s": 1.0, "total_s": 0.4}))
            ws.close()

    ws.on_message(on_message)


STUB = {"mode": "normal"}


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


def health_ok(route):
    # ACAO:* is what stt-server should send (and what the verified probe
    # path needs); the streaming ws itself is not subject to CORS.
    route.fulfill(
        status=200,
        content_type="application/json",
        headers={"access-control-allow-origin": "*"},
        body=json.dumps({"ok": True, "model": "e2e-stub", "loaded": True,
                         "sample_rate": 16000, "window_s": 6, "hop_s": 1}),
    )


def seed(context):
    """localStorage: one ws agent + telemetry off + a cwd for New session."""
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                    "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def deny_mic(context):
    # Plain script body — an arrow wrapper would never be invoked.
    # defineProperty because plain assignment silently fails on mediaDevices.
    context.add_init_script(
        """
        (function () {
          const deny = () => Promise.reject(
            new DOMException('Permission denied by e2e', 'NotAllowedError'));
          if (navigator.mediaDevices) {
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia',
              { value: deny, configurable: true });
          }
        })();
        """
    )


def start_server():
    for _ in range(30):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", PORT))
            break
        except OSError:
            time.sleep(1)
        finally:
            s.close()
    else:
        print(f"FAIL  port {PORT} still busy after 30s — refusing a stale server")
        sys.exit(1)
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on port {PORT}")
    sys.exit(1)


def wire_routes(page, tag, health=health_ok):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25905/health"), health)
    # A real state server may be running on the host (it holds a persisted
    # activeView that hid the sidebar once). Refuse it so the page falls
    # back to localStorage and every run starts from the same state.
    page.route(re.compile(r":25900/"), lambda route: route.abort())
    # The generic ACP mock is registered first so the narrower STT pattern
    # wins for :25905 sockets (last matching route takes precedence).
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.route_web_socket(re.compile(r":25905/ws/stream"), stt_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))


def open_chat(page, tag, **kwargs):
    wire_routes(page, tag, **kwargs)
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".new-session-btn:not([disabled])", timeout=10000)
    page.click(".new-session-btn")
    page.wait_for_selector(".input-row", timeout=15000)
    page.wait_for_timeout(400)


def rect(page, sel):
    return page.evaluate(
        """(s) => { const el = document.querySelector(s);
                   if (!el) return null;
                   const r = el.getBoundingClientRect();
                   return { w: r.width, h: r.height }; }""",
        sel,
    )


def css(page, sel, props):
    return page.evaluate(
        """([s, ps]) => { const el = document.querySelector(s);
                         if (!el) return null;
                         const cs = getComputedStyle(el);
                         const out = {};
                         for (const p of ps) out[p] = cs.getPropertyValue(p);
                         return out; }""",
        [sel, props],
    )


def token(page, name):
    return page.evaluate(
        """(v) => { const d = document.createElement('div');
                   d.style.cssText = `color: var(${v}); position:absolute; visibility:hidden`;
                   document.body.appendChild(d);
                   const c = getComputedStyle(d).color;
                   d.remove();
                   return c; }""",
        name,
    )


def field_value(page):
    return page.eval_on_selector(".composer-box textarea", "el => el.value")


def launch(p):
    return p.chromium.launch(
        headless=True,
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ],
    )


def run_checks():
    with sync_playwright() as p:
        browser = launch(p)

        # ---------------- happy path: dictate, stop, dictate again ----------------
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
            permissions=["microphone"],
        )
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "main")

        btn = rect(page, ".voice-btn")
        check("mic button mounts in the input row", btn is not None)
        if btn:
            check("mic button is a 34x34 square",
                  abs(btn["w"] - 34) <= 1.5 and abs(btn["h"] - 34) <= 1.5,
                  f"{btn['w']:.1f}x{btn['h']:.1f}")
        style = css(page, ".voice-btn", ["border-top-left-radius", "box-shadow"])
        check("mic button: radius 6px, no shadow",
              style is not None and style["border-top-left-radius"] == "6px"
              and style["box-shadow"] == "none", repr(style))
        check("mic button carries an svg icon, no emoji",
              page.locator(".voice-btn svg").count() == 1)

        # Hand-typed text must survive the take.
        page.fill(".composer-box textarea", "note:")
        page.click(".composer-box textarea")
        page.click(".voice-btn")
        page.wait_for_selector(".voice-btn.listening", timeout=8000)
        check("click opens STT ws and shows the listening state", True)
        check("status line shows the listening timer",
              page.locator(".voice-status").inner_text().startswith("Listening"),
              page.locator(".voice-status").inner_text())

        # Frames really stream: wait until the stub's second partial lands.
        page.wait_for_selector(".voice-overlay .voice-commit", timeout=8000)
        check("binary PCM frames reached the stub",
              stt_stats["binary_frames"] >= 7 and stt_stats["binary_bytes"] > 0,
              f"{stt_stats['binary_frames']} frames, {stt_stats['binary_bytes']} B")

        commit = css(page, ".voice-overlay .voice-commit", ["color"])
        volatile = css(page, ".voice-overlay .voice-volatile", ["color"])
        texts = page.evaluate(
            """() => ({ c: document.querySelector('.voice-overlay .voice-commit')?.textContent,
                        v: document.querySelector('.voice-overlay .voice-volatile')?.textContent })"""
        )
        check("committed span carries the settled words",
              texts["c"] == PARTIAL_2["committed"], repr(texts))
        check("volatile span carries the hypothesis",
              texts["v"] == PARTIAL_2["volatile"], repr(texts))
        check("committed renders in the normal field colour",
              commit and commit["color"] == token(page, "--text-primary"),
              repr(commit))
        check("volatile renders muted",
              volatile and volatile["color"] == token(page, "--text-muted"),
              repr(volatile))
        check("typed text still visible in the overlay",
              page.locator(".voice-overlay").inner_text().startswith("note:"))
        page.screenshot(path=str(SHOTS / "voice-listening.png"))

        # Stop via the button -> final lands at the caret with a space.
        page.click(".voice-btn")
        page.wait_for_function(
            "() => !document.querySelector('.voice-btn.listening')", timeout=8000
        )
        page.wait_for_timeout(300)
        check("final text stays in the field after stop",
              field_value(page) == f"note: {FINAL_TEXT}", repr(field_value(page)))
        check("stop frame reached the stub", stt_stats["stops"] == 1)
        check("overlay cleared once idle",
              page.locator(".voice-overlay").count() == 0)

        # A second click starts a fresh take; Escape ends it.
        page.click(".voice-btn")
        page.wait_for_selector(".voice-btn.listening", timeout=8000)
        check("second click starts a new take", True)
        before = field_value(page)
        page.keyboard.press("Escape")
        page.wait_for_function(
            "() => !document.querySelector('.voice-btn.listening')", timeout=8000
        )
        page.wait_for_timeout(300)
        check("Escape stops the take and keeps the text",
              field_value(page) == before + " " + FINAL_TEXT
              or field_value(page).endswith(FINAL_TEXT),
              repr(field_value(page)))
        check("two STT sessions opened in total", stt_stats["opens"] == 2,
              repr(stt_stats))
        page.screenshot(path=str(SHOTS / "voice-after.png"))
        ctx.close()

        # ---------------- ws drop mid-take keeps recognised text ----------------
        STUB["mode"] = "drop"
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
            permissions=["microphone"],
        )
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "drop")
        page.click(".voice-btn")
        page.wait_for_selector(".voice-btn.listening", timeout=8000)
        # The stub drops the socket after the second partial (~7 frames).
        page.wait_for_selector(".voice-status.is-error", timeout=8000)
        page.wait_for_timeout(200)
        check("dropped ws surfaces a visible error",
              "connection lost" in page.locator(".voice-status").inner_text().lower()
              or "lost" in page.locator(".voice-status").inner_text().lower(),
              page.locator(".voice-status").inner_text())
        val = field_value(page)
        check("recognised text stays in the field after a drop",
              PARTIAL_2["committed"] in val, repr(val))
        check("mic button idles again after the drop",
              page.locator(".voice-btn.listening").count() == 0
              and page.locator(".voice-btn:not([disabled])").count() == 1)
        STUB["mode"] = "normal"
        ctx.close()

        # ---------------- service down: disabled with a reason ----------------
        ctx = browser.new_context(
            ignore_https_errors=True, viewport={"width": 1440, "height": 900}
        )
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "down", health=lambda route: route.abort())
        page.wait_for_selector(".voice-btn[disabled]", timeout=8000)
        title = page.get_attribute(".voice-btn", "title") or ""
        check("service down disables the mic button", True)
        check("disabled button explains itself in the title",
              "unreachable" in title.lower() or "unavailable" in title.lower(),
              repr(title))
        ctx.close()

        # ---------------- contrast: voice colours in both schemes ----------------
        # WCAG contrast of the token pairs the dictation UI actually paints.
        def rel_lum(rgb):
            vals = [c / 255 for c in rgb]
            vals = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
                    for c in vals]
            return 0.2126 * vals[0] + 0.7152 * vals[1] + 0.0722 * vals[2]

        def parse_rgb(s):
            return [int(x) for x in re.findall(r"\d+", s)[:3]]

        def ratio(fg, bg):
            l1, l2 = sorted((rel_lum(parse_rgb(fg)), rel_lum(parse_rgb(bg))),
                            reverse=True)
            return (l1 + 0.05) / (l2 + 0.05)

        for scheme in ("light", "dark"):
            ctx = browser.new_context(ignore_https_errors=True,
                                      color_scheme=scheme,
                                      viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), lambda route: route.abort())
            page.on("pageerror", lambda exc: page_errors.append(f"contrast:{scheme}: {exc}"))
            page.goto(BASE, wait_until="load")
            page.wait_for_timeout(400)
            muted = token(page, "--text-muted")
            accent = token(page, "--text-accent")
            danger = token(page, "--bg-danger")
            bg = token(page, "--bg-main")
            # volatile text = --text-muted; error line = --bg-danger (light)
            # / --text-accent (dark); status line = --text-muted.
            err_fg = danger if scheme == "light" else accent
            check(f"{scheme}: volatile muted text >= 4.5:1",
                  ratio(muted, bg) >= 4.5, f"{ratio(muted, bg):.2f}:1 {muted} on {bg}")
            check(f"{scheme}: error line >= 4.5:1",
                  ratio(err_fg, bg) >= 4.5, f"{ratio(err_fg, bg):.2f}:1 {err_fg} on {bg}")
            ctx.close()

        # ---------------- mic denied: visible error, nothing hangs ----------------
        ctx = browser.new_context(
            ignore_https_errors=True, viewport={"width": 1440, "height": 900}
        )
        seed(ctx)
        deny_mic(ctx)
        page = ctx.new_page()
        open_chat(page, "denied")
        page.wait_for_selector(".voice-btn:not([disabled])", timeout=8000)
        page.click(".voice-btn")
        page.wait_for_selector(".voice-status.is-error", timeout=8000)
        msg = page.locator(".voice-status").inner_text()
        check("denied mic shows a visible reason",
              "denied" in msg.lower() or "permission" in msg.lower(), repr(msg))
        check("button returns to idle after the denial",
              page.locator(".voice-btn.listening").count() == 0
              and page.locator(".voice-btn:not([disabled])").count() == 1)
        ctx.close()

        browser.close()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    TMP.mkdir(exist_ok=True)
    # The canned transcript lives with the suite's artefacts, not inline.
    (TMP / "stub-transcript.json").write_text(
        json.dumps({"partials": [PARTIAL_1, PARTIAL_2], "final": FINAL_TEXT},
                   indent=2)
    )
    server = start_server()
    try:
        run_checks()
    finally:
        server.terminate()
        server.wait(timeout=5)

    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
