<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import { ref, computed, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import { useSessionStore } from '../stores/session';
import ProjectsSection from '../features/settings/ProjectsSection.vue';
import RolesSection from '../features/roles/RolesSection.vue';
import { addAgent, removeAgent, updateAgent } from '../lib/host';
import { getTransportKind, type AgentTransportKind } from '../lib/types';
import { restrictedTransports } from '../lib/platform';
import EnvVarEditor from './EnvVarEditor.vue';
import PwaSettings from './PwaSettings.vue';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const configStore = useConfigStore();
const sessionStore = useSessionStore();

// Sidebar filter: title prefixes hidden from the session list
// (subagent runs like `porch-delegate#…`). One per line in the box.
const hiddenPrefixesText = ref(sessionStore.hiddenSessionPrefixes.join('\n'));
watch(
  () => sessionStore.hiddenSessionPrefixes,
  (prefixes) => {
    hiddenPrefixesText.value = prefixes.join('\n');
  }
);
async function saveHiddenPrefixes() {
  await sessionStore.setHiddenSessionPrefixes(hiddenPrefixesText.value.split('\n'));
}

interface AgentRow {
  name: string;
  transport: AgentTransportKind;
  command: string;
  args: string;
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

// True on iOS / Android / web: hide the stdio option in the form, and
// filter stdio agents out of the list entirely (they can't run there
// anyway).
const restricted = restrictedTransports();

const agents = computed<AgentRow[]>(() => {
  const entries = Object.entries(configStore.config.agents);
  // On restricted hosts (mobile / web), hide stdio agents entirely. They
  // can't run there (no subprocess), and showing them with a disabled
  // Edit button just creates confusion. The raw entries remain in the
  // config so a desktop sync round-trips them losslessly.
  const filtered = restricted
    ? entries.filter(([, c]) => getTransportKind(c) !== 'stdio')
    : entries;
  return filtered.map(([name, config]) => ({
    name,
    transport: getTransportKind(config),
    command: config.command ?? '',
    args: (config.args ?? []).join(' '),
    env: config.env ?? {},
    url: config.url ?? '',
    headers: config.headers ?? {},
  }));
});

// Form state
const showAddForm = ref(false);
const editingAgent = ref<string | null>(null);
const formName = ref('');
const formTransport = ref<AgentTransportKind>(restricted ? 'websocket' : 'stdio');
const formCommand = ref('');
const formArgs = ref('');
const formEnv = ref<Record<string, string>>({});
const formUrl = ref('');
const formHeaders = ref<Record<string, string>>({});
const formError = ref('');
const isSubmitting = ref(false);

function resetForm() {
  formName.value = '';
  formTransport.value = restricted ? 'websocket' : 'stdio';
  formCommand.value = '';
  formArgs.value = '';
  formEnv.value = {};
  formUrl.value = '';
  formHeaders.value = {};
  formError.value = '';
  showAddForm.value = false;
  editingAgent.value = null;
}

function startAdd() {
  resetForm();
  showAddForm.value = true;
}

function startEdit(agent: AgentRow) {
  resetForm();
  editingAgent.value = agent.name;
  formName.value = agent.name;
  formTransport.value = agent.transport;
  formCommand.value = agent.command;
  formArgs.value = agent.args;
  formEnv.value = { ...agent.env };
  formUrl.value = agent.url;
  formHeaders.value = { ...agent.headers };
}

function parseArgs(argsString: string): string[] {
  // Simple arg parsing - split on spaces but respect quotes
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (const char of argsString) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

async function handleSubmit() {
  formError.value = '';

  if (!formName.value.trim()) {
    formError.value = 'Name is required';
    return;
  }

  // Validate agent name is not purely numeric (JavaScript object key ordering issue)
  if (/^\d+$/.test(formName.value)) {
    formError.value = 'Agent name cannot be purely numeric';
    return;
  }

  const transport = formTransport.value;
  const isRemote = transport !== 'stdio';

  if (isRemote) {
    if (!formUrl.value.trim()) {
      formError.value = 'URL is required for remote agents';
      return;
    }
    const lower = formUrl.value.trim().toLowerCase();
    if (transport === 'websocket' && !(lower.startsWith('ws://') || lower.startsWith('wss://'))) {
      formError.value = 'WebSocket URL must start with ws:// or wss://';
      return;
    }
    if (transport === 'http' && !(lower.startsWith('http://') || lower.startsWith('https://'))) {
      formError.value = 'HTTP URL must start with http:// or https://';
      return;
    }
  } else {
    if (!formCommand.value.trim()) {
      formError.value = 'Command is required';
      return;
    }
  }

  const args = isRemote ? [] : parseArgs(formArgs.value);
  isSubmitting.value = true;

  try {
    const remoteOpts = isRemote
      ? {
          transport: transport as 'websocket' | 'http',
          url: formUrl.value.trim(),
          headers: Object.keys(formHeaders.value).length > 0 ? formHeaders.value : undefined,
        }
      : {};
    const command = isRemote ? null : formCommand.value;
    const env = isRemote ? {} : formEnv.value;

    if (editingAgent.value) {
      const newConfig = await updateAgent(formName.value, command, args, env, remoteOpts);
      configStore.updateFromEvent(newConfig);
    } else {
      // Check for duplicates
      if (configStore.config.agents[formName.value]) {
        formError.value = 'An agent with this name already exists';
        isSubmitting.value = false;
        return;
      }
      const newConfig = await addAgent(formName.value, command, args, env, remoteOpts);
      configStore.updateFromEvent(newConfig);
    }
    resetForm();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSubmitting.value = false;
  }
}

async function handleDelete(name: string) {
  if (!confirm(`Delete agent "${name}"?`)) return;

  try {
    const newConfig = await removeAgent(name);
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to delete agent:', e);
  }
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <UiButton class="close-btn" aria-label="Close" @click="emit('close')" variant="ghost" icon><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></UiButton>
      </div>

      <div class="settings-content">
        <PwaSettings />
        <section class="agents-section">
          <div class="section-header">
            <h3>Agents</h3>
            <UiButton class="add-btn" @click="startAdd" :disabled="showAddForm">
              + Add Agent
            </UiButton>
          </div>

          <!-- Add/Edit Form -->
          <div v-if="showAddForm || editingAgent" class="agent-form">
            <h4>{{ editingAgent ? 'Edit Agent' : 'Add New Agent' }}</h4>

            <div class="form-group">
              <label>Name</label>
              <input class="ui-input"
                v-model="formName"
                type="text"
                placeholder="My Agent"
                :disabled="!!editingAgent"
              />
            </div>

            <div class="form-group">
              <label>Transport</label>
              <select class="ui-input" v-model="formTransport">
                <option v-if="!restricted" value="stdio">stdio (local subprocess)</option>
                <option value="websocket">websocket (remote)</option>
                <option value="http">http (remote)</option>
              </select>
              <small v-if="restricted">stdio is not available on this platform.</small>
            </div>

            <template v-if="formTransport === 'stdio'">
              <div class="form-group">
                <label>Command</label>
                <input class="ui-input"
                  v-model="formCommand"
                  type="text"
                  placeholder="npx"
                />
              </div>

              <div class="form-group">
                <label>Arguments</label>
                <input class="ui-input"
                  v-model="formArgs"
                  type="text"
                  placeholder="-y @example/agent"
                />
                <small>Space-separated. Use quotes for args with spaces.</small>
              </div>

              <div class="form-group">
                <EnvVarEditor v-model="formEnv" />
              </div>
            </template>

            <template v-else>
              <div class="form-group">
                <label>URL</label>
                <input class="ui-input"
                  v-model="formUrl"
                  type="text"
                  :placeholder="formTransport === 'websocket' ? 'wss://acp.example.com/v1' : 'https://acp.example.com/v1'"
                />
                <small>
                  {{ formTransport === 'websocket' ? 'WebSocket endpoint (ws:// or wss://)' : 'Streamable HTTP endpoint (http:// or https://)' }}
                </small>
              </div>

              <div class="form-group">
                <label>Headers</label>
                <EnvVarEditor v-model="formHeaders" />
                <small>
                  Authorization headers are sent over the connection. Browser WebSocket APIs
                  cannot attach arbitrary HTTP headers; an <code>Authorization: Bearer &lt;token&gt;</code>
                  header is forwarded as a <code>bearer.&lt;token&gt;</code> WebSocket subprotocol.
                </small>
              </div>
            </template>

            <div v-if="formError" class="form-error">
              {{ formError }}
            </div>

            <div class="form-actions">
              <UiButton
                class="save-btn"
                @click="handleSubmit"
                :disabled="isSubmitting"
                variant="primary"
              >
                {{ isSubmitting ? 'Saving...' : 'Save' }}
              </UiButton>
              <UiButton class="cancel-btn" @click="resetForm">
                Cancel
              </UiButton>
            </div>
          </div>

          <!-- Agent List -->
          <div class="agents-list">
            <div
              v-for="agent in agents"
              :key="agent.name"
              class="agent-item"
            >
              <div class="agent-info">
                <div class="agent-name">
                  {{ agent.name }}
                  <span class="agent-transport-badge" :data-kind="agent.transport">{{ agent.transport }}</span>
                </div>
                <div class="agent-command">
                  <code v-if="agent.transport === 'stdio'">{{ agent.command }} {{ agent.args }}</code>
                  <code v-else>{{ agent.url }}</code>
                </div>
              </div>
              <div class="agent-actions">
                <UiButton class="edit-btn" @click="startEdit(agent)">
                  Edit
                </UiButton>
                <UiButton class="delete-btn" @click="handleDelete(agent.name)" variant="danger">
                  Delete
                </UiButton>
              </div>
            </div>

            <div v-if="agents.length === 0" class="no-agents">
              No agents configured. Add one to get started!
            </div>
          </div>
        </section>

        <section class="config-section">
          <h3>Sessions</h3>
          <div class="form-group">
            <label>Hidden title prefixes</label>
            <textarea class="ui-input"
              v-model="hiddenPrefixesText"
              rows="3"
              placeholder="porch-delegate#"
              @change="saveHiddenPrefixes"
            />
            <small>Sessions whose title starts with one of these (one per line) are hidden from the sidebar.</small>
          </div>
        </section>

        <ProjectsSection />

        <RolesSection />

        <section class="config-section">
          <h3>Config File</h3>
          <p class="config-path">{{ configStore.configPath }}</p>
          <small>Changes to this file are automatically reloaded.</small>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 39, 35, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.agent-transport-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  vertical-align: middle;
  border: 1px solid transparent;
  /* Default (stdio) — emerald to convey "local process". */
  background: var(--bg-warning, #f5e9cf);
  color: var(--bg-success, #5a7d4f);
  border-color: var(--border-faint, rgba(43, 39, 35, 0.09));
}
.agent-transport-badge[data-kind='websocket'],
.agent-transport-badge[data-kind='http'] {
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
  color: var(--text-accent, #c2532f);
  border-color: var(--border-faint, rgba(43, 39, 35, 0.09));
}

.settings-panel {
  background: var(--bg-main);
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  max-height: 90dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: none;
}

.settings-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.settings-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.settings-content {
  min-height: 0;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  padding: 1.25rem;
  overflow-y: auto;
}

.section-header {
  gap: 0.75rem;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-header h3 {
  margin: 0;
}

.agent-form {
  background: var(--bg-sidebar);
  padding: 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}

.agent-form h4 {
  margin: 0 0 1rem 0;
  font-size: 1rem;
}

.form-group {
  margin-bottom: 0.75rem;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.form-error {
  color: var(--bg-danger);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}

.form-actions {
  flex-wrap: wrap;
  display: flex;
  gap: 0.5rem;
}

.agents-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.agent-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  background: var(--bg-sidebar);
  border-radius: 6px;
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name {
  overflow-wrap: anywhere;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.agent-command {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.agent-command code {
  background: var(--bg-main);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  word-break: break-all;
}

.agent-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
  margin-left: 1rem;
}

.no-agents {
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
}

.config-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-color);
}

.config-section h3 {
  margin: 0 0 0.5rem 0;
}

.config-path {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
  background: var(--bg-sidebar);
  padding: 0.5rem;
  border-radius: 4px;
  word-break: break-all;
  margin-bottom: 0.25rem;
}

.config-section small {
  font-size: 0.75rem;
  color: var(--text-muted);
}
@media (max-width: 600px) {
  .settings-panel {
    width: 100%;
    max-width: none;
    height: 100%;
    height: 100dvh;
    max-height: 100%;
    border-radius: 0;
  }
  .settings-header {
    padding: max(0.5rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.5rem max(1rem, env(safe-area-inset-left));
  }
  .settings-content {
    padding: 1rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  }
  .agent-item { flex-direction: column; align-items: stretch; gap: 0.75rem; }
  .agent-actions { margin-left: 0; }
  .agent-actions > * { flex: 1; }
}
</style>
