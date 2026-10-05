// Canonical preparation document rendering; no network or approval commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { createSSRApp } = await import('vue');
const { renderToString } = await import('@vue/server-renderer');
const { createPinia, setActivePinia } = await import('pinia');
const { setExecutionClient } = await import('../src/stores/execution.ts');
const Review = (await import('../src/features/board/PreparationDocumentReview.vue')).default;
const sha256 = 'a'.repeat(64);

async function render({ kind = 'requirements', approved = false, disabled = false, response, reject } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const calls = [];
  setExecutionClient({
    getDocument: async (cardId, versionId) => {
      calls.push([cardId, versionId]);
      if (reject) throw new Error(reject);
      return { kind, versionId, sha256, content: '# Full requirements\n\nFirst paragraph.\n\nLast paragraph.', ...response };
    },
    sendCommand: () => { throw new Error('Reading a document must never send an approval.'); },
  });
  const app = createSSRApp(Review, { cardId: 'card-one', kind, versionId: 'version-one', approved, disabled });
  app.use(pinia);
  try { return { html: await renderToString(app), calls }; }
  finally { setExecutionClient(null); }
}

test('loads exact canonical version and renders complete markdown, with deliberate approval action', async () => {
  const { html, calls } = await render();
  assert.deepEqual(calls, [['card-one', 'version-one']]);
  assert.match(html, /<h1>Full requirements<\/h1>/);
  assert.match(html, /Last paragraph\./);
  assert.match(html, /Approve requirements/);
  assert.doesNotMatch(html, /Loading requirements/);
});

test('approved document remains readable and has no second approval action', async () => {
  const { html } = await render({ approved: true });
  assert.match(html, /Last paragraph\./);
  assert.match(html, /This version is approved/);
  assert.doesNotMatch(html, /prep-document-approve/);
});

test('server errors and wrong versions expose retry instead of approval', async () => {
  for (const options of [{ reject: 'State unavailable' }, { response: { versionId: 'other-version' } }]) {
    const { html } = await render(options);
    assert.match(html, /role="alert"/);
    assert.match(html, /Retry loading document/);
    assert.doesNotMatch(html, /prep-document-approve/);
  }
});

test('plan displays exact verification commands and metadata for deliberate approval', async () => {
  const { html } = await render({ kind: 'plan', response: {
    checksFromDocument: { ok: true, checks: [{ run: 'npm test -- --runInBand', cwd: 'web', timeoutSec: 90, setup: true }] },
  } });
  assert.match(html, /Review plan/);
  assert.match(html, /npm test -- --runInBand/);
  assert.match(html, /Directory: web/);
  assert.match(html, /Timeout: 90 seconds/);
  assert.match(html, /Setup command/);
  assert.match(html, /Approve plan/);
  assert.doesNotMatch(html, /Plan needs verification commands/);
});

test('plan without valid checks cannot be approved', async () => {
  const { html } = await render({ kind: 'plan' });
  assert.match(html, /Plan needs verification commands before approval/);
  assert.match(html, /disabled[^>]*data-testid="prep-document-approve"/);
});

test('canonical markdown cannot inject raw HTML, event handlers, or executable URL schemes', async () => {
  const { html } = await render({ response: { content: [
    '<img src=x onerror="alert(1)">',
    '<script>alert(2)</script>',
    '[unsafe](javascript:alert%281%29)',
    '[other unsafe](vbscript:evil)',
    '![unsafe image](data:image/svg+xml,evil)',
    '[safe relative](/docs/requirements)',
    '[safe mail](mailto:lead@example.com)',
    '![safe image](https://example.com/diagram.png)',
  ].join('\n\n') } });
  assert.doesNotMatch(html, /<script\b|<img[^>]+onerror/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:javascript|vbscript|data):/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.match(html, /href="\/docs\/requirements"/);
  assert.match(html, /href="mailto:lead@example.com"/);
  assert.match(html, /src="https:\/\/example.com\/diagram.png"/);
});
