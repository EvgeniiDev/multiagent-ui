#!/usr/bin/env python3
"""E2E for the `color: white` -> var(--text-on-accent, #fbf8f3) pass (cc/tokens).

For each of the four elements whose rule switched to the accent-ink token —
`.send-btn` (ChatView.vue), `.add-btn` :hover, `.save-btn`, `.delete-btn`
:hover (SettingsView.vue) — the
script measures the computed `color` against the composited background (walk
ancestors, collect every backgroundColor with alpha > 0, stop at the first
opaque layer, composite bottom-up `out = top*top.a + out*(1-top.a)`) and
asserts WCAG >= 4.5:1. Runs under BOTH `color_scheme="dark"` and `"light"`
at 1440x900, then clicks each of the four `.rail-btn` views and requires zero
`pageerror` events.

`.send-btn` only renders while a session is connected, so the script answers
the ACP JSON-RPC handshake itself via
`page.route_web_socket` (initialize + session/new on a ws:// URL seeded into
the web agents config). The DirectoryPicker's `/api/fs/*` calls are stubbed,
and telemetry is disabled via the seeded preferences store.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_white_text.py

The script builds (`npm run build:web`), serves dist-web itself on
http://127.0.0.1:25992/, prints PASS/FAIL per assertion and exits non-zero on
any failure.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
PORT = 25992
BASE = f"http://127.0.0.1:{PORT}/"
MIN_RATIO = 4.5

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# WCAG contrast on the composited background.
# --------------------------------------------------------------------------

def _lin(v255):
    c = v255 / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lum(rgb):
    return 0.2126 * _lin(rgb[0]) + 0.7152 * _lin(rgb[1]) + 0.0722 * _lin(rgb[2])


def contrast(fg_rgb, bg_rgb):
    l1, l2 = _lum(fg_rgb), _lum(bg_rgb)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# Walk ancestors; collect every backgroundColor with alpha > 0; stop at the
# first opaque one; composite bottom-up per the brief's formula.
JS_MEASURE = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const parse = (s) => {
    const m = /rgba?\\(([^)]*)\\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const layers = [];
  let node = el;
  for (;;) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg[3] > 0) {
      layers.push(bg);
      if (bg[3] >= 1) break;
    }
    if (node === document.documentElement) break;
    node = node.parentElement;
    if (!node) break;
  }
  let out = [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) {
    const [r, g, b, a] = layers[i];
    out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
  }
  const fg = parse(getComputedStyle(el).color);
  const rect = el.getBoundingClientRect();
  return { fg, bg: out, shown: rect.width > 0 && rect.height > 0 };
}"""


def measure(page, scheme, sel, origin, hover=False):
    """Assert `sel`'s computed color is >= 4.5:1 over its composited bg."""
    try:
        if hover:
            page.locator(sel).first.hover()
        else:
            # Park the pointer off the element so a leftover click position
            # doesn't put it in :hover (the buttons stack in the same spot).
            page.mouse.move(720, 450)
        page.wait_for_timeout(80)
        data = page.evaluate(JS_MEASURE, sel)
    except Exception as e:  # element gone / navigation raced
        check(f"{scheme} {sel}: contrast >= {MIN_RATIO}", False, f"evaluate failed: {e}")
        return
    if data is None or not data["shown"]:
        check(f"{scheme} {sel}: contrast >= {MIN_RATIO}", False, f"no rendered element for {sel}")
        return
    fg, bg = data["fg"], data["bg"]
    if fg[3] < 1:  # translucent text: fold over the background first
        a = fg[3]
        fg = [fg[i] * a + bg[i] * (1 - a) for i in range(3)]
    after = contrast(fg[:3], bg)
    before = contrast([255, 255, 255], bg)  # what `color: white` measured
    check(
        f"{scheme} {sel} ({origin}): contrast >= {MIN_RATIO}",
        after >= MIN_RATIO,
        f"after {after:.2f}:1, before {before:.2f}:1, "
        f"fg rgb({fg[0]:.0f},{fg[1]:.0f},{fg[2]:.0f}) on rgb({bg[0]:.0f},{bg[1]:.0f},{bg[2]:.0f})",
    )


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API.
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
                continue  # notification (e.g. $/ping heartbeat)
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


