// Opt-in Web Push and an ACP relay. A pending prompt belongs to the server
// socket, so a suspended/closed phone cannot lose its completion notification.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const imageRequire = createRequire('/opt/acp-ui/push/package.json');
function dependency(name) {
  try { return localRequire(name); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return imageRequire(name); }
}
const webpush = dependency('web-push');
const WebSocket = dependency('ws');
const { WebSocketServer } = WebSocket;

const BRIDGES = { 'Hermes Agent': 25901, OpenCode: 25902, Devin: 25903, Pi: 25904, Codex: 25907 };
const ok = json => ({ status: 200, json });
const fail = (status, error) => ({ status, json: { error } });
function validSubscription(subscription) {
  try {
    const u = new URL(subscription.endpoint);
    const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
      (allowed.includes(u.hostname) || u.hostname.endsWith('.notify.windows.com')) &&
      /^[\w-]{87,88}$/.test(subscription.keys.p256dh) &&
      /^[\w-]{22,24}$/.test(subscription.keys.auth) && subscription.endpoint.length < 4096;
  } catch { return false; }
}

export async function createPushService({ stateDir, bridgePorts = BRIDGES,
  sendNotification = webpush.sendNotification.bind(webpush) } = {}) {
  // Legacy /api/state/* can read/write flat JSON documents. Keep push keys
  // and relay credentials outside that document namespace.
  const privateDir = join(stateDir, '.push');
  const file = join(privateDir, 'devices.json');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  data ??= { ...webpush.generateVAPIDKeys(), devices: {} };
  let writes = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(data);
    writes = writes.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return writes;
  }
  await persist();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const deviceFor = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) &&
    Object.hasOwn(data.devices, token) ? data.devices[token] : undefined;

  async function notify(token, payload) {
    const device = deviceFor(token);
    if (!device?.subscription) return false;
    try {
      await sendNotification(device.subscription, JSON.stringify(payload), {
        vapidDetails: { subject: 'https://github.com/formulahendry/acp-ui',
          publicKey: data.publicKey, privateKey: data.privateKey },
        TTL: 3600, urgency: 'normal', timeout: 10000,
      });
      return true;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        // Keep the relay credential usable: an expired push subscription must
        // never prevent this device from reconnecting to its chats.
        device.subscription = null;
        await persist();
      }
      // Never log endpoints, tokens or upstream response bodies.
      console.warn('Web Push delivery failed:', error.statusCode || error.code || 'network');
      return false;
    }
  }

  async function request({ method, path, body, token, origin }) {
    if (method === 'GET' && path === '/api/push/config') return ok({ publicKey: data.publicKey });
    if (method === 'POST' && path === '/api/push/subscription') {
      if (!validSubscription(body?.subscription)) return fail(400, 'Invalid push subscription');
      const previous = deviceFor(token);
      if (previous?.origin === origin && JSON.stringify(previous.subscription) === JSON.stringify(body.subscription)) return ok({ token });
      if (Object.keys(data.devices).length >= 100 && !previous) return fail(429, 'Too many devices');
      token = previous ? token : randomBytes(32).toString('hex');
      data.devices[token] = { subscription: body.subscription, origin };
      await persist();
      return ok({ token });
    }
    if (!deviceFor(token)) return fail(401, 'Notifications are not registered on this device');
    if (method === 'DELETE' && path === '/api/push/subscription') {
      delete data.devices[token];
      await persist();
      return ok({ enabled: false });
    }
    if (method === 'POST' && path === '/api/push/test') {
      return await notify(token, { title: 'Multiagent UI', body: 'Notifications are working.', url: '/chat', tag: 'acp-test' })
        ? ok({ sent: true }) : fail(502, 'Push delivery failed. Try enabling notifications again.');
    }
    return fail(404, 'Not found');
  }

  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
      const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
      const token = protocols.find(p => p.startsWith('acp-push.'))?.slice(9);
      const agent = url.searchParams.get('agent');
      const device = deviceFor(token);
      if (url.pathname !== '/api/push/bridge' || !Object.hasOwn(bridgePorts, agent) ||
        !device || req.headers.origin !== device.origin || sockets.size >= 256) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      // Connect before accepting the browser: no initialize frame can be lost
      // between the browser's open event and the upstream handshake.
      if (protocols.length > 16 || new Set(protocols).size !== protocols.length) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
      }
      const entry = { client: null, upstream: null };
      sockets.add(entry);
      let upstream;
      try {
        upstream = entry.upstream = new WebSocket(`ws://127.0.0.1:${bridgePorts[agent]}`,
          protocols.filter(p => !p.startsWith('acp-push.')), { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 });
      } catch {
        sockets.delete(entry);
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
      }
      let upgraded = false;
      socket.once('close', () => { if (!upgraded) upstream.terminate(); });
      upstream.once('close', () => sockets.delete(entry));
      upstream.once('error', () => { sockets.delete(entry); socket.destroy(); });
      upstream.once('open', () => {
        if (socket.destroyed) { upstream.close(); return; }
        wss.handleUpgrade(req, socket, head, client => {
          upgraded = true;
          entry.client = client;
          relay(entry, token, agent);
        });
      });
    });
  }

  function relay(entry, token, agent) {
    const { client, upstream } = entry;
    const pending = new Map();
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { client.terminate(); return; }
      if (client.readyState === WebSocket.OPEN) { alive = false; client.ping(); }
    }, 25000);
    heartbeat.unref();
    // Bound abandoned turns, without imposing a normal RPC deadline.
    let deadline;
    const cleanup = () => { clearInterval(heartbeat); clearTimeout(deadline); sockets.delete(entry); };
    client.on('pong', () => { alive = true; });
    client.on('error', () => {});
    upstream.on('error', () => { client.close(1011, 'Agent connection failed'); cleanup(); });
    client.on('close', () => {
      clearInterval(heartbeat);
      if (!pending.size) upstream.close();
      else {
        deadline = setTimeout(() => upstream.close(), 24 * 60 * 60 * 1000);
        deadline.unref();
      }
    });
    upstream.on('close', (code, reason) => {
      const sendable = code >= 3000 || [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code);
      client.close(sendable ? code : 1011, reason);
      cleanup();
    });
    client.on('message', (bytes, binary) => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      if (!binary) for (const line of String(bytes).split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'session/prompt' && msg.id != null && typeof msg.params?.sessionId === 'string') {
            pending.set(msg.id, msg.params.sessionId);
          }
        } catch { /* Forward unchanged; bridge owns protocol validation. */ }
      }
      upstream.send(bytes, { binary });
    });
    upstream.on('message', (bytes, binary) => {
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > 8 * 1024 * 1024) client.terminate();
        else client.send(bytes, { binary });
      }
      if (!binary) for (const line of String(bytes).split('\n')) {
        try {
          const msg = JSON.parse(line);
          // Only responses to prompts from this socket, never replayed updates
          // or agent-originated permission requests sharing the same id.
          if (msg.method || !pending.has(msg.id)) continue;
          const sessionId = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.result?.stopReason !== 'cancelled') {
            void notify(token, { title: `${agent}: ${msg.error ? 'response failed' : 'response ready'}`,
              body: msg.error ? 'Open the chat to view the error.' : 'The agent has finished. Open the chat to continue.',
              url: `/chat?s=${encodeURIComponent(`${agent}::${sessionId}`)}`,
              tag: `acp-${agent}-${sessionId}` }).catch(() => {});
          }
          if (client.readyState !== WebSocket.OPEN && !pending.size) upstream.close();
        } catch { /* Non-JSON frames do not create notifications. */ }
      }
    });
  }
  return { request, attach, close() {
    for (const { client, upstream } of sockets) { client?.terminate(); upstream?.terminate(); }
    wss.close();
  } };
}
