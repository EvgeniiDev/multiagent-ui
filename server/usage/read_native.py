"""Read provider token counters locally, without exporting conversation content.

Databases are opened read-only. No price inference: only recorded monetary
amounts are returned. Cache and reasoning subsets must not be added twice.
"""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys


def number(value):
    return max(0, value) if isinstance(value, (int, float)) and math.isfinite(value) else 0


def timestamp(value):
    if isinstance(value, (int, float)):
        return int(value * 1000 if value < 100000000000 else value)
    try:
        return int(dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def sample(agent, sid, at, used, cwd=None, model=None, provider=None, cost=None, **extra):
    row = dict(agentName=agent, sessionId=str(sid), at=timestamp(at), used=number(used),
               size=0, source='agent', accounting='delta', model=model or 'unknown',
               provider=provider or 'unknown', **extra)
    if cwd: row['cwd'] = cwd
    if isinstance(cost, (int, float)) and math.isfinite(cost) and cost >= 0:
        row.update(cost=cost, currency='USD')
    return row


def json_lines(path):
    with path.open() as stream:
        for line in stream:
            try:
                row = json.loads(line)
                if isinstance(row, dict): yield row
            except (ValueError, TypeError):
                continue  # An in-flight JSONL append can have an incomplete tail.


def read_pi_file(path):
    sid, cwd = path.stem, None
    rows, seen = [], set()
    for data in json_lines(path):
        if data.get('type') == 'session':
            sid, cwd = data.get('id', sid), data.get('cwd')
        msg = data.get('message') or {}
        usage = msg.get('usage') if isinstance(msg, dict) else None
        if not usage or msg.get('role') != 'assistant': continue
        mid = data.get('id')
        if mid and mid in seen: continue
        if mid: seen.add(mid)
        total = usage.get('totalTokens')
        if total is None:
            total = sum(number(usage.get(k)) for k in ('input', 'output', 'cacheRead', 'cacheWrite'))
        rows.append(sample('Pi', sid, data.get('timestamp'), total, cwd,
                           msg.get('model'), msg.get('provider'), (usage.get('cost') or {}).get('total'),
                           eventId=mid or f"{sid}:{data.get('timestamp')}"))
    return rows


def read_codex_file(path):
    sid, cwd, model, provider = path.stem, None, None, None
    records, compat, seen, previous, prefix = [], [], set(), 0, 0
    for data in json_lines(path):
        payload = data.get('payload') or {}
        kind = data.get('type')
        if kind == 'session_meta':
            sid, cwd = payload.get('id', sid), payload.get('cwd')
            provider = payload.get('model_provider')
        if kind == 'turn_context':
            model = payload.get('model', model)
        if kind == 'token_usage_record':
            usage = payload.get('usage') or {}
            rid = payload.get('response_id')
            if rid and rid in seen: continue
            if rid: seen.add(rid)
            total = usage.get('total_tokens')
            if total is None: total = number(usage.get('input_tokens')) + number(usage.get('output_tokens'))
            if not records:
                prefix = max(0, number((payload.get('thread_token_usage') or {}).get('total_tokens')) - number(total))
            records.append(sample('Codex', sid, data.get('timestamp'), total, cwd, model, provider,
                                  eventId=rid or f"{sid}:{data.get('timestamp')}:{total}"))
        if kind == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            usage = info.get('total_token_usage') or {}
            total = number(usage.get('total_tokens'))
            if total > previous:
                compat.append(sample('Codex', sid, data.get('timestamp'), total - previous, cwd, model, provider,
                                     eventId=f"{sid}:{data.get('timestamp')}:{total}"))
                previous = total
    # A session resumed after an upgrade can have an older compatibility-only
    # prefix. Native thread totals tell us exactly how much preceded the first
    # native call, even if its duplicate compatibility event came first.
    if not records: return compat
    historical = []
    for row in compat:
        if prefix <= 0: break
        kept = dict(row); kept['used'] = min(row['used'], prefix)
        historical.append(kept); prefix -= kept['used']
    if prefix > 0:
        first = records[0]
        historical.append(sample('Codex', sid, first['at'], prefix, cwd, model, provider,
                                 eventId=f'{sid}:historic-prefix', timeBasis='session-last-active'))
    return historical + records


def database(path):
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def read_hermes(path):
    conn = database(path)
    try:
        models = conn.execute('SELECT * FROM session_model_usage').fetchall()
        sessions = {r['id']: dict(r) for r in conn.execute('''SELECT id,cwd,started_at,last_activity_at,ended_at,
          model,billing_provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
          actual_cost_usd,cost_status FROM sessions''')}
        rows, covered = [], set()
        for record in models:
            r = dict(record); s = sessions.get(r['session_id'], {})
            covered.add(r['session_id'])
            total = sum(number(r.get(k)) for k in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'))
            cost = r.get('actual_cost_usd') if r.get('cost_status') == 'actual' else None
            if r.get('cost_status') == 'included': cost = 0
            rows.append(sample('Hermes Agent', r['session_id'], r['last_seen'], total,
                               s.get('cwd'), r.get('model'), r.get('billing_provider'), cost,
                               timeBasis='session-last-active'))
        for sid, s in sessions.items():
            if sid in covered: continue
            total = sum(number(s.get(k)) for k in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'))
            cost = s.get('actual_cost_usd') if s.get('cost_status') == 'actual' else None
            if s.get('cost_status') == 'included': cost = 0
            rows.append(sample('Hermes Agent', sid, s.get('last_activity_at') or s.get('ended_at') or s['started_at'],
                               total, s.get('cwd'), s.get('model'), s.get('billing_provider'), cost,
                               timeBasis='session-last-active'))
        return rows
    finally: conn.close()


def read_opencode(path):
    conn = database(path)
    try:
        rows, seen = [], set()
        parents = {r['id']: r['parent_id'] for r in conn.execute('SELECT id,parent_id FROM session')}
        def family(sid):
            visited = set()
            while parents.get(sid) and sid not in visited:
                visited.add(sid); sid = parents[sid]
            return sid
        query = 'SELECT m.id, m.session_id, m.time_created, m.data, s.directory FROM message m LEFT JOIN session s ON s.id=m.session_id'
        for record in conn.execute(query):
            info = json.loads(record['data'])
            if info.get('role') != 'assistant': continue
            # Forking copies assistant info (including usage/time) with new
            # message/session/parent IDs. Those copies are not provider calls.
            identity = {k: v for k, v in info.items() if k not in ('id', 'sessionID', 'parentID')}
            fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
            key = (family(record['session_id']), fingerprint)
            if key in seen: continue
            seen.add(key)
            tokens = info.get('tokens') or {}; cache = tokens.get('cache') or {}
            total = tokens.get('total')
            if total is None:
                total = sum(number(tokens.get(k)) for k in ('input', 'output', 'reasoning')) + number(cache.get('read')) + number(cache.get('write'))
            rows.append(sample('OpenCode', record['session_id'], (info.get('time') or {}).get('completed') or record['time_created'],
                               total, record['directory'], info.get('modelID'), info.get('providerID'), info.get('cost')))
        return rows
    finally: conn.close()


def read_devin(path):
    conn = database(path)
    try:
        rows, seen = [], set()
        # Extract metadata only: conversation text and tool results never leave SQLite.
        query = """SELECT n.node_id,n.session_id,n.created_at,s.working_directory,s.model,
          json_extract(n.chat_message,'$.metadata.metrics') AS metrics,
          json_extract(n.chat_message,'$.metadata.request_id') AS request_id,
          json_extract(n.chat_message,'$.metadata.generation_model') AS generation_model
          FROM message_nodes n JOIN sessions s ON s.id=n.session_id
          WHERE json_extract(n.chat_message,'$.role')='assistant'
          AND json_type(n.chat_message,'$.metadata.metrics')='object'"""
        for r in conn.execute(query):
            key = (r['session_id'], r['request_id'] or r['node_id'])
            if key in seen: continue
            seen.add(key); m = json.loads(r['metrics'])
            if not any(k in m for k in ('input_tokens', 'prompt_tokens')): continue
            # Native metadata has uncached input + separate cache buckets.
            # Older transcript-style metrics have inclusive prompt_tokens.
            if 'input_tokens' in m:
                total = sum(number(m.get(k)) for k in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'))
            else: total = number(m.get('prompt_tokens')) + number(m.get('completion_tokens'))
            rows.append(sample('Devin', r['session_id'], r['created_at'], total,
                               r['working_directory'], r['generation_model'] or r['model']))
        return rows
    finally: conn.close()


def collect(home):
    home = Path(home)
    rows, sources = [], []
    readers = [('Hermes Agent', home / '.hermes/state.db', read_hermes),
               ('OpenCode', home / '.local/share/opencode/opencode.db', read_opencode),
               ('Devin', home / '.local/share/devin/cli/sessions.db', read_devin)]
    for agent, path, reader in readers:
        try:
            if not path.is_file(): raise FileNotFoundError()
            found = reader(path); rows.extend(found)
            sources.append(dict(agentName=agent, status='ready', samples=len(found)))
        except (OSError, sqlite3.Error, ValueError, KeyError):
            sources.append(dict(agentName=agent, status='unavailable', samples=0))
    for agent, directory, reader in [('Pi', home / '.pi/agent/sessions', read_pi_file),
                                      ('Codex', home / '.codex/sessions', read_codex_file)]:
        found, errors = [], 0
        files = sorted(directory.rglob('*.jsonl')) if directory.is_dir() else []
        if agent == 'Codex': files.extend((home / '.codex/archived_sessions').rglob('*.jsonl'))
        if agent == 'Pi':
            state = Path(os.environ.get('STATE_DIR') or home / '.hermes/acp-ui-state')
            extra_roots = [state, Path(__file__).resolve().parents[2] / '.agent-tmp']
            for root in extra_roots:
                for folder in root.rglob('pi-sessions'):
                    if folder.is_dir(): files.extend(folder.rglob('*.jsonl'))
            for record in (state / 'execution/attempts').glob('*/launch.json'):
                try:
                    session_dir = (json.loads(record.read_text()).get('launch') or {}).get('pi', {}).get('sessionDir')
                    if session_dir: files.extend(Path(session_dir).glob('*.jsonl'))
                except (OSError, ValueError, TypeError): errors += 1
        files = sorted(set(files))
        for path in files:
            try: found.extend(reader(path))
            except (OSError, ValueError, TypeError): errors += 1
        rows.extend(found)
        sources.append(dict(agentName=agent, status='partial' if errors else 'ready' if directory.is_dir() or files else 'unavailable', samples=len(found)))
    unique, seen = [], set()
    for r in rows:
        if r['at'] <= 0 or (r['used'] <= 0 and r.get('cost', 0) <= 0): continue
        event = r.pop('eventId', None)
        key = (r['agentName'], event)
        if event and key in seen: continue
        if event: seen.add(key)
        unique.append(r)
    rows = unique
    return dict(usage=rows, sources=sources, updatedAt=int(dt.datetime.now().timestamp() * 1000))


if __name__ == '__main__':
    print(json.dumps(collect(os.environ.get('ACP_USAGE_HOME') or os.environ.get('HOME') or str(Path.home())), allow_nan=False, separators=(',', ':')))
