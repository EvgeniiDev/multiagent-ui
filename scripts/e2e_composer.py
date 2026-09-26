#!/usr/bin/env python3
"""E2E for the composer rework (cc/v2-composer): one-line resting field with
autogrow + uniform square icon buttons.

Serves dist-web on http://127.0.0.1:25986/, answers the app's ACP handshake
over a mocked websocket so a session connects and `.input-row` mounts.

Asserts, at 1440x900 and 390x844:
  * rest height: the textarea is exactly one line — same height as the row's
    icon buttons (34px desktop, 44px touch), +-4px;
  * 4 lines of input grow it, ~15 lines cap at ~200px with internal scroll,
    clearing or a real send returns it to the resting height;
  * every button in the row shares one geometry (same w/h, radius 6px,
    box-shadow: none), and is >= 44px on the phone;
  * no emoji glyphs anywhere in the composer DOM — icons are <svg>;
  * disabled Send is a quiet hairline (no --bg-primary fill), armed Send is
    the single accent fill of the row;
  * zero pageerror events.

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_composer.py

Screenshots land in docs/composer-{1440x900,1024x768,390x844}.png.
Prints PASS/FAIL per assertion and exits non-zero on any failure.
"""

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
PORT = 25986
BASE = f"http://127.0.0.1:{PORT}/"

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


# --------------------------------------------------------------------------
# Fakes: ACP websocket agent + bridge fs API (same shape as the other suites).
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
                result = {}  # session/prompt etc. resolve empty
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
    agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                    "url": "ws://127.0.0.1:25993/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
    for key, val in (("acp-ui:agents", agents), ("acp-ui:preferences.json", prefs)):
        context.add_init_script(
            f"if (!localStorage.getItem({json.dumps(key)}))"
            f" localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});"
        )


def open_chat(page, tag):
    page.route(re.compile(r"/api/fs/"), fs_api)
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
    page.on("pageerror", lambda exc: page_errors.append(f"{tag}: {exc}"))
    page.goto(BASE, wait_until="load")
    # Narrow layouts keep the sidebar in a drawer — open it first.
    if page.viewport_size and page.viewport_size["width"] < 800:
        page.wait_for_selector(".mobile-hamburger", timeout=10000)
        page.click(".mobile-hamburger")
        page.wait_for_selector(".sidebar .list-new-session", timeout=5000)
    page.wait_for_selector(".list-new-session:not([disabled])", timeout=10000)
    page.click(".list-new-session")
    page.wait_for_selector(".input-row", timeout=15000)
    page.wait_for_timeout(400)  # autosize + first paint


# --------------------------------------------------------------------------
# Measurement helpers (all run inside the page).
# --------------------------------------------------------------------------

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
    """Resolve a :root CSS var to its computed color on a probe element."""
    return page.evaluate(
        """(v) => { const d = document.createElement('div');
                   d.style.cssText = `color: var(${v}); position:absolute; visibility:hidden`;
                   document.body.appendChild(d);
                   const c = getComputedStyle(d).color;
                   d.remove();
                   return c; }""",
        name,
    )


def row_buttons(page):
    return page.evaluate(
        """() => [...document.querySelectorAll('.input-row .icon-btn')].map(el => {
             const r = el.getBoundingClientRect();
             const cs = getComputedStyle(el);
             return { cls: String(el.className), w: r.width, h: r.height,
                      radius: cs.borderTopLeftRadius, shadow: cs.boxShadow,
                      disabled: el.disabled, svg: !!el.querySelector('svg'),
                      text: (el.textContent || '').trim() };
           })""",
    )


def composer_emoji_scan(page):
    """Emoji presentation codepoints inside the composer subtree."""
    return page.evaluate(
        """() => {
          const root = document.querySelector('.input-container');
          if (!root) return ['<no .input-container>'];
          const re = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}\\u{1F1E6}-\\u{1F1FF}]/u;
          const hits = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const t = n.textContent || '';
            if (re.test(t)) hits.push(t.trim().slice(0, 40));
          }
          return hits;
        }""",
    )


