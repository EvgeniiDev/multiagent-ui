import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from '../server/acp-state-server.mjs';
test('native usage GET is read-only and does not expose message content', async () => {
  const data = { usage: [{ agentName: 'Pi', used: 120 }], sources: [], updatedAt: 1 };
  let status, body;
  const handler = createRequestHandler({ request() { throw new Error('must not modify ledger'); } }, { usageReader: async () => data });
  await handler({ method: 'GET', url: '/api/usage' }, {
    writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); },
  });
  assert.equal(status, 200);
  assert.deepEqual(body, data);
});
