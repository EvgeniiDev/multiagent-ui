#!/usr/bin/env python3
"""Light-mode accent-text contrast gate against the real web build (port 25990).

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_accent_contrast.py baseline
    # ... edit the tokens ...
    ~/.hermes/tools-venv/bin/python scripts/e2e_accent_contrast.py          # verify

The script builds (`npm run build:web`), then serves dist-web itself on
http://127.0.0.1:25990/ and walks Chat/Projects/Board/Dashboard at 1440x900 in
`color_scheme="light"`.

`baseline` scans every rendered text element, records the failing
(element, colours) pairs into scripts/.accent_baseline.json, and exits.

`verify` (default):
  * measures the four accent-text elements from the brief live and asserts each
    is >= 4.5:1, printing before -> after (before values hardcoded from the
    brief as the baseline);
  * asserts each rail view switches with zero `pageerror`;
  * asserts no NEW contrast failures vs the saved baseline — the only allowed
    difference is failures disappearing (improvements). Failures whose computed
    color resolves to `--text-muted` are excluded (identified by color, listed
    by class name): they are expected here and fixed in the sibling branch
    cc/muted.

Backgrounds are composited by walking ancestors, collecting every
`backgroundColor` with alpha > 0 up to the first opaque one, then compositing
bottom-up: out = top*top.a + out*(1-top.a).
"""

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
BASELINE_FILE = Path(__file__).resolve().with_name(".accent_baseline.json")
PORT = 25990
BASE = f"http://127.0.0.1:{PORT}/"
VIEWS = ["Chat", "Projects", "Board", "Dashboard"]
MARKERS = {
    "Chat": ".chat-view, .welcome-screen",
    "Projects": ".view-pane .head-controls",
    "Board": ".view-pane .tab-bar",
    "Dashboard": '[data-testid="dashboard"]',
}
MIN_RATIO = 4.5

# The four light-mode accent-text pairs from the brief. `before` values are the
# brief's own measurements (composited backgrounds), hardcoded as the baseline
# for the before -> after printout.
TARGETS = [
    {"view": "Board", "sel": ".board-empty .empty-btn.primary", "label": "New card",
     "before_fg": "rgb(251, 248, 243)", "before_bg": "rgb(194, 83, 47)", "before": 4.34},
    {"view": "Dashboard", "sel": ".seg-btn.active", "label": "7 days",
     "before_fg": "rgb(194, 83, 47)", "before_bg": "rgb(245, 232, 223)", "before": 3.82},
    {"view": "Board", "sel": ".tab-btn.active", "label": "Tasks",
     "before_fg": "rgb(194, 83, 47)", "before_bg": "rgb(251, 248, 243)", "before": 4.34},
    {"view": "Projects", "sel": ".range button.active", "label": "7d",
     "before_fg": "rgb(194, 83, 47)", "before_bg": "rgb(245, 232, 223)", "before": 3.82},
]

# Shared measurement JS: WCAG luminance + alpha-aware ancestor compositing.
HELPERS_JS = """
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
  function rgbStr(c) { return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`; }
  // Walk ancestors collecting every non-transparent background, stop at the
  // first opaque one, then composite bottom-up.
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
  function ratio(fg, bg) {
    const L1 = lum(fg.r, fg.g, fg.b), L2 = lum(bg.r, bg.g, bg.b);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  }
  // Resolve a CSS color expression (var(--x) or literal) via a hidden probe.
  function resolve(css, prop) {
    const d = document.createElement('div');
    d.style.cssText = `${prop}:${css};position:absolute;visibility:hidden`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).getPropertyValue(prop);
    d.remove();
    return c;
  }
"""

WALK_JS = """() => {
""" + HELPERS_JS + """
  const muted = resolve('var(--text-muted)', 'color');
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
    const r = ratio(fg, bg);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3.0 : 4.5;
    const cls = (el.className && el.className.baseVal === undefined
      ? String(el.className) : el.tagName.toLowerCase());
    rows.push({ ratio: r, need, large, fg: cs.color, bg: rgbStr(bg), px,
      text: el.innerText.trim().slice(0, 60),
      cls,
      sel: cls.split(' ')[0] });
  }
  return { rows, muted };
}"""

