"""Browser regression on the built dashboard, with isolated known counters.

Serve the build through Playwright routes; no test servers or real state writes.
"""
import json
import mimetypes
from pathlib import Path
import re
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

DIST = Path(__file__).parents[1] / 'dist-web'
NOW = int(time.time() * 1000) - 60000
AGENTS = ['Hermes Agent', 'Pi', 'Codex', 'OpenCode', 'Devin']


def usage(agent, used, offset=0, **extra):
    return dict(agentName=agent, sessionId=agent, at=NOW + offset, used=used,
                size=0, accounting='delta', source='agent', model='model', provider=agent,
                cwd='/project', **extra)


ROWS = [usage('Hermes Agent', 600), usage('Pi', 300, cost=0.3, currency='USD'),
        usage('Pi', 500, 1000, cost=0.5, currency='USD'), usage('Codex', 200),
        usage('Devin', 400)]
for at, used, cost in [(NOW, 1000, 1), (NOW + 1000, 1400, 1.4)]:
    ROWS.append(dict(agentName='OpenCode', sessionId='OpenCode', at=at, used=used,
                     size=0, accounting='cumulative', source='agent', model='model',
                     provider='OpenCode', cost=cost, currency='USD'))

for row in ROWS:
    row['model'] = 'deepseek/deepseek-v4-flash-0731'
    row['provider'] = 'opencode-go' if row['agentName'] == 'OpenCode' else 'openai-codex'


def run_case(browser, fail=False, large=False):
    context = browser.new_context(viewport=dict(width=1440, height=1000), timezone_id='Asia/Karachi')
    errors = []
    rows = [dict(ROWS[0], used=100, at=NOW - i * 60000,
                 sessionId=f'session-{i % 2000}', cwd=f'/projects/project-{i % 200}')
            for i in range(52000)] if large else ROWS
    def route(request):
        url = urlparse(request.request.url)
        if url.port == 25808:
            path = DIST / url.path.lstrip('/')
            if not path.is_file(): path = DIST / 'index.html'
            request.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        elif url.path == '/health': request.fulfill(json=dict(ok=True))
        elif url.path == '/api/usage':
            request.fulfill(status=503 if fail else 200, json=dict(usage=rows, sources=[dict(agentName=a, status='ready', samples=1) for a in AGENTS]))
        elif url.path.startswith('/api/state/'):
            data = dict(entries=[], usage=[]) if url.path.endswith('activity.json') else {}
            request.fulfill(json=dict(rev=1, updatedAt=1, data=data))
        else: request.fulfill(status=404, json=dict(error='not found'))
    context.route('**/*', route)
    page = context.new_page()
    page.add_init_script("""window.dashboardLongTasks = [];
        new PerformanceObserver(list => window.dashboardLongTasks.push(...list.getEntries()
            .map(e => ({at: e.startTime, duration: e.duration})))).observe({entryTypes: ['longtask']});""")
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:25808/dashboard')
    page.wait_for_selector('[data-testid="dashboard"]')
    if fail:
        page.wait_for_selector('[data-testid="usage-error"]')
        assert '503' in page.locator('[data-testid="usage-error"]').inner_text()
    elif large:
        page.wait_for_selector('[data-testid="usage-sources"]')
        before = page.evaluate('performance.now()')
        page.click('[data-testid="range-all"]')
        page.wait_for_function("document.querySelector('[data-testid=sum-tokens]').textContent.trim() === '5,200,000'")
        page.wait_for_timeout(100)
        tasks = page.evaluate('dashboardLongTasks').copy()
        blocking = [t['duration'] for t in tasks if t['at'] >= before]
        assert max(blocking, default=0) < 1000, f'Range switch blocks the browser: {blocking}'
        assert page.locator('[data-testid="by-project-table"] tbody tr').count() == 200
    else:
        page.wait_for_selector('[data-testid="usage-sources"]')
        page.wait_for_function("document.querySelector('[data-testid=sum-tokens]').textContent.trim() === '3,400'")
        assert page.locator('[data-testid="by-agent-row"]').count() == 5
        assert page.locator('[data-testid="sum-cost"]').inner_text() == '2.2 USD'
        assert page.locator('[data-testid="top-sessions-table"] tbody tr').count() == 5
        page.click('[data-testid="range-all"]')
        assert page.locator('[data-testid="sum-tokens"]').inner_text().strip() == '3,400'
        page.set_viewport_size(dict(width=961, height=1000))
        page.locator('.share-cell').first.wait_for()
        cells = page.locator('.share-cell').evaluate_all("""cells => cells.map(cell => ({
            display: getComputedStyle(cell).display,
            bottom: cell.getBoundingClientRect().bottom,
            rowBottom: cell.parentElement.getBoundingClientRect().bottom,
        }))""")
        assert all(c['display'] == 'table-cell' for c in cells), cells
        assert all(abs(c['bottom'] - c['rowBottom']) < 1 for c in cells), cells
        page.set_viewport_size(dict(width=390, height=844))
        assert page.locator('[data-testid="usage-sources"]').is_visible()
        assert page.locator('.share-cell').first.evaluate("e => getComputedStyle(e).display") == 'flex'
        assert page.locator('.share-content').first.bounding_box()['width'] > 80
    assert not errors, errors
    context.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        run_case(browser)
        run_case(browser, fail=True)
        run_case(browser, large=True)
        browser.close()
    print('PASS dashboard: accounting, mobile, error state and responsive range switch with 52,000 records / 200 projects')
