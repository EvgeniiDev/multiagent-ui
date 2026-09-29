// State-server porch client — the Workflow view's only data source.
//
// The browser cannot read ~/.cache/pragmatic-orchestration/steer; the state
// server (server/acp-state-server.mjs) bridges it read-only:
//   GET /api/porch/runs      → { runs: PorchRunSummary[] } (startedAt desc)
//   GET /api/porch/runs/:id  → { meta, state, audit, final }
// `porchBase()` replicates storage.ts's stateServerBase() convention:
// VITE_STATE_URL wins (inside the function — the node test runner imports
// this module), else http://<location.hostname>:25900 passed through
// toSecureUrl() so an https page lands on the TLS twin :25910.
//
// Erasable TS only; nothing reads import.meta.env or location at module
// top level — scripts/test_workflow_porch.mjs imports the lib directly.

import { toSecureUrl } from '../host/secure.ts';
import type { PorchAudit, PorchRunDetail, PorchRunSummary } from './types.ts';

const STATE_SERVER_PORT = 25900;
const HEALTH_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 5000;

export function porchBase(): string {
  const env = import.meta.env?.VITE_STATE_URL as string | undefined;
  if (env) return env.replace(/\/+$/, '');
  const hostname =
    (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
  return toSecureUrl(`http://${hostname}:${STATE_SERVER_PORT}`);
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Session-scoped like storage.ts's probe — concurrent callers share one
// in-flight probe and a `true` verdict is cached for the page's life. A
// `false` verdict is NOT cached: the next call re-probes, so a state
// server that comes up after first mount heals the view on its own
// instead of pinning it at "unreachable" until reload.
let healthProbe: Promise<boolean> | null = null;

export async function probePorch(): Promise<boolean> {
  if (!healthProbe) {
    healthProbe = (async () => {
      try {
        const res = await fetchWithTimeout(`${porchBase()}/health`, HEALTH_TIMEOUT_MS);
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return body?.ok === true;
      } catch {
        return false;
      }
    })();
  }
  const probe = healthProbe;
  if (await probe) return true;
  // Clear only if nobody started a newer probe while we awaited.
  if (healthProbe === probe) healthProbe = null;
  return false;
}

export async function listRuns(): Promise<PorchRunSummary[]> {
  const res = await fetchWithTimeout(`${porchBase()}/api/porch/runs`, REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new Error(`porch runs: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    runs?: PorchRunSummary[];
  } | null;
  return Array.isArray(body?.runs) ? body.runs : [];
}

/** One run's raw payload; null on 404 (the run vanished or never existed). */
export async function getRun(runId: string): Promise<PorchRunDetail | null> {
  const res = await fetchWithTimeout(
    `${porchBase()}/api/porch/runs/${encodeURIComponent(runId)}`,
    REQUEST_TIMEOUT_MS,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`porch run ${runId}: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    meta?: PorchRunDetail['meta'];
    state?: Record<string, unknown> | null;
    audit?: PorchAudit | null;
    final?: string | null;
  } | null;
  if (body === null || body.meta === undefined) return null;
  return {
    meta: body.meta,
    state: body.state ?? null,
    audit: body.audit ?? null,
    final: body.final ?? null,
  };
}