MEASURE_JS = """(sel) => {
""" + HELPERS_JS + """
  const el = document.querySelector(sel);
  if (!el) return null;
  if (el.getClientRects().length === 0) return null;
  const cs = getComputedStyle(el);
  const fg = parse(cs.color);
  if (!fg || fg.a < 1) return null;
  const bg = bgOf(el);
  return { ratio: ratio(fg, bg), fg: cs.color, bg: rgbStr(bg),
    text: el.innerText.trim().slice(0, 40),
    cls: String(el.className) };
}"""

TOKEN_RATIO_JS = """([fgCss, bgCss]) => {
""" + HELPERS_JS + """
  const fg = parse(resolve(fgCss, 'color'));
  const bg = parse(resolve(bgCss, 'background-color'));
  return { fg: resolve(fgCss, 'color'), bg: resolve(bgCss, 'background-color'),
    ratio: ratio(fg, bg) };
}"""

results = []
page_errors = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({extra})" if extra else ""))


def fkey(rec):
    """Identity of a failing (element, colours) pair for baseline diffing."""
    return (rec["view"], rec["sel"], rec["fg"], rec["bg"])


def fdesc(rec):
    return (f'[{rec["view"]}] .{rec["sel"]} "{rec["text"]}" '
            f'{rec["fg"]} on {rec["bg"]} = {rec["ratio"]:.2f}:1')


def build():
    proc = subprocess.run(
        ["npm", "run", "build:web"], cwd=ROOT,
        capture_output=True, text=True, timeout=300,
    )
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-8:]
    print("BUILD tail:")
    for line in tail:
        print(f"  {line}")
    if proc.returncode != 0:
        print(f"FAIL  npm run build:web exited {proc.returncode}")
        sys.exit(1)
    if not (DIST / "index.html").exists():
        print(f"FAIL  {DIST} missing after build")
        sys.exit(1)


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


def scan_views(page):
    """Click through all four rail views; return (failures, muted_failures,
    measured, marker_ok) for the light scheme at 1440x900."""
    failures, muted_failures, measured, marker_ok = [], [], {}, {}
    for v in VIEWS:
        errs_before = len(page_errors)
        page.click(f'.rail-btn[aria-label="{v}"]')
        ok = True
        try:
            page.wait_for_selector(MARKERS[v], timeout=8000)
        except Exception:
            ok = False
        # Deterministic settle: the board's empty overlay and the dashboard's
        # range-seg render after their stores hydrate.
        for t in TARGETS:
            if t["view"] == v:
                try:
                    page.wait_for_selector(t["sel"], timeout=8000)
                except Exception:
                    pass
        page.wait_for_timeout(600)
        data = page.evaluate(WALK_JS)
        muted_rgb = data["muted"]
        for r in data["rows"]:
            if r["ratio"] + 1e-9 < r["need"]:
                rec = {"view": v, **r}
                if r["fg"] == muted_rgb:
                    muted_failures.append(rec)
                else:
                    failures.append(rec)
        for t in TARGETS:
            if t["view"] == v:
                measured[t["sel"]] = page.evaluate(MEASURE_JS, t["sel"])
        marker_ok[v] = ok and len(page_errors) == errs_before
    return failures, muted_failures, measured, marker_ok


def run_browser(mode):
    failures = muted_failures = measured = marker_ok = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            color_scheme="light", viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".view-rail", timeout=10000)
        page.wait_for_timeout(800)
        failures, muted_failures, measured, marker_ok = scan_views(page)

        if mode == "verify":
            # Token-level probes for the report: the two changed tokens on
            # paper (--bg-main) and on the 16% accent tint composite.
            for fg_css, bg_css, label in [
                ("var(--text-on-accent)", "var(--bg-primary)",
                 "--text-on-accent on --bg-primary"),
                ("var(--text-accent)", "var(--bg-main)",
                 "--text-accent on --bg-main (paper)"),
                ("var(--text-accent)", "rgb(245, 232, 223)",
                 "--text-accent on accent tint rgb(245,232,223)"),
            ]:
                m = page.evaluate(TOKEN_RATIO_JS, [fg_css, bg_css])
                print(f"RATIO  {label}: {m['ratio']:.2f}:1  "
                      f"({m['fg']} on {m['bg']})")
        ctx.close()
        browser.close()
    return failures, muted_failures, measured, marker_ok


