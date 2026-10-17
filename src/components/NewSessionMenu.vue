<script setup lang="ts">
// "+" at the left of the tab strip — the new-session entry point. Clicking it
// drops down a small form: which agent, which working directory. Both prefill
// from the last choice (sessions.json `lastAgent`, preferences.json `lastCwd`)
// so a repeat start is one click on Start. An empty cwd is passed through as
// '' — the agent then uses its own default directory.
//
// The dropdown is teleported to <body> with fixed positioning: on the narrow
// layout its anchor bar is `overflow: hidden`, so an in-place absolute panel
// would be clipped.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import UiButton from './ui/UiButton.vue';
import DirectoryPicker from './DirectoryPicker.vue';
import { useConfigStore } from '../stores/config';
import { useSessionStore } from '../stores/session';
import { canPickFolder, pickFolder, loadKvStore, type KVStore } from '../lib/host';

const configStore = useConfigStore();
const sessionStore = useSessionStore();

const open = ref(false);
const agent = ref('');
const cwd = ref('');
const busy = ref(false);
const error = ref('');
const rootEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

let prefs: KVStore | null = null;
// Desktop (Tauri): native folder picker; elsewhere: bridge fs tree browser.
const folderPickerAvailable = canPickFolder();

const agents = computed(() => configStore.agentNames);

/** Display labels — stdio agents are plain names, remote ones carry their
 * transport (same convention as NewSessionDialog). */
const agentLabels = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const name of agents.value) {
    const kind = configStore.getAgentTransportKind(name);
    out[name] = kind === 'stdio' ? name : `${name} (${kind})`;
  }
  return out;
});

// Prefill: the last used agent wins; fall back to the first configured one.
watch(agents, (names) => {
  const last = sessionStore.lastAgentName;
  if (!agent.value || !names.includes(agent.value)) {
    agent.value = last && names.includes(last) ? last : (names[0] ?? '');
  }
}, { immediate: true });

/** HTTP base URL of the selected agent's bridge — the DirectoryPicker lists
 * directories through `/api/fs/*` on this bridge; with no ws URL the browse
 * button has nothing to talk to and the plain text input still works. */
const fsBaseUrl = computed(() => {
  const cfg = configStore.getAgent(agent.value);
  const u = cfg?.url?.trim() ?? '';
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return (u.startsWith('wss://') ? 'https://' : 'http://') + u.slice(u.indexOf('://') + 3).replace(/\/+$/, '');
  }
  return '';
});

/** Disabled while any tab is mid-connect — a double click would spawn two
 * agents for one intent (the session list's old "+" used the same gate). */
const blocked = computed(() => sessionStore.anySessionConnecting);

function positionMenu() {
  const rect = rootEl.value?.getBoundingClientRect();
  if (!rect) return;
  const width = Math.min(300, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  menuStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${left}px`,
    width: `${width}px`,
  };
}

async function toggle() {
  if (busy.value) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  error.value = '';
  await nextTick();
  positionMenu();
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onScroll, true);
}

function close() {
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', onScroll, true);
}

function onOutside(e: Event) {
  const t = e.target as Node;
  if (rootEl.value?.contains(t) || menuEl.value?.contains(t)) return;
  close();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}

// Background chat updates auto-scroll the feed too. Keep the menu and its
// directory browser mounted, and follow the anchor if it actually moves.
function onScroll(e: Event) {
  const t = e.target as Node | null;
  if (t && menuEl.value?.contains(t)) return;
  positionMenu();
}

async function pickNative() {
  const folder = await pickFolder('Select Working Directory');
  if (folder) cwd.value = folder;
}

async function start() {
  if (!agent.value || busy.value) return;
  busy.value = true;
  error.value = '';
  const dir = cwd.value.trim();
  try {
    // Remember the choice — the next menu opens prefilled with it.
    if (prefs) {
      await prefs.set('lastCwd', dir);
      await prefs.save();
    }
    await sessionStore.createSession(agent.value, dir);
    close();
  } catch (e) {
    // The store also surfaces this via the tab's error banner; keeping the
    // menu open with the message inline makes the failed click legible.
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  prefs = await loadKvStore('preferences.json');
  const saved = await prefs.get<string>('lastCwd');
  if (saved && !cwd.value) cwd.value = saved;
});
onBeforeUnmount(close);
</script>

<template>
  <div ref="rootEl" class="nsm">
    <UiButton
      icon
      size="xs"
      variant="ghost"
      class="tab-new"
      :disabled="blocked"
      :aria-expanded="open"
      aria-haspopup="dialog"
      title="New session"
      aria-label="New session"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
    </UiButton>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="nsm-menu"
        :style="menuStyle"
        role="dialog"
        aria-label="New session"
      >
        <label class="nsm-label" for="nsm-agent">Agent</label>
        <select
          id="nsm-agent"
          v-model="agent"
          class="nsm-select"
          :disabled="busy || agents.length === 0"
          aria-label="Agent"
        >
          <option value="" disabled>
            {{ agents.length ? 'Select an agent…' : 'No agents configured' }}
          </option>
          <option v-for="name in agents" :key="name" :value="name">
            {{ agentLabels[name] }}
          </option>
        </select>

        <label class="nsm-label">
          Working directory <span class="nsm-optional">(optional)</span>
        </label>
        <!-- Desktop: read-only display + native folder picker. -->
        <div v-if="folderPickerAvailable" class="nsm-cwd-row">
          <span class="nsm-cwd-path" :title="cwd || 'Agent’s default directory'">
            {{ cwd ? cwd.split(/[\\/]/).pop() : '.' }}
          </span>
          <button
            class="nsm-cwd-btn"
            type="button"
            title="Select folder"
            aria-label="Select folder"
            :disabled="busy"
            @click="pickNative"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          </button>
        </div>
        <!-- Web / mobile: bridge fs tree browser + editable path. The path is
             interpreted on the agent's host. -->
        <DirectoryPicker
          v-else
          :base-url="fsBaseUrl"
          v-model="cwd"
          :disabled="busy"
        />
        <p class="nsm-hint">Leave empty to use the agent&rsquo;s default directory.</p>

        <p v-if="error" class="nsm-error">{{ error }}</p>

        <div class="nsm-foot">
          <UiButton
            variant="primary"
            class="nsm-start"
            :disabled="!agent || busy"
            :aria-busy="busy"
            @click="start"
          >
            {{ busy ? 'Starting…' : 'Start session' }}
          </UiButton>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.nsm {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
}

.tab-new {
  align-self: center;
}
</style>

<!-- The menu is teleported to <body> — scoped styles can't reach it, so its
     block lives unscoped. Class names are nsm-* to stay collision-free. -->
<style>
.nsm-menu {
  position: fixed;
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.75rem;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
  box-shadow: 0 10px 32px rgba(43, 39, 35, 0.14);
}

.nsm-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.nsm-label:not(:first-child) {
  margin-top: 0.5rem;
}

.nsm-optional {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.nsm-select {
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
}

.nsm-cwd-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.nsm-cwd-path {
  flex: 1;
  min-width: 0;
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 0.5rem;
  background: var(--bg-main, #fbf8f3);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nsm-cwd-btn {
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
}

.nsm-hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.nsm-error {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  color: var(--bg-danger, #b3402e);
}

.nsm-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

@media (max-width: 800px) {
  .nsm-select,
  .nsm-cwd-btn,
  .nsm-foot .nsm-start {
    min-height: 44px;
  }

  .nsm-cwd-btn {
    min-width: 44px;
  }
}
</style>
