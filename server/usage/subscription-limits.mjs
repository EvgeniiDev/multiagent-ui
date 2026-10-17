import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Account metadata only: never start a thread or make an inference request.
export function readCodexLimits({ spawnProcess = spawn, timeoutMs = 20000, env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env, cwd });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      const complete = () => error ? reject(error) : resolve(data);
      if (child.pid && child.exitCode === null) child.once('close', complete);
      else complete();
      child.kill();
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      killTimer.unref();
    }
    function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
    child.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('unavailable')));
    child.stdin.on('error', error => finish(error));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) { finish(new Error('account_unavailable')); return; }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else finish(null, message.result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'acp-ui-limits', version: '1.0.0' } } });
  });
}

// The state service mounts the real Codex home read-only. Use a private,
// disposable CLI home so an account read cannot change its SQLite/auth files
// or scan the user's sessions. Auth never crosses the HTTP API boundary.
async function readCodexSubscription() {
  const directory = await mkdtemp(join(tmpdir(), 'acp-ui-limits-'));
  try {
    const source = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    await copyFile(source, join(directory, 'auth.json'));
    await chmod(join(directory, 'auth.json'), 0o600);
    return await readCodexLimits({ env: { ...process.env, CODEX_HOME: directory }, cwd: directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function windowData(id, label, usedPercent, resetsAt) {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return null;
  const reset = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt);
  return { id, label, usedPercent: Math.min(100, usedPercent), resetsAt: Number.isFinite(reset) ? reset : null };
}

export function normalizeCodex(data) {
  const buckets = data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
    ? Object.entries(data.rateLimitsByLimitId) : [['codex', data?.rateLimits]];
  const windows = buckets.flatMap(([bucket, value]) => ['primary', 'secondary'].flatMap(key => {
    const w = value?.[key];
    if (!w) return [];
    const mins = w.windowDurationMins;
    const duration = mins === 10080 ? 'Weekly' : typeof mins === 'number' && mins > 0
      ? mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute` : 'Usage window';
    const label = buckets.length > 1 ? `${value.limitName || bucket} · ${duration}` : duration;
    const normalized = windowData(`${bucket}-${key}`, label, w.usedPercent, w.resetsAt);
    return normalized ? [normalized] : [];
  }));
  return { id: 'codex', name: 'Codex', status: windows.length ? 'ready' : 'unavailable',
    message: windows.length ? null : 'The account did not report subscription limits.', windows };
}

export function normalizeOpenCode(data) {
  const windows = Object.entries({ rolling: '5-hour', weekly: 'Weekly', monthly: 'Monthly' }).flatMap(([key, label]) => {
    const w = data?.usage?.[key];
    const normalized = w && windowData(key, label, w.percent, w.resetsAt);
    return normalized ? [normalized] : [];
  });
  return { id: 'opencode', name: 'OpenCode Go', status: windows.length ? 'ready' : 'unavailable',
    message: windows.length ? null : 'The account did not report subscription limits.', windows };
}

export function createSubscriptionReader({ codexReader = readCodexSubscription, read = readFile, fetcher = fetch,
  home = homedir(), ttlMs = 60000, now = Date.now } = {}) {
  let cache;
  let pending;
  async function codex() {
    try { return normalizeCodex(await codexReader()); }
    catch { return { id: 'codex', name: 'Codex', status: 'unavailable', windows: [],
      message: 'Could not read Codex limits. Check the CLI sign-in and try again.' }; }
  }
  async function opencode() {
    let auth;
    try { auth = JSON.parse(await read(join(home, '.local/share/opencode/auth.json'), 'utf8')); }
    catch { /* no readable credentials */ }
    const key = auth?.['opencode-go']?.key;
    if (typeof key !== 'string' || !key) return { id: 'opencode', name: 'OpenCode Go', status: 'not_connected',
      windows: [], message: 'Connect an OpenCode Go subscription to see its limits.' };
    try {
      const response = await fetcher('https://opencode.ai/zen/go/v1/usage', {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) return { id: 'opencode', name: 'OpenCode Go', status: 'unavailable', windows: [],
        message: response.status === 403 ? 'OpenCode requires an active Go subscription for this key.'
          : response.status === 401 ? 'OpenCode sign-in has expired. Reconnect the account.' : `OpenCode limits are unavailable (HTTP ${response.status}).` };
      return normalizeOpenCode(await response.json());
    } catch { return { id: 'opencode', name: 'OpenCode Go', status: 'unavailable', windows: [],
      message: 'Could not read OpenCode limits. Try again shortly.' }; }
  }
  return async function subscriptionLimits() {
    if (cache && now() - cache.updatedAt < ttlMs) return cache;
    if (!pending) pending = Promise.all([codex(), opencode()]).then(providers => {
      cache = { updatedAt: now(), providers: [...providers, { id: 'claude', name: 'Claude',
        status: 'not_connected', message: 'Claude is not connected yet.', windows: [] }] };
      return cache;
    }).finally(() => { pending = null; });
    return pending;
  };
}

export const subscriptionLimits = createSubscriptionReader();
