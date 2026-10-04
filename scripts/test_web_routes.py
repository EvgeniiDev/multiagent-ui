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
if __name__=='__main__':unittest.main()
