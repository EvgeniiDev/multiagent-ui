// Unit tests for the workflow porch reader — node:test + assert/strict.
//
// Ports of the three Paseo workflow suites (porch-reader / event-blocks /
// graph) adapted to THIS host's audit.jsonl contract (PLAN.md §9). Runs
// the lib directly via node's native TS type stripping — the lib is
// erasable-TS only, so `node scripts/test_workflow_porch.mjs` just works.
//
// Fixtures are real audit.jsonl tails captured from this host's steer
// registry (~/.cache/pragmatic-orchestration/steer/runs):
//   audit-devin-tail.jsonl    run_cosmic-quill-41bf  (devin-cli, completed)
//   audit-opencode-tail.jsonl run_dusty-comet-6e81 (opencode, completed)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { KNOWN_STEER_TYPES, STREAM_TO_EVENT, parseAudit } from '../src/lib/porch/audit.ts';
import { deriveRunStatus } from '../src/lib/porch/status.ts';
import { projectEvents } from '../src/lib/porch/event-blocks.ts';
import {
  DIRECTIONS,
  NODE_DEFS,
  activeIndex,
  inferDirection,
  matchesNode,
} from '../src/lib/porch/graph.ts';
import { porchBase, probePorch } from '../src/lib/porch/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8');

const meta = (over = {}) => ({
  run_id: 'run_test-1',
  agent_id: 'devin',
  backend: 'devin-cli',
  status: 'running',
  exit_code: null,
  error: null,
  started_at: '2026-09-29T12:00:00Z',
  updated_at: '2026-09-29T12:00:00Z',
  ...over,
});

const line = (obj) => JSON.stringify(obj);
const adapter = (kind, data_preview, ts = '2026-09-29T12:00:00Z') =>
  line({ event: 'adapter_event', kind, data_preview, ts });

// ---------------------------------------------------------------------------
// deriveRunStatus (port of porch-reader.test.ts's readRunStatus cases,
// pidAlive → silence detection)
// ---------------------------------------------------------------------------

describe('deriveRunStatus', () => {
  const now = Date.parse('2026-09-29T12:10:00Z');

  test('running + fresh meta.updated_at = active', () => {
    const d = { meta: meta({ updated_at: '2026-09-29T12:09:50Z' }) };
    assert.equal(deriveRunStatus(d, now, { auditGrew: false }), 'active');
  });

  test('running + silent > 3min AND audit not growing = stale', () => {
    const d = { meta: meta({ updated_at: '2026-09-29T12:05:00Z' }) };
    assert.equal(deriveRunStatus(d, now, { auditGrew: false }), 'stale');
  });

  test('running + old updated_at but audit still growing = active', () => {
    const d = { meta: meta({ updated_at: '2026-09-29T12:05:00Z' }) };
    assert.equal(deriveRunStatus(d, now, { auditGrew: true }), 'active');
  });

  test('running + old updated_at, first poll (no delta known) = active', () => {
    const d = { meta: meta({ updated_at: '2026-09-29T12:05:00Z' }) };
    assert.equal(deriveRunStatus(d, now), 'active');
  });

  test('completed + final.txt = done', () => {
    const d = {
      meta: meta({ status: 'completed', exit_code: 0 }),
      final: 'ok',
    };
    assert.equal(deriveRunStatus(d, now), 'done');
  });

  test('completed без final.txt = done (final.txt unreliable on this host)', () => {
    const d = { meta: meta({ status: 'completed', exit_code: 0 }) };
    assert.equal(deriveRunStatus(d, now), 'done');
  });

  test('failed exit_code = failed', () => {
    const d = { meta: meta({ status: 'failed', exit_code: 1 }), final: 'err' };
    assert.equal(deriveRunStatus(d, now), 'failed');
  });

  test('cancelled = failed', () => {
    const d = { meta: meta({ status: 'cancelled', exit_code: 143 }) };
    assert.equal(deriveRunStatus(d, now), 'failed');
  });

  test('completed + meta.error = failed', () => {
    const d = {
      meta: meta({ status: 'completed', exit_code: 0, error: 'permission_required' }),
    };
    assert.equal(deriveRunStatus(d, now), 'failed');
  });

  test('missing meta = active (Paseo parity)', () => {
    assert.equal(deriveRunStatus({}, now), 'active');
    assert.equal(deriveRunStatus({ meta: null }, now), 'active');
  });
});

