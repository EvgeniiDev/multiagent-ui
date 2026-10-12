#!/usr/bin/env python3
"""E2E for composer voice input using the audio-video-to-text HTTP API.

Serves dist-web on http://127.0.0.1:25991/, stubs the ACP websocket, and
intercepts the transcriber's OpenAPI probe and multipart WAV request. Chromium
uses a fake microphone so audio capture and WAV encoding run through production
code, while inference remains deterministic.
"""

import io
import json
import os
import re
import sys
import time
import wave
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = Path(os.environ.get("ACP_UI_DIST", str(ROOT / "dist-web")))
TMP = ROOT / "tmp-voice-test"
SHOTS = TMP / "screenshots"
PORT = 25991
BASE = f"http://127.0.0.1:{PORT}/"

FINAL_TEXT = "the quick brown fox"

results = []
page_errors = []
stt_stats = {
    "health_checks": 0, "health_path": "", "requests": 0,
    "method": "", "multipart": False, "wav_bytes": 0, "valid_wav": False,
}


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API + transcription HTTP API.
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


def make_mime_envelope(content_type: str, body: bytes) -> bytes:
    """Add RFC-compliant CRLF-delimited headers around a browser multipart body."""
    crlf = bytes((13, 10))
    return (
        b"MIME-Version: 1.0" + crlf
        + b"Content-Type: " + content_type.encode("ascii") + crlf + crlf
        + body
    )


def transcribe(route):
    """Stub the synchronous multipart API and inspect the production WAV."""
    stt_stats["requests"] += 1
    body = cast(bytes, route.request.post_data_buffer) or b""
    content_type = route.request.header_value("content-type") or ""
    stt_stats["method"] = route.request.method
    stt_stats["multipart"] = content_type.lower().startswith("multipart/form-data; boundary=")
    stt_stats["wav_bytes"] = len(body)
    stt_stats["valid_wav"] = False
    try:
        envelope = make_mime_envelope(content_type, body)
        message = BytesParser(policy=default).parsebytes(envelope)
        if message.get_content_type() != "multipart/form-data" or not message.is_multipart():
            raise ValueError("invalid multipart/form-data envelope")
        files = [
            part for part in message.iter_parts()
            if part.get_param("name", header="content-disposition") == "file"
        ]
        if len(files) == 1:
            file_part = files[0]
            payload = file_part.get_payload(decode=True) or b""
            with wave.open(io.BytesIO(payload), "rb") as wav:
                stt_stats["valid_wav"] = (
                    file_part.get_filename() == "recording.wav"
                    and file_part.get_content_type() == "audio/wav"
                    and wav.getnchannels() == 1
                    and wav.getframerate() == 16000
                    and wav.getsampwidth() == 2
                    and wav.getnframes() > 0
                )
    except (ValueError, OSError, TypeError, EOFError, wave.Error):
        stt_stats["valid_wav"] = False
    headers = {"access-control-allow-origin": "*"}
    if STUB["mode"] == "error":
        route.fulfill(status=503, content_type="text/plain", headers=headers,
                      body="inference unavailable")
    else:
        route.fulfill(status=200, content_type="text/plain", headers=headers,
                      body=FINAL_TEXT)


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
    stt_stats["health_checks"] += 1
    stt_stats["health_path"] = urlsplit(route.request.url).path
    route.fulfill(
        status=200,
        content_type="application/json",
        headers={"access-control-allow-origin": "*"},
        body=json.dumps({"paths": {"/v1/audio/transcriptions": {"post": {}}}}),
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


def wire_routes(page, tag, health=health_ok):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":8099/openapi\.json"), health)
    page.route(re.compile(r":8099/v1/audio/transcriptions"), transcribe)
    # A real state server may be running on the host (it holds a persisted
    # activeView that hid the sidebar once). Refuse it so the page falls
    # back to localStorage and every run starts from the same state.
    page.route(re.compile(r":25900/"), lambda route: route.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))


def open_chat(page, tag, **kwargs):
    wire_routes(page, tag, **kwargs)
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".tab-new:not([disabled])", timeout=10000)
    page.click(".tab-new")
    page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
    page.click(".nsm-start")
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
        for _ in range(20):
            if stt_stats["health_checks"]:
                break
            page.wait_for_timeout(50)
        check("voice readiness probes the OpenAPI transcription endpoint",
              stt_stats["health_checks"] > 0
              and stt_stats["health_path"] == "/openapi.json",
              repr(stt_stats))

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
        check("click starts recording and shows the listening state", True)
        check("status line shows the listening timer",
              page.locator(".voice-status").inner_text().startswith("Listening"),
              page.locator(".voice-status").inner_text())
        page.wait_for_timeout(700)
        page.screenshot(path=str(SHOTS / "voice-listening.png"))

        # Stop sends the captured audio as one multipart WAV request.
        page.click(".voice-btn")
        page.wait_for_function(
            "() => document.querySelector('.composer-box textarea')?.value === 'note: the quick brown fox'",
            timeout=20000,
        )
        check("recording reached the transcription API as a multipart WAV",
              stt_stats["requests"] == 1
              and stt_stats["method"] == "POST"
              and stt_stats["multipart"]
              and stt_stats["wav_bytes"] > 44
              and stt_stats["valid_wav"], repr(stt_stats))
        check("final text stays in the field after transcription",
              field_value(page) == f"note: {FINAL_TEXT}", repr(field_value(page)))
        check("overlay cleared once idle", page.locator(".voice-overlay").count() == 0)

        # A second click starts a fresh take; Escape stops it too.
        page.click(".voice-btn")
        page.wait_for_selector(".voice-btn.listening", timeout=8000)
        check("second click starts a new take", True)
        before = field_value(page)
        page.keyboard.press("Escape")
        expected_after_escape = before + " " + FINAL_TEXT
        page.wait_for_function(
            "() => document.querySelector('.composer-box textarea')?.value === "
            + json.dumps(expected_after_escape),
            timeout=5000,
        )
        check("Escape submits the second take and keeps the text",
              field_value(page) == expected_after_escape, repr(field_value(page)))
        check("two audio uploads reached the API", stt_stats["requests"] == 2,
              repr(stt_stats))
        page.screenshot(path=str(SHOTS / "voice-after.png"))
        ctx.close()

        # ---------------- API failure is visible and does not hang ----------------
        STUB["mode"] = "error"
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
            permissions=["microphone"],
        )
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "api-error")
        page.click(".voice-btn")
        page.wait_for_selector(".voice-btn.listening", timeout=8000)
        page.wait_for_timeout(400)
        page.click(".voice-btn")
        page.wait_for_selector(".voice-status.is-error", timeout=20000)
        message = page.locator(".voice-status").inner_text()
        check("transcription API failure is visible",
              "503" in message or "inference unavailable" in message.lower(), message)
        check("mic returns to idle after API failure",
              page.locator(".voice-btn.listening").count() == 0)
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
    SHOTS.mkdir(exist_ok=True)
    # The canned transcript is stored with the suite's artefacts.
    (TMP / "stub-transcript.json").write_text(
        json.dumps({"api": "/v1/audio/transcriptions", "text": FINAL_TEXT}, indent=2)
    )
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