def mode_baseline():
    failures, muted_failures, _, marker_ok = run_browser("baseline")
    payload = {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "failures": failures,
        "muted_failures": muted_failures,
    }
    BASELINE_FILE.write_text(json.dumps(payload, indent=2))
    print(f"\nBASELINE saved -> {BASELINE_FILE}")
    print(f"  non-muted failures: {len(failures)}")
    for rec in failures:
        print(f"    {fdesc(rec)}")
    print(f"  muted failures (excluded by class at diff time): "
          f"{len(muted_failures)}")
    for rec in muted_failures:
        print(f"    {fdesc(rec)}")
    if page_errors:
        print(f"  pageerrors during baseline scan: {len(page_errors)}")


def mode_verify():
    failures, muted_failures, measured, marker_ok = run_browser("verify")

    # 1) The four accent-text elements, live "after" measurement.
    for t in TARGETS:
        m = measured.get(t["sel"])
        line = (f'[{t["view"]}] {t["sel"]} "{t["label"]}": '
                f'{t["before"]:.2f}:1 -> ',)
        if m is None:
            check(f'{t["sel"]} "{t["label"]}" >= {MIN_RATIO}', False,
                  "element not found or has no opaque color")
            continue
        print(f"RATIO  {line[0]}{m['ratio']:.2f}:1  "
              f"({t['before_fg']} -> {m['fg']} on {m['bg']}; "
              f"before bg {t['before_bg']})")
        check(f'{t["sel"]} "{t["label"]}" >= {MIN_RATIO}:1',
              m["ratio"] + 1e-9 >= MIN_RATIO,
              f'{t["before"]:.2f} -> {m["ratio"]:.2f}')

    # 2) Rail switching with zero pageerror.
    for v in VIEWS:
        check(f'rail: {v} switches clean ({MARKERS[v]})', marker_ok.get(v, False))
    check("zero pageerror events", len(page_errors) == 0,
          "; ".join(page_errors[:3]) if page_errors else "")

    # 3) Baseline diff: no new failures; the only delta may be improvements.
    if not BASELINE_FILE.exists():
        check("baseline diff", False,
              f"{BASELINE_FILE} missing — run `baseline` before the edit")
    else:
        base = json.loads(BASELINE_FILE.read_text())
        base_keys = {fkey(r) for r in base["failures"]}
        after_keys = {fkey(r) for r in failures}
        new = sorted(after_keys - base_keys)
        gone = sorted(base_keys - after_keys)
        check("no NEW contrast failures vs baseline", not new,
              "; ".join(f"{v} .{s} {fg} on {bg}" for v, s, fg, bg in new))
        print(f"DIFF  improvements vs baseline ({len(gone)} fixed):")
        for v, s, fg, bg in gone:
            print(f"    FIXED [{v}] .{s}  (was {fg} on {bg})")
        still = sorted(after_keys & base_keys)
        print(f"DIFF  still failing (pre-existing, unchanged): {len(still)}")
        for v, s, fg, bg in still:
            print(f"    [{v}] .{s}  {fg} on {bg}")

    # Muted failures are excluded from the diff: expected here, fixed by the
    # sibling branch cc/muted (--text-muted: #786d62).
    print(f"MUTED  excluded failures (expected, fixed in cc/muted): "
          f"{len(muted_failures)}")
    seen = set()
    for rec in muted_failures:
        k = (rec["view"], rec["cls"])
        if k in seen:
            continue
        seen.add(k)
        print(f"    .{rec['cls']}  [{rec['view']}] {rec['fg']} on {rec['bg']} "
              f"= {rec['ratio']:.2f}:1")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if mode not in ("baseline", "verify"):
        print(f"usage: {sys.argv[0]} [baseline|verify]")
        sys.exit(2)
    build()
    server = start_server()
    try:
        if mode == "baseline":
            mode_baseline()
            return
        mode_verify()
    finally:
        server.terminate()
        server.wait(timeout=5)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