// ---------------------------------------------------------------------------
// parseAudit — audit.jsonl → WfEvent (this host's contract, not Paseo's
// normalized/ stream)
// ---------------------------------------------------------------------------

describe('parseAudit', () => {
  test('kind:text → answer_delta with delta preserved', () => {
    const evs = parseAudit(adapter('text', 'hello '), meta());
    assert.equal(evs[1].type, 'answer_delta');
    assert.equal(evs[1].data, 'hello ');
    assert.equal(evs[1].agentId, 'devin');
  });

  test('kind:thought → thinking_delta', () => {
    const evs = parseAudit(adapter('thought', 'hmm'), meta());
    assert.equal(evs[1].type, 'thinking_delta');
  });

  test('kind:tool summary → tool_started, preview IS the name', () => {
    const evs = parseAudit(adapter('tool', 'Ran ls'), meta());
    assert.equal(evs[1].type, 'tool_started');
    assert.equal(evs[1].toolName, 'Ran ls');
    assert.equal(evs[1].data, null);
  });

  test('opencode tool_started JSON preview → tool + call_id extracted', () => {
    const preview = JSON.stringify({
      tool: 'read',
      call_id: 'call_abc',
      status: 'running',
      input: { filePath: '/x' },
    });
    const evs = parseAudit(adapter('tool_started', preview), meta());
    assert.equal(evs[1].type, 'tool_started');
    assert.equal(evs[1].toolName, 'read');
    assert.equal(evs[1].toolId, 'call_abc');
    assert.equal(evs[1].data, preview);
  });

  test('truncated JSON preview → regex fallback, no throw', () => {
    const preview =
      '{"tool": "bash", "call_id": "call_deadbeef", "status": "running", "input": {"command": "npm ru…';
    const evs = parseAudit(adapter('tool_started', preview), meta());
    assert.equal(evs[1].toolName, 'bash');
    assert.equal(evs[1].toolId, 'call_deadbeef');
  });

  test('steer_ack "completed:…" → steer_completed', () => {
    const evs = parseAudit(
      adapter('steer_ack', 'completed:prompt_result_end_turn'),
      meta(),
    );
    assert.equal(evs[1].type, 'steer_completed');
  });

  test('steer_ack "request_sent:prompt" → steer_request_sent', () => {
    const evs = parseAudit(adapter('steer_ack', 'request_sent:prompt'), meta());
    assert.equal(evs[1].type, 'steer_request_sent');
  });

  test('steer_ack with unknown status → steer_request_sent', () => {
    const evs = parseAudit(adapter('steer_ack', 'weirdstatus:x'), meta());
    assert.equal(evs[1].type, 'steer_request_sent');
  });

  test('steer_result supervisor line → steer_request_sent', () => {
    const l = line({
      event: 'steer_result',
      status: 'request_sent',
      evidence: 'acp_concurrent_prompt',
      ok: true,
      ts: 't',
    });
    const evs = parseAudit(l, meta());
    assert.equal(evs[1].type, 'steer_request_sent');
    assert.equal(evs[1].data, 'acp_concurrent_prompt');
  });

  test('steer_ack_reconcile new_status=completed → steer_completed', () => {
    const l = line({
      event: 'steer_ack_reconcile',
      old_status: 'request_sent',
      new_status: 'completed',
      ts: 't',
    });
    const evs = parseAudit(l, meta());
    assert.equal(evs[1].type, 'steer_completed');
  });

  test('supervisor_error → run_failed carrying the error', () => {
    const l = line({
      event: 'supervisor_error',
      error: 'opencode serve exited early',
      trace: '…',
      ts: 't',
    });
    const evs = parseAudit(l, meta());
    assert.equal(evs[1].type, 'run_failed');
    assert.match(evs[1].data, /opencode serve exited early/);
  });

  test('open_messages_failed_on_terminal → steer_failed with reason', () => {
    const l = line({
      event: 'open_messages_failed_on_terminal',
      reason: 'run_cancelled',
      count: 1,
      ts: 't',
    });
    const evs = parseAudit(l, meta());
    assert.equal(evs[1].type, 'steer_failed');
    assert.equal(evs[1].data, 'run_cancelled');
  });

  test('malformed lines are skipped, never thrown', () => {
    const text = [adapter('text', 'a'), 'not-json{{{', '{"event":42}', ''].join('\n');
    const evs = parseAudit(text, meta());
    assert.equal(evs.filter((e) => e.type === 'answer_delta').length, 1);
  });

  test('unknown kind is skipped silently', () => {
    const evs = parseAudit(adapter('raw', '{"blob":1}'), meta());
    assert.equal(evs.filter((e) => e.type !== 'run_started').length, 0);
  });

  test('run_started synthesized from meta.started_at (never an audit kind here)', () => {
    const evs = parseAudit('', meta());
    assert.equal(evs[0].type, 'run_started');
    assert.equal(evs[0].ts, '2026-09-29T12:00:00Z');
  });

  test('terminal meta with no seen terminal event → run_completed appended', () => {
    const m = meta({ status: 'completed', exit_code: 0, finished_at: '2026-09-29T12:05:00Z' });
    const evs = parseAudit(adapter('text', 'done'), m);
    const last = evs[evs.length - 1];
    assert.equal(last.type, 'run_completed');
    assert.equal(last.ts, '2026-09-29T12:05:00Z');
  });

  test('terminal meta failed + no error line → run_failed appended', () => {
    const m = meta({ status: 'failed', exit_code: 1, error: 'boom' });
    const evs = parseAudit(adapter('text', 'oops'), m);
    assert.equal(evs[evs.length - 1].type, 'run_failed');
    assert.equal(evs[evs.length - 1].data, 'boom');
  });

  test('no synthesized bookend when done/error lines already cover it', () => {
    const m = meta({ status: 'completed', exit_code: 0 });
    const evs = parseAudit(adapter('done', 'end_turn'), m);
    assert.equal(evs.filter((e) => e.type === 'run_completed').length, 1);
  });

  test('meta=null → no bookends, events still parse', () => {
    const evs = parseAudit(adapter('text', 'hi'), null);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'answer_delta');
    assert.equal(evs[0].agentId, '');
  });
});

