#!/usr/bin/env python3
"""Chat link navigation with mocked ACP/local state; never contacts a model.

UI_TEST_URL selects an existing build, including production HTTPS.
"""
import json
import os
import re
from playwright.sync_api import sync_playwright

base = os.environ.get('UI_TEST_URL', 'https://127.0.0.1:25809').rstrip('/')
saved = {'id': 'links-test', 'agentName': 'Links test', 'sessionId': 'links-test',
         'cwd': '/tmp', 'title': 'Link navigation test', 'supportsLoadSession': True,
         'lastUpdated': 1}
errors, sockets = [], []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
    try:
        context = browser.new_context(ignore_https_errors=True)
        context.add_init_script('''{
          const saved = SAVED;
          localStorage.setItem('acp-ui:agents', JSON.stringify({agents:{
            'Links test':{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
          localStorage.setItem('acp-ui:sessions.json', JSON.stringify({sessions:[saved],
            openTabs:[{agentName:saved.agentName,sessionId:saved.sessionId}],
            activeTab:{agentName:saved.agentName,sessionId:saved.sessionId}}));
        }'''.replace('SAVED', json.dumps(saved)))

        def route(request):
            url = request.request.url
            if '/health' in url:
                request.fulfill(json={'ok': False})
            elif '/api/chat-files' in url:
                request.fulfill(body='preview document', content_type='text/plain')
            elif '/api/' in url:
                request.fulfill(json={'projects': [], 'cards': [], 'sessions': []})
            elif url.startswith('https://links.example.test/'):
                request.fulfill(body='<title>Link destination</title><p>Destination</p>', content_type='text/html')
            else:
                request.continue_()

        context.route('**/*', route)

        def socket(ws):
            sockets.append(ws)
            def receive(raw):
                request = json.loads(raw)
                method = request.get('method')
                if method is None or 'id' not in request:
                    return
                result = {}
                if method == 'initialize':
                    result = {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}, 'authMethods': []}
                elif method == 'session/load':
                    for kind, text in [
                        ('user_message_chunk', '[User link](https://links.example.test/user)'),
                        ('agent_thought_chunk', '[Thought link](https://links.example.test/thought)'),
                        ('agent_message_chunk', '[**Markdown link**](https://links.example.test/markdown "Link title")\n\n'
                         'https://links.example.test/autolink\n\n'
                         '<a href="https://links.example.test/raw" target="_self" rel="nofollow">HTML link</a>\n\n'
                         '[Local file](/tmp/chat-link-proof.txt)'),
                    ]:
                        ws.send(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
                            'sessionId': saved['sessionId'], 'update': {
                                'sessionUpdate': kind, 'content': {'type': 'text', 'text': text}}}}))
                    result = {'sessionId': saved['sessionId']}
                ws.send(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}))
            ws.on_message(receive)

        context.route_web_socket(re.compile(r'^wss?://'), socket)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/chat', wait_until='domcontentloaded')
        markdown = page.get_by_role('link', name='Markdown link', exact=True)
        markdown.wait_for()
        page.locator('.thought-toggle').click()
        links = page.locator('.messages a[href^="https://links.example.test/"]')
        assert links.count() == 5, links.count()
        for link in links.all():
            assert link.get_attribute('target') == '_blank', link.inner_text()
            assert {'noopener', 'noreferrer'} <= set((link.get_attribute('rel') or '').split())
        assert markdown.get_attribute('title') == 'Link title'
        assert markdown.locator('strong').inner_text() == 'Markdown link'
        assert 'nofollow' in page.get_by_role('link', name='HTML link').get_attribute('rel')
        # A later streamed chunk replaces v-html on an existing message.
        sockets[-1].send(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
            'sessionId': saved['sessionId'], 'update': {'sessionUpdate': 'agent_message_chunk',
                'content': {'type': 'text', 'text': '\n\n[Streamed link](https://links.example.test/streamed)'}}}}))
        streamed = page.get_by_role('link', name='Streamed link', exact=True)
        streamed.wait_for()
        assert streamed.get_attribute('target') == '_blank'
        current_url = page.url
        for name, keyboard in [('Markdown link', False), ('HTML link', True)]:
            link = page.get_by_role('link', name=name, exact=True)
            with page.expect_popup() as popup_info:
                if keyboard:
                    link.focus()
                    page.keyboard.press('Enter')
                else:
                    link.click()
            popup = popup_info.value
            popup.wait_for_load_state()
            assert popup.title() == 'Link destination'
            assert popup.evaluate('window.opener === null')
            assert page.url == current_url
            popup.close()
        local = page.get_by_role('link', name='Local file', exact=True)
        assert local.get_attribute('target') != '_blank'
        local.click()
        page.get_by_role('dialog', name='File preview', exact=True).wait_for()
        assert page.url == current_url
        assert not errors, errors
        print('PASS: Markdown, HTML, autolink, streamed/user/reasoning links; mouse/keyboard popup; chat retained; file preview retained')
    finally:
        browser.close()
