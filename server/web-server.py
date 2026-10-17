"""Static web bundle with explicit SPA entry routes; assets retain real 404s."""
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PORT", "25808"))

class PanelHandler(SimpleHTTPRequestHandler):
    # The slim container has no system MIME database. Android's certificate
    # picker needs the certificate type rather than application/octet-stream.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.crt': 'application/x-x509-ca-cert',
    }

    def do_GET(self):
        self.serve_route(super().do_GET)

    def do_HEAD(self):
        self.serve_route(super().do_HEAD)

    def serve_route(self, serve):
        original = self.path
        if urlsplit(original).path.rstrip('/') in {'/chat', '/board', '/projects', '/dashboard'}:
            self.path = '/index.html'
        try:
            serve()
        finally:
            self.path = original

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), PanelHandler).serve_forever()
