import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createPushService } from '../server/push/service.mjs';
import { createRequestHandler } from '../server/acp-state-server.mjs';
import { createStateService } from '../server/execution/state-service.mjs';
import WebSocket, { WebSocketServer } from '../server/push/node_modules/ws/wrapper.mjs';

const dir = await mkdtemp(join(tmpdir(), 'acp-push-'));
const bridge = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(bridge, 'listening');
const notifications = [];
let deliveryStatus = 0;
const push = await createPushService({ stateDir: dir,
  bridgePorts: { Test: bridge.address().port },
  sendNotification: async (...args) => { if (deliveryStatus) throw { statusCode: deliveryStatus }; notifications.push(args); },
});
const server = createServer(createRequestHandler({ request: async () => ({ status: 404, json: {} }) }, { pushService: push }));
push.attach(server);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: {
  p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22),
} };
async function request(method, path, body, token) {
  return push.request({ method, path, body, token, origin });
}
try {
  const state = await createStateService({ stateDir: dir });
  assert.equal((await state.request({ method: 'GET', path: '/api/state/push-private' })).status, 404);
  assert.equal((await state.request({ method: 'GET', path: '/api/state/.push%2Fdevices' })).status, 400);
  assert.equal((await state.request({ method: 'GET', path: '/api/state' })).json.docs.some(d => d.name.includes('push')), false);
  assert.equal((await stat(join(dir, '.push', 'devices.json'))).mode & 0o777, 0o600);
  assert.equal((await fetch(`${origin}/api/push/config`)).status, 200);
  assert.equal((await fetch(`${origin}/api/push/subscription`, { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/push/subscription`, { method: 'POST', headers: { Origin: origin }, body: '{' })).status, 400);
  assert.equal((await request('POST', '/api/push/subscription', { subscription: { ...subscription, endpoint: 'http://127.0.0.1/private' } })).status, 400);
  const saved = await request('POST', '/api/push/subscription', { subscription });
  assert.equal(saved.status, 200);
  const token = saved.json.token;
  assert(token);
  async function rawUpgrade(protocols, requestOrigin) {
    const socket = connect(server.address().port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /api/push/bridge?agent=Test HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: ${protocols}\r\n${requestOrigin ? `Origin: ${requestOrigin}\r\n` : ''}\r\n`);
    const [reply] = await once(socket, 'data');
    socket.destroy();
    return String(reply);
  }
  assert.match(await rawUpgrade('acp-push.__proto__, acp.v1, acp.v1'), /403 Forbidden/);
  assert.match(await rawUpgrade(`acp-push.${token}, acp.v1, acp.v1`, origin), /400 Bad Request/);
  assert.equal((await fetch(`${origin}/api/push/config`)).status, 200, 'malformed upgrades cannot crash state');
  const restored = await createPushService({ stateDir: dir });
  assert.equal((await restored.request({ method: 'GET', path: '/api/push/config' })).json.publicKey,
    (await request('GET', '/api/push/config')).json.publicKey, 'VAPID survives restart');
  assert.equal((await request('POST', '/api/push/test', {}, 'bad')).status, 401);
  assert.equal((await request('POST', '/api/push/test', {}, token)).status, 200);
  notifications.length = 0;

  const nextBridge = once(bridge, 'connection');
  const client = new WebSocket(`${origin.replace('http', 'ws')}/api/push/bridge?agent=Test`, [`acp-push.${token}`], { origin });
  await once(client, 'open');
  const [upstream] = await nextBridge;
  const upstreamMessages = [];
  upstream.on('message', data => upstreamMessages.push(JSON.parse(String(data))));
  const received = once(client, 'message');
  upstream.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'history' } }));
  assert.equal(JSON.parse(String((await received)[0])).params.sessionId, 'history');
  assert.equal(notifications.length, 0, 'history never notifies');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'one' } }));
  while (!upstreamMessages.length) await new Promise(r => setTimeout(r, 5));
  client.close();
  await once(client, 'close');
  assert.equal(upstream.readyState, WebSocket.OPEN, 'server owns pending prompt after app closes');
  upstream.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }));
  await once(upstream, 'close');
  assert.equal(notifications.length, 1);
  const payload = JSON.parse(notifications[0][1]);
  assert.equal(payload.url, '/chat?s=Test%3A%3Aone');
  assert.equal(notifications[0][0].endpoint, subscription.endpoint);
  assert(!JSON.stringify(payload).includes(token), 'notification has no credential');
  // Cancels and replay do not notify; responses and ids remain socket-local.
  for (const stopReason of ['cancelled', 'end_turn']) {
    const connected = once(bridge, 'connection');
    const other = new WebSocket(`${origin.replace('http', 'ws')}/api/push/bridge?agent=Test`, [`acp-push.${token}`], { origin });
    await once(other, 'open');
    const [agentSocket] = await connected;
    const gotPrompt = once(agentSocket, 'message');
    other.send(JSON.stringify({ id: 1, method: 'session/prompt', params: { sessionId: stopReason } }));
    await gotPrompt;
    const response = once(other, 'message');
    agentSocket.send(JSON.stringify({ id: 1, result: { stopReason } }));
    assert.equal(JSON.parse(String((await response)[0])).result.stopReason, stopReason);
    other.close();
    await once(agentSocket, 'close');
  }
  assert.equal(notifications.length, 2, 'cancelled turn stays silent, next socket with same id notifies once');
  deliveryStatus = 410;
  assert.equal((await request('POST', '/api/push/test', {}, token)).status, 502);
  const expiredConnection = once(bridge, 'connection');
  const expired = new WebSocket(`${origin.replace('http', 'ws')}/api/push/bridge?agent=Test`, [`acp-push.${token}`], { origin });
  await once(expired, 'open');
  const [expiredUpstream] = await expiredConnection;
  const forwarded = once(expiredUpstream, 'message');
  expired.send(JSON.stringify({ id: 2, method: 'session/list' }));
  assert.equal(JSON.parse(String((await forwarded)[0])).method, 'session/list', 'expired push cannot lock out chat traffic');
  expired.close(); await once(expiredUpstream, 'close');
  deliveryStatus = 0;
  assert.equal((await request('POST', '/api/push/subscription', { subscription }, token)).json.token, token, 'expired device can re-enroll');
  const diagnosticsConnection = once(bridge, 'connection');
  const diagnostics = new WebSocket(`${origin.replace('http', 'ws')}/api/push/bridge?agent=Test`, [`acp-push.${token}`], { origin });
  await once(diagnostics, 'open');
  const [diagnosticsUpstream] = await diagnosticsConnection;
  const closed = once(diagnostics, 'close');
  diagnosticsUpstream.close(1011, 'agent CLI exited');
  const [code, reason] = await closed;
  assert.equal(code, 1011); assert.equal(String(reason), 'agent CLI exited');
  // Parallel sockets can reuse ids, including when they name the same session.
  for (const sessions of [['parallel-a', 'parallel-b'], ['shared', 'shared']]) {
    const pairs = [];
    for (const sessionId of sessions) {
      const connected = once(bridge, 'connection');
      const tab = new WebSocket(`${origin.replace('http', 'ws')}/api/push/bridge?agent=Test`, [`acp-push.${token}`], { origin });
      await once(tab, 'open');
      const [up] = await connected;
      const prompt = once(up, 'message');
      tab.send(JSON.stringify({ id: 1, method: 'session/prompt', params: { sessionId } }));
      await prompt;
      pairs.push({ tab, up, response: once(tab, 'message'), sessionId });
    }
    for (const pair of pairs.toReversed()) pair.up.send(JSON.stringify({ id: 1, result: { stopReason: 'end_turn', marker: pair.sessionId } }));
    for (const pair of pairs) {
      assert.equal(JSON.parse(String((await pair.response)[0])).result.marker, pair.sessionId);
      pair.tab.close(); await once(pair.up, 'close');
    }
  }
  assert.equal((await request('DELETE', '/api/push/subscription', undefined, token)).status, 200);
  assert.equal((await request('POST', '/api/push/test', {}, token)).status, 401);
  console.log('PASS durable subscription, endpoint validation, permissions, real WS relay, replay isolation, detached completion, deep link, unsubscribe');
} finally {
  push.close();
  for (const ws of bridge.clients) ws.terminate();
  await new Promise(r => bridge.close(r));
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
