"""Dashboard flows on built assets with known history; no test server or real writes."""
import json
import mimetypes
from pathlib import Path
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

DIST = Path(__file__).parents[1] / 'dist-web'
NOW = int(time.time() * 1000) - 60000
AGENTS = ['Hermes Agent', 'Pi', 'Codex', 'OpenCode', 'Devin']


def usage(agent, used, offset=0, **extra):
    return dict(agentName=agent, sessionId=agent, at=NOW + offset, used=used,
                size=0, accounting='delta', source='agent',
                model='deepseek/deepseek-v4-flash-0731', provider='openai-codex', cwd='/project', **extra)


ROWS = [usage('Hermes Agent', 600, -3 * 86400000, cost=0, currency='USD'), usage('Pi', 300, cost=0.3, currency='USD'),
        usage('Pi', 500, 1000, cost=0.5, currency='USD'), usage('Codex', 200), usage('Devin', 400)]
ROWS[2]['model'] = 'another-model-in-the-same-chat'
for at, used, cost in [(NOW, 1000, 1), (NOW + 1000, 1400, 1.4)]:
    ROWS.append(dict(agentName='OpenCode', sessionId='OpenCode', at=at, used=used,
                     size=0, accounting='cumulative', source='agent',
                     model='deepseek/deepseek-v4-flash-0731', provider='opencode-go',
                     cwd='/project', cost=cost, currency='USD'))


