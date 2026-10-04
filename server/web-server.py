"""Static web bundle with explicit SPA entry routes; assets retain real 404s."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

class PanelHandler(SimpleHTTPRequestHandler):
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
    ThreadingHTTPServer(('127.0.0.1', 25808), PanelHandler).serve_forever()
