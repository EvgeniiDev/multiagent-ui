import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = (await readFile(new URL('../src/lib/chatFiles.ts', import.meta.url), 'utf8'))
  .replace("import { stateServerBase } from './host/storage';", "const stateServerBase = () => 'https://panel:25910';");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const { chatFileFromLink, previewKind, fetchChatFile, isMarkdownFile, MAX_PREVIEW_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('local file links resolve against the owning session, preserving Unicode and escaping query strings', () => {
  const local = chatFileFromLink('report%20сводка.md', '/projects/one');
  assert.equal(new URL(local.url).searchParams.get('path'), '/projects/one/report сводка.md');
  assert.equal(chatFileFromLink('file:///projects/one/source.ts:42').name, 'source.ts');
  assert.equal(new URL(chatFileFromLink('same.json', '/projects/two').url).searchParams.get('path'), '/projects/two/same.json');
  for (const link of ['https://example.com/file.pdf', '//example.com/file.pdf', 'javascript:alert(1)', '#heading', 'file://other-host/file.txt', 'notes', '%bad.txt']) assert.equal(chatFileFromLink(link), null, link);
  assert.equal(previewKind({ name: 'report.pdf' }), 'pdf');
  assert.equal(previewKind({ name: 'archive.zip' }), 'binary');
});
test('client file reader stops oversized responses with and without Content-Length', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  const file = { name: 'large.txt', url: 'https://panel/file' };
  const read = () => fetchChatFile(file, new AbortController().signal);
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(MAX_PREVIEW_BYTES + 1) } });
    await assert.rejects(read(), /too large/);
    assert.equal(cancelled, 1, 'declared oversized body is cancelled');
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } }));
    await assert.rejects(read(), /too large/);
    assert.equal(cancelled, 2, 'chunked oversized body is cancelled');
    globalThis.fetch = async () => new Response('File unavailable', { status: 404 });
    await assert.rejects(read(), /HTTP 404/);
  } finally { globalThis.fetch = originalFetch; }
});

test('ephemeral preview content is reused without refetch and still respects the size limit', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected refetch'); };
  try {
    const blob = new Blob(['original bytes'], { type: 'text/plain' });
    const result = await fetchChatFile({ name: 'report.txt', url: '', blob }, new AbortController().signal);
    assert.equal(result, blob);
    const text = await fetchChatFile({ name: 'notes.md', url: '', text: '# Привет' }, new AbortController().signal);
    assert.equal(await text.text(), '# Привет');
    await assert.rejects(fetchChatFile({ name: 'large.txt', url: '', blob: new Blob([new Uint8Array(MAX_PREVIEW_BYTES + 1)]) }, new AbortController().signal), /too large/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Markdown classification agrees for extensions and MIME-only resources', () => {
  assert(isMarkdownFile({ name: 'notes', url: '', mimeType: 'text/markdown' }));
  assert(isMarkdownFile({ name: 'notes', url: '', mimeType: 'text/markdown; charset=utf-8' }));
  assert(isMarkdownFile({ name: 'NOTES.MD', url: '' }));
  assert(!isMarkdownFile({ name: 'notes.txt', url: '', mimeType: 'text/plain' }));
});
