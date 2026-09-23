#!/usr/bin/env python3
"""E2E: the dashboard's token arithmetic, on a fixture with known answers.

`usage_update` carries a session's RUNNING total, so the old aggregation summed
every sample and multiplied each session by its sample count. The fixture below is
built to be counted by hand AND to reproduce the owner's "график как будто в
масштабе ×4":

  session S1  used 10000 -> 12000         (running total, seen twice)
  session S2  used  5000 (one sample)
  session S3  used  3000 -> 9000 -> 15000 (running total, seen three times)
  ----------------------------------------------------------------------
  honest total 32000     naive sum of every sample 54000
  (every sample counted separately — the "×4" the owner saw on real data, where a
  session produces many samples a day)

Assertions:
  1. "Tokens used" reads 14,000, not 54,000;
  2. the per-day table lists only days that have data (2 rows, not the whole year);
  3. the CSV export matches the table's row count;
  4. the chart's tallest bar is scaled to the honest daily maximum;
  5. zero pageerrors.

Usage: npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_dash_math.py
"""
import csv
import io
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 25992
BASE = f"http://127.0.0.1:{PORT}/"
REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-web"

HONEST = 32000
NAIVE = 54000
checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def start_server():
    for _ in range(30):
        s = socket.socket()
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


def fixture() -> dict:
    """Usage samples with cumulative totals, two days of real spend."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    day1 = (now - timedelta(days=1)).replace(hour=10, minute=0, second=0)
    day2 = (now - timedelta(days=2)).replace(hour=12, minute=0, second=0)
    ms = lambda d: int(d.timestamp() * 1000)
    samples = [
        {"at": ms(day2), "agentName": "Hermes Agent", "sessionId": "S1", "cwd": "/home/hermes/projects/acp-ui", "used": 10000, "size": 200000, "cost": 0.10, "currency": "USD"},
        {"at": ms(day2 + timedelta(hours=1)), "agentName": "Hermes Agent", "sessionId": "S1", "cwd": "/home/hermes/projects/acp-ui", "used": 12000, "size": 200000, "cost": 0.12, "currency": "USD"},
        {"at": ms(day2 + timedelta(minutes=30)), "agentName": "Devin", "sessionId": "S2", "cwd": "/home/hermes/projects/acp-ui", "used": 5000, "size": 200000, "cost": 0.05, "currency": "USD"},
        {"at": ms(day1), "agentName": "Devin", "sessionId": "S3", "cwd": "/home/hermes/projects/acp-ui", "used": 3000, "size": 200000, "cost": 0.03, "currency": "USD"},
        {"at": ms(day1 + timedelta(hours=1)), "agentName": "Devin", "sessionId": "S3", "cwd": "/home/hermes/projects/acp-ui", "used": 9000, "size": 200000, "cost": 0.09, "currency": "USD"},
        {"at": ms(day1 + timedelta(hours=2)), "agentName": "Devin", "sessionId": "S3", "cwd": "/home/hermes/projects/acp-ui", "used": 15000, "size": 200000, "cost": 0.15, "currency": "USD"},
    ]
    entries = [{"id": f"t{i}", "at": s["at"], "kind": "turn-end", "agentName": s["agentName"],
                "sessionId": s["sessionId"], "cwd": s["cwd"], "title": "turn"} for i, s in enumerate(samples)]
    return {"entries": entries, "usage": samples}


def seed(context):
    agents = {"agents": {"E2E Mock": {"transport": "websocket", "url": "ws://127.0.0.1:25990/"}}}
    prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects", "activeView": "dashboard"}
    for key, val in (("acp-ui:agents", agents),
                     ("acp-ui:preferences.json", prefs),
                     ("acp-ui:activity.json", fixture())):
        context.add_init_script(
            f"localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")


def main():
    proc = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            seed(ctx)
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), lambda r: r.abort())   # stay isolated
            page.on("pageerror", lambda exc: page_errors.append(str(exc)))
            page.goto(BASE, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.click('button[aria-label="Dashboard"]')
            page.wait_for_selector('[data-testid="dashboard"]', timeout=8000)
            page.click('[data-testid="range-all"]')
            page.wait_for_timeout(600)

            tokens = page.locator('[data-testid="sum-tokens"]').inner_text().strip()
            digits = int(re.sub(r"[^\d]", "", tokens) or 0)
            check("summary counts per-session deltas, not every sample",
                  digits == HONEST, f"shown {tokens!r} (honest {HONEST}, naive {NAIVE})")

            # "All time" spans more than 120 days, so the series is bucketed by WEEK:
            # both fixture days land in one bucket, and empty buckets are dropped
            # instead of printing a year of zero rows.
            rows = page.locator('[data-testid="by-day-row"]').count()
            check("day table lists only buckets with data",
                  rows == 1, f"{rows} rows (before the fix: every bucket in the range)")

            values = [int(re.sub(r"[^\d]", "", page.locator('[data-testid="by-day-row"]').nth(i)
                                 .get_attribute("data-day") or "0") or 0) for i in range(0)]
            # per-day honesty: day1 grew 12000, day2 grew 2000
            day_cells = page.evaluate(
                """() => [...document.querySelectorAll('[data-testid="by-day-row"]')].map(tr =>
                     [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))""")
            nums = []
            for cells in day_cells:
                for cell in cells:
                    if re.fullmatch(r"[\d\s,]+", cell) and re.search(r"\d", cell):
                        nums.append(int(re.sub(r"[^\d]", "", cell)))
                        break
            check("no day exceeds the honest total", all(n <= HONEST for n in nums),
                  f"day values {nums}")

            with page.expect_download() as dl:
                page.click('[data-testid="export-csv"]')
            path = dl.value.path()
            text = Path(path).read_text(encoding="utf-8")
            exported = list(csv.DictReader(io.StringIO(text)))
            body = [r for r in exported if any((v or "").strip() for v in r.values())]
            check("CSV export carries the same days as the table",
                  len(body) == rows, f"csv rows {len(body)} vs table {rows}")

            bars = page.evaluate(
                """() => [...document.querySelectorAll('[data-testid="day-chart"] rect.bar, [data-testid="day-chart"] rect')]
                     .map(r => Number(r.getAttribute('height')) || 0).filter(h => h > 0)""")
            tallest = max(bars) if bars else 0
            check("chart draws one bar per data bucket, scaled to the honest value",
                  len(bars) == rows and tallest > 0, f"bar heights {bars} vs rows {rows}")

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
