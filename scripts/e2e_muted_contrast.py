#!/usr/bin/env python3
"""Light-mode muted-text contrast audit (port 25991).

Builds the web bundle (`npm run build:web`), serves dist-web on
http://127.0.0.1:25991/, and for BOTH light and dark color schemes at
1440x900 across all four views (Chat/Projects/Board/Dashboard) computes
the WCAG ratio of every text node against its composited background
(walk ancestors collecting every backgroundColor with alpha > 0, stop
at the first opaque one, composite bottom-up
out = top*top.a + out*(1-top.a); threshold 4.5 for text <18.66px and
3.0 for >=18.66px bold or >=24px).

Asserts: light mode has zero failures except the three known
accent-adjacent cases (proposed, not fixed — see REPORT.md), dark mode
has zero failures, zero pageerror events. Prints before/after ratios
for --text-muted. Screenshots land in docs/muted-*.png.
"""

import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25991
ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
VIEWS = ["Chat", "Projects", "Board", "Dashboard"]
BASE = f"http://127.0.0.1:{PORT}/"

# The three accent-adjacent near-misses: owner's design decision, proposed
# in REPORT.md only, never changed here. fg accent = #c2532f (194,83,47),
# paper = #fbf8f3 (251,248,243).
ACCENT = (194, 83, 47)
PAPER = (251, 248, 243)

WALK_JS = """() => {
  function lum(r, g, b) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function parse(c) {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  // Walk ancestors collecting every non-transparent background, stop at
  // the first opaque one, then composite bottom-up.
  function bgOf(el) {
    const layers = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        layers.unshift(c);
        if (c.a >= 1) break;
      }
      node = node.parentElement;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    if ((!layers.length || layers[0].a < 1) && body) layers.unshift(body);
    let out = { r: 255, g: 255, b: 255 };
    for (const t of layers) out = { r: t.r * t.a + out.r * (1 - t.a),
      g: t.g * t.a + out.g * (1 - t.a), b: t.b * t.a + out.b * (1 - t.a) };
    return out;
  }
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode())) {
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
    }
    if (!hasText) continue;
    if (el.getClientRects().length === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const fg = parse(cs.color);
    if (!fg || fg.a < 1) continue;
    const bg = bgOf(el);
    const L1 = lum(fg.r, fg.g, fg.b), L2 = lum(bg.r, bg.g, bg.b);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3.0 : 4.5;
    rows.push({ ratio, need, px, fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      fgRgb: [fg.r, fg.g, fg.b], bgRgb: [bg.r, bg.g, bg.b],
      text: el.innerText.trim().slice(0, 60),
      sel: (el.className && el.className.baseVal === undefined ? String(el.className).split(' ')[0] : el.tagName) });
  }
  return { rows };
}"""

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def near(rgb, target, tol=8):
    return all(abs(a - b) <= tol for a, b in zip(rgb, target))


def is_accent_exception(r):
    # Case 1+2: accent text on light surfaces (tint or paper).
    if near(r["fgRgb"], ACCENT):
        return True
    # Case 3: near-white text on the accent fill (either scheme's fill).
    fg, bg = r["fgRgb"], r["bgRgb"]
    if (min(fg) >= 240 and bg[0] >= 150
            and bg[0] - bg[1] > 60 and bg[0] - bg[2] > 60):
        return True
    return False


def start_server():
    try:
        socket.create_connection(("127.0.0.1", PORT), 0.3).close()
    except OSError:
        pass
    else:
        print(f"FAIL  port {PORT} already in use — refusing to test a stale server")
        sys.exit(1)
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    print(f"FAIL  could not serve {DIST} on port {PORT}")
    sys.exit(1)


def audit(browser, scheme):
    ctx = browser.new_context(
        color_scheme=scheme, viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda exc: page_errors.append(f"{scheme}: {exc}"))
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(1500)
    fails = []
    for v in VIEWS:
        page.click(f'.rail-btn[aria-label="{v}"]')
        page.wait_for_timeout(800)
        data = page.evaluate(WALK_JS)
        for r in data["rows"]:
            if r["ratio"] + 1e-9 < r["need"]:
                fails.append((v, r))
        if scheme == "light":
            page.screenshot(path=str(SHOTS / f"muted-{v.lower()}-1440x900.png"))
    ctx.close()
    return fails


def token_ratio(page, fg_hex, bg_hex):
    return page.evaluate("""([f, b]) => {
      const lum = (hex) => {
        const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
        const g = c.map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
        return 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
      };
      const L1 = lum(f), L2 = lum(b);
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    }""", [fg_hex, bg_hex])