def run_case(browser, fail=False, large=False, mixed=False):
    context = browser.new_context(viewport=dict(width=1440, height=1000), timezone_id='Asia/Karachi')
    errors = []
    rows = [dict(ROWS[0], used=100, at=NOW - i * 60000, sessionId=f'session-{i % 2000}',
                 cwd=f'/projects/project-{i % 200}', agentName=f'Agent-{i % 30}', model=f'Model-{i % 60}')
            for i in range(52000)] if large else [dict(row) for row in ROWS]
    if mixed: rows[2]['currency'] = 'EUR'
    agents = [f'Agent-{i}' for i in range(30)] if large else AGENTS
    def route(request):
        url = urlparse(request.request.url)
        if url.port == 25808:
            path = DIST / url.path.lstrip('/')
            if not path.is_file(): path = DIST / 'index.html'
            request.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        elif url.path == '/health': request.fulfill(json=dict(ok=True))
        elif url.path == '/api/usage':
            request.fulfill(status=503 if fail else 200, json=dict(usage=rows, sources=[dict(agentName=a, status='ready', samples=1) for a in agents]))
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
    if fail:
        expect(page.locator('[data-testid="usage-error"]')).to_contain_text('503')
        expect(page.get_by_role('button', name='Try again')).to_be_visible()
    else:
        page.wait_for_selector('[data-testid="usage-sources"]')
        total = '5,200,000' if large else '3,400'
        if large:
            before = page.evaluate('performance.now()')
            page.click('[data-testid="range-all"]')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            page.wait_for_timeout(100)
            blocking = [t['duration'] for t in page.evaluate('dashboardLongTasks') if t['at'] >= before]
            assert max(blocking, default=0) < 1000, blocking
            for tab, table, control, count in [('models','by-model-table','toggle-models',60),
                                              ('projects','by-project-table','toggle-projects',200),
                                              ('agents','by-agent-table','toggle-agents',30),
                                              ('sessions','top-sessions-table','toggle-sessions',6000),
                                              ('days','by-day-table','toggle-days',None)]:
                page.click(f'[data-testid=tab-{tab}]')
                visible = page.locator(f'[data-testid={table}] tbody tr')
                expect(visible).to_have_count(20)
                toggle = page.locator(f'[data-testid={control}]')
                assert toggle.get_attribute('aria-controls') == page.locator(f'[data-testid={table}]').get_attribute('id')
                toggle.click()
                expect(toggle).to_have_attribute('aria-expanded','true')
                assert visible.count() == count if count else visible.count() > 20
                if tab == 'days':
                    days = visible.evaluate_all('rows=>rows.map(r=>r.dataset.day)')
                    assert days == sorted(days, reverse=True)
                toggle.click(); expect(visible).to_have_count(20)
                expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            for period in ['today','7d','30d','all']:
                page.click(f'[data-testid=range-{period}]')
                page.wait_for_timeout(100)
                days = page.locator('[data-testid=by-day-row]').evaluate_all('rows=>rows.map(r=>r.dataset.day)')
                assert days and days == sorted(days, reverse=True), (period, days)
        else:
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            expected_cost = '1.7 USD · 0.5 EUR' if mixed else '2.2 USD'
            expect(page.locator('[data-testid=sum-cost]')).to_have_text(expected_cost)
            page.click('[data-testid=tab-agents]')
            expect(page.locator('[data-testid=by-agent-row]')).to_have_count(5)
            page.click('[data-testid=tab-sessions]')
            expect(page.locator('[data-testid=top-sessions-table] tbody tr')).to_have_count(5)
            page.click('[data-testid=tab-models]')
            page.locator('[data-testid=usage-search]').fill('opencode-go')
            expect(page.locator('[data-testid=by-model-row]')).to_have_count(1)
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            page.locator('[data-testid=usage-search]').fill('missing-model')
            expect(page.locator('[data-testid=models-empty]')).to_contain_text('No matching')
            page.locator('[data-testid=usage-search]').fill('')
            page.locator('[data-testid=by-model-row][data-tokens="1500"] button').click()
            expect(page.locator('[data-testid=session-scope]')).to_contain_text('1,500')
            session_rows = page.locator('[data-testid=top-session-row]')
            assert sum(int(n) for n in session_rows.evaluate_all('rs=>rs.map(r=>r.dataset.tokens)')) == 1500
            expect(session_rows.filter(has_text='Pi')).to_have_attribute('data-tokens', '300')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            page.locator('[data-testid=tab-models]').click()
            # The prior day has 600 tokens. Selecting it changes the inspector and all breakdowns.
            oldest = page.locator('[data-testid=day-bar][data-tokens="600"]').get_attribute('data-day')
            page.locator('[data-testid=inspect-period]').select_option(oldest)
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text('600')
            expect(page.locator('[data-testid=sum-sessions]')).to_have_text('1')
            expect(page.locator('.inspector dt').filter(has_text='Reported cost')).to_have_text('Reported cost')
            expect(page.locator('[data-testid=sum-cost]')).to_have_text('0 USD')
            expect(page.locator('[data-testid=by-model-row]')).to_have_count(1)
            # Native history must be inspectable without a browser chat or activity log.
            page.locator('[data-testid=by-model-row] button').click()
            expect(page.locator('[data-testid=session-scope]')).to_contain_text('600')
            expect(page.locator('[data-testid=top-session-row]')).to_have_count(1)
            page.locator('[data-testid=top-session-row] button').click()
            expect(page.locator('[data-testid=session-detail]')).to_contain_text('Hermes Agent')
            expect(page.locator('[data-testid=session-detail]')).to_contain_text('/project')
            expect(page.locator('[data-testid=session-detail]')).to_contain_text('600')
            expect(page.locator('[data-testid=open-saved-chat]')).to_have_count(0)
            page.locator('[data-testid=agent-state] summary').click()
            historical = page.locator('[data-testid=agent-history-row]').filter(has_text='Hermes Agent')
            expect(historical).to_contain_text('1 session')
            expect(historical).to_contain_text('600')
            page.locator('[data-testid=agent-state] summary').click()
            page.locator('[data-testid=tab-models]').click()
            # JSON export covers the full toolbar range even with a selected bar and search.
            page.locator('[data-testid=usage-search]').fill('missing')
            page.locator('.export-menu summary').click()
            with page.expect_download() as download:
                page.locator('[data-testid=export-json]').click()
            payload = json.loads(Path(download.value.path()).read_text())
            assert payload['summary']['tokens'] == 3400
            assert len(payload['summary']['costs']) == (2 if mixed else 1)
            assert sum(d['tokens'] for d in payload['byDay']) == 3400
            page.locator('.export-menu summary').click()
            page.click('[data-testid=clear-selection]')
            page.locator('[data-testid=usage-search]').fill('')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            # Keyboard selection on the real SVG bar.
            bars = page.locator('.chart-bucket')
            page.locator(f'#bar-{oldest}').focus(); page.keyboard.press('Enter')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text('600')
            page.keyboard.press('Enter')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            page.locator('.chart-bucket').last.focus();page.keyboard.press('ArrowLeft')
            page.click('[data-testid=range-today]')
            expect(page.locator('.chart-bucket[tabindex="0"]')).to_have_count(1)
            page.click('[data-testid=range-7d]')
            expect(page.locator('[data-testid=sum-tokens]')).to_have_text(total)
            page.locator('[data-testid=tab-models]').focus();page.keyboard.press('ArrowRight')
            expect(page.locator('[data-testid=tab-projects]')).to_have_attribute('aria-selected','true')
            page.locator('[data-testid=tab-models]').click()
            page.set_viewport_size(dict(width=961, height=1000))
            assert page.locator('.share-cell').first.evaluate('e=>getComputedStyle(e).display') == 'table-cell'
            for width in [320,360,390,430]:
                page.set_viewport_size(dict(width=width,height=844))
                close = page.get_by_role('button', name='Collapse sidebar', exact=True)
                if close.is_visible(): close.click()
                assert page.evaluate('document.documentElement.scrollWidth') <= width
                assert page.locator('[data-testid=by-model-row]').first.bounding_box()['height'] < 140
                cells = page.locator('[data-testid=by-model-row] td').evaluate_all('cells=>cells.map(e=>({right:e.getBoundingClientRect().right,overflow:e.scrollWidth-e.clientWidth}))')
                assert all(c['right'] <= width and c['overflow'] <= 2 for c in cells), (width,cells)
            page.locator('[data-testid=limits-block] summary').click()
            page.locator('[data-testid=limit-add]').click()
            expect(page.locator('[data-testid=limit-form]')).to_be_visible()
            page.get_by_role('button', name='Cancel',exact=True).click()
            page.locator('[data-testid=agent-state] summary').click()
            expect(page.locator('[data-testid=agent-state] .secondary-body')).to_be_visible()
    assert not errors, errors
    context.close()

if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        run_case(browser); run_case(browser, fail=True); run_case(browser, large=True); run_case(browser,mixed=True)
        browser.close()
    print('PASS dashboard B: accounting, chart selection, search, tabs, exports, mobile density, quotas, keyboard, errors and 52k history')
