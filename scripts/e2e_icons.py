"""E2E: no emoji icons (stroke SVG only) + icon-bearing controls still work.

Builds the web bundle, serves dist-web on port 25997, drives it with
playwright (chromium headless) and asserts:
  1. zero glyphs in U+1F300-1FAFF, U+2600-27BF, U+FE0F, U+2B00-2BFF in the
     rendered DOM (every element's own text nodes + attributes);
  2. settings / traffic / hamburger / directory picker / add-agent form
     (hosts EnvVarEditor) / error banner all open and close;
  3. the zero-emoji scan passes with Settings + Traffic open;
  4. zero pageerror events;
  5. (static) no glyphs in that range remain in src/** templates/strings.

Prints PASS/FAIL per assertion, exits non-zero on failure.
"""
import re
import subprocess
import sys
import time
from pathlib import Path

from _e2e_harness import serve_web, stop

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
PORT = 25997
URL = f"http://127.0.0.1:{PORT}/"  # rebased in main() to the served port

EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u2B00-\u2BFF]")

SCAN_JS = """() => {
  const re = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\uFE0F\\u{2B00}-\\u{2BFF}]/u;
  const bad = [];
  for (const el of document.body.querySelectorAll('*')) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && re.test(n.textContent || '')) {
        bad.push(el.tagName + '.' + el.className + ': ' + n.textContent.trim().slice(0, 60));
      }
    }
    for (const a of el.getAttributeNames()) {
      const v = el.getAttribute(a);
      if (v && re.test(v)) bad.push(el.tagName + '@' + a + ': ' + v.slice(0, 60));
    }
  }
  return bad.slice(0, 20);
}"""

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))


