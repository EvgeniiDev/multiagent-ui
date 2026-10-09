// One small, non-polling shared tail document per session. localStorage is
// still the immediate path; this copy lets another browser/device open fast.
import { stateServerBase } from './host/storage';
import type { HistoryCacheEntry } from './historyCache';

const revisions = new Map<string, number>();
const queues = new Map<string, Promise<void>>();
const TIMEOUT_MS = 1200;

export function sharedHistoryName(agent: string, sessionId: string): string {
  const text = `${agent}::${sessionId}`;
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 16777619);
  }
  return `history-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}.json`;
}

async function request(name: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${stateServerBase()}/api/state/${name}`, { ...init, signal: ctrl.signal });
    return { status: response.status, ok: response.ok, body: await response.json() };
  } finally { clearTimeout(timer); }
}

export async function readSharedHistoryCache(agent: string, sessionId: string): Promise<HistoryCacheEntry | null> {
  const name = sharedHistoryName(agent, sessionId);
  try {
    const response = await request(name);
    if (response.status === 404) { revisions.set(name, 0); return null; }
    if (!response.ok) { revisions.delete(name); return null; }
    const doc = response.body;
    revisions.set(name, doc.rev);
    const data = doc.data;
    const entry = data?.entry;
    if (data?.agent !== agent || data?.sessionId !== sessionId || entry?.version !== 1 || !Array.isArray(entry.messages)) { revisions.delete(name); return null; }
    return entry;
  } catch { revisions.delete(name); return null; } // optional cache cannot make ACP unavailable
}

export function writeSharedHistoryCache(agent: string, sessionId: string, entry: HistoryCacheEntry): Promise<void> {
  const name = sharedHistoryName(agent, sessionId);
  const job = (queues.get(name) ?? Promise.resolve()).then(async () => {
    try {
      let current = await readSharedHistoryCache(agent, sessionId);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (current && current.savedAt > entry.savedAt) return;
        if (!revisions.has(name)) return; // unavailable read: don't overwrite blindly
        const response = await request(name, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rev: revisions.get(name), data: { agent, sessionId, entry } }),
        });
        if (response.ok) { revisions.set(name, response.body.rev); return; }
        if (response.status !== 409) return;
        current = await readSharedHistoryCache(agent, sessionId);
      }
    } catch { /* best effort; the local cache and ACP remain available */ }
  });
  queues.set(name, job);
  void job.then(() => { if (queues.get(name) === job) queues.delete(name); });
  return job;
}
