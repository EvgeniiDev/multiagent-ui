<script setup lang="ts">
import { computed, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import { restrictedTransports } from '../lib/platform';

const emit = defineEmits<{
  select: [agentName: string];
}>();

const configStore = useConfigStore();

const selectedAgent = defineModel<string>('selected', { default: '' });

const agents = computed(() => configStore.agentNames);
const hasAgents = computed(() => configStore.hasAgents);
const configPath = computed(() => configStore.configPath);
// On mobile / web the config-file path is not actionable (sandbox /
// localStorage). Point users at the Settings dialog instead of the path.
const restricted = restrictedTransports();

/** Build the display label for each agent once, instead of calling
 * `getAgentTransportKind` twice per option in the template. */
const agentLabels = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const name of agents.value) {
    const kind = configStore.getAgentTransportKind(name);
    out[name] = kind === 'stdio' ? name : `${name} (${kind})`;
  }
  return out;
});

// Auto-select first agent when agents are available and none selected
watch(agents, (newAgents) => {
  if (newAgents.length > 0 && !selectedAgent.value) {
    selectedAgent.value = newAgents[0];
    emit('select', newAgents[0]);
  }
}, { immediate: true });

function handleSelect(event: Event) {
  const target = event.target as HTMLSelectElement;
  selectedAgent.value = target.value;
  if (target.value) {
    emit('select', target.value);
  }
}
</script>

<template>
  <div class="agent-selector">
    <label for="agent-select">Agent:</label>
    <select 
      id="agent-select" 
      :value="selectedAgent"
      @change="handleSelect"
      :disabled="!hasAgents"
    >
      <option value="" disabled>
        {{ hasAgents ? 'Select an agent...' : 'No agents configured' }}
      </option>
      <option v-for="agent in agents" :key="agent" :value="agent">
        {{ agentLabels[agent] }}
      </option>
    </select>
    
    <div v-if="!hasAgents" class="config-hint">
      <template v-if="restricted">
        <p>No remote agents configured.</p>
        <p class="hint-action">Open Settings (⚙) to add one.</p>
      </template>
      <template v-else>
        <p>No agents found. Add agents to:</p>
        <code>{{ configPath }}</code>
      </template>
    </div>
  </div>
</template>

<style scoped>
.agent-selector {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

select {
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  font-family: inherit;
  font-size: 0.8125rem;
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
}

select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.config-hint {
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--bg-warning, #fff3cd);
  border-radius: 4px;
  font-size: 0.875rem;
}

.config-hint code {
  display: block;
  margin-top: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: var(--bg-code, #f5f5f5);
  border-radius: 2px;
  font-family: monospace;
  word-break: break-all;
}
</style>
