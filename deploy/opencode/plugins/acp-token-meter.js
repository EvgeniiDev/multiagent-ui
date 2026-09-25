// acp-token-meter — report OpenCode's exact token usage to the ACP panel's
// shared ledger (the state server behind http://<host>:25900).
//
// Why: the panel's dashboard sums `usage_update` ACP notifications, and
// OpenCode does not emit them. It does, however, keep exact per-message token
// counts in the session store — every AssistantMessage carries
// `tokens: {input, output, reasoning, cache: {read, write}}` and `cost`.
// This plugin hooks `session.idle` (fired when a turn finishes) and appends a
// `{source: "agent"}` sample to `usage[]` in activity.json: exact numbers,
// indistinguishable in the ledger from a real usage_update.
//
// `used` is the session's cumulative processed tokens — the sum over all
// assistant messages of input+output+reasoning+cache.read+cache.write (the
// ledger treats `used` as a running total and takes deltas between samples;
// a monotone sum survives compaction, where a context-fill figure would
// shrink). `size` is the model's context limit when resolvable, else 0.
// `cost` sums opencode's USD cost per message.
//
// Dedup: a session re-reporting identical used+cost is skipped, both locally
// and against the doc's last sample for that session.
//
// Install: ~/.config/opencode/plugins/acp-token-meter.js (global plugins dir —
// opencode auto-loads every file there at startup).
// Env: ACP_STATE_URL overrides the ledger base URL (tests point it at a
// throwaway state server).

const STATE_URL = (process.env.ACP_STATE_URL || 'http://127.0.0.1:25900').replace(/\/+$/, '');
const DOC = 'activity.json';
const MAX_USAGE = 5000;
const RETRIES = 6;
const RETRY_DELAY_MS = 300;

async function appendUsage(sample) {
  for (let i = 0; i < RETRIES; i++) {
    const got = await fetch(`${STATE_URL}/api/state/${DOC}`).catch(() => null);
    if (!got) return false;
    let doc = { entries: [], usage: [] };
    let rev = 0;
    if (got.status === 200) {
      const body = await got.json().catch(() => null);
      if (body && typeof body === 'object') {
        if (body.data && typeof body.data === 'object') doc = body.data;
        rev = Number(body.rev) || 0;
      }
    } else if (got.status !== 404) {
      return false;
    }
    if (!Array.isArray(doc.usage)) doc.usage = [];
    const last = [...doc.usage]
      .reverse()
      .find((u) => u && u.sessionId === sample.sessionId && (u.source ?? 'agent') === 'agent');
    if (last && last.used === sample.used && (last.cost ?? 0) === (sample.cost ?? 0)) {
      return true; // already recorded
    }
    doc.usage = [...doc.usage.slice(-(MAX_USAGE - 1)), sample];
    const put = await fetch(`${STATE_URL}/api/state/${DOC}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: doc, rev }),
    }).catch(() => null);
    if (!put) return false;
    if (put.status === 200) return true;
    if (put.status === 409) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    return false;
  }
  return false;
}

export const AcpTokenMeter = async ({ client }) => {
  // sessionID -> last sample we wrote — a session that goes idle twice with
  // nothing new between does not write twice.
  const lastReported = new Map();
  let providers = null; // lazily fetched once for model context limits

  async function contextLimit(providerID, modelID) {
    try {
      if (!providers) providers = await client.provider.list();
      const all = providers?.data?.all ?? providers?.all ?? [];
      const provider = all.find((p) => p && p.id === providerID);
      const model = provider?.models?.[modelID];
      return Number(model?.limit?.context) || 0;
    } catch {
      return 0;
    }
  }

  async function report(sessionID) {
    const res = await client.session.messages({ path: { id: sessionID } });
    const msgs = res?.data ?? res;
    if (!Array.isArray(msgs)) return;

    let used = 0;
    let cost = 0;
    let providerID;
    let modelID;
    for (const m of msgs) {
      const info = m?.info ?? m;
      if (!info || info.role !== 'assistant') continue;
      const t = info.tokens || {};
      const cache = t.cache || {};
      used +=
        (Number(t.input) || 0) +
        (Number(t.output) || 0) +
        (Number(t.reasoning) || 0) +
        (Number(cache.read) || 0) +
        (Number(cache.write) || 0);
      if (typeof info.cost === 'number') cost += info.cost;
      providerID = info.providerID;
      modelID = info.modelID;
    }
    if (used <= 0) return;

    const prev = lastReported.get(sessionID);
    // Compaction drops older messages — the running total must not shrink.
    if (prev && used < prev.used) used = prev.used;
    if (prev && prev.used === used && prev.cost === cost) return;

    let cwd;
    try {
      const s = await client.session.get({ path: { id: sessionID } });
      cwd = s?.data?.directory ?? s?.directory;
    } catch {
      /* cwd is informational */
    }
    const size = await contextLimit(providerID, modelID);

    const wrote = await appendUsage({
      at: Date.now(),
      agentName: 'OpenCode',
      sessionId: sessionID,
      cwd,
      used,
      size,
      cost,
      currency: 'USD',
      source: 'agent',
    });
    if (wrote) lastReported.set(sessionID, { used, cost });
  }

  return {
    event: async ({ event }) => {
      try {
        if (event?.type === 'session.idle' && event.properties?.sessionID) {
          await report(event.properties.sessionID);
        }
      } catch (e) {
        // A metering failure must never surface as a plugin crash inside
        // opencode — log through the SDK and move on.
        try {
          await client.app.log({
            body: { service: 'acp-token-meter', level: 'warn', message: String(e) },
          });
        } catch {
          /* no client, no log */
        }
      }
    },
  };
};
