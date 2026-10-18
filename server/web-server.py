"""Static web bundle with explicit SPA entry routes; assets retain real 404s."""
import os
import re
from http.client import HTTPConnection, HTTPException
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PORT", "25808"))

class PanelHandler(SimpleHTTPRequestHandler):
    state_port = 25900
    # The slim container has no system MIME database. Android's certificate
    # picker needs the certificate type rather than application/octet-stream.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.crt': 'application/x-x509-ca-cert',
    }

    def end_headers(self):
        path = urlsplit(self.path).path
        if path == '/health' or path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        elif re.fullmatch(r'/assets/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp)', path):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:
            # Always revalidate the entry page, worker and unversioned files.
            # Vite already gives JS/CSS content hashes; HTML selects the build.
            self.send_header('Cache-Control', 'no-cache, max-age=0, must-revalidate')
        super().end_headers()

    def do_GET(self):
        self.serve_route(super().do_GET)

    def do_HEAD(self):
        self.serve_route(super().do_HEAD)

    def do_PUT(self):
        self.serve_state()

    do_POST = do_PUT
    do_DELETE = do_PUT
    do_PATCH = do_PUT
    do_OPTIONS = do_PUT

    def serve_state(self):
        path = urlsplit(self.path).path
        if path != '/health' and not path.startswith('/api/'):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send_error(400)
            return
        if length < 0 or length > 5 * 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        headers = {name: self.headers[name] for name in ('Content-Type', 'Authorization', 'Accept') if name in self.headers}
        upstream = HTTPConnection('127.0.0.1', self.state_port, timeout=30)
        try:
            upstream.request('GET' if self.command == 'HEAD' else self.command, self.path, body, headers)
            response = upstream.getresponse()
            content = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {'connection', 'transfer-encoding', 'content-length', 'cache-control', 'server', 'date'}:
                    self.send_header(name, value)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(content)
        except (OSError, HTTPException):
            self.send_error(502, 'Session server is unavailable')
        finally:
            upstream.close()

    def serve_route(self, serve):
        original = self.path
        if urlsplit(original).path == '/health' or urlsplit(original).path.startswith('/api/'):
            self.serve_state()
            return
        if urlsplit(original).path.rstrip('/') in {'/chat', '/board', '/projects', '/dashboard'}:
            self.path = '/index.html'
        try:
            serve()
        finally:
            self.path = original

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), PanelHandler).serve_forever()