def main() -> int:
    from playwright.sync_api import sync_playwright

    r = subprocess.run(["npm", "run", "build:web"], cwd=ROOT,
                       capture_output=True, text=True)
    check("build:web green", r.returncode == 0, r.stderr[-2000:] if r.returncode else "")
    if r.returncode != 0:
        return report()

    global URL
    server, URL = serve_web(PORT, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True,
                                      viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(URL, wait_until="domcontentloaded")
            page.wait_for_selector(".app-container", timeout=20000)
            page.wait_for_timeout(1200)

            bad = page.evaluate(SCAN_JS)
            check("load: zero emoji in DOM", bad == [], str(bad))

            # Settings open/close (also hosts SettingsView + EnvVarEditor).
            page.click('.scope-icon-btn[title="Settings"]')
            page.wait_for_selector(".settings-panel", timeout=5000)
            settings_open = page.is_visible(".settings-panel")
            bad = page.evaluate(SCAN_JS)
            check("settings opens, zero emoji", settings_open and bad == [],
                  str(bad) if bad else "panel not visible")
            # Add-agent form hosts EnvVarEditor (headers branch on web).
            page.click(".settings-panel .add-btn")
            page.wait_for_timeout(400)
            env_present = page.is_visible(".settings-panel .env-var-editor")
            check("add-agent form shows EnvVarEditor", env_present)
            if env_present:
                page.eval_on_selector(".settings-panel .add-env-btn", "el => el.click()")
                page.wait_for_timeout(300)
                row = page.is_visible(".settings-panel .env-row")
                rm = page.query_selector(".settings-panel .remove-env-btn svg")
                if row:
                    page.eval_on_selector(".settings-panel .remove-env-btn", "el => el.click()")
                    page.wait_for_timeout(300)
                check("env row add/remove works, remove is SVG",
                      row and rm is not None and not page.query_selector(".settings-panel .env-row"))
            page.click(".settings-panel .close-btn")
            page.wait_for_timeout(400)
            check("settings closes", not page.query_selector(".settings-panel"))

            # Traffic panel open/close (hosts TrafficMonitor).
            page.click('.scope-icon-btn[title="ACP Traffic Monitor"]')
            page.wait_for_selector(".traffic-monitor", timeout=5000)
            traffic_open = page.is_visible(".traffic-monitor")
            has_svg = page.query_selector(".traffic-monitor svg") is not None
            page.click(".traffic-monitor .close-btn")
            page.wait_for_timeout(400)
            check("traffic opens (SVG icons) and closes",
                  traffic_open and has_svg and not page.query_selector(".traffic-monitor"))

            # Directory picker browse overlay — it lives inside the tab bar's
            # "+" menu now.
            page.click(".tab-new")
            page.wait_for_selector(".nsm-menu .dir-picker .browse-btn", timeout=5000)
            page.click(".nsm-menu .dir-picker .browse-btn")
            page.wait_for_selector(".tree-overlay", timeout=5000)
            picker_open = page.is_visible(".tree-overlay")
            bad = page.evaluate(SCAN_JS)
            check("directory picker opens, zero emoji", picker_open and bad == [],
                  str(bad) if bad else "overlay not visible")
            page.click(".tree-panel .tree-close")
            page.wait_for_timeout(300)
            check("directory picker closes", not page.query_selector(".tree-overlay"))
            page.keyboard.press("Escape")  # close the "+" menu

            # Error banner path: add a fake ws agent and start a session on it
            # -> connect fails -> banner with SVG icon, dismissable.
            page.click('.scope-icon-btn[title="Settings"]')
            page.wait_for_selector(".settings-panel", timeout=5000)
            page.click(".settings-panel .add-btn")
            page.wait_for_timeout(300)
            page.fill('.settings-panel input[placeholder="My Agent"]', "e2e-fake")
            page.fill('.settings-panel input[placeholder="wss://acp.example.com/v1"]',
                      "ws://127.0.0.1:9/nope")
            page.eval_on_selector(".settings-panel .save-btn", "el => el.click()")
            page.wait_for_timeout(800)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            if page.query_selector(".settings-panel"):
                page.click(".settings-panel .close-btn")
                page.wait_for_timeout(300)
            # The tab bar's "+" menu: pick the dead agent and start — the
            # connect failure must surface as the app's error banner.
            page.wait_for_selector(".tab-new:not([disabled])", timeout=5000)
            page.click(".tab-new")
            page.wait_for_selector("#nsm-agent", timeout=5000)
            page.select_option("#nsm-agent", "e2e-fake")
            page.click(".nsm-start")
            page.wait_for_timeout(1000)
            page.keyboard.press("Escape")  # dismiss the menu if still open
            banner = page.query_selector(".error-banner")
            banner_svg = page.query_selector(".error-banner .error-icon svg")
            bad = page.evaluate(SCAN_JS)
            check("error banner shows with SVG icon, zero emoji",
                  banner is not None and banner_svg is not None and bad == [],
                  str(bad) if bad else "no banner (agent add may have failed)")
            if banner:
                page.click(".error-banner .error-close")
                page.wait_for_timeout(300)
                check("error banner dismisses", not page.query_selector(".error-banner"))

            # Zero-emoji scan with Settings + Traffic both open (traffic
            # first: the settings overlay covers the header buttons).
            page.click('.scope-icon-btn[title="ACP Traffic Monitor"]')
            page.wait_for_selector(".traffic-monitor", timeout=5000)
            page.click('.scope-icon-btn[title="Settings"]')
            page.wait_for_selector(".settings-panel", timeout=5000)
            page.wait_for_timeout(400)
            bad = page.evaluate(SCAN_JS)
            check("zero emoji with Settings + Traffic open", bad == [], str(bad))
            page.eval_on_selector(".settings-panel .close-btn", "el => el.click()")
            page.wait_for_timeout(300)

            # Hamburger on a narrow viewport.
            narrow = browser.new_context(ignore_https_errors=True,
                                         viewport={"width": 500, "height": 900}).new_page()
            narrow.route(re.compile(r":25900/"), lambda r: r.abort())
            narrow.on("pageerror", lambda e: errors.append("narrow: " + str(e)))
            narrow.goto(URL, wait_until="domcontentloaded")
            narrow.wait_for_selector(".app-container", timeout=20000)
            narrow.wait_for_timeout(1000)
            ham = narrow.query_selector(".mobile-hamburger")
            ham_visible = ham is not None and ham.is_visible()
            ham_svg = narrow.query_selector(".mobile-hamburger svg")
            bad = narrow.evaluate(SCAN_JS)
            if ham_visible:
                narrow.eval_on_selector(".mobile-hamburger", "el => el.click()")
                narrow.wait_for_timeout(500)
                drawer = narrow.evaluate(
                    "() => getComputedStyle(document.querySelector('.sidebar')).display")
                narrow.eval_on_selector(".drawer-backdrop", "el => el.click()")
                narrow.wait_for_timeout(400)
            else:
                drawer = "hamburger not visible"
            check("hamburger opens/closes drawer, zero emoji",
                  ham_visible and ham_svg is not None and bad == [] and drawer != "none",
                  f"visible={ham_visible} svg={ham_svg is not None} bad={bad} drawer={drawer}")

            check("zero pageerror events", errors == [], str(errors[:5]))
            browser.close()

        # Static floor: nothing in the glyph range left in src/.
        hits = [f"{p.relative_to(ROOT)}:{i}" for p in sorted((ROOT / "src").rglob("*"))
                if p.is_file()
                for i, line in enumerate(p.read_text().splitlines(), 1)
                if EMOJI.search(line)]
        check("src/** free of emoji-range glyphs", not hits, str(hits[:10]))
    finally:
        stop(server)
    return report()


def report() -> int:
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
