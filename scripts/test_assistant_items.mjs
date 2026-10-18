// Exercise the actual ChatView render projection, including its work on long turns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
const source = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8');
const script = parse(source).descriptor.scriptSetup.content;
const ast = ts.createSourceFile('ChatView.ts', script, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assistantItems');
assert.ok(fn, 'ChatView assistantItems exists');
const js = ts.transpileModule(`export ${fn.getText(ast)}`, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText;
const { assistantItems } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('ordered narration, tool, attachment and plan pieces preserve their objects and final flag', () => {
  const tool = { toolCallId: 'one', title: 'first' }, duplicate = { toolCallId: 'one', title: 'duplicate' };
  const attachments = [{ name: 'unclaimed' }, { name: 'inline' }];
  const message = { toolCalls: [tool, duplicate], attachments, plan: [{}], segments: [
    { kind: 'text', text: 'before' }, { kind: 'tool', toolCallId: 'one' },
    { kind: 'tool', toolCallId: 'missing' }, { kind: 'attachment', index: 1 },
    { kind: 'plan' }, { kind: 'text', text: '' }, { kind: 'text', text: 'after' },
  ] };
  const items = assistantItems(message);
  assert.deepEqual(items.map(i => i.kind), ['attachment', 'text', 'tool', 'attachment', 'plan', 'text']);
  assert.equal(items[0].att, attachments[0]);
  assert.equal(items[2].tc, tool, 'duplicate tool ids keep the previous first-match behavior');
  assert.equal(items[3].att, attachments[1]);
  assert.deepEqual(items.map(i => i.last), [false, false, false, false, false, true]);
  message.toolCalls[0] = { toolCallId: 'one', title: 'updated' };
  assert.equal(assistantItems(message)[2].tc, message.toolCalls[0], 'later renders see current tools');
});

test('legacy messages and empty messages retain their render order', () => {
  assert.deepEqual(assistantItems({}), []);
  const items = assistantItems({ attachments: [{}], toolCalls: [{toolCallId:'a'}], plan: [{}], content: 'text' });
  assert.deepEqual(items.map(i => i.kind), ['attachment', 'tool', 'plan', 'text']);
  assert.equal(items.at(-1).last, true);
});

test('a long replay inspects tools linearly rather than scanning the whole turn for every segment', () => {
  const count = 3000;
  let reads = 0;
  const tools = Array.from({length:count}, (_, i) => ({ toolCallId: String(i), title: `Tool ${i}` }));
  const observed = new Proxy(tools, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  }});
  const items = assistantItems({ toolCalls: observed, segments: tools.map(t => ({kind:'tool', toolCallId:t.toolCallId})) });
  assert.equal(items.length, count);
  assert.equal(items.at(-1).tc, tools.at(-1));
  assert.ok(reads <= count * 2, `${reads} tool reads for ${count} segments blocked the browser during replay`);
});