def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---------------- 1440x900 ----------------
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        seed(ctx)
        page = ctx.new_page()
        open_chat(page, "1440")

        # --- resting geometry ---
        ta = rect(page, ".composer-box textarea")
        buttons = row_buttons(page)
        check("1440: composer mounts with field + 2 icon buttons",
              ta is not None and len(buttons) == 2, repr(buttons))
        sizes = {(round(b["w"], 1), round(b["h"], 1)) for b in buttons}
        check("1440: all row buttons share one square geometry",
              len(sizes) == 1 and abs(list(sizes)[0][0] - list(sizes)[0][1]) < 1,
              repr(sizes))
        btn_h = list(sizes)[0][1] if sizes else 0
        check("1440: textarea rest height ~= button height (+-4px)",
              ta is not None and abs(ta["h"] - btn_h) <= 4,
              f"textarea {ta and ta['h']:.1f} vs buttons {btn_h:.1f}")
        check("1440: buttons are 34px squares", abs(btn_h - 34) <= 1.5,
              f"{btn_h:.1f}px")

        check("1440: every row button: radius 6px, no shadow",
              all(b["radius"] == "6px" and b["shadow"] == "none" for b in buttons),
              repr([(b["radius"], b["shadow"]) for b in buttons]))
        check("1440: every row button carries an svg icon, no text",
              all(b["svg"] and not b["text"] for b in buttons),
              repr([(b["svg"], b["text"]) for b in buttons]))

        box = css(page, ".composer-box",
                  ["border-top-width", "border-top-left-radius", "border-top-color"])
        check("1440: single hairline frame (1px, radius-lg) wraps field+attach",
              box is not None and box["border-top-width"] == "1px"
              and box["border-top-left-radius"] == "10px", repr(box))
        check("1440: attach button sits inside the field frame",
              page.locator(".composer-box .attach-btn").count() == 1)

        hits = composer_emoji_scan(page)
        check("1440: no emoji glyphs in the composer DOM", hits == [], repr(hits))

        # --- disabled vs armed Send ---
        muted = token(page, "--text-muted")
        faint = token(page, "--border-faint")
        accent = token(page, "--bg-primary")
        on_accent = token(page, "--text-on-accent")
        dis = css(page, ".send-btn", ["background-color", "color", "border-top-color"])
        check("1440: disabled Send is a quiet hairline (no accent fill, muted icon)",
              dis is not None
              and dis["background-color"] != accent
              and dis["color"] == muted
              and dis["border-top-color"] == faint,
              repr(dis))
        page.fill(".composer-box textarea", "x")
        # Let the v-model -> disabled flip render AND the 0.15s fill
        # transition settle, else we sample a mid-interpolation alpha.
        page.wait_for_timeout(300)
        en = css(page, ".send-btn", ["background-color", "color"])
        check("1440: armed Send takes the accent fill",
              en is not None and en["background-color"] == accent
              and en["color"] == on_accent, repr(en))
        page.fill(".composer-box textarea", "")

        # --- focus-visible contour ---
        page.evaluate("() => document.querySelector('.attach-btn').focus()")
        page.wait_for_timeout(60)
        fv = page.evaluate(
            """() => { const el = document.querySelector('.attach-btn');
                      const cs = getComputedStyle(el);
                      return { visible: el.matches(':focus-visible'),
                               width: cs.outlineWidth, style: cs.outlineStyle,
                               offset: cs.outlineOffset, color: cs.outlineColor }; }"""
        )
        accent_text = token(page, "--text-accent")
        check("1440: focus-visible = 2px --text-accent outline, offset 2px",
              fv["visible"] and fv["width"] == "2px" and fv["style"] == "solid"
              and fv["offset"] == "2px" and fv["color"] == accent_text,
              repr(fv))

        # --- autogrow ---
        rest_h = ta["h"]
        page.fill(".composer-box textarea", "one\ntwo\nthree\nfour")
        page.wait_for_timeout(120)
        grew = rect(page, ".composer-box textarea")["h"]
        check("1440: 4 lines grow the field", grew > rest_h + 30,
              f"{rest_h:.0f} -> {grew:.0f}")

        page.fill(".composer-box textarea", "\n".join(f"line {i}" for i in range(15)))
        page.wait_for_timeout(120)
        cap = page.evaluate(
            """() => { const el = document.querySelector('.composer-box textarea');
                      const r = el.getBoundingClientRect();
                      const cs = getComputedStyle(el);
                      return { h: r.height, scroll: el.scrollHeight,
                               client: el.clientHeight, oy: cs.overflowY }; }"""
        )
        check("1440: ~15 lines cap at ~200px", abs(cap["h"] - 200) <= 2,
              f"h={cap['h']:.0f}")
        check("1440: capped field scrolls internally",
              cap["scroll"] > cap["client"] + 10 and cap["oy"] in ("auto", "scroll"),
              repr(cap))

        page.fill(".composer-box textarea", "")
        page.wait_for_timeout(120)
        back = rect(page, ".composer-box textarea")["h"]
        check("1440: clearing returns the field to rest height",
              abs(back - rest_h) <= 1, f"{rest_h:.0f} -> {back:.0f}")

        # --- real send resets too ---
        page.fill(".composer-box textarea", "one\ntwo\nthree\nfour")
        page.wait_for_timeout(120)
        page.press(".composer-box textarea", "Enter")
        page.wait_for_timeout(600)
        sent_h = rect(page, ".composer-box textarea")["h"]
        sent_v = page.eval_on_selector(".composer-box textarea", "el => el.value")
        check("1440: sending returns the field to rest height",
              abs(sent_h - rest_h) <= 1 and sent_v == "",
              f"h={sent_h:.0f} value={sent_v!r}")
        check("1440: sent turn appears in the transcript",
              page.locator(".message-user").count() >= 1)

        # --- attach tray still works inside the new frame ---
        probe = ROOT / "package.json"  # .json is in the accept list
        page.set_input_files(".file-input", str(probe))
        page.wait_for_timeout(400)
        check("1440: staged attachment renders the tray",
              page.locator(".attach-tray .attach-chip").count() == 1)
        active_css = css(page, ".attach-btn.active", ["background-color", "color"])
        tint_active = token(page, "--tint-active")
        check("1440: staged files mark attach with the active tint",
              active_css is not None
              and active_css["background-color"] == tint_active
              and active_css["color"] == accent_text,
              repr(active_css))
        page.locator(".attach-remove").click()
        page.wait_for_timeout(200)
        check("1440: tray clears", page.locator(".attach-chip").count() == 0)

        page.screenshot(path=str(SHOTS / "composer-1440x900.png"))

        # --- 1024x768 (same page, reflow through the ResizeObserver) ---
        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(300)
        ta1024 = rect(page, ".composer-box textarea")
        check("1024: field still rests at button height after resize",
              ta1024 is not None and abs(ta1024["h"] - rest_h) <= 4,
              f"{ta1024 and ta1024['h']:.0f}px")
        page.screenshot(path=str(SHOTS / "composer-1024x768.png"))
        ctx.close()

        # ---------------- 390x844 ----------------
        phone = browser.new_context(ignore_https_errors=True,
                                    viewport={"width": 390, "height": 844})
        seed(phone)
        p2 = phone.new_page()
        open_chat(p2, "390")

        ta3 = rect(p2, ".composer-box textarea")
        buttons3 = row_buttons(p2)
        sizes3 = {(round(b["w"], 1), round(b["h"], 1)) for b in buttons3}
        check("390: all row buttons share one geometry >= 44px",
              len(sizes3) == 1 and list(sizes3)[0][0] >= 44 - 0.6
              and list(sizes3)[0][1] >= 44 - 0.6,
              repr(sizes3))
        btn_h3 = list(sizes3)[0][1] if sizes3 else 0
        check("390: textarea rest height ~= button height (+-4px)",
              ta3 is not None and abs(ta3["h"] - btn_h3) <= 4,
              f"textarea {ta3 and ta3['h']:.1f} vs buttons {btn_h3:.1f}")
        check("390: buttons keep radius 6px + no shadow",
              all(b["radius"] == "6px" and b["shadow"] == "none" for b in buttons3),
              repr([(b["radius"], b["shadow"]) for b in buttons3]))
        hits3 = composer_emoji_scan(p2)
        check("390: no emoji glyphs in the composer DOM", hits3 == [], repr(hits3))
        dis3 = css(p2, ".send-btn", ["background-color", "color", "border-top-color"])
        check("390: disabled Send stays a quiet hairline",
              dis3 is not None
              and dis3["background-color"] != token(p2, "--bg-primary")
              and dis3["color"] == token(p2, "--text-muted"),
              repr(dis3))
        # grow + reset on the phone too
        p2.fill(".composer-box textarea", "a\nb\nc\nd")
        p2.wait_for_timeout(120)
        grew3 = rect(p2, ".composer-box textarea")["h"]
        check("390: field grows on input", grew3 > ta3["h"] + 30,
              f"{ta3['h']:.0f} -> {grew3:.0f}")
        p2.fill(".composer-box textarea", "")
        p2.wait_for_timeout(120)
        check("390: clearing returns to rest height",
              abs(rect(p2, ".composer-box textarea")["h"] - ta3["h"]) <= 1)
        # The drawer is still open from connecting — dismiss it via the
        # backdrop so the shot shows the composer, not the sidebar.
        p2.mouse.click(370, 400)
        p2.wait_for_timeout(300)
        p2.screenshot(path=str(SHOTS / "composer-390x844.png"))
        phone.close()

        browser.close()


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
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
