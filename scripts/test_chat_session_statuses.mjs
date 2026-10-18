import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatSessionStatusReader, parseCodexTurnStatus } from '../server/chat-session-statuses.mjs';
const sid = '01a14dd8-7645-70b3-a569-f031dc1aa8ea';
const line = (type, timestamp, turn_id = 'turn') => JSON.stringify({ type: 'event_msg', timestamp, payload: { type, turn_id } }) + '\n';

test('native task completion is evidence even when UI missed its prompt response', () => {
 const log = line('task_started', '2026-10-18T07:51:52Z') + JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: 'done' } }) + '\n';
 assert.equal(parseCodexTurnStatus(log).status, 'working', 'assistant text never implies completion');
 assert.deepEqual(parseCodexTurnStatus(log + line('task_complete', '2026-10-18T08:12:05Z')), { status: 'completed', at: Date.parse('2026-10-18T08:12:05Z') });
 assert.equal(parseCodexTurnStatus(log + line('turn_aborted', '2026-10-18T08:12:05Z')).status, 'cancelled');
 assert.equal(parseCodexTurnStatus(log + line('task_started', '2026-10-18T08:13:00Z', 'next') + line('task_complete', '2026-10-18T08:13:01Z', 'turn')).status, 'working', 'a late completion for an older turn cannot finish a newer turn');
 assert.equal(parseCodexTurnStatus('{partial'), undefined);
});

test('reader follows native start/end changes and returns no invented status for missing sessions', async () => {
 const root = await mkdtemp(join(tmpdir(), 'acp-native-status-'));
 try {
  const dir = join(root, '2026/10/18'); await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-18T07-09-54-${sid}.jsonl`);
  await writeFile(file, line('task_started', '2026-10-18T07:51:52Z'));
  const read = createChatSessionStatusReader({ root, indexMs: 0 });
  const sessions = [{ agentName: 'Codex', sessionId: sid }, { agentName: 'Pi', sessionId: sid }, { agentName: 'Codex', sessionId: '../secret' }];
  const key = JSON.stringify(['Codex', sid]);
  assert.deepEqual(Object.keys((await read(sessions)).statuses), [key]);
  assert.equal((await read(sessions)).statuses[key].status, 'working');
  await appendFile(file, line('task_complete', '2026-10-18T08:12:05Z'));
  assert.equal((await read(sessions)).statuses[key].status, 'completed');
  await appendFile(file, line('task_started', '2026-10-18T08:13:00Z', 'next'));
  assert.equal((await read(sessions)).statuses[key].status, 'working');
  await rm(file); await symlink('/etc/passwd', file);
  assert.deepEqual((await read(sessions)).statuses, {});
 } finally { await rm(root, { recursive: true, force: true }); }
});
