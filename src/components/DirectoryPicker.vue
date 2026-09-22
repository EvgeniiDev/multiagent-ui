<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

interface DirEntry {
  name: string;
  path: string;
}

interface FsListResponse {
  path: string;
  parent: string;
  root: string;
  dirs: DirEntry[];
}

const props = defineProps<{
  /** Base HTTP URL of the bridge (e.g. `http://192.168.1.222:25901`). */
  baseUrl: string;
  /** Currently selected path. */
  modelValue: string;
  /** True while a session is being created/active (picker disabled). */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  select: [value: string];
}>();

const open = ref(false);
const root = ref('');
const path = ref('');
const parent = ref('');
const dirs = ref<DirEntry[]>([]);
const loading = ref(false);
const error = ref('');
const showHidden = ref(false);
const chain = ref<DirEntry[]>([]);

async function list(target?: string): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const q = new URLSearchParams();
    if (target) q.set('path', target);
    if (showHidden.value) q.set('hidden', '1');
    const resp = await fetch(`${props.baseUrl}/api/fs/list?${q.toString()}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as FsListResponse;
    path.value = data.path;
    parent.value = data.parent;
    dirs.value = data.dirs;
    // Build the crumb chain from root to current path.
    const crumbs: DirEntry[] = [];
    const rel = data.path.startsWith(data.root)
      ? data.path.slice(data.root.length).replace(/^[/\\]/, '')
      : '';
    let acc = data.root;
    if (rel) {
      for (const part of rel.split(/[/\\]/).filter(Boolean)) {
        acc = `${acc}/${part}`;
        crumbs.push({ name: part, path: acc });
      }
    }
    chain.value = crumbs;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function openPicker() {
  open.value = true;
  // Initial target: current selection if non-empty and inside the root,
  // else the bridge root. loadRoot() guarantees root.value is known so the
  // crumb chain renders correctly.
  loadRoot().then(() => {
    const sel = props.modelValue || '';
    if (sel && (!root.value || sel.startsWith(root.value))) {
      list(sel);
    } else {
      list();
    }
  });
}

function close() {
  open.value = false;
}

function onDirClick(d: DirEntry) {
  list(d.path);
}

function goTo(t: string) {
  list(t || undefined);
}

async function loadRoot(): Promise<string> {
  if (root.value) return root.value;
  try {
    const r = await fetch(`${props.baseUrl}/api/fs/root`);
    if (r.ok) {
      const d = (await r.json()) as { root?: string };
      root.value = d.root || '';
    }
  } catch {
    /* cosmetic */
  }
  return root.value;
}

function goRoot() {
  // No path param -> the bridge serves its own root.
  list();
}

function goUp() {
  if (parent.value) list(parent.value);
}

function toggleHidden() {
  showHidden.value = !showHidden.value;
  list(path.value || undefined);
}

function useCurrent() {
  emit('update:modelValue', path.value);
  emit('select', path.value);
  open.value = false;
}

function useDir(d: DirEntry) {
  emit('update:modelValue', d.path);
  emit('select', d.path);
  open.value = false;
}

watch(() => props.baseUrl, () => {
  // Re-resolve the bridge root when the agent (and thus the bridge URL)
  // changes.
  if (props.baseUrl) {
    fetch(`${props.baseUrl}/api/fs/root`)
      .then((r) => r.json())
      .then((r) => {
        root.value = r.root || '';
      })
      .catch(() => {
        /* root label is cosmetic */
      });
  }
});

onMounted(() => {
  if (props.baseUrl) {
    fetch(`${props.baseUrl}/api/fs/root`)
      .then((r) => r.json())
      .then((r) => {
        root.value = r.root || '';
      })
      .catch(() => {
        /* root label is cosmetic */
      });
  }
});
</script>

<template>
  <div class="dir-picker">
    <div class="cwd-row">
      <input
        class="cwd-input"
        type="text"
        :value="modelValue"
        placeholder="~/path  or  absolute path"
        spellcheck="false"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="browse-btn"
        type="button"
        title="Browse directories"
        :disabled="disabled"
        @click="openPicker"
      >
        📂
      </button>
    </div>

    <div v-if="open" class="tree-overlay" @click.self="close">
      <div class="tree-panel">
        <div class="tree-header">
          <span class="tree-title">Browse (agent host)</span>
          <button class="tree-close" type="button" @click="close">×</button>
        </div>

        <div class="crumb-row">
          <button class="crumb" type="button" title="Root" @click="goRoot">⌂</button>
          <template v-for="c in chain" :key="c.path">
            <span class="crumb-sep">›</span>
            <button class="crumb" type="button" @click="goTo(c.path)">{{ c.name }}</button>
          </template>
          <span class="spacer"></span>
          <button class="small-btn" type="button" @click="goUp" :disabled="!parent">↑</button>
          <label class="hidden-toggle">
            <input type="checkbox" :checked="showHidden" @change="toggleHidden" />
            hidden
          </label>
        </div>

        <div class="tree-body">
          <p v-if="loading" class="tree-note">Loading…</p>
          <p v-else-if="error" class="tree-error">{{ error }}</p>
          <div v-else-if="dirs.length === 0" class="tree-note">No directories</div>
          <ul v-else class="dir-list">
            <li v-for="d in dirs" :key="d.path">
              <button class="dir-row" type="button" @click="onDirClick(d)">
                <span class="dir-icon">📁</span>
                <span class="dir-name">{{ d.name }}</span>
                <span class="dir-pick" title="Use this directory" @click.stop="useDir(d)">✓</span>
              </button>
            </li>
          </ul>
        </div>

        <div class="tree-footer">
          <span class="selected-path" :title="path">{{ path }}</span>
          <button class="use-btn" type="button" :disabled="!path" @click="useCurrent">
            Use this directory
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dir-picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cwd-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.cwd-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
}

.browse-btn {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
  font-size: 0.875rem;
}

.tree-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 39, 35, 0.28);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tree-panel {
  width: min(560px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 10px 32px rgba(43, 39, 35, 0.14);
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
}

.tree-title {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.tree-close {
  border: none;
  background: none;
  font-size: 1.4rem;
  cursor: pointer;
  color: var(--text-secondary, #666);
}

.crumb-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color, #eee);
  flex-wrap: wrap;
}

.crumb {
  border: none;
  background: none;
  color: var(--text-accent, #c2532f);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
}

.crumb-sep {
  color: var(--text-secondary, #999);
}

.spacer {
  flex: 1;
}

.small-btn {
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--bg-main, #fbf8f3);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0.1rem 0.5rem;
}

.hidden-toggle {
  font-size: 0.8rem;
  color: var(--text-secondary, #666);
  display: flex;
  align-items: center;
  gap: 0.2rem;
}

.tree-body {
  flex: 1;
  overflow-y: auto;
  min-height: 220px;
}

.tree-note,
.tree-error {
  padding: 1rem;
  font-size: 0.9rem;
}

.tree-error {
  color: #c0392b;
}

.dir-list {
  list-style: none;
  margin: 0;
  padding: 0.25rem;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 26px;
  padding: 0.125rem 0.5rem;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.8125rem;
  color: inherit;
  text-align: left;
  border-radius: var(--radius-md, 6px);
}

.dir-row:hover {
  background: var(--bg-hover, #efe9e0);
}

.dir-icon {
  flex: 0 0 auto;
}

.dir-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dir-pick {
  flex: 0 0 auto;
  opacity: 0;
  color: var(--text-accent, #c2532f);
  font-weight: 700;
}

.dir-row:hover .dir-pick {
  opacity: 1;
}

.tree-footer {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border-color, #e0e0e0);
}

.selected-path {
  flex: 1;
  font-size: 0.8rem;
  color: var(--text-secondary, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.use-btn {
  height: 30px;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: var(--text-accent, #c2532f);
  color: var(--bg-main, #fbf8f3);
  padding: 0 0.875rem;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
}
</style>