// ---------------------------------------------------------------------------
// projectEvents (port of event-blocks.test.ts)
// ---------------------------------------------------------------------------

const ev = (type, over = {}) => ({
  type,
  ts: 't',
  data: null,
  agentId: 'a',
  ...over,
});

describe('projectEvents', () => {
  test('answer deltas concat into one text block', () => {
    const blocks = projectEvents([
      ev('answer_delta', { data: 'hello ' }),
      ev('answer_delta', { data: 'world' }),
    ]);
    assert.deepEqual(blocks, [{ kind: 'text', markdown: 'hello world', truncated: undefined }]);
  });

  test('thinking_delta → reasoning block', () => {
    const blocks = projectEvents([ev('thinking_delta', { data: 'hmm' })]);
    assert.deepEqual(blocks, [{ kind: 'reasoning', text: 'hmm', truncated: undefined }]);
  });

  test('tool_started/tool_completed pair by toolId', () => {
    const blocks = projectEvents([
      ev('tool_started', { data: '{"in":1}', toolName: 'read', toolId: 'c1' }),
      ev('tool_completed', { data: 'ok', toolName: 'read', toolId: 'c1' }),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'tool');
    assert.equal(blocks[0].status, 'done');
    assert.equal(blocks[0].output, 'ok');
  });

  test('repeated tool_started for one call_id updates, not duplicates', () => {
    const blocks = projectEvents([
      ev('tool_started', { data: null, toolName: 'read', toolId: 'c1' }),
      ev('tool_started', { data: '{"filePath":"/x"}', toolName: 'read', toolId: 'c1' }),
      ev('tool_completed', { data: 'ok', toolName: 'read', toolId: 'c1' }),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].status, 'done');
    assert.equal(blocks[0].input, '{"filePath":"/x"}');
  });

  test('unpaired completion → standalone done block', () => {
    const blocks = projectEvents([
      ev('tool_completed', { data: 'late output', toolName: 'bash', toolId: 'gone' }),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'tool');
    assert.equal(blocks[0].status, 'done');
  });

  test('uncompleted tool stays started', () => {
    const blocks = projectEvents([
      ev('tool_started', { data: null, toolName: 'bash', toolId: 'c2' }),
    ]);
    assert.equal(blocks[0].status, 'started');
  });

  test('unknown type is skipped without throwing', () => {
    const blocks = projectEvents([
      ev('answer_delta', { data: 'hi' }),
      ev('future_unknown_xyz', { data: '???' }),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'text');
  });

  test('steer_/run_/turn_ events → meta lines; progress skipped', () => {
    const blocks = projectEvents([
      ev('run_started'),
      ev('steer_request_sent', { data: 'acp_concurrent_prompt' }),
      ev('progress', { data: 'usage_update' }),
      ev('run_completed', { data: 'end_turn' }),
    ]);
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['meta', 'meta', 'meta'],
    );
    assert.match(blocks[1].text, /steer_request_sent — acp_concurrent_prompt/);
  });

  test('…-suffixed previews mark the block truncated', () => {
    const blocks = projectEvents([ev('answer_delta', { data: 'a long preview…' })]);
    assert.equal(blocks[0].truncated, true);
  });

  test('agent_id filter keeps only matching events', () => {
    const blocks = projectEvents(
      [
        ev('answer_delta', { data: 'mine', agentId: 'a' }),
        ev('answer_delta', { data: ' other', agentId: 'b' }),
      ],
      'a',
    );
    assert.deepEqual(blocks, [{ kind: 'text', markdown: 'mine', truncated: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// graph (port of graph.test.ts + this host's additions)
// ---------------------------------------------------------------------------

describe('workflow graph', () => {
  test('delegate: first-minute → supervise → wait → acceptance in order', () => {
    const ids = NODE_DEFS.delegate.map((n) => n.id);
    const order = ['first-minute', 'supervise', 'wait', 'acceptance'];
    let cursor = -1;
    for (const id of order) {
      const idx = ids.indexOf(id);
      assert.ok(idx > cursor, `${id} out of order`);
      cursor = idx;
    }
  });

  test('pipeline keeps ask → delegate → code bridges', () => {
    const ids = NODE_DEFS.pipeline.map((n) => n.id);
    for (const id of ['ask', 'delegate', 'code']) assert.ok(ids.includes(id));
    assert.ok(ids.indexOf('ask') < ids.indexOf('delegate'));
    assert.ok(ids.indexOf('delegate') < ids.indexOf('code'));
  });

  test('run fallback direction exists and matches its own events', () => {
    assert.ok(Array.isArray(NODE_DEFS.run));
    const start = NODE_DEFS.run.find((n) => n.id === 'start');
    assert.ok(matchesNode(ev('run_started'), start));
  });

  test('steer_* prefix entry matches the whole family', () => {
    const steer = NODE_DEFS.delegate.find((n) => n.id === 'steer');
    assert.ok(matchesNode(ev('steer_request_sent'), steer));
    assert.ok(matchesNode(ev('steer_cancelled'), steer));
    assert.ok(matchesNode(ev('steer_failed'), steer));
    assert.ok(!matchesNode(ev('run_completed'), steer));
  });

  test('type:agent qualifier matches only that agent', () => {
    const spark = NODE_DEFS.ask.find((n) => n.id === 'profile-spark');
    assert.ok(matchesNode(ev('answer_delta', { agentId: 'spark' }), spark));
    assert.ok(!matchesNode(ev('answer_delta', { agentId: 'devin' }), spark));
    assert.ok(!matchesNode(ev('thinking_delta', { agentId: 'spark' }), spark));
  });

  test('every matchType is produceable by the §1.3 map', () => {
    const produceable = new Set([...Object.values(STREAM_TO_EVENT), ...KNOWN_STEER_TYPES]);
    for (const dir of DIRECTIONS) {
      for (const node of NODE_DEFS[dir]) {
        for (const m of node.matchTypes) {
          if (m.endsWith('*')) {
            const prefix = m.slice(0, -1);
            assert.ok(
              [...produceable].some((t) => t.startsWith(prefix)),
              `${dir}/${node.id}: no produceable type matches ${m}`,
            );
          } else if (m.includes(':')) {
            const base = m.split(':', 1)[0];
            assert.ok(produceable.has(base), `${dir}/${node.id}: ${m} base not produceable`);
          } else {
            assert.ok(produceable.has(m), `${dir}/${node.id}: ${m} not produceable`);
          }
        }
      }
    }
  });

  test('activeIndex: last node with a matched event, -1 when none', () => {
    const nodes = NODE_DEFS.run;
    assert.equal(activeIndex(nodes, []), -1);
    assert.equal(activeIndex(nodes, [ev('run_started')]), 0);
    assert.equal(
      activeIndex(nodes, [ev('run_started'), ev('answer_delta'), ev('run_completed')]),
      nodes.length - 1,
    );
  });

  test('inferDirection: artifacts_dir basename run-<direction>-*', () => {
    assert.equal(
      inferDirection({ artifacts_dir: '/tmp/x/run-delegate-gentle-maple-d279' }),
      'delegate',
    );
    assert.equal(inferDirection({ artifacts_dir: '/tmp/x/run-ask-foo-1' }), 'ask');
    assert.equal(inferDirection({ artifacts_dir: '/tmp/x/weird' }), 'run');
    assert.equal(inferDirection(null), 'run');
    assert.equal(inferDirection({}), 'run');
  });
});

// ---------------------------------------------------------------------------
// Fixtures — real audit.jsonl tails from this host
// ---------------------------------------------------------------------------

describe('real audit tails', () => {
  test('devin tail: kinds map to the expected vocabulary', () => {
    const m = meta({
      agent_id: 'devin',
      status: 'completed',
      exit_code: 0,
      artifacts_dir: '/tmp/x/run-delegate-cosmic-quill-41bf',
    });
    const evs = parseAudit(fixture('audit-devin-tail.jsonl'), m);
    const types = new Set(evs.map((e) => e.type));
    for (const t of ['run_started', 'tool_started', 'answer_delta', 'steer_completed', 'run_completed']) {
      assert.ok(types.has(t), `missing ${t}`);
    }
    // devin's kind:"tool" previews become the tool name itself.
    const tool = evs.find((e) => e.type === 'tool_started');
    assert.equal(tool.toolName, 'Ran cat, wc');
    // No synthesized run_failed on a clean completed run.
    assert.ok(!types.has('run_failed'));
    // Whole stepper lights: last node is acceptance.
    const nodes = NODE_DEFS[inferDirection(m)];
    assert.equal(activeIndex(nodes, evs), nodes.length - 1);
  });

  test('opencode tail: JSON tool previews pair by call_id', () => {
    const m = meta({
      agent_id: 'spark',
      backend: 'opencode',
      status: 'completed',
      exit_code: 0,
    });
    const evs = parseAudit(fixture('audit-opencode-tail.jsonl'), m);
    const types = new Set(evs.map((e) => e.type));
    for (const t of ['tool_started', 'tool_completed', 'turn_completed', 'run_completed']) {
      assert.ok(types.has(t), `missing ${t}`);
    }
    const ids = new Set(
      evs.filter((e) => e.toolId !== undefined).map((e) => e.toolId),
    );
    assert.ok(ids.size >= 2, 'expected several call_ids');
    // Every completion with a call_id pairs an earlier start with the same
    // id — projectEvents leaves no orphan "done" card for these ids.
    const blocks = projectEvents(evs.filter((e) => e.type === 'tool_started' || e.type === 'tool_completed'));
    const doneTools = blocks.filter((b) => b.kind === 'tool' && b.status === 'done');
    assert.ok(doneTools.length >= 2);
    assert.ok(blocks.every((b) => b.kind === 'tool'));
  });
});

// ---------------------------------------------------------------------------
// api smoke — porchBase must not read env/location at import or crash node
// ---------------------------------------------------------------------------

describe('api', () => {
  test('porchBase resolves a loopback default under node (no location/env)', () => {
    const base = porchBase();
    assert.match(base, /^https?:\/\//);
    assert.match(base, /25900|25910/);
  });

  test('probePorch re-probes after a false verdict but caches true', async () => {
    const orig = globalThis.fetch;
    try {
      // Server down → false, and the failure is not cached: once fetch
      // recovers, the very next call probes again and reports up.
      globalThis.fetch = async () => {
        throw new Error('connection refused');
      };
      assert.equal(await probePorch(), false);
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 });
      assert.equal(await probePorch(), true);
      // true IS session-cached — a later outage does not flip the verdict.
      globalThis.fetch = async () => {
        throw new Error('down again');
      };
      assert.equal(await probePorch(), true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
