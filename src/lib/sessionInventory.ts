import type { SavedSession } from './types';

type Doc = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rows = (value: unknown): Doc[] => Array.isArray(value) ? value : [];
const key = (s: Doc) => JSON.stringify([s.agentName, s.sessionId]);

/** Apply this device's changes to the latest inventory, preserving sessions
 * and metadata changed on other devices. Absence alone is not a deletion:
 * only removing a row present in our acknowledged baseline deletes it. */
export function mergeSessionInventory(base: Doc, local: Doc, remote: Doc): Doc {
  const result = { ...remote };
  for (const field of Object.keys(local)) {
    if (field !== 'sessions' && !same(local[field], base[field])) result[field] = local[field];
  }
  const before = new Map(rows(base.sessions).map(s => [key(s), s]));
  const after = new Map(rows(local.sessions).map(s => [key(s), s]));
  const merged = new Map(rows(remote.sessions).map(s => [key(s), s]));
  for (const id of before.keys()) if (!after.has(id)) merged.delete(id);
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (same(previous, row)) continue;
    const next = { ...merged.get(id) };
    for (const field of new Set([...Object.keys(previous ?? {}), ...Object.keys(row)])) {
      if (same(previous?.[field], row[field])) continue;
      if (field in row) next[field] = row[field]; else delete next[field];
    }
    merged.set(id, next);
  }
  result.sessions = [...merged.values()];
  return result;
}

/** Reuse rows held by live runtimes when a newer server directory arrives. */
export function adoptSessionInventory(current: SavedSession[], incoming: SavedSession[]): SavedSession[] {
  const known = new Map(current.map(row => [key(row as unknown as Doc), row]));
  return incoming.map(row => {
    const existing = known.get(key(row as unknown as Doc));
    if (!existing) return row;
    const lastMessageAt = Math.max(existing.lastMessageAt ?? 0, row.lastMessageAt ?? 0);
    for (const field of Object.keys(existing) as (keyof SavedSession)[]) {
      if (!(field in row)) delete existing[field];
    }
    Object.assign(existing, row);
    if (lastMessageAt) existing.lastMessageAt = lastMessageAt;
    return existing;
  });
}

/** File/metadata writes are not conversation activity. */
export function sessionActivityTime(session: SavedSession, remote?: { at: number }): number {
  return Math.max(session.lastMessageAt ?? 0, remote?.at ?? session.lastMessageAt ?? session.lastUpdated);
}
