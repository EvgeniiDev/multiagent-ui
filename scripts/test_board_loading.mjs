import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { createPinia, setActivePinia } = await import('pinia');
const { createSSRApp } = await import('vue');
const { renderToString } = await import('@vue/server-renderer');
const { useBoardStore } = await import('../src/stores/board.ts');
const KanbanTab = (await import('../src/features/board/KanbanTab.vue')).default;
async function render({ ready, filter = false, cards = [] }) {
  setActivePinia(createPinia());
  const board = useBoardStore();
  board.ready = ready;
  board.cards = cards;
  if (filter) board.filters.search = 'missing-card';
  return renderToString(createSSRApp(KanbanTab));
}
test('initial board shows loading and no empty, filtered-empty or create actions', async () => {
  const html = await render({ ready: false, filter: true });
  assert.match(html, /data-testid="board-loading"/);
  assert.ok(!html.includes('No cards yet'));
  assert.ok(!html.includes('No cards match the filter'));
  assert.ok(!html.includes('Add example card'));
  assert.ok(!html.includes('class="col-add"'));
});
test('confirmed empty board offers first-card actions after loading', async () => {
  const html = await render({ ready: true });
  assert.match(html, /No cards yet/);
  assert.match(html, /Add example card/);
  assert.ok(!html.includes('data-testid="board-loading"'));
});
test('loaded cards are rendered without empty or loading state', async () => {
  const html = await render({ ready: true, cards: [{
    id: 'existing-card', title: 'Existing task', description: '', project: '', agent: '',
    createdAt: 1791096000000, updatedAt: 1791096000000, priority: 'medium', stage: 'backlog', status: null, statusByStage: {}, order: 0,
    blocked: false, cancelled: false, links: [], touches: [], dependsOn: [], blocks: [], conflictsWith: [],
  }] });
  assert.match(html, /Existing task/);
  assert.ok(!html.includes('No cards yet'));
  assert.ok(!html.includes('data-testid="board-loading"'));
});
