import importlib.util
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('web_server',Path(__file__).resolve().parents[1]/'server/web-server.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Routes(unittest.TestCase):
 def route(self,path):
  handler=object.__new__(module.PanelHandler);handler.path=path;seen=[]
  handler.serve_route(lambda:seen.append(handler.path))
  self.assertEqual(handler.path,path)
  return seen[0]
 def test_entry_pages(self):
  for page in ['board','chat','projects','dashboard']:
   self.assertEqual(self.route('/'+page+'?s=Pi%3A%3AA'),'/index.html')
   self.assertEqual(self.route('/'+page+'/'),'/index.html')
 def test_assets_and_unknown_routes_are_not_rewritten(self):
  for path in ['/assets/missing.js','/unknown','/board/missing','/']:
   self.assertEqual(self.route(path),path)
 def test_entry_and_worker_revalidate_but_hashed_assets_are_immutable(self):
  from unittest.mock import patch
  for path, expected in [('/chat','no-cache'),('/index.html','no-cache'),('/sw.js','no-cache'),('/manifest.webmanifest','no-cache'),('/assets/index-B1234567.js','immutable')]:
   handler=object.__new__(module.PanelHandler);handler.path=path;headers={}
   handler.send_header=lambda k,v:headers.__setitem__(k.lower(),v)
   with patch.object(module.SimpleHTTPRequestHandler,'end_headers'):
    handler.end_headers()
   self.assertIn(expected,headers.get('cache-control',''),path)
class StateProxy(unittest.TestCase):
 def test_same_origin_state_reads_writes_conflicts_and_missing_documents(self):
  import http.client
  import json
  import threading
  from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
  received=[]
  class State(BaseHTTPRequestHandler):
   def do_GET(self):
    received.append((self.command,self.path,None))
    self.send_response(404 if self.path.endswith('/missing') else 200)
    self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'ok':True,'path':self.path}).encode())
   def do_PUT(self):
    received.append((self.command,self.path,self.rfile.read(int(self.headers['Content-Length']))))
    self.send_response(409);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(b'{"error":"rev conflict"}')
   def log_message(self,*args):pass
  upstream=ThreadingHTTPServer(('127.0.0.1',0),State)
  class Panel(module.PanelHandler):
   state_port=upstream.server_port
   def log_message(self,*args):pass
  web=ThreadingHTTPServer(('127.0.0.1',0),Panel)
  for server in [upstream,web]:threading.Thread(target=server.serve_forever,daemon=True).start()
  try:
   client=http.client.HTTPConnection('127.0.0.1',web.server_port,timeout=3)
   for route,status in [('/health',200),('/api/state/sessions.json?fresh=1',200),('/api/state/missing',404)]:
    client.request('GET',route);response=client.getresponse()
    self.assertEqual(response.status,status)
    self.assertEqual(response.getheader('Cache-Control'),'no-store')
    self.assertEqual(json.loads(response.read())['path'],route)
   client.request('PUT','/api/state/sessions.json',body=b'{"rev":1,"data":{}}',headers={'Content-Type':'application/json'})
   response=client.getresponse();self.assertEqual(response.status,409);response.read()
   self.assertEqual(received[-1],('PUT','/api/state/sessions.json',b'{"rev":1,"data":{}}'))
   client.close()
  finally:
   for server in [web,upstream]:server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
