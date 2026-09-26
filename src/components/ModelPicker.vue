<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import type { ModelInfo } from '../lib/types';

const props = defineProps<{
  models: ModelInfo[];
  currentModelId: string;
  disabled?: boolean;
  /** Borderless inline chip for the composer's bottom menu. */
  compact?: boolean;
}>();

const emit = defineEmits<{
  change: [modelId: string];
}>();

const isOpen = ref(false);
const search = ref('');
const searchInput = ref<HTMLInputElement | null>(null);

const currentModel = computed(() => 
  props.models.find(m => m.modelId === props.currentModelId)
);

// The list is the union of every provider's catalog — substring match on
// name, id and description (which carries "Provider: <name>") so a provider
// name alone narrows the list to its models.
const filteredModels = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.models;
  return props.models.filter(m =>
    m.modelId.toLowerCase().includes(q) ||
    m.name.toLowerCase().includes(q) ||
    (m.description ?? '').toLowerCase().includes(q)
  );
});

function toggleDropdown() {
  if (!props.disabled) {
    isOpen.value = !isOpen.value;
    if (isOpen.value) {
      search.value = '';
      void nextTick(() => searchInput.value?.focus());
    }
  }
}

function selectModel(modelId: string) {
  if (modelId !== props.currentModelId) {
    emit('change', modelId);
  }
  isOpen.value = false;
}

function selectFirstMatch() {
  const first = filteredModels.value[0];
  if (first) selectModel(first.modelId);
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest('.model-picker')) {
    isOpen.value = false;
  }
}

// Close dropdown when clicking outside
if (typeof window !== 'undefined') {
  window.addEventListener('click', handleClickOutside);
}
onBeforeUnmount(() => window.removeEventListener('click', handleClickOutside));
</script>

<template>
  <div class="model-picker" :class="{ disabled, compact }">
    <button 
      class="model-button"
      :disabled="disabled"
      @click.stop="toggleDropdown"
      :title="currentModel?.name || currentModelId"
    >
      <svg v-if="compact" class="model-spark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>
      <span class="model-name">{{ currentModel?.name || currentModelId }}</span>
      <span class="dropdown-arrow">{{ isOpen ? '▲' : '▼' }}</span>
    </button>
    
    <Transition name="dropdown">
      <div v-if="isOpen" class="dropdown-menu" @click.stop>
        <div class="dropdown-search">
          <input
            ref="searchInput"
            v-model="search"
            type="search"
            class="search-input"
            placeholder="Filter models…"
            aria-label="Filter models"
            @keydown.esc.stop="isOpen = false"
            @keydown.enter.prevent="selectFirstMatch"
          />
        </div>
        <div class="dropdown-list">
          <div
            v-for="model in filteredModels"
            :key="model.modelId"
            :class="['dropdown-item', { selected: model.modelId === currentModelId }]"
            @click="selectModel(model.modelId)"
          >
            <div class="item-content">
              <span class="item-name">{{ model.name }}</span>
              <span v-if="model.description" class="item-description">
                {{ model.description }}
              </span>
            </div>
            <span v-if="model.modelId === currentModelId" class="check-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg></span>
          </div>
          <div v-if="filteredModels.length === 0" class="dropdown-empty">No models match</div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.model-picker {
  position: relative;
  display: inline-block;
}

.model-picker.disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* Composer chip: text-like dropdown, no frame until hovered. */
.model-picker.compact .model-button {
  border: none;
  background: transparent;
  padding: 0.25rem 0.375rem;
  color: var(--text-secondary, #6b6259);
  font-size: 0.78rem;
  max-width: 220px;
}

.model-picker.compact .model-button:hover:not(:disabled) {
  background: var(--bg-hover);
  border: none;
}

.model-spark {
  flex-shrink: 0;
}

/* The chip sits in the composer's bottom menu — an upward dropdown is the
 * only one that fits inside the viewport (downward ran off-screen). */
.model-picker.compact .dropdown-menu {
  top: auto;
  bottom: calc(100% + 6px);
}

.model-button {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
  max-width: 200px;
}

.model-button:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--text-accent);
}

.model-button:disabled {
  cursor: not-allowed;
}

.model-icon {
  font-size: 0.9rem;
  flex-shrink: 0;
}

.model-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dropdown-arrow {
  font-size: 0.6rem;
  color: var(--text-muted);
  margin-left: 0.25rem;
  flex-shrink: 0;
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 280px;
  max-width: 360px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  z-index: 100;
}

.dropdown-search {
  padding: 0.375rem;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  height: 28px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.8rem;
}

.search-input:focus {
  outline: none;
  border-color: var(--text-accent);
}

.dropdown-list {
  overflow-y: auto;
  min-height: 0;
}

.dropdown-empty {
  padding: 0.625rem 0.75rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

@media (prefers-color-scheme: dark) {
  .dropdown-menu {
  }
}

/* On phones the menu's anchored width (`min-width: 280px`) overflows the
   viewport. Re-anchor to the viewport itself, leaving a small margin on
   each side, so the menu becomes a full-width sheet that always fits. */
@media (max-width: 800px) {
  .dropdown-menu {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 4rem);
    left: 0.5rem;
    right: 0.5rem;
    bottom: auto;
    min-width: 0;
    max-width: none;
    max-height: calc(100vh - 6rem);
  }
}

.dropdown-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  cursor: pointer;
  transition: background 0.1s ease;
}

.dropdown-item:hover {
  background: var(--bg-hover);
}

.dropdown-item.selected {
  background: var(--bg-user);
}

.dropdown-item + .dropdown-item {
  border-top: 1px solid var(--border-color);
}

.item-icon {
  font-size: 1rem;
  flex-shrink: 0;
  margin-top: 0.125rem;
}

.item-content {
  flex: 1;
  min-width: 0;
}

.item-name {
  display: block;
  font-weight: 500;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.item-description {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 0.125rem;
  line-height: 1.3;
}

.check-mark {
  color: var(--text-accent);
  font-weight: bold;
  margin-left: auto;
  flex-shrink: 0;
}

/* Dropdown animation */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
