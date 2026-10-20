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


def sample(agent, sid, at, used, cwd=None, model=None, provider=None, cost=None,
           tokens=None, **extra):
    row = dict(agentName=agent, sessionId=str(sid), at=timestamp(at), used=number(used),
               size=0, source='agent', accounting='delta', model=model or 'unknown',
               provider=provider or 'unknown', **extra)
    if cwd: row['cwd'] = cwd
    if isinstance(cost, (int, float)) and math.isfinite(cost) and cost >= 0:
        row.update(cost=cost, currency='USD')
    # Token mix: input excludes cached reads/writes so the buckets partition
    # `used` — frontends can show "in / cached / out" without double counting.
    for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
        value = number((tokens or {}).get(key))
        if value: row[key] = value
    return row


def codex_buckets(usage):
    """Codex input_tokens already contains cached reads and cache writes."""
    def get(*names):
        for name in names:
            v = usage.get(name)
            if v is not None: return number(v)
        return 0
    cached = get('cached_input_tokens', 'cachedInputTokens')
    written = get('cache_write_input_tokens', 'cacheWriteInputTokens')
    total_in = get('input_tokens', 'inputTokens')
    return dict(input=max(0, total_in - cached - written), cacheRead=cached,
                cacheWrite=written,
                output=get('output_tokens', 'outputTokens') +
                       get('reasoning_output_tokens', 'reasoningOutputTokens'))


def pi_buckets(usage):
    # `reasoning` is a subset of output, not a separate bucket.
    return dict(input=usage.get('input'), output=usage.get('output'),
                cacheRead=usage.get('cacheRead'), cacheWrite=usage.get('cacheWrite'))


def json_lines(path):
    with path.open() as stream:
        for line in stream:
            try:
                row = json.loads(line)
                if isinstance(row, dict): yield row
            except (ValueError, TypeError):
                continue  # An in-flight JSONL append can have an incomplete tail.


def dict_lines(block):
    """Same as json_lines over an already-read block of complete lines."""
    for line in block.splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict): yield row
        except (ValueError, TypeError):
            continue


def tail_block(path, off):
    """Bytes after `off` up to and including the last complete line, plus
    the advanced offset — an in-flight trailing append is left unconsumed."""
    with path.open('rb') as stream:
        stream.seek(off)
        block = stream.read()
    cut = block.rfind(b'\n')
    if cut < 0: return '', off
    return block[:cut + 1].decode('utf-8', 'replace'), off + cut + 1


def parsed_offset(path):
    """Byte offset after a full parse: everything before it is complete
    lines already folded into the returned rows."""
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            window = min(4096, size)
            stream.seek(size - window)
            block = stream.read()
    except OSError:
        return 0
    cut = block.rfind(b'\n')
    if cut < 0: return max(0, size - window)  # oversized live line: re-read it next scan
    return size - len(block) + cut + 1


def pi_event_id(msg, fallback):
    response = msg.get('responseId')
    if response:
        return f"pi:{msg.get('provider')}:{response}"
    if msg.get('timestamp'):
        identity = {k: msg.get(k) for k in ('timestamp', 'provider', 'model', 'usage')}
        return 'pi:' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return f'pi:{fallback}'


def parse_pi(lines, state):
    rows, seen = [], set()
    sid, cwd = state['sid'], state['cwd']
    for data in lines:
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
                           tokens=pi_buckets(usage),
                           eventId=pi_event_id(msg, mid or f"{sid}:{data.get('timestamp')}")))
    state['sid'], state['cwd'] = sid, cwd
    return rows


def read_pi_file(path):
    return parse_pi(json_lines(path), dict(sid=path.stem, cwd=None))


def full_pi(path):
    """Full parse; returns (rows, resumable state, parsed byte offset)."""
    state = dict(sid=path.stem, cwd=None)
    return parse_pi(json_lines(path), state), state, parsed_offset(path)


def tail_pi(block, state):
    return parse_pi(dict_lines(block), state)


