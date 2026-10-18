#!/usr/bin/env python3
"""Reconnect and tab-switch regression with isolated state and mocked ACP.

No models, bridges or production documents are modified. UI_TEST_URL selects
an existing frontend, including production HTTPS.
"""
import json
import os
import re
import time
from playwright.sync_api import sync_playwright

base = os.environ.get('UI_TEST_URL', 'https://192.168.1.222:25809').rstrip('/')
sessions = [dict(id=s, sessionId=s, agentName='History test', cwd='/tmp', title=s,
                 lastUpdated=1, supportsLoadSession=True) for s in ['history-a', 'history-b']]
old = dict(version=1, savedAt=1, userTurnBase=0, messages=[
    dict(id='yesterday', role='assistant', content='Yesterday cached answer', timestamp=1)])


def update(ws, sid, kind, text):
    ws.send(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
        'sessionId': sid, 'update': {'sessionUpdate': kind, 'content': {'type': 'text', 'text': text}}}}))


def transcript(ws, sid):
    for number in range(20):
        update(ws, sid, 'user_message_chunk', f'Question {number} for {sid}')
        update(ws, sid, 'agent_message_chunk', f'Answer {number} for {sid}\n\n' + ('History paragraph.\n\n' * 5))
    update(ws, sid, 'user_message_chunk', f'Today question for {sid}')
    update(ws, sid, 'agent_message_chunk', f'Today latest answer for {sid}')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
    try:
        for width in [1440, 390]:
            context = browser.new_context(ignore_https_errors=True, viewport={'width': width, 'height': 900})
            context.add_init_script('''{
              const sessions=SESSIONS;
              localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{'History test':{
                transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
              localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions,
                openTabs:sessions.map(s=>({agentName:s.agentName,sessionId:s.sessionId})),
                activeTab:{agentName:sessions[0].agentName,sessionId:sessions[0].sessionId}}));
            }'''.replace('SESSIONS', json.dumps(sessions)))
            context.route('**/health', lambda route: route.fulfill(json={'ok': False}))
            context.route('**/api/**', lambda route: route.fulfill(json={
                'projects': [], 'sessions': [], 'cards': [], 'root': '/tmp', 'dirs': []}))
            loads, sockets, pending, errors = {}, {}, [], []

            def socket(ws):
                def receive(raw):
                    request = json.loads(raw)
                    if 'id' not in request or 'method' not in request:
                        return
                    method = request['method']
                    result = {}
                    if method == 'initialize':
                        result = dict(protocolVersion=1, agentCapabilities={'loadSession': True}, authMethods=[])
                    elif method == 'session/load':
                        sid = request['params']['sessionId']
                        sockets[sid] = ws
                        loads[sid] = loads.get(sid, 0) + 1
                        if sid == 'history-a' and loads[sid] == 2:
                            update(ws, sid, 'user_message_chunk', 'Old replay prefix')
                            update(ws, sid, 'agent_message_chunk', 'Yesterday replay prefix')
                            pending.append((ws, request['id']))
                            return
                        transcript(ws, sid)
                        result = {'sessionId': sid}
                    ws.send(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}))
                ws.on_message(receive)

            context.route_web_socket(re.compile(r'^wss?://'), socket)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/chat?s=History%20test%3A%3Ahistory-a', wait_until='domcontentloaded')
            page.get_by_text('Today latest answer for history-a', exact=True).wait_for()

            def activate(sid):
                if width >= 800:
                    page.get_by_role('tab').filter(has_text=sid).click()
                else:
                    page.get_by_role('button', name='Open menu', exact=True).click()
                    page.locator('#app-sidebar .session-open').filter(has_text=sid).click()
                page.locator('.chat-view:visible .chat-header h2').filter(has_text=sid).wait_for(state='attached')

            activate('history-b')
            activate('history-a')
            page.evaluate("entry=>localStorage.setItem('acp-ui:history:History test::history-a',JSON.stringify(entry))", old)
            activate('history-b')
            sockets['history-a'].close(code=1012, reason='test reconnect')
            deadline = time.monotonic() + 10
            while not pending and time.monotonic() < deadline:
                page.wait_for_timeout(50)
            assert pending, 'automatic reconnect did not start'
            # Replay must not light an unread notification in the background.
            if width >= 800:
                assert page.get_by_role('tab').filter(has_text='history-a').locator('.tab-dot:not(.dead)').count() == 0
            activate('history-a')
            view = page.locator('.chat-view:visible')
            assert view.get_by_text('Today latest answer for history-a', exact=True).count() == 1, 'reconnect rolled the visible history backwards'
            assert not view.get_by_text('Yesterday cached answer', exact=True).count()
            assert not view.get_by_text('Yesterday replay prefix', exact=True).count()
            assert view.locator('.turn-status-text').inner_text() == 'Restoring history…'
            assert view.locator('.message.streaming').count() == 0
            # Tab switching during restoration keeps the recent snapshot.
            activate('history-b')
            activate('history-a')
            ws, rid = pending.pop()
            # Finish with the complete authoritative transcript, not the prefix.
            transcript(ws, 'history-a')
            ws.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'result': {'sessionId': 'history-a'}}))
            page.wait_for_function("!document.querySelector('.chat-view:not([style*=\"display: none\"]) .history-note')")
            assert not view.locator('.loading-indicator').count()
            assert view.get_by_text('Today latest answer for history-a', exact=True).count() == 1
            activate('history-b')
            activate('history-a')
            assert loads == {'history-a': 2, 'history-b': 1}, loads
            assert not errors, errors
            print(f'PASS {width}px: reconnect retains recent history, old prefix buffered, restoration identified, no replay unread/live caret, tab switches do not reload', flush=True)
            context.close()
    finally:
        browser.close()
