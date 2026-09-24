"""Dashboard E2E (F5/F6): seed the ledger via localStorage, assert the real build.

Run: npm run build:web, then run this with the tools venv python
(sync_playwright, chromium headless). The script serves dist-web itself via
scripts/_e2e_harness.py (preferred port 25998, falls back to the next free
port when a stale/foreign server holds it) and fails every `:25900`
state-server call so the panel uses localStorage — no live services needed.
"""
import json
import re
import sys
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

from _e2e_harness import DIST, serve_web, stop

PORT = 25998
BASE = f"http://127.0.0.1:{PORT}/"  # rebased in main() to the served port
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def ts_ago(**kwargs: int) -> int:
    # Relative fixture clock: N minutes/hours/days before "now", so the seed
    # never lands in the future no matter what time of day the suite runs.
    # (The old "today at 12:00 UTC" clock broke every assertion before noon.)
    d = NOW - timedelta(**kwargs)
    return int(d.timestamp() * 1000)


def ts(days_ago: int, hour: int = 12) -> int:  # noqa: ARG001
    # "Same wall-clock day, N days back" without ever landing in the future:
    # clamp to now - 5 minutes.
    d = (NOW - timedelta(days=days_ago)).replace(hour=hour, minute=0, second=0)
    return min(int(d.timestamp() * 1000), int((NOW - timedelta(minutes=5)).timestamp() * 1000))


# Two agents, two projects, two days. `used` is a session's RUNNING total (that is
# what `usage_update` carries), so sess-a1 reads 1200 and then 2000 — an increasing
# series. Tokens actually consumed: alpha 2000, beta 500.
USAGE = [
    {"at": ts(1), "agentName": "alpha", "sessionId": "sess-a1", "cwd": "/home/u/proj-one",
     "used": 1200, "size": 8000, "cost": 0.02, "currency": "USD"},
    {"at": ts(0), "agentName": "alpha", "sessionId": "sess-a1", "cwd": "/home/u/proj-one",
     "used": 2000, "size": 8000, "cost": 0.03, "currency": "USD"},
    {"at": ts(0), "agentName": "beta", "sessionId": "sess-b1", "cwd": "/home/u/proj-two",
     "used": 500, "size": 4000},
]
ENTRIES = [
    {"id": "e1", "at": ts(1), "kind": "turn-end", "agentName": "alpha",
     "sessionId": "sess-a1", "cwd": "/home/u/proj-one", "title": "alpha work"},
    {"id": "e2", "at": ts(1), "kind": "turn-end", "agentName": "alpha",
     "sessionId": "sess-a1", "cwd": "/home/u/proj-one", "title": "alpha work 2"},
    {"id": "e3", "at": ts(1), "kind": "tool-call", "agentName": "alpha",
     "sessionId": "sess-a1", "cwd": "/home/u/proj-one", "title": "read"},
    {"id": "e4", "at": ts(0), "kind": "turn-end", "agentName": "beta",
     "sessionId": "sess-b1", "cwd": "/home/u/proj-two", "title": "beta work"},
    {"id": "e5", "at": ts(0), "kind": "connected", "agentName": "beta",
     "sessionId": "sess-b1", "cwd": "/home/u/proj-two"},
]

FIXTURE = json.dumps({"entries": ENTRIES, "usage": USAGE})
EXPECTED_TOKENS = "2,500"
EXPECTED_TURNS = "3"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def main() -> int:
    global BASE
    server, BASE = serve_web(PORT, DIST)
    try:
        return run_checks()
    finally:
        stop(server)


def run_checks() -> int:
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.route(re.compile(r":25900/"), lambda route: route.abort())
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script(
            f"localStorage.setItem('acp-ui:activity.json', {json.dumps(FIXTURE)});"
        )
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(1500)

        # Switch to the Dashboard via the rail.
        rail = page.get_by_role("button", name="Dashboard")
        check("rail dashboard button exists", rail.count() > 0)
        if rail.count() == 0:
            browser.close()
            return 1
        rail.first.click()
        page.wait_for_selector('[data-testid="dashboard"]', timeout=10000)

        # Summary strip.
        tokens = page.get_by_test_id("sum-tokens").inner_text().strip()
        check("summary tokens = 2,500", tokens == EXPECTED_TOKENS, f"got {tokens!r}")
        turns = page.get_by_test_id("sum-turns").inner_text().strip()
        check("summary turns = 3", turns == EXPECTED_TURNS, f"got {turns!r}")

        # By-agent table: one row per agent, right token counts.
        rows = page.get_by_test_id("by-agent-row")
        check("by-agent has 2 rows", rows.count() == 2, f"got {rows.count()}")
        got: dict[str, str] = {}
        for i in range(rows.count()):
            r = rows.nth(i)
            got[r.get_attribute("data-agent") or "?"] = r.get_attribute("data-tokens") or "?"
        check("alpha tokens = 2000", got.get("alpha") == "2000", f"got {got}")
        check("beta tokens = 500", got.get("beta") == "500", f"got {got}")

        # Day chart: an SVG with a bar per day present in the fixture.
        chart = page.get_by_test_id("day-chart")
        check("day chart renders", chart.count() == 1)
        if chart.count() == 1:
            bars = page.get_by_test_id("day-bar")
            days = {bars.nth(i).get_attribute("data-day") for i in range(bars.count())}
            want = {
                datetime.fromtimestamp(USAGE[0]["at"] / 1000, tz=timezone.utc).date().isoformat(),
                datetime.fromtimestamp(USAGE[2]["at"] / 1000, tz=timezone.utc).date().isoformat(),
            }
            check("chart covers fixture days", want <= days, f"bars={sorted(days)} want={sorted(want)}")

        # Quota below current usage -> warning state.
        page.get_by_test_id("limit-add").click()
        page.wait_for_selector('[data-testid="limit-form"]')
        form = page.get_by_test_id("limit-form")
        form.get_by_placeholder("e.g. Weekly budget").fill("E2E quota")
        form.locator('input[type="number"]').fill("100")
        form.get_by_test_id("limit-save").click()
        page.wait_for_timeout(500)
        warn_rows = page.locator('[data-testid^="limit-row-"][data-warn="true"]')
        check("quota below usage shows warning", warn_rows.count() >= 1,
              f"warn rows={warn_rows.count()}")

        # Export buttons produce non-empty downloads with range+date in the name.
        for kind in ("json", "csv"):
            try:
                with page.expect_download(timeout=5000) as dl:
                    page.get_by_test_id(f"export-{kind}").click()
                download = dl.value
                path = download.path()
                size = 0
                if path:
                    with open(path, "rb") as f:
                        size = len(f.read())
                name_ok = download.suggested_filename.startswith("dashboard-") and \
                    download.suggested_filename.endswith(f".{kind}")
                check(f"export {kind} non-empty download", size > 0 and name_ok,
                      f"name={download.suggested_filename} size={size}")
            except Exception as e:  # noqa: BLE001
                check(f"export {kind} non-empty download", False, str(e)[:160])

        # Range selector: all four ranges switch the label.
        for rid in ("today", "7d", "30d", "all"):
            page.get_by_test_id(f"range-{rid}").click()
            page.wait_for_timeout(300)
            label = page.get_by_test_id("range-label").inner_text().strip()
            check(f"range {rid} updates label", len(label) > 0, f"got {label!r}")

        check("zero pageerrors", len(errors) == 0, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
