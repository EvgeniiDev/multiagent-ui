// Read protocol lifecycle events, never transcript text or a missing UI reply.
import { readdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TAIL_BYTES = 1024 * 1024;
export function parseCodexTurnStatus(text) {
  let result, activeTurn;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'event_msg') continue;
    const at = Date.parse(row.timestamp), event = row.payload;
    if (!Number.isFinite(at) || at <= 0) continue;
    const kinds = { task_started: 'working', task_complete: 'completed', turn_aborted: 'cancelled' };
    if (!event || !Object.hasOwn(kinds, event.type)) continue;
    if (event.type === 'task_started') activeTurn = event.turn_id;
    else if (activeTurn && event.turn_id && activeTurn !== event.turn_id) continue;
    result = { status: kinds[event.type], at };
  }
  return result;
}

export function createNativeCodexStatusReader({ root = join(homedir(), '.codex', 'sessions'), indexMs = 15000 } = {}) {
  let files = new Map(), indexedAt = 0, indexing;
  const cache = new Map();
  async function inventory() {
    if (indexedAt && Date.now() - indexedAt < indexMs) return;
    if (indexing) return indexing;
    indexing = (async () => {
      const next = new Map();
      async function walk(dir, depth) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) await walk(join(dir, entry.name), depth + 1);
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const id = entry.name.slice(-42, -6);
          if (UUID.test(id)) next.set(id, join(dir, entry.name));
        }
      }
      await walk(root, 0);
      files = next; indexedAt = Date.now();
    })().finally(() => { indexing = null; });
    return indexing;
  }
  async function read(file) {
    const resolved = await realpath(file), rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (cache.get(file)?.signature === signature) return cache.get(file).result;
      const start = Math.max(0, stat.size - TAIL_BYTES), buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const result = parseCodexTurnStatus(text);
      cache.set(file, { signature, result });
      return result;
    } finally { await handle.close(); }
  }
  return async sessions => {
    await inventory();
    const statuses = {};
    for (const session of sessions) {
      if (session.agentName?.toLowerCase() !== 'codex' || !UUID.test(session.sessionId)) continue;
      const file = files.get(session.sessionId);
      if (!file) continue;
      try {
        const result = await read(file);
        if (result) statuses[JSON.stringify([session.agentName, session.sessionId])] = result;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { statuses };
  };
}

const BRIDGES = { 'Hermes Agent': 25901, OpenCode: 25902, Devin: 25903, Pi: 25904, Codex: 25907 };
export function createChatSessionStatusReader({ bridges = BRIDGES, fetcher = fetch, ...nativeOptions } = {}) {
  const native = createNativeCodexStatusReader(nativeOptions);
  return async sessions => {
    const wanted = new Set(sessions.map(s => JSON.stringify([s.agentName, s.sessionId])));
    const providers = new Set(sessions.map(s => s.agentName));
    const [historical, ...live] = await Promise.all([
      native(sessions),
      ...Object.entries(bridges).filter(([agent]) => providers.has(agent)).map(async ([agent, port]) => {
        try {
          const response = await fetcher(`http://127.0.0.1:${port}/api/sessions/status`, { signal: AbortSignal.timeout(2000) });
          if (!response.ok) return {};
          const { statuses } = await response.json(), result = {};
          for (const [sid, row] of Object.entries(statuses ?? {})) {
            const key = JSON.stringify([agent, sid]);
            if (wanted.has(key) && row && [null, 'working', 'completed', 'cancelled', 'error'].includes(row.status) && Number.isFinite(row.at)) result[key] = row;
          }
          return result;
        } catch { return {}; } // An unavailable bridge never implies Working.
      }),
    ]);
    // Old native starts cannot establish that a process is still alive.
    // Only the live bridge may report Working; history can recover results.
    const activity = Object.fromEntries(Object.entries(historical.statuses).map(([key, row]) => [key, { at: row.at }]));
    const statuses = Object.fromEntries(Object.entries(historical.statuses).filter(([, row]) => row.status !== 'working'));
    for (const snapshot of live) for (const [key, row] of Object.entries(snapshot)) {
      if (!statuses[key] || row.at >= statuses[key].at) statuses[key] = row;
      if (!activity[key] || row.at >= activity[key].at) activity[key] = { at: row.at };
    }
    return { statuses, activity };
  };
}
