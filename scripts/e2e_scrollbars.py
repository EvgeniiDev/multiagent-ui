#!/usr/bin/env python3
"""E2E: scrollbars must be painted from the theme in BOTH colour schemes.

Measures what the browser actually resolves, not what the stylesheet claims:
  * `color-scheme` on :root per scheme — this is what stops the engine drawing
    its default cool-white bar at all;
  * `scrollbar-color` on a real scrolled element resolves to the SAME colour as
    the token (compared value-by-value, not by string shape);
  * the token is a warm ink tint, never white;
  * the two schemes do not resolve to the same bar.

Note: headless Chromium uses overlay scrollbars, so a scrolled element reports
0px of layout width — the probe therefore asserts `scrollbar-width: thin` is
applied rather than a non-zero gutter.

Usage: npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_scrollbars.py
"""
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25987
BASE = f"http://127.0.0.1:{PORT}/"
REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-web"

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def chan(value: str) -> str:
    """Normalise a colour to 'r,g,b' + optional alpha, so '0.22' == '.22'."""
    nums = re.findall(r"[\d.]+", value.replace("rgba(", "").replace("rgb(", ""))
    if not nums:
        return value
    out = [nums[0], nums[1], nums[2]]
    if len(nums) > 3:
        out.append(str(round(float(nums[3]), 3)))
    return ",".join(out)


def start_server():
    for _ in range(30):
        s = socket.socket()
        # SO_REUSEADDR: a socket left in TIME_WAIT by the previous run would
        # otherwise fail this availability probe for up to a minute while the
        # real server would have bound fine.
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


PROBE = """() => {
  const root = getComputedStyle(document.documentElement);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:0;left:0;width:120px;height:60px;overflow:scroll';
  probe.innerHTML = '<div style="width:400px;height:400px"></div>';
  document.body.appendChild(probe);
  // Resolve the token the same way the browser resolves it in scrollbar-color.
  const tok = document.createElement('div');
  tok.style.cssText = 'color: var(--scrollbar-thumb)';
  document.body.appendChild(tok);
  const out = {
    colorScheme: root.colorScheme,
    thumbToken: root.getPropertyValue('--scrollbar-thumb').trim(),
    thumbResolved: getComputedStyle(tok).color,
    scrollbarColor: getComputedStyle(probe).scrollbarColor,
    scrollbarWidth: getComputedStyle(probe).scrollbarWidth,
  };
  probe.remove();
  tok.remove();
  return out;
}"""


def measure(browser, scheme):
    ctx = browser.new_context(color_scheme=scheme, viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.route(re.compile(r":25900/"), lambda r: r.abort())
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".view-rail", timeout=10000)
    out = page.evaluate(PROBE)
    ctx.close()
    return out


def main():
    proc = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            seen = {}
            for scheme in ("light", "dark"):
                m = measure(browser, scheme)
                seen[scheme] = m
                thumb = m["scrollbarColor"].split(")")[0] + ")"

                check(f"{scheme}: color-scheme follows the theme",
                      m["colorScheme"].startswith(scheme), repr(m["colorScheme"]))
                check(f"{scheme}: scrollbar-color thumb == the theme token",
                      chan(thumb) == chan(m["thumbResolved"]),
                      f"bar={thumb} token={m['thumbResolved']}")
                track = chan(m["scrollbarColor"].split(") ", 1)[1]).split(",")
                # fully transparent: every channel zero and alpha 0 (0 or 0.0)
                check(f"{scheme}: the track is transparent (no white gutter)",
                      track[:3] == ["0", "0", "0"] and float(track[3]) == 0.0,
                      f"track={track} from {m['scrollbarColor']!r}")
                check(f"{scheme}: a painted thin scrollbar, not the default",
                      m["scrollbarWidth"] == "thin", repr(m["scrollbarWidth"]))
                check(f"{scheme}: thumb token is an ink tint, never white",
                      m["thumbToken"] not in ("", "#fff", "#ffffff", "white")
                      and chan(m["thumbResolved"]) not in ("255,255,255", "255,255,255,1"),
                      repr(m["thumbResolved"]))

            check("the two schemes paint different scrollbars",
                  chan(seen["light"]["thumbResolved"]) != chan(seen["dark"]["thumbResolved"])
                  and seen["light"]["colorScheme"] != seen["dark"]["colorScheme"],
                  f"light={seen['light']['thumbResolved']} dark={seen['dark']['thumbResolved']}")
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
    sys.exit(main())
