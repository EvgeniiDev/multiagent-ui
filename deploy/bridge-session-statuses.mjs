// Lifecycle belongs to the bridge, independent of the socket that sent a turn.
export class BridgeSessionStatuses {
  constructor({ load = async () => ({}), save = async () => true, now = Date.now, commandSteering = false } = {}) {
    this.load = load; this.save = save; this.now = now; this.commandSteering = commandSteering;
    this.sessions = new Map(); this.requests = new Map(); this.generations = new Map();
    this.dirty = false; this.writing = null;
  }
  async restore() {
    try {
      const saved = await this.load();
      for (const [sid, row] of Object.entries(saved ?? {})) {
        if (!row || !['completed', 'cancelled', 'error', 'working', null].includes(row.status) || !Number.isFinite(row.at)) continue;
        // A previous process's unanswered prompt cannot prove work is alive.
        this.sessions.set(sid, { status: row.status === 'working' ? null : row.status, at: row.at });
      }
    } catch { /* An unavailable persistence service is not a live turn. */ }
  }
  snapshot() { return Object.fromEntries(this.sessions); }
  get pendingCount() { return this.requests.size; }
  update(sid, status) {
    this.sessions.set(sid, { status, at: Math.max(this.now(), (this.sessions.get(sid)?.at ?? 0) + 1) });
    this.dirty = true; void this.flush();
  }
  outbound(msg) {
    const sid = msg?.params?.sessionId;
    if (typeof sid !== 'string' || !sid) return;
    if (msg.method === 'session/prompt' && msg.id != null) {
      // Hermes /steer returns only an injection ACK, not a finished turn.
      const text = msg.params?.prompt?.find(block => block.type === 'text')?.text;
      if (this.commandSteering && typeof text === 'string' && /^\s*\/steer(?:\s|$)/.test(text)) return;
      const generation = (this.generations.get(sid) ?? 0) + 1;
      this.generations.set(sid, generation);
      this.requests.set(msg.id, { sid, generation });
      this.update(sid, 'working');
    } else if (msg.method === 'session/cancel') {
      this.generations.set(sid, (this.generations.get(sid) ?? 0) + 1);
      this.update(sid, 'cancelled');
    }
  }
  inbound(msg) {
    if (!msg || msg.method || msg.id == null) return;
    const request = this.requests.get(msg.id);
    if (!request) return;
    this.requests.delete(msg.id);
    if (this.generations.get(request.sid) !== request.generation) return true;
    const reason = msg.result?.stopReason;
    this.update(request.sid, msg.error ? 'error' : reason === 'end_turn' ? 'completed' : reason === 'cancelled' ? 'cancelled' : null);
    return true;
  }
  failAll() {
    for (const { sid, generation } of this.requests.values()) {
      if (this.generations.get(sid) === generation) this.update(sid, 'error');
    }
    this.requests.clear();
  }
  async flush() {
    if (this.writing || !this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = this.snapshot();
    this.writing = (async () => {
      try { if (!await this.save(snapshot)) this.dirty = true; }
      catch { this.dirty = true; }
    })().finally(() => { this.writing = null; });
    await this.writing;
    // Changed snapshots trail the in-flight write; an unchanged failure waits
    // for the periodic retry rather than spinning on a failed state service.
    if (this.dirty && JSON.stringify(snapshot) !== JSON.stringify(this.snapshot())) await this.flush();
  }
}

export function bridgeStatusPersistence(base, agent, fetcher = fetch) {
  const url = `${base.replace(/\/+$/, '')}/api/state/bridge-session-statuses.json`;
  const key = sid => JSON.stringify([agent, sid]);
  async function read() {
    const response = await fetcher(url, { signal: AbortSignal.timeout(3000) });
    if (response.status === 404) return { rev: 0, data: {} };
    if (!response.ok) throw new Error('bridge status store unavailable');
    return response.json();
  }
  return {
    async load() {
      const doc = await read(), result = {};
      for (const [encoded, row] of Object.entries(doc.data?.statuses ?? {})) {
        try { const [owner, sid] = JSON.parse(encoded); if (owner === agent && typeof sid === 'string') result[sid] = row; } catch { /* invalid key */ }
      }
      return result;
    },
    async save(snapshot) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const doc = await read(), statuses = { ...doc.data?.statuses };
        for (const [sid, row] of Object.entries(snapshot)) {
          const previous = statuses[key(sid)];
          if (!previous || row.at >= previous.at) statuses[key(sid)] = row;
        }
        const response = await fetcher(url, { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rev: doc.rev, data: { ...doc.data, statuses } }), signal: AbortSignal.timeout(3000) });
        if (response.status === 409) continue;
        return response.ok;
      }
      return false;
    },
  };
}
