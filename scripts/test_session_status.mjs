import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { mergeSessionStatuses, sessionStatusesFromActivity } = await import('../src/stores/sessionStatus.ts');
const key = JSON.stringify(['E2E', 'one']);

test('status merges retain concurrent sessions and newer explicit resets', () => {
 const a = { [key]: { status: 'completed', at: 1 } };
 const b = { [key]: { status: null, at: 2 }, other: { status: 'cancelled', at: 3 } };
 assert.deepEqual(mergeSessionStatuses(a, b, a), b);
 assert.equal(mergeSessionStatuses(b, structuredClone(b)), b, 'unchanged polls preserve the reactive reference');
 assert.deepEqual(mergeSessionStatuses(null, { invalid: { status: 'unread', at: 5 }, corrupt: { status: 'completed', at: NaN } }), {});
});

test('activity recovery uses terminal protocol results, never replay/output notifications', () => {
 const event = (kind, at, detail) => ({ kind, at, detail, agentName: 'E2E', sessionId: 'one' });
 const base = [event('turn-start', 1), event('turn-end', 2, 'end_turn'), event('session-open', 3), event('tool-call', 4), event('error', 5, 'history load failed')];
 assert.deepEqual(sessionStatusesFromActivity(base)[key], { status: 'completed', at: 2 });
 assert.deepEqual(sessionStatusesFromActivity([...base, event('turn-start', 6)])[key], { status: 'working', at: 6 });
 assert.deepEqual(sessionStatusesFromActivity([...base, event('turn-start', 6), event('error', 7)])[key], { status: 'error', at: 7 });
 assert.deepEqual(sessionStatusesFromActivity([event('turn-end', 8, 'cancelled')])[key], { status: 'cancelled', at: 8 });
 assert.deepEqual(sessionStatusesFromActivity([event('tool-call', 1)]), {});
});
