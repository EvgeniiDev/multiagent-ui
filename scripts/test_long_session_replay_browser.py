#!/usr/bin/env python3
"""Measure a real, idle Codex session replay without writing shared UI state.

HISTORY_SESSION_JSON must point to a SavedSession JSON selected for read-only
inspection. UI_TEST_URL selects the served frontend (default production HTTP).
No prompts are sent. Only timings/counts are printed; transcript text is not.
The test uses a fresh browser/local store so it does not alter the user's tabs.
"""
import json
import os
import time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

with open(os.environ['HISTORY_SESSION_JSON']) as source:
    saved = json.load(source)
started = time.monotonic()
counts = {'frames': 0, 'bytes': 0}
responses = []
errors = []


def emit(**values):
    print(json.dumps({'atMs': round((time.monotonic() - started) * 1000), **values}), flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(ignore_https_errors=True)
    context.add_init_script('''{
      const saved = SAVED_SESSION;
      localStorage.setItem('acp-ui:agents', JSON.stringify({agents: {
        Codex: {transport: 'websocket', url: location.protocol === 'https:'
          ? 'wss://127.0.0.1:25917/' : 'ws://127.0.0.1:25907/'}
      }}));
      if (!localStorage.getItem('acp-ui:sessions.json')) localStorage.setItem('acp-ui:sessions.json', JSON.stringify({sessions: [saved],
        openTabs: [{agentName:saved.agentName,sessionId:saved.sessionId}],
        activeTab:{agentName:saved.agentName,sessionId:saved.sessionId}}));
      window.replayLongTasks = [];
      new PerformanceObserver(list => {
        for (const task of list.getEntries()) window.replayLongTasks.push(task.duration);
      }).observe({type:'longtask',buffered:true});
    }'''.replace('SAVED_SESSION', json.dumps(saved)))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Force local KV persistence. ACP remains real; shared documents stay intact.
    page.route('**/health', lambda route: route.fulfill(json={'ok': False}))
    page.route('**/api/**', lambda route: route.continue_()
               if route.request.method in ['GET', 'HEAD', 'OPTIONS'] else route.abort())

    def on_socket(socket):
        pending = {}  # Request ids are scoped to this socket, never just its URL.

        def on_sent(raw):
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                return
            if frame.get('method') and frame.get('id') is not None:
                pending[frame['id']] = (frame['method'], time.monotonic())
                emit(event='rpc/sent', method=frame['method'])

        def on_received(raw):
            counts['frames'] += 1
            counts['bytes'] += len(raw)
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                return
            if not frame.get('method') and frame.get('id') in pending:
                method, sent = pending.pop(frame['id'])
                result = {'method': method, 'ms': round((time.monotonic() - sent) * 1000),
                          'error': frame.get('error', {}).get('message')}
                responses.append(result)
                emit(event='rpc/response', **result)

        socket.on('framesent', on_sent)
        socket.on('framereceived', on_received)

    page.on('websocket', on_socket)
    base = os.environ.get('UI_TEST_URL', 'http://127.0.0.1:25808').rstrip('/')
    try:
        page.goto(base + '/chat?s=' + quote(saved['agentName'] + '::' + saved['sessionId']),
                  wait_until='domcontentloaded')
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline and not any(r['method'] == 'session/load' for r in responses):
            page.wait_for_timeout(100)
        loads = [r for r in responses if r['method'] == 'session/load']
        assert loads and not loads[-1]['error'], loads
        page.wait_for_function("document.querySelector('.chat-view textarea')?.disabled === false", timeout=15000)
        metrics = page.evaluate('''({count:window.replayLongTasks.length,
          totalMs:window.replayLongTasks.reduce((sum, duration)=>sum+duration,0),
          maxMs:Math.max(0,...window.replayLongTasks)})''')
        emit(event='replay/ready', **counts, longTasks=metrics, errors=errors)
        assert not errors, errors
        if 'MAX_REPLAY_TASK_MS' in os.environ:
            assert metrics['maxMs'] < float(os.environ['MAX_REPLAY_TASK_MS']), metrics
        # A fresh session must still work after the replay, with a single create.
        before = sum(r['method'] == 'session/new' for r in responses)
        page.locator('.nsm > button').click()
        page.locator('.cwd-input').fill('/tmp')
        at = time.monotonic()
        page.get_by_role('button', name='Start session', exact=True).click()
        page.wait_for_function("!document.querySelector('.nsm-menu') && document.querySelector('.chat-view:not([style*=\"display: none\"]) textarea')?.disabled === false", timeout=20000)
        assert sum(r['method'] == 'session/new' for r in responses) == before + 1
        assert not errors, errors
        emit(event='new-session/ready', ms=round((time.monotonic() - at) * 1000))
        page.get_by_role('button', name='ACP Traffic Monitor', exact=True).click()
        monitor = page.locator('.traffic-monitor')
        monitor.wait_for(state='visible')
        assert monitor.locator('.entry').count() == 500
        monitor.locator('.filter-select').select_option('responses')
        assert monitor.locator('.entry').count() > 0
        monitor.get_by_role('textbox', name='Search ACP traffic').fill('session/new')
        assert monitor.locator('.entry').count() == 1
        monitor.locator('.entry-toggle').click()
        assert monitor.locator('.entry-payload pre').is_visible()
        monitor.get_by_role('button', name='Clear search', exact=True).click()
        monitor.locator('.filter-select').select_option('all')
        monitor.get_by_role('button', name='Pause', exact=True).click()
        assert monitor.get_by_role('button', name='Resume', exact=True).get_attribute('aria-pressed') == 'true'
        monitor.get_by_role('button', name='Resume', exact=True).click()
        monitor.get_by_role('button', name='Clear', exact=True).click()
        assert monitor.locator('.entry').count() == 0
        monitor.get_by_role('button', name='Close', exact=True).click()
        assert not errors, errors
        emit(event='traffic-monitor/verified')
        # Restore both the historical tab and the new tab concurrently. The
        # active URL and enabled composer must survive a fresh navigation.
        active_url = page.url
        load_count = sum(r['method'] == 'session/load' for r in responses)
        page.reload(wait_until='domcontentloaded')
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline and sum(r['method'] == 'session/load' for r in responses) < load_count + 2:
            page.wait_for_timeout(100)
        reloaded = [r for r in responses if r['method'] == 'session/load'][load_count:]
        assert len(reloaded) == 2 and all(not r['error'] for r in reloaded), reloaded
        page.wait_for_function("document.querySelector('.chat-view:not([style*=\"display: none\"]) textarea')?.disabled === false", timeout=15000)
        assert page.url == active_url
        assert not errors, errors
        emit(event='reload/two-sessions-ready')
    finally:
        browser.close()
