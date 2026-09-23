<script setup lang="ts">
// "New session" dialog — one implementation, two entry points (Projects
// header, Chat header). Starts a session independent of any project: an
// agent picker fed by the configured agents plus an optional working
// directory. An empty cwd is passed through as '' — the agent then uses its
// own default directory. On success the app switches to the Chat view,
// exactly like the project-scoped "New session here" path.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSessionStore } from '../../stores/session';
import { useConfigStore } from '../../stores/config';
import { useUiStore } from '../../stores/ui';
import DirectoryPicker from '../../components/DirectoryPicker.vue';

const emit = defineEmits<{
  close: [];
}>();

const sessionStore = useSessionStore();
const configStore = useConfigStore();
const uiStore = useUiStore();

const agent = ref('');
const cwd = ref('');
const busy = ref(false);
const error = ref('');

const agents = computed(() => configStore.agentNames);

/** Display labels — stdio agents are plain names, remote ones carry their
 * transport (same convention as AgentSelector). */
const agentLabels = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const name of agents.value) {
    const kind = configStore.getAgentTransportKind(name);
    out[name] = kind === 'stdio' ? name : `${name} (${kind})`;
  }
  return out;
});

// Preselect the first configured agent so a lone agent needs no picking.
watch(agents, (names) => {
  if (!agent.value || !names.includes(agent.value)) {
    agent.value = names[0] ?? '';
  }
}, { immediate: true });

/** HTTP base URL of the selected agent's bridge (same origin as its ws
 * URL). The DirectoryPicker lists directories through `/api/fs/*` on this
 * bridge; with no ws URL the browse button just has nothing to talk to and
 * the plain text input still works. */
const fsBaseUrl = computed(() => {
  const cfg = configStore.getAgent(agent.value);
  const u = cfg?.url?.trim() ?? '';
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return (u.startsWith('wss://') ? 'https://' : 'http://') + u.slice(u.indexOf('://') + 3).replace(/\/+$/, '');
  }
  return '';
});

async function confirm() {
  if (!agent.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await sessionStore.createSession(agent.value, cwd.value.trim());
    emit('close');
    await uiStore.setView('chat');
  } catch (e) {
    // The store already surfaces this via its error banner; keeping the
    // dialog open with the message inline makes the failed click legible.
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="ns-overlay" @click.self="emit('close')">
    <div class="ns-dialog" role="dialog" aria-modal="true" aria-label="New session">
      <header class="ns-head">
        <h3>New session</h3>
        <button
          class="ns-close"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>

      <div class="ns-body">
        <label class="ns-label" for="ns-agent">Agent</label>
        <select
          id="ns-agent"
          v-model="agent"
          class="ns-select"
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

        <label class="ns-label">
          Working directory <span class="ns-optional">(optional)</span>
        </label>
        <DirectoryPicker
          :base-url="fsBaseUrl"
          v-model="cwd"
          :disabled="busy"
        />
        <p class="ns-hint">Leave empty to use the agent&rsquo;s default directory.</p>

        <p v-if="error" class="ns-error">{{ error }}</p>
      </div>

      <footer class="ns-foot">
        <button class="ns-cancel" type="button" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button
          class="ns-confirm"
          type="button"
          :disabled="!agent || busy"
          @click="confirm"
        >
          {{ busy ? 'Starting…' : 'Start session' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.ns-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 39, 35, 0.28);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ns-dialog {
  width: min(460px, 92vw);
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

.ns-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.ns-head h3 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.ns-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
}

.ns-close:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.ns-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem 1rem;
  overflow-y: auto;
}

.ns-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.ns-label:not(:first-child) {
  margin-top: 0.5rem;
}

.ns-optional {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.ns-select {
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
}

.ns-hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.ns-error {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  color: var(--bg-danger, #b3402e);
}

.ns-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.ns-cancel {
  height: 30px;
  padding: 0 0.875rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

.ns-cancel:hover:not(:disabled) {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.ns-confirm {
  height: 30px;
  padding: 0 0.875rem;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.ns-confirm:hover:not(:disabled) {
  background: var(--bg-primary-hover, #a8431f);
}

.ns-confirm:disabled,
.ns-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 800px) {
  .ns-select,
  .ns-cancel,
  .ns-confirm {
    min-height: 44px;
  }

  .ns-close {
    width: 44px;
    height: 44px;
  }

  .ns-body :deep(.cwd-input),
  .ns-body :deep(.browse-btn) {
    min-height: 44px;
  }
}
</style>
