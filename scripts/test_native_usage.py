import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sqlite3
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_usage', Path(__file__).parents[1] / 'server/usage/read_native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

class NativeUsageTest(unittest.TestCase):
    def test_devin_cache_buckets_and_request_deduplication(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'devin.db'
            conn = sqlite3.connect(path)
            conn.executescript('CREATE TABLE sessions(id,working_directory,model); CREATE TABLE message_nodes(node_id,session_id,created_at,chat_message);')
            conn.execute('INSERT INTO sessions VALUES(?,?,?)', ('s', '/project', 'model'))
            message = dict(role='assistant', metadata=dict(request_id='r', metrics=dict(input_tokens=100, output_tokens=40, cache_read_tokens=200, cache_creation_tokens=20)))
            for mid in ['m1', 'm2']:
                conn.execute('INSERT INTO message_nodes VALUES(?,?,?,?)', (mid, 's', 1791367200, json.dumps(message)))
            conn.commit(); conn.close()
            rows = native.read_devin(path)
            self.assertEqual(sum(r['used'] for r in rows), 360)
            self.assertNotIn('cost', rows[0])

    def test_opencode_reported_total_wins_over_subsets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'opencode.db'
            conn = sqlite3.connect(path)
            conn.executescript('CREATE TABLE session(id,directory,parent_id); CREATE TABLE message(id,session_id,time_created,data);')
            conn.execute('INSERT INTO session VALUES(?,?,?)', ('s', '/project', None))
            message = dict(role='assistant', time=dict(created=1791367200000), tokens=dict(total=360, input=100, output=40, reasoning=10, cache=dict(read=200, write=20)), cost=0.02)
            conn.execute('INSERT INTO message VALUES(?,?,?,?)', ('m', 's', 1791367200000, json.dumps(message)))
            conn.execute('INSERT INTO session VALUES(?,?,?)', ('fork', '/project', 's'))
            conn.execute('INSERT INTO message VALUES(?,?,?,?)', ('copied', 'fork', 1791367200000, json.dumps({**message, 'id': 'copied', 'sessionID': 'fork', 'parentID': 'new-parent'})))
            conn.commit(); conn.close()
            rows = native.read_opencode(path)
            self.assertEqual(rows[0]['used'], 360)
            self.assertEqual(rows[0]['cost'], 0.02)
            self.assertEqual(len(rows), 1, 'forked copies are not new provider spend')

    def test_missing_sources_are_reported_without_fake_zero_costs(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = native.collect(Path(tmp), porch_output=Path(tmp) / 'porch')
            self.assertEqual(len(result['sources']), 5)
            self.assertTrue(all(s['status'] == 'unavailable' for s in result['sources']))
            self.assertEqual(result['usage'], [])

    def test_hermes_reads_counters_and_does_not_infer_prices(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'hermes.db'
            conn = sqlite3.connect(path)
            columns = 'id,cwd,started_at,last_activity_at,ended_at,model,billing_provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,actual_cost_usd,cost_status'
            conn.executescript(f'CREATE TABLE sessions({columns}); CREATE TABLE session_model_usage(session_id,model,billing_provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,actual_cost_usd,cost_status,last_seen);')
            conn.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', ('s','/project',1791367200,1791367200,None,'m','p',100,40,200,20,0,'unknown'))
            conn.commit(); conn.close()
            rows = native.read_hermes(path)
            self.assertEqual(rows[0]['used'], 360)
            self.assertNotIn('cost', rows[0])
            self.assertEqual(rows[0]['timeBasis'], 'session-last-active')

    def test_managed_pi_sessions_and_fork_copies_are_included_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            managed = home / '.hermes/acp-ui-state/execution/preparation/prep-1/pi-sessions'
            standard = home / '.pi/agent/sessions'
            managed.mkdir(parents=True); standard.mkdir(parents=True)
            record = dict(type='message', id='unique', timestamp='2026-10-07T10:00:00Z', message=dict(role='assistant', usage=dict(totalTokens=42)))
            (managed / 'a.jsonl').write_text(json.dumps(record))
            (standard / 'copy.jsonl').write_text(json.dumps(record))
            rows = native.collect(home, porch_output=home / 'porch')['usage']
            self.assertEqual(sum(r['used'] for r in rows), 42)

    def test_codex_keeps_old_usage_when_a_session_upgrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            records = [dict(type='event_msg', timestamp='2026-10-06T10:00:00Z', payload=dict(type='token_count', info=dict(total_token_usage=dict(total_tokens=100)))), dict(type='event_msg', timestamp='2026-10-07T10:00:00Z', payload=dict(type='token_count', info=dict(total_token_usage=dict(total_tokens=150)))), dict(type='token_usage_record', timestamp='2026-10-07T10:00:00Z', payload=dict(response_id='r', usage=dict(total_tokens=50), thread_token_usage=dict(total_tokens=150)))]
            p.write_text('\n'.join(map(json.dumps, records)))
            self.assertEqual(sum(r['used'] for r in native.read_codex_file(p)), 150)

    def test_ephemeral_porch_codex_counters_and_persisted_session_dedup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'raw').mkdir()
            (root / 'meta.json').write_text(json.dumps(dict(cwd='/project', started_at='2026-10-07T10:00:00Z')))
            records = [dict(method='thread/tokenUsage/updated', emittedAtMs=1791367200000 + n,
                            params=dict(threadId='thread', tokenUsage=dict(total=dict(totalTokens=used))))
                       for n, used in enumerate([100, 100, 250])]
            (root / 'raw/codex.jsonl').write_text('\n'.join(map(json.dumps, records)))
            rows = native.read_porch_usage([root], set())
            self.assertEqual(sum(r['used'] for r in rows), 250)
            self.assertEqual(len(rows), 2)
            self.assertEqual(native.read_porch_usage([root], {'thread'}), [])

    def test_porch_pi_repeated_notifications_count_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'raw').mkdir()
            (root / 'meta.json').write_text(json.dumps(dict(cwd='/project', started_at='2026-10-07T10:00:00Z')))
            msg = dict(role='assistant', timestamp=1791367200000, responseId='r', provider='p', model='m', usage=dict(totalTokens=42))
            records = [dict(type=kind, message=msg) for kind in ['message_end', 'turn_end']]
            (root / 'raw/pi.jsonl').write_text('\n'.join(map(json.dumps, records)))
            rows = native.read_porch_usage([root], set())
            self.assertEqual(sum(r['used'] for r in rows), 42)

    def test_porch_codex_cli_reports_cumulative_thread_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'raw').mkdir()
            (root / 'meta.json').write_text(json.dumps(dict(started_at='2026-10-07T10:00:00Z')))
            events = [dict(type='thread.started', thread_id='t'),
                      dict(type='turn.completed', usage=dict(input_tokens=100, output_tokens=20)),
                      dict(type='turn.completed', usage=dict(input_tokens=200, output_tokens=40))]
            (root / 'raw/codex.jsonl').write_text('\n'.join(map(json.dumps, events)))
            self.assertEqual(sum(r['used'] for r in native.read_porch_usage([root], set())), 240)

    def test_private_porch_artifacts_are_discovered_via_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp); root = home / 'private-artifacts'; (root / 'raw').mkdir(parents=True)
            registry = home / '.cache/pragmatic-orchestration/steer/runs/run-1'; registry.mkdir(parents=True)
            (registry / 'meta.json').write_text(json.dumps(dict(artifacts_dir=str(root), cwd='/project', model='M', started_at='2026-10-07T10:00:00Z')))
            event = dict(method='thread/tokenUsage/updated', emittedAtMs=1791367200000,
                         params=dict(threadId='t', tokenUsage=dict(total=dict(totalTokens=42))))
            (root / 'raw/codex.jsonl').write_text(json.dumps(event))
            result = native.collect(home, porch_output=home / 'default-output')
            self.assertEqual(sum(r['used'] for r in result['usage']), 42)
            self.assertEqual(result['usage'][0]['model'], 'M')

    def test_one_unreadable_porch_journal_does_not_discard_other_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'raw').mkdir()
            (root / 'raw/codex.jsonl').touch()
            errors = []
            with patch.object(native, 'json_lines', side_effect=PermissionError()):
                rows = native.read_porch_usage([root], set(), errors=errors)
            self.assertEqual(rows, [])
            self.assertEqual(errors, ['unreadable-journal'])

    def test_pi_cache_and_reasoning_are_not_counted_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            records = [dict(type='session', id='s', cwd='/project'), dict(type='message', id='m', timestamp='2026-10-07T10:00:00Z', message=dict(role='assistant', model='m', provider='p', usage=dict(input=100, output=40, reasoning=10, cacheRead=200, cacheWrite=20, totalTokens=360, cost=dict(total=0))))]
            p.write_text('\n'.join(map(json.dumps, records)))
            rows = native.read_pi_file(p)
            self.assertEqual(sum(r['used'] for r in rows), 360)
            self.assertEqual(rows[0]['cost'], 0)

    def test_codex_native_records_take_priority_over_duplicate_compat_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            records = [dict(type='session_meta', payload=dict(id='s', cwd='/project')), dict(type='turn_context', payload=dict(model='m')), dict(type='token_usage_record', timestamp='2026-10-07T10:00:00Z', payload=dict(response_id='r', usage=dict(input_tokens=100, cached_input_tokens=80, output_tokens=20, reasoning_output_tokens=10, total_tokens=120))), dict(type='event_msg', timestamp='2026-10-07T10:00:00Z', payload=dict(type='token_count', info=dict(total_token_usage=dict(total_tokens=120))))]
            p.write_text('\n'.join(map(json.dumps, records)))
            rows = native.read_codex_file(p)
            self.assertEqual(sum(r['used'] for r in rows), 120)

    def test_corrupt_tail_does_not_discard_complete_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            p.write_text(json.dumps(dict(type='message', id='m', timestamp='2026-10-07T10:00:00Z', message=dict(role='assistant', usage=dict(totalTokens=42)))) + '\n{"type":')
            self.assertEqual(sum(r['used'] for r in native.read_pi_file(p)), 42)

    def test_unchanged_sessions_are_served_from_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            sessions = home / '.pi/agent/sessions'; sessions.mkdir(parents=True)
            record = dict(type='message', id='m', timestamp='2026-10-07T10:00:00Z',
                          message=dict(role='assistant', usage=dict(totalTokens=42)))
            (sessions / 's.jsonl').write_text(json.dumps(record))
            env = {'STATE_DIR': str(home / 'state')}
            with patch.dict(os.environ, env):
                first = native.collect(home, porch_output=home / 'porch')
                with patch.object(native, 'read_pi_file', side_effect=AssertionError('rescanned')):
                    second = native.collect(home, porch_output=home / 'porch')
            self.assertEqual(first['usage'], second['usage'])

    def test_changed_session_file_is_rescanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            sessions = home / '.pi/agent/sessions'; sessions.mkdir(parents=True)
            p = sessions / 's.jsonl'
            record = dict(type='message', id='m', timestamp='2026-10-07T10:00:00Z',
                          message=dict(role='assistant', usage=dict(totalTokens=42)))
            p.write_text(json.dumps(record) + '\n')
            env = {'STATE_DIR': str(home / 'state')}
            with patch.dict(os.environ, env):
                first = native.collect(home, porch_output=home / 'porch')
                with p.open('a') as stream:
                    stream.write(json.dumps(dict(record, id='m2', message=dict(
                        role='assistant', usage=dict(totalTokens=8)))) + '\n')
                second = native.collect(home, porch_output=home / 'porch')
            self.assertEqual(sum(r['used'] for r in first['usage']), 42)
            self.assertEqual(sum(r['used'] for r in second['usage']), 50)

    def test_finished_porch_runs_are_served_from_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / 'run'; (root / 'raw').mkdir(parents=True)
            (root / 'meta.json').write_text(json.dumps(dict(started_at='2026-10-07T10:00:00Z')))
            event = dict(method='thread/tokenUsage/updated', emittedAtMs=1791367200000,
                         params=dict(threadId='t', tokenUsage=dict(total=dict(totalTokens=42))))
            (root / 'raw/codex.jsonl').write_text(json.dumps(event))
            env = {'STATE_DIR': str(home / 'state'), 'ACP_PORCH_OUTPUT_DIR': str(home)}
            with patch.dict(os.environ, env):
                first = native.collect(home)
                with patch.object(native, 'read_porch_root', side_effect=AssertionError('rescanned')):
                    second = native.collect(home)
            self.assertEqual(first['usage'], second['usage'])
            self.assertEqual(sum(r['used'] for r in first['usage']), 42)

    def test_pi_token_mix_buckets_partition_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            usage = dict(input=100, output=40, reasoning=10, cacheRead=200, cacheWrite=20, totalTokens=360)
            p.write_text(json.dumps(dict(type='message', id='m', timestamp='2026-10-07T10:00:00Z',
                                         message=dict(role='assistant', usage=usage))))
            row = native.read_pi_file(p)[0]
            self.assertEqual((row['input'], row['output'], row['cacheRead'], row['cacheWrite']), (100, 40, 200, 20))
            self.assertEqual(row['input'] + row['output'] + row['cacheRead'] + row['cacheWrite'], row['used'])

    def test_codex_buckets_split_cached_input_out_of_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'session.jsonl'
            usage = dict(input_tokens=1160, cached_input_tokens=1000, cache_write_input_tokens=60,
                         output_tokens=40, reasoning_output_tokens=10, total_tokens=1200)
            records = [dict(type='session_meta', payload=dict(id='s')),
                       dict(type='token_usage_record', timestamp='2026-10-07T10:00:00Z',
                            payload=dict(response_id='r', usage=usage))]
            p.write_text('\n'.join(map(json.dumps, records)))
            row = native.read_codex_file(p)[0]
            self.assertEqual((row['input'], row['output'], row['cacheRead'], row['cacheWrite']), (100, 50, 1000, 60))
            self.assertEqual(row['used'], 1200)

    def test_porch_snapshot_buckets_follow_cumulative_deltas(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'raw').mkdir()
            def snap(used, at):
                return dict(method='thread/tokenUsage/updated', emittedAtMs=1791367200000 + at,
                            params=dict(threadId='t', tokenUsage=dict(total=dict(
                                totalTokens=used, inputTokens=used - 50, cachedInputTokens=used - 150,
                                outputTokens=50, reasoningOutputTokens=0))))
            (root / 'raw/codex.jsonl').write_text('\n'.join(map(json.dumps, [snap(200, 0), snap(500, 1)])))
            rows = native.read_porch_usage([root], set())
            self.assertEqual([(r['used'], r['cacheRead']) for r in rows], [(200, 50), (300, 300)])

    def test_cached_porch_snapshots_are_not_subtracted_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / 'run'; (root / 'raw').mkdir(parents=True)
            (root / 'meta.json').write_text(json.dumps(dict(started_at='2026-10-07T10:00:00Z')))
            records = [dict(method='thread/tokenUsage/updated', emittedAtMs=1791367200000 + n,
                            params=dict(threadId='t', tokenUsage=dict(total=dict(totalTokens=used))))
                       for n, used in enumerate([100, 250])]
            (root / 'raw/codex.jsonl').write_text('\n'.join(map(json.dumps, records)))
            env = {'STATE_DIR': str(home / 'state'), 'ACP_PORCH_OUTPUT_DIR': str(home)}
            with patch.dict(os.environ, env):
                first = native.collect(home)
                second = native.collect(home)
            for result in (first, second):
                self.assertEqual(sum(r['used'] for r in result['usage']), 250)

if __name__ == '__main__': unittest.main()