def fs_api(route):
    """Stub the bridge's /api/fs/* used by the web DirectoryPicker."""
    if "/api/fs/root" in route.request.url:
        body = {"root": "/home/hermes"}
    else:
        body = {
            "path": "/home/hermes",
            "parent": "/home",
            "root": "/home/hermes",
            "dirs": [{"name": "acp-ui-cc-tokens", "path": "/home/hermes/acp-ui-cc-tokens"}],
        }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def seed(context):
    """localStorage: one ws agent, telemetry off, a couple of saved sessions."""
    agents = {
        "agents": {
            "E2E Mock": {"transport": "websocket", "url": "ws://127.0.0.1:25993/"},
        }
    }
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/acp-ui-cc-tokens"}
    now = int(time.time() * 1000)
    sessions = {
        "sessions": [
            {"id": "saved-1", "agentName": "E2E Mock", "sessionId": "sess-e2e-1",
             "title": "acp-ui tokens work", "lastUpdated": now - 3600_000,
             "cwd": "/home/hermes/acp-ui-cc-tokens", "supportsLoadSession": True,
             "origin": "local"},
            {"id": "saved-2", "agentName": "E2E Mock", "sessionId": "sess-e2e-2",
             "title": "infra triage", "lastUpdated": now - 7200_000,
             "cwd": "/home/hermes/projects/infra", "supportsLoadSession": True,
             "origin": "local"},
        ]
    }
    for key, val in (
        ("acp-ui:agents", agents),
        ("acp-ui:preferences.json", prefs),
        ("acp-ui:sessions.json", sessions),
    ):
        context.add_init_script(
            f"localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def run_scheme(browser, scheme):
    ctx = browser.new_context(
        ignore_https_errors=True,
        viewport={"width": 1440, "height": 900},
        color_scheme=scheme,
    )
    seed(ctx)
    page = ctx.new_page()
    page.on("pageerror", lambda exc: page_errors.append(f"[{scheme}] {exc}"))
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)

    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".view-rail", timeout=10000)

    # The tab bar's "+" is muted-on-transparent, not accent ink — it is only
    # the way into a connected state, not a subject of this suite.
    page.wait_for_selector(".tab-new:not([disabled])", timeout=10000)

    # Connect through the mocked ACP handshake so the ChatView (.send-btn)
    # mounts — the menu opens prefilled (seeded agent + lastCwd).
    page.click(".tab-new")
    page.wait_for_selector(".nsm-start:not([disabled])", timeout=5000)
    page.click(".nsm-start")
    page.wait_for_selector(".send-btn", timeout=15000)
    page.fill(".chat-view textarea", "e2e probe")  # enable the send button
    measure(page, scheme, ".send-btn", "ChatView.vue:980")

    # Settings overlay: .add-btn and .delete-btn carry the token only on
    # :hover; .save-btn lives in the agent form opened via .add-btn.
    page.click('.scope-icon-btn[aria-label="Settings"]')
    page.wait_for_selector(".settings-overlay .add-btn", timeout=5000)
    measure(page, scheme, ".add-btn", "SettingsView.vue:457 :hover", hover=True)
    measure(page, scheme, ".agent-item .delete-btn", "SettingsView.vue:621 :hover", hover=True)
    page.click(".settings-overlay .add-btn")
    page.wait_for_selector(".agent-form .save-btn", timeout=5000)
    measure(page, scheme, ".agent-form .save-btn", "SettingsView.vue:524")
    page.click('.settings-overlay .close-btn')
    page.wait_for_selector(".settings-overlay", state="detached", timeout=5000)

    # Rail: all four main views must switch cleanly.
    views = [
        ("Projects", ".view-pane .head-controls"),
        ("Board", ".view-pane .tab-bar"),
        ("Dashboard", '.view-pane[data-testid="dashboard"]'),
        ("Chat", ".chat-view"),
    ]
    for label, sel in views:
        page.click(f'.rail-btn[aria-label="{label}"]')
        try:
            page.wait_for_selector(sel, timeout=5000)
            ok = True
        except Exception:
            ok = False
        check(f"{scheme} rail: {label} view mounts ({sel})", ok)

    ctx.close()


def main():
    build = subprocess.run(
        ["npm", "run", "build:web"], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    tail = "\n".join(build.stdout.rstrip().splitlines()[-6:])
    print("--- npm run build:web (tail) ---")
    print(tail)
    print("--------------------------------")
    if build.returncode != 0:
        print("FAIL  npm run build:web")
        sys.exit(1)

    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for scheme in ("dark", "light"):
                run_scheme(browser, scheme)
            browser.close()
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
