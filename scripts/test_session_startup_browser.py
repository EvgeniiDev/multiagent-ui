#!/usr/bin/env python3
"""Real Codex ACP startup with isolated shared-state documents; no model prompts.

UI_TEST_URL selects the frontend. STALL_DOC selects preferences.json or
sessions.json. STALL_SECONDS defaults to 60; use 0 for the healthy path.
The fixture commits PUTs before stalling their bodies and enforces revisions.
Production documents are never written. Requires Python Playwright.
"""
import json
import os
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright

started = time.monotonic()
documents, events, errors = {}, [], []
lock = threading.Lock()


def emit(**values):
    values['atMs'] = round((time.monotonic() - started) * 1000)
    events.append(values)
    print(json.dumps(values), flush=True)


class StateFixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, data, status=200, delay=0):
        body = json.dumps(data).encode()
        self.send_response(status)
        for key, value in {
            'Content-Type': 'application/json', 'Content-Length': str(len(body)),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type',
        }.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.flush()
        if delay:
            emit(event='state/body-stalled', seconds=delay)
            time.sleep(delay)
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass

    def do_OPTIONS(self):
        self.reply({}, 204)

    def do_GET(self):
        if urlsplit(self.path).path == '/health':
            self.reply({'ok': True})
            return
        name = unquote(urlsplit(self.path).path.split('/')[-1])
        with lock:
            doc = documents.setdefault(name, {'rev': 1, 'updatedAt': 1, 'data': {}})
        self.reply(doc)

    def do_PUT(self):
        name = unquote(urlsplit(self.path).path.split('/')[-1])
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            current = documents.get(name, {'rev': 0})
            if payload.get('rev', current['rev']) != current['rev']:
                self.reply({'code': 'rev_conflict', 'rev': current['rev']}, 409)
                return
            doc = {'rev': current['rev'] + 1, 'updatedAt': round(time.time() * 1000),
                   'data': payload['data']}
            documents[name] = doc
        delay = (float(os.environ.get('STALL_SECONDS', '60'))
                 if name == os.environ.get('STALL_DOC', 'preferences.json') else 0)
        self.reply({'rev': doc['rev'], 'updatedAt': doc['updatedAt']}, delay=delay)


def count_rpc(method, event='rpc/response'):
    return sum(e.get('event') == event and e.get('method') == method
               and not e.get('error') for e in events)


def websocket(socket):
    pending = {}

    def sent(raw):
        try:
            frame = json.loads(raw)
        except (ValueError, TypeError):
            return
        if frame.get('method') and frame.get('id') is not None:
            pending[frame['id']] = frame['method']
            emit(event='rpc/sent', method=frame['method'])

    def received(raw):
        try:
            frame = json.loads(raw)
        except (ValueError, TypeError):
            return
        if 'id' in frame and 'method' not in frame:
            emit(event='rpc/response', method=pending.pop(frame['id'], None),
                 error=frame.get('error', {}).get('message'))

    socket.on('framesent', sent)
    socket.on('framereceived', received)


def wait_ready(page):
    page.locator('.chat-view:visible textarea').wait_for(state='visible', timeout=15000)
    page.wait_for_function("""!document.querySelector('.startup-progress') &&
      !document.querySelector('.nsm-menu') &&
      document.querySelector('.chat-view:not([style*="display: none"]) textarea')?.disabled===false
    """, timeout=15000)


base = os.environ.get('UI_TEST_URL', 'http://127.0.0.1:25808').rstrip('/')
protocol = urlsplit(base).scheme
certificates = tempfile.TemporaryDirectory(prefix='acp-state-fixture-')
server = ThreadingHTTPServer(('127.0.0.1', 0), StateFixture)
if protocol == 'https':
    cert = certificates.name + '/cert.pem'
    key = certificates.name + '/key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-days', '1', '-subj', '/CN=127.0.0.1',
                    '-addext', 'subjectAltName=IP:127.0.0.1',
                    '-keyout', key, '-out', cert], check=True, capture_output=True)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        context = browser.new_context(ignore_https_errors=True)
        context.add_init_script("""localStorage.setItem('acp-ui:agents', JSON.stringify({agents:{
          'Codex startup test':{transport:'websocket',url:location.protocol==='https:'
            ?'wss://127.0.0.1:25917/':'ws://127.0.0.1:25907/'}}}));""")

        def route(request):
            path = urlsplit(request.request.url).path
            if '/api/state/' in path or path == '/health':
                request.continue_(url=f'{protocol}://127.0.0.1:{server.server_port}' + path)
            elif request.request.method not in ['GET', 'HEAD', 'OPTIONS']:
                emit(event='unexpected-write-blocked', path=path)
                request.abort()
            else:
                request.continue_()

        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('websocket', websocket)
        try:
            page.goto(base + '/chat', wait_until='domcontentloaded')
            page.locator('.nsm > button').click()
            page.locator('.cwd-input').fill('/tmp')
            emit(event='click/start')
            clicked = time.monotonic()
            page.get_by_role('button', name='Start session', exact=True).click()
            wait_ready(page)
            elapsed = round((time.monotonic() - clicked) * 1000)
            emit(event='chat/ready', elapsedMs=elapsed)
            assert elapsed < int(os.environ.get('MAX_START_MS', '11500')), elapsed
            assert documents.get('sessions.json', {}).get('data', {}).get('sessions'), 'state fixture was bypassed'
            if float(os.environ.get('STALL_SECONDS', '60')) > 0:
                assert any(e.get('event') == 'state/body-stalled' for e in events), 'fault was not injected'
            assert count_rpc('session/new') == 1
            assert not page.locator('.nsm-error:visible').count()
            assert not errors, errors

            page.reload(wait_until='domcontentloaded')
            wait_ready(page)
            assert count_rpc('session/load') == 1
            assert not errors, errors
            emit(event='reload/ready')

            # Restore the same session in another window; no new session/prompt.
            other = context.new_page()
            other.on('pageerror', lambda error: errors.append(str(error)))
            other.on('websocket', websocket)
            other.goto(page.url, wait_until='domcontentloaded')
            wait_ready(other)
            assert count_rpc('session/load') == 2
            assert count_rpc('session/new', 'rpc/sent') == 1
            assert not errors, errors
            emit(event='second-window/ready')
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    certificates.cleanup()
