<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import { ref, watch, computed } from 'vue';

interface EnvVar {
  key: string;
  value: string;
}

const props = defineProps<{
  modelValue: Record<string, string>;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void;
}>();

const envVars = ref<EnvVar[]>([]);

// Convert Record to array for editing
watch(
  () => props.modelValue,
  (newValue) => {
    envVars.value = Object.entries(newValue || {}).map(([key, value]) => ({
      key,
      value,
    }));
  },
  { immediate: true }
);

// Emit changes when envVars change
function emitUpdate() {
  const result: Record<string, string> = {};
  for (const env of envVars.value) {
    if (env.key.trim()) {
      result[env.key.trim()] = env.value;
    }
  }
  emit('update:modelValue', result);
}

function addEnvVar() {
  envVars.value.push({ key: '', value: '' });
}

function removeEnvVar(index: number) {
  envVars.value.splice(index, 1);
  emitUpdate();
}

function onKeyChange(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  envVars.value[index].key = input.value;
  emitUpdate();
}

function onValueChange(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  envVars.value[index].value = input.value;
  emitUpdate();
}

const hasEnvVars = computed(() => envVars.value.length > 0);
</script>

<template>
  <div class="env-var-editor">
    <div class="env-header">
      <span class="env-label">Environment Variables</span>
      <UiButton type="button" class="add-env-btn" @click="addEnvVar">
        + Add
      </UiButton>
    </div>

    <div v-if="hasEnvVars" class="env-list">
      <div v-for="(env, index) in envVars" :key="index" class="env-row">
        <input
          type="text"
          class="ui-input env-key"
          placeholder="KEY"
          :value="env.key"
          @input="onKeyChange(index, $event)"
        />
        <span class="env-equals">=</span>
        <input
          type="text"
          class="ui-input env-value"
          placeholder="value"
          :value="env.value"
          @input="onValueChange(index, $event)"
        />
        <UiButton
          type="button"
          class="remove-env-btn"
          @click="removeEnvVar(index)"
          title="Remove"
          aria-label="Remove"
          variant="ghost" icon
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </UiButton>
      </div>
    </div>

    <div v-else class="env-empty">
      No environment variables configured.
    </div>
  </div>
</template>

<style scoped>
.env-var-editor {
  margin-top: 0.5rem;
}

.env-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.env-label {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.env-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.env-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.env-equals {
  color: var(--text-secondary);
  padding: 0 0.25rem;
}

.env-empty {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-style: italic;
}

.env-key { flex: 0 1 120px; }
.env-value { flex: 1; }
@media (max-width: 600px) {
  .env-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 0.5rem; }
  .env-key, .env-value { grid-column: 1; }
  .env-equals { display: none; }
  .remove-env-btn { grid-column: 2; grid-row: 1 / 3; }
}
</style>
