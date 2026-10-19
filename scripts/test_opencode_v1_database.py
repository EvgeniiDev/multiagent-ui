import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).resolve().parents[1] / 'deploy/prepare-opencode-v1-db.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'original.db'
        self.target = Path(self.temp.name) / 'acp.db'
        with sqlite3.connect(self.source) as db:
            db.executescript('''CREATE TABLE workspace(id text primary key, provider text, binding text, created_at integer, last_used_at integer);
                CREATE TABLE session(id text); INSERT INTO session VALUES('legacy');
                CREATE TABLE session_v2(id text); INSERT INTO session_v2 VALUES('v2');''')

    def test_copies_both_generations_without_touching_original_or_existing_target(self):
        self.assertTrue(mod.prepare(self.source, self.target))
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(self.source) as db:
            self.assertEqual(mod.columns(db), mod.V2_COLUMNS)
        with sqlite3.connect(self.target) as db:
            self.assertEqual(mod.columns(db), mod.V1_COLUMNS)
            self.assertEqual(db.execute('select id from session').fetchall(), [('legacy',)])
            self.assertEqual(db.execute('select id from session_v2').fetchall(), [('v2',)])
            db.execute("insert into session values('new ACP conversation')")
        self.assertFalse(mod.prepare(self.source, self.target))
        with sqlite3.connect(self.target) as db:
            self.assertEqual(db.execute('select count(*) from session').fetchone()[0], 2)

    def test_nonempty_workspaces_refuse_and_leave_no_target(self):
        with sqlite3.connect(self.source) as db:
            db.execute("insert into workspace values('one','local',null,1,1)")
        with self.assertRaisesRegex(ValueError, 'nonempty'):
            mod.prepare(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_same_file_refused(self):
        with self.assertRaisesRegex(ValueError, 'different'):
            mod.prepare(self.source, self.source)

if __name__ == '__main__':
    unittest.main()