def read_codex_history(path):
    """Full parse; returns (rows, state, off) for cached_jsonl. `kind`
    marks whether the file speaks the native token_usage_record dialect
    (safe to tail-parse: appended records are self-contained deltas) or the
    legacy cumulative event stream, where the prefix arithmetic spans the
    whole file — legacy files carry no offset and always reparse whole."""
    sid, cwd, model, provider = path.stem, None, None, None
    records, compat, seen, previous, prefix = [], [], set(), 0, 0
    compat_buckets = {}  # cumulative snapshot of the last emitted compat row
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
                                  tokens=codex_buckets(usage),
                                  eventId=rid or f"{sid}:{data.get('timestamp')}:{total}"))
        if kind == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            usage = info.get('total_token_usage') or {}
            total = number(usage.get('total_tokens'))
            if total > previous:
                row = sample('Codex', sid, data.get('timestamp'), total - previous, cwd, model, provider,
                             tokens=codex_buckets(usage),
                             eventId=f"{sid}:{data.get('timestamp')}:{total}")
                for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
                    if key in row: row[key] = max(0, row[key] - number(compat_buckets.get(key)))
                compat_buckets = codex_buckets(usage)
                compat.append(row)
                previous = total
    # A session resumed after an upgrade can have an older compatibility-only
    # prefix. Native thread totals tell us exactly how much preceded the first
    # native call, even if its duplicate compatibility event came first.
    if not records:
        return compat, dict(sid=sid, cwd=cwd, model=model, provider=provider, kind='legacy'), None
    historical = []
    historical = []
    for row in compat:
        if prefix <= 0: break
        kept = dict(row); kept['used'] = min(row['used'], prefix)
        historical.append(kept); prefix -= kept['used']
    if prefix > 0:
        first = records[0]
        historical.append(sample('Codex', sid, first['at'], prefix, cwd, model, provider,
                                 eventId=f'{sid}:historic-prefix', timeBasis='session-last-active'))
    return historical + records, dict(sid=sid, cwd=cwd, model=model, provider=provider, kind='native'), parsed_offset(path)


def read_codex_file(path):
    return read_codex_history(path)[0]


def tail_codex_native(block, state):
    """Continue a native-dialect session from its saved offset state. Compat
    token_count events are ignored: with native records present the compat
    stream only matters before the first record (the historical prefix)."""
    rows = []
    for data in dict_lines(block):
        payload = data.get('payload') or {}
        kind = data.get('type')
        if kind == 'session_meta':
            state['sid'] = payload.get('id', state['sid'])
            state['cwd'] = payload.get('cwd')
            state['provider'] = payload.get('model_provider')
        elif kind == 'turn_context':
            state['model'] = payload.get('model', state['model'])
        elif kind == 'token_usage_record':
            usage = payload.get('usage') or {}
            total = usage.get('total_tokens')
            if total is None: total = number(usage.get('input_tokens')) + number(usage.get('output_tokens'))
            rows.append(sample('Codex', state['sid'], data.get('timestamp'), total, state['cwd'],
                               state['model'], state['provider'],
                               tokens=codex_buckets(usage),
                               eventId=payload.get('response_id') or
                                        f"{state['sid']}:{data.get('timestamp')}:{total}"))
    return rows


def database(path):
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


# Per-source result cache: a full scan walks ~1 GB of JSONL plus several
# hundred MB of SQLite, so unchanged sessions must not be re-parsed on every
# request. Entries are keyed by absolute path and validated by stat
# (mtime+ctime+size); SQLite additionally signs the -wal sibling since
# WAL commits do not touch the main file's mtime.
CACHE_VERSION = 2  # v1 rows predate the token-mix buckets
CACHE_NAME = 'usage-cache.json'


def file_sig(path):
    st = path.stat()
    return [st.st_mtime_ns, st.st_ctime_ns, st.st_size]


def db_sig(path):
    # -shm intentionally excluded: SQLite touches it during read-only
    # transactions too, which would invalidate the cache on every access.
    sig = []
    for suffix in ('', '-wal', '-journal'):
        try:
            sig.append([suffix] + file_sig(Path(f'{path}{suffix}')))
        except OSError:
            pass
    return sig


def load_cache(state):
    try:
        data = json.loads((state / CACHE_NAME).read_text())
        if isinstance(data, dict) and data.get('version') == CACHE_VERSION:
            data.setdefault('files', {})
            data.setdefault('roots', {})
            return data
    except (OSError, ValueError):
        pass
    return {'version': CACHE_VERSION, 'files': {}, 'roots': {}}


def save_cache(state, cache):
    # The cache is a couple dozen MB of JSON; rewriting it takes seconds of
    # disk-bound time, so a scan that only revalidated entries must not
    # touch the file at all. Readers/writers set `_dirty` when they changed
    # an entry.
    if not cache.pop('_dirty', False): return
    try:
        for section in ('files', 'roots'):
            cache[section] = {k: v for k, v in cache[section].items()
                              if Path(v.get('path', '')).exists()}
        state.mkdir(parents=True, exist_ok=True)
        tmp = state / (CACHE_NAME + '.tmp')
        tmp.write_text(json.dumps(cache, separators=(',', ':')))
        tmp.replace(state / CACHE_NAME)
    except (OSError, ValueError):
        pass  # Best effort: a read-only state dir must not break reporting.


