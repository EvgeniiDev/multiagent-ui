import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequestHandler } from '../server/acp-state-server.mjs';

test('chat files: bytes, scope, failures and inert response headers through real HTTP adapter', async () => {
  const base = await mkdtemp(join(tmpdir(), 'acp-chat-files-'));
  const root = join(base, 'projects');
  await mkdir(root);
  await writeFile(join(root, 'отчёт.txt'), 'Привет');
  await writeFile(join(root, '.env'), 'SECRET');
  await mkdir(join(root, '.push'));
  await writeFile(join(root, '.push/devices.json'), 'PRIVATE PUSH STORE');
  await symlink(join(root, '.push/devices.json'), join(root, 'push-link.json'));
  await mkdir(join(root, 'private-state'));
  await writeFile(join(root, 'private-state/private.json'), 'PRIVATE STATE');
  await symlink(join(root, 'private-state/private.json'), join(root, 'state-link.json'));
  await writeFile(join(base, 'outside.txt'), 'outside');
  await symlink(join(base, 'outside.txt'), join(root, 'escape.txt'));
  await writeFile(join(root, 'large.zip'), Buffer.alloc(1025));
  const service = { request: async () => ({ status: 404, json: { error: 'not found' } }) };
  const previousStateDir = process.env.STATE_DIR;
  process.env.STATE_DIR = join(root, 'private-state');
  const server = createServer(createRequestHandler(service, { chatFileRoots: [root], chatFileMaxBytes: 1024 }));
  if (previousStateDir === undefined) delete process.env.STATE_DIR; else process.env.STATE_DIR = previousStateDir;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/chat-files?path=`;
  const read = (p, options) => fetch(url + encodeURIComponent(p), options);
  try {
    const response = await read(join(root, 'отчёт.txt'));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Привет');
    assert.match(response.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    for (const p of [join(base, 'outside.txt'), join(root, 'escape.txt'), join(root, '.env'), join(root, '.push/devices.json'), join(root, 'push-link.json'), join(root, 'private-state/private.json'), join(root, 'state-link.json')]) {
      assert.equal((await read(p)).status, 403, p);
    }
    assert.equal((await read(join(root, 'missing.png'))).status, 404);
    assert.equal((await read(root)).status, 403);
    assert.equal((await read(join(root, 'large.zip'))).status, 413);
    assert.equal((await read('relative.txt')).status, 400);
    assert.equal((await read(join(root, 'отчёт.txt'), { method: 'POST' })).status, 405);
    assert.equal((await read(join(root, 'отчёт.txt'), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await read(join(root, 'отчёт.txt'), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const head = await read(join(root, 'отчёт.txt'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true }); }
});
