import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLeadResult } from '../server/execution/preparation/lead.mjs';

const fence = result => `\`\`\`acp-prep\n${JSON.stringify(result)}\n\`\`\``;
test('a generated plan preserves nested check and source code fences', () => {
  const result = { document: { kind: 'plan', text: '# Plan\n```acp-checks\n{"checks":[{"run":"node --test","timeoutSec":60}]}\n```\n```js\nexport const value = 1;\n```' } };
  assert.deepEqual(extractLeadResult(fence(result)), { present: true, result });
});
test('a quoted acp-prep example is document data', () => {
  const result = { document: { kind: 'requirements', text: 'Example:\n```acp-prep\n{}\n```' } };
  assert.deepEqual(extractLeadResult(fence(result)), { present: true, result });
});
test('two actual result blocks are refused', () => {
  assert.match(extractLeadResult(`${fence({ note: 'one' })}\n${fence({ note: 'two' })}`).malformed, /multiple/);
});
test('malformed JSON stays malformed', () => {
  assert.match(extractLeadResult('```acp-prep\n{not json\n```').malformed, /valid JSON/);
});