def cached_file(cache, section, key, path, sig, parse):
    entry = cache[section].get(key)
    if entry and entry.get('sig') == sig:
        return entry['rows']
    rows = parse()
    cache[section][key] = {'sig': sig, 'rows': rows, 'path': str(path)}
    cache['_dirty'] = True
    return rows


def cached_jsonl(cache, key, path, sig, full, tail):
    """JSONL history cache: rows survive across scans and only appended
    bytes are decoded. A full parse seeds `off` (end of the last complete
    line) and the parser `state`; strict growth either tail-parses under
    the saved state or falls back to a full parse (new cache entries, a
    shrunk or rewritten file, or a tail step that rejects the state)."""
    entry = cache['files'].get(key)
    if entry and entry.get('sig') == sig:
        return entry['rows']
    rows, state, off = None, None, None
    if (entry and entry.get('off') is not None and isinstance(entry.get('state'), dict)
            and isinstance(sig, list) and sig[2] > entry['off']):
        try:
            block, off = tail_block(path, entry['off'])
            added, state = tail(block, entry['state'])
            rows = entry['rows'] + added
        except (OSError, ValueError, TypeError, KeyError):
            rows = None
    if rows is None:
        rows, state, off = full(path)
    cache['files'][key] = {'sig': sig, 'rows': rows, 'path': str(path),
                           'off': off, 'state': state}
    cache['_dirty'] = True
    return rows


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
                               tokens=dict(input=r.get('input_tokens'), output=r.get('output_tokens'),
                                           cacheRead=r.get('cache_read_tokens'),
                                           cacheWrite=r.get('cache_write_tokens')),
                               timeBasis='session-last-active'))
        for sid, s in sessions.items():
            if sid in covered: continue
            total = sum(number(s.get(k)) for k in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'))
            cost = s.get('actual_cost_usd') if s.get('cost_status') == 'actual' else None
            if s.get('cost_status') == 'included': cost = 0
            rows.append(sample('Hermes Agent', sid, s.get('last_activity_at') or s.get('ended_at') or s['started_at'],
                               total, s.get('cwd'), s.get('model'), s.get('billing_provider'), cost,
                               tokens=dict(input=s.get('input_tokens'), output=s.get('output_tokens'),
                                           cacheRead=s.get('cache_read_tokens'),
                                           cacheWrite=s.get('cache_write_tokens')),
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
                               total, record['directory'], info.get('modelID'), info.get('providerID'), info.get('cost'),
                               # OpenCode counts reasoning separately from output;
                               # providers bill it as output, so fold it in.
                               tokens=dict(input=tokens.get('input'),
                                           output=number(tokens.get('output')) + number(tokens.get('reasoning')),
                                           cacheRead=cache.get('read'), cacheWrite=cache.get('write'))))
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
                buckets = dict(input=m.get('input_tokens'), output=m.get('output_tokens'),
                               cacheRead=m.get('cache_read_tokens'), cacheWrite=m.get('cache_creation_tokens'))
            else:
                total = number(m.get('prompt_tokens')) + number(m.get('completion_tokens'))
                buckets = dict(input=m.get('prompt_tokens'), output=m.get('completion_tokens'))
            rows.append(sample('Devin', r['session_id'], r['created_at'], total,
                               r['working_directory'], r['generation_model'] or r['model'],
                               tokens=buckets))
        return rows
    finally: conn.close()


def read_porch_root(root, meta):
    """Parse one run's raw journals -> (rows, snapshots, unreadable count).

    Codex snapshots stay unfiltered and cumulative: which threads overlap
    native history is only known after every native source was read, so the
    dedup happens at merge time in read_porch_usage. That split is also what
    makes a finished run's rows safely cacheable.
    """
    rows, snapshots, unreadable = [], [], 0
    cwd, model, sid = meta.get('cwd'), meta.get('model'), root.name
    at = meta.get('finished_at') or meta.get('started_at')
    for path in sorted((root / 'raw').glob('*.jsonl')):
        try:
            lines = iter(json_lines(path))
            for data in lines:
                method, kind = data.get('method'), data.get('type')
                params = data.get('params') or {}
                if method == 'thread/started':
                    thread = params.get('thread') or {}
                    sid, model = thread.get('id', sid), thread.get('model', model)
                if kind == 'thread.started': sid = data.get('thread_id', sid)
                if method == 'thread/tokenUsage/updated':
                    thread = params.get('threadId') or sid
                    usage = (params.get('tokenUsage') or {}).get('total') or {}
                    total = usage.get('totalTokens')
                    if total is None: total = number(usage.get('inputTokens')) + number(usage.get('outputTokens'))
                    snapshots.append(sample('Codex', thread, data.get('emittedAtMs') or at, total, cwd, model,
                                            tokens=codex_buckets(usage)))
                if kind == 'turn.completed' and data.get('usage'):
                    usage = data['usage']
                    total = usage.get('total_tokens')
                    if total is None: total = number(usage.get('input_tokens')) + number(usage.get('output_tokens'))
                    snapshots.append(sample('Codex', sid, data.get('timestamp') or data.get('emittedAtMs') or at,
                                            total, cwd, model, tokens=codex_buckets(usage)))
                if kind == 'message_end':
                    msg = data.get('message') or {}; usage = msg.get('usage') or {}
                    if msg.get('role') != 'assistant' or not usage: continue
                    total = usage.get('totalTokens')
                    if total is None: total = sum(number(usage.get(k)) for k in ('input', 'output', 'cacheRead', 'cacheWrite'))
                    rows.append(sample('Pi', root.name, msg.get('timestamp') or data.get('emittedAtMs') or at,
                                       total, cwd, msg.get('model'), msg.get('provider'),
                                       (usage.get('cost') or {}).get('total'),
                                       tokens=pi_buckets(usage),
                                       eventId=pi_event_id(msg, f'{root.name}:{len(rows)}')))
        except (OSError, ValueError, TypeError):
            unreadable += 1
    return rows, snapshots, unreadable


def porch_root_sig(root, meta):
    try:
        sig = [['meta'] + file_sig(root / 'meta.json')]
    except OSError:
        sig = []
    for path in sorted((root / 'raw').glob('*.jsonl')):
        try:
            sig.append([path.name] + file_sig(path))
        except OSError:
            continue
    # Registry/launch metadata merged into `meta` lives outside the root and
    # can change defaults (cwd/model) without touching any journal.
    sig.append(['merged-meta', hashlib.sha256(
        json.dumps(meta, sort_keys=True, default=str).encode()).hexdigest()])
    return sig


def read_porch_usage(roots, native_codex_sessions, *, metadata=None, errors=None, cache=None):
    """Porch's ephemeral calls may exist only in its raw event journals.

    Persistent Codex threads are already covered by their native history.
    Pi events use provider response IDs shared with the native JSONL file.
    """
    metadata = metadata or {}
    rows, snapshots = [], []
    for root in roots:
        try: meta = json.loads((root / 'meta.json').read_text())
        except (OSError, ValueError): meta = {}
        meta = {**metadata.get(root, {}), **meta}
        prows = psnaps = None
        unreadable = 0
        if cache is not None:
            sig = porch_root_sig(root, meta)
            entry = cache['roots'].get(str(root))
            if entry and entry.get('sig') == sig:
                prows, psnaps, unreadable = entry['rows'], entry['snapshots'], entry.get('unreadable', 0)
        if prows is None:
            prows, psnaps, unreadable = read_porch_root(root, meta)
            if cache is not None and not unreadable:
                cache['roots'][str(root)] = {'sig': sig, 'rows': prows,
                                             'snapshots': psnaps, 'unreadable': 0,
                                             'path': str(root)}
                cache['_dirty'] = True
        if errors is not None: errors.extend(['unreadable-journal'] * unreadable)
        rows.extend(prows)
        snapshots.extend(psnaps)
    seen, unique_rows = set(), []
    for row in rows:
        event = row.get('eventId')
        if event and event in seen: continue
        if event: seen.add(event)
        unique_rows.append(row)
    rows = unique_rows
    previous = {}
    for row in sorted(snapshots, key=lambda r: r['at']):
        if row['sessionId'] in native_codex_sessions: continue
        before = previous.get(row['sessionId'], {})
        total = row['used']; base = before.get('used', 0)
        if total <= base: continue
        # Cumulative baseline tracks every bucket, not just the total.
        previous[row['sessionId']] = {k: row.get(k, 0)
                                      for k in ('used', 'input', 'output', 'cacheRead', 'cacheWrite')}
        # Copy before deriving the delta: cache-held snapshots must stay
        # cumulative, otherwise a cache hit would subtract the delta twice.
        row = dict(row)
        row['used'] = total - base
        for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
            if key in row: row[key] = max(0, row[key] - number(before.get(key)))
        row['eventId'] = f"porch-codex:{row['sessionId']}:{total}"
        rows.append(row)
    return rows


def porch_roots(home, state, output):
    roots = {p.parent for p in output.glob('*/meta.json')}
    metadata = {}
    registries = [Path(os.environ.get('PORCH_STEER_DIR') or home / '.cache/pragmatic-orchestration/steer'),
                  state / 'execution/steer']
    for registry in registries:
        for path in (registry / 'runs').glob('*/meta.json'):
            try:
                meta = json.loads(path.read_text())
                location = meta.get('artifacts_dir')
                if location:
                    root = Path(location)
                    roots.add(root); metadata[root] = meta
            except (OSError, ValueError, TypeError): continue
    for path in (state / 'execution/attempts').glob('*/launch.json'):
        try:
            meta = json.loads(path.read_text())
            root = Path(meta.get('artifactsDir') or path.parent / 'artifacts')
            roots.add(root); metadata[root] = meta
        except (OSError, ValueError, TypeError): continue
    return sorted(roots), metadata


def collect(home, *, porch_output=None):
    home = Path(home)
    state = Path(os.environ.get('STATE_DIR') or home / '.hermes/acp-ui-state')
    cache = load_cache(state)
    rows, sources = [], []
    readers = [('Hermes Agent', home / '.hermes/state.db', read_hermes),
               ('OpenCode', home / '.local/share/opencode/opencode.db', read_opencode),
               ('Devin', home / '.local/share/devin/cli/sessions.db', read_devin)]
    for agent, path, reader in readers:
        try:
            if not path.is_file(): raise FileNotFoundError()
            found = cached_file(cache, 'files', f'{agent}:{path}', path,
                                db_sig(path), lambda p=path: reader(p))
            rows.extend(found)
            sources.append(dict(agentName=agent, status='ready', samples=len(found)))
        except (OSError, sqlite3.Error, ValueError, KeyError):
            sources.append(dict(agentName=agent, status='unavailable', samples=0))
    save_cache(state, cache)  # Persist progress: a killed scan resumes cheaper.
    for agent, directory, full, tail in [('Pi', home / '.pi/agent/sessions', full_pi, tail_pi),
                                          ('Codex', home / '.codex/sessions', read_codex_history, tail_codex_native)]:
        found, errors = [], 0
        files = sorted(directory.rglob('*.jsonl')) if directory.is_dir() else []
        if agent == 'Codex': files.extend((home / '.codex/archived_sessions').rglob('*.jsonl'))
        if agent == 'Pi':
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
            try:
                found.extend(cached_jsonl(cache, f'{agent}:{path}', path,
                                          file_sig(path), full, tail))
            except (OSError, ValueError, TypeError): errors += 1
        rows.extend(found)
        sources.append(dict(agentName=agent, status='partial' if errors else 'ready' if directory.is_dir() or files else 'unavailable', samples=len(found)))
    save_cache(state, cache)
    output = Path(porch_output or os.environ.get('ACP_PORCH_OUTPUT_DIR') or '/tmp/pragmatic-orchestration-outputs')
    roots, metadata = porch_roots(home, state, output)
    native_codex_sessions = {r['sessionId'] for r in rows if r['agentName'] == 'Codex'}
    porch_errors = []
    porch_rows = read_porch_usage(roots, native_codex_sessions, metadata=metadata,
                                  errors=porch_errors, cache=cache)
    rows.extend(porch_rows)
    save_cache(state, cache)
    for source in sources:
        if source['status'] == 'unavailable' and any(r['agentName'] == source['agentName'] for r in porch_rows):
            source['status'] = 'partial'
    porch = dict(status='partial' if porch_errors else 'ready' if output.is_dir() or any(p.is_dir() for p in roots) else 'unavailable',
                 rawFiles=sum(len(list((root / 'raw').glob('*.jsonl'))) for root in roots))
    unique, seen = [], set()
    for r in rows:
        if r['at'] <= 0 or (r['used'] <= 0 and r.get('cost', 0) <= 0): continue
        # Copy before stripping eventId: cached entries must keep it.
        row = dict(r)
        event = row.pop('eventId', None)
        key = (row['agentName'], event)
        if event and key in seen: continue
        if event: seen.add(key)
        unique.append(row)
    rows = unique
    return dict(usage=rows, sources=sources, porch=porch, updatedAt=int(dt.datetime.now().timestamp() * 1000))


if __name__ == '__main__':
    print(json.dumps(collect(os.environ.get('ACP_USAGE_HOME') or os.environ.get('HOME') or str(Path.home())), allow_nan=False, separators=(',', ':')))