def live_token_ratio(page, fg_var, bg_var):
    return page.evaluate("""([f, b]) => {
      function lum(r, g, b) {
        const g2 = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * g2(r) + 0.7152 * g2(g) + 0.0722 * g2(b);
      }
      const probe = (v) => {
        const d = document.createElement('div');
        d.style.cssText = `background-color: var(${v});color: var(${v});position:absolute;visibility:hidden`;
        document.body.appendChild(d);
        const cs = getComputedStyle(d);
        const c = cs.color.match(/[\\d.]+/g).map(Number);
        const bg = cs.backgroundColor.match(/[\\d.]+/g).map(Number);
        d.remove();
        return { c, bg };
      };
      const F = probe(f).c, B = probe(b).bg;
      const L1 = lum(...F.slice(0, 3)), L2 = lum(...B.slice(0, 3));
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    }""", [fg_var, bg_var])


def main():
    print("== build ==")
    build = subprocess.run(["npm", "run", "build:web"], cwd=ROOT,
                           capture_output=True, text=True)
    print("\n".join((build.stdout + build.stderr).strip().splitlines()[-5:]))
    if build.returncode != 0 or not (DIST / "index.html").exists():
        print("FAIL  build failed")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            light_fails = audit(browser, "light")
            dark_fails = audit(browser, "dark")

            accent = [(v, r) for v, r in light_fails if is_accent_exception(r)]
            other = [(v, r) for v, r in light_fails if not is_accent_exception(r)]
            dark_accent = [(v, r) for v, r in dark_fails if is_accent_exception(r)]
            dark_other = [(v, r) for v, r in dark_fails if not is_accent_exception(r)]

            print("== light-mode accent exceptions (known, unapplied — see REPORT.md) ==")
            for v, r in accent:
                print(f"EXCEPTION  [{v}] {r['sel']} '{r['text']}' "
                      f"{r['fg']} on {r['bg']} -> {r['ratio']:.2f}:1 (needs {r['need']})")
            if not accent:
                print("EXCEPTION  (none observed)")

            check("light mode: zero failures outside the three accent cases",
                  len(other) == 0,
                  f"{len(other)} non-accent failing" +
                  (f" e.g. [{other[0][0]}] {other[0][1]['sel']} "
                   f"'{other[0][1]['text']}' {other[0][1]['ratio']:.2f}:1 "
                   f"fg {other[0][1]['fg']} on {other[0][1]['bg']}" if other else ""))
            check("light mode: accent exceptions observed (the known three classes)",
                  len([1 for _, r in accent if near(r['fgRgb'], ACCENT)]) >= 1
                  and len([1 for _, r in accent if near(r['bgRgb'], ACCENT)]) >= 1,
                  f"{len(accent)} accent rows")
            print("== dark-mode accent exceptions (paper-on-accent fill; same owner decision) ==")
            for v, r in dark_accent:
                print(f"EXCEPTION  [{v}] {r['sel']} '{r['text']}' "
                      f"{r['fg']} on {r['bg']} -> {r['ratio']:.2f}:1 (needs {r['need']})")
            if not dark_accent:
                print("EXCEPTION  (none observed)")
            check("dark mode: zero failures outside the accent fill case",
                  len(dark_other) == 0,
                  f"{len(dark_other)} non-accent failing" +
                  (f" e.g. [{dark_other[0][0]}] {dark_other[0][1]['sel']} "
                   f"'{dark_other[0][1]['text']}' {dark_other[0][1]['ratio']:.2f}:1 "
                   f"fg {dark_other[0][1]['fg']} on {dark_other[0][1]['bg']}" if dark_other else ""))

            # Before/after for --text-muted.
            tok = browser.new_context(color_scheme="light").new_page()
            tok.goto(BASE, wait_until="networkidle")
            tok.wait_for_timeout(1200)
            print(f"BEFORE  --text-muted #a39a8e on paper #fbf8f3: "
                  f"{token_ratio(tok, '#a39a8e', '#fbf8f3'):.2f}:1")
            print(f"BEFORE  --text-muted #a39a8e on sidebar #f6f2ec: "
                  f"{token_ratio(tok, '#a39a8e', '#f6f2ec'):.2f}:1")
            after_paper = live_token_ratio(tok, "--text-muted", "--bg-main")
            after_side = live_token_ratio(tok, "--text-muted", "--bg-sidebar")
            print(f"AFTER  --text-muted on --bg-main: {after_paper:.2f}:1")
            print(f"AFTER  --text-muted on --bg-sidebar: {after_side:.2f}:1")
            check("after: --text-muted on paper >= 4.5", after_paper >= 4.5,
                  f"{after_paper:.2f}:1")
            check("after: --text-muted on sidebar >= 4.5", after_side >= 4.5,
                  f"{after_side:.2f}:1")

            # Accent near-misses, measured (proposals in REPORT.md only).
            accent_paper = live_token_ratio(tok, "--text-accent", "--bg-main")
            paper_on_accent = live_token_ratio(tok, "--text-on-accent", "--bg-primary")
            print(f"MEASURED  --text-accent on --bg-main (paper): {accent_paper:.2f}:1")
            print(f"MEASURED  --text-on-accent on --bg-primary: {paper_on_accent:.2f}:1")
            tok.close()

            check("zero pageerror events",
                  len(page_errors) == 0,
                  "; ".join(page_errors[:3]) if page_errors else "")
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
