#!/usr/bin/env python3
"""Dark/light contrast audit against the real web build (port 25994).

Usage:
    npm run build:web
    ~/.hermes/tools-venv/bin/python scripts/e2e_dark_contrast.py

Builds nothing itself — requires dist-web present. Serves dist-web on
http://127.0.0.1:25994/, walks Chat/Projects/Board/Dashboard in dark and
light color schemes at 1440x900, composites backgrounds through alpha
layers, and asserts zero WCAG failures in each. Screenshots land in
docs/dark-*-1440x900.png.
"""

import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25994
ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
VIEWS = ["Chat", "Projects", "Board", "Dashboard"]
BASE = f"http://127.0.0.1:{PORT}/"

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
    rows.push({ view: document.title || '', ratio, need, large,
      fg: cs.color, px, text: el.innerText.trim().slice(0, 60),
      sel: (el.className && el.className.baseVal === undefined ? String(el.className).split(' ')[0] : el.tagName) });
  }
  const colors = [...new Set(rows.map(r => r.fg))].sort();
  return { rows, colors };
}"""

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


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
    fails, colors = [], set()
    for v in VIEWS:
        page.click(f'.rail-btn[aria-label="{v}"]')
        page.wait_for_timeout(800)
        data = page.evaluate(WALK_JS)
        for c in data["colors"]:
            colors.add(c)
        for r in data["rows"]:
            if r["ratio"] + 1e-9 < r["need"]:
                fails.append((v, r))
        if scheme == "dark":
            page.screenshot(path=str(SHOTS / f"dark-{v.lower()}-1440x900.png"))
    ctx.close()
    return fails, sorted(colors)


def ratio_of(page, fg_var, bg_var):
    return page.evaluate("""([f, b]) => {
      function lum(r, g, b) {
        const g2 = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * g2(r) + 0.7152 * g2(g) + 0.0722 * g2(b);
      }
      const cs = getComputedStyle(document.documentElement);
      const p = (v) => getComputedStyle(document.body);
      const probe = (v) => {
        const d = document.createElement('div');
        d.style.cssText = `color: var(${v});position:absolute;visibility:hidden`;
        document.body.appendChild(d);
        const c = getComputedStyle(d).color.match(/[\\d.]+/g).map(Number);
        d.remove();
        return c;
      };
      const F = probe(f), B = probe(b);
      const L1 = lum(...F.slice(0, 3)), L2 = lum(...B.slice(0, 3));
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    }""", [fg_var, bg_var])


def main():
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        sys.exit(1)
    SHOTS.mkdir(exist_ok=True)
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            dark_fails, dark_colors = audit(browser, "dark")
            light_fails, light_colors = audit(browser, "light")

            check("dark mode: zero contrast failures",
                  len(dark_fails) == 0,
                  f"{len(dark_fails)} failing" +
                  (f" e.g. [{dark_fails[0][0]}] {dark_fails[0][1]['sel']} "
                   f"'{dark_fails[0][1]['text']}' {dark_fails[0][1]['ratio']:.2f}:1 "
                   f"fg {dark_fails[0][1]['fg']}" if dark_fails else ""))
            check("light mode: zero contrast failures",
                  len(light_fails) == 0,
                  f"{len(light_fails)} failing")

            # Before/after ratios for the three token pairs (dark block).
            tok = browser.new_context(color_scheme="dark").new_page()
            tok.goto(BASE, wait_until="networkidle")
            tok.wait_for_timeout(1200)
            pairs = [("--text-muted", "--bg-main"), ("--text-muted", "--bg-sidebar"),
                     ("--text-on-accent", "--bg-primary"), ("--text-accent", "--bg-main")]
            for f, b in pairs:
                print(f"RATIO  {f} on {b}: {ratio_of(tok, f, b):.2f}:1")

            check("token pair --text-muted on --bg-main >= 4.5",
                  ratio_of(tok, "--text-muted", "--bg-main") >= 4.5)
            check("token pair --text-muted on --bg-sidebar >= 4.5",
                  ratio_of(tok, "--text-muted", "--bg-sidebar") >= 4.5)
            check("token pair --text-on-accent on --bg-primary >= 4.5",
                  ratio_of(tok, "--text-on-accent", "--bg-primary") >= 4.5)
            check("token pair --text-accent on --bg-main >= 4.5",
                  ratio_of(tok, "--text-accent", "--bg-main") >= 4.5)
            tok.close()

            check("zero pageerror events",
                  len(page_errors) == 0,
                  "; ".join(page_errors[:3]) if page_errors else "")
            print("LIGHT COLORS " + json_str(light_colors))
            print("DARK COLORS " + json_str(dark_colors))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


def json_str(vals):
    import json as j
    return j.dumps(vals)


if __name__ == "__main__":
    main()
