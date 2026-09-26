<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SessionMode } from '../lib/types';

const props = defineProps<{
  modes: SessionMode[];
  currentModeId: string;
  disabled?: boolean;
  /** Borderless inline chip for the composer's bottom menu — strips a
   * "Thinking: "-style prefix and reads as plain text with a caret. */
  compact?: boolean;
}>();

const emit = defineEmits<{
  change: [modeId: string];
}>();

const isOpen = ref(false);

const currentMode = computed(() => 
  props.modes.find(m => m.id === props.currentModeId)
);

// Compact chip label: agents name modes like "Thinking: high" — the prefix
// is context the composer menu already provides, show just the value.
const compactLabel = computed(() => {
  const name = currentMode.value?.name || props.currentModeId;
  const i = name.lastIndexOf(':');
  return i >= 0 ? name.slice(i + 1).trim() : name;
});

function toggleDropdown() {
  if (!props.disabled) {
    isOpen.value = !isOpen.value;
  }
}

function selectMode(modeId: string) {
  if (modeId !== props.currentModeId) {
    emit('change', modeId);
  }
  isOpen.value = false;
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest('.mode-picker')) {
    isOpen.value = false;
  }
}

// Close dropdown when clicking outside
if (typeof window !== 'undefined') {
  window.addEventListener('click', handleClickOutside);
}
</script>

<template>
  <div class="mode-picker" :class="{ disabled, compact }">
    <button 
      class="mode-button"
      :disabled="disabled"
      @click.stop="toggleDropdown"
    >
      <svg v-if="compact" class="effort-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20v-6M12 20V10M19 20V4"/></svg>
      <span class="mode-name">{{ compact ? compactLabel : (currentMode?.name || currentModeId) }}</span>
      <span class="dropdown-arrow">{{ isOpen ? '▲' : '▼' }}</span>
    </button>
    
    <Transition name="dropdown">
      <div v-if="isOpen" class="dropdown-menu" @click.stop>
        <div 
          v-for="mode in modes"
          :key="mode.id"
          :class="['dropdown-item', { selected: mode.id === currentModeId }]"
          @click="selectMode(mode.id)"
        >
          <div class="item-content">
            <span class="item-name">{{ mode.name }}</span>
            <span v-if="mode.description" class="item-description">
              {{ mode.description }}
            </span>
          </div>
          <span v-if="mode.id === currentModeId" class="check-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg></span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.mode-picker {
  position: relative;
  display: inline-block;
}

.mode-picker.disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* Composer chip: text-like dropdown, no frame until hovered. */
.mode-picker.compact .mode-button {
  border: none;
  background: transparent;
  padding: 0.25rem 0.375rem;
  color: var(--text-secondary, #6b6259);
  font-size: 0.78rem;
}

.mode-picker.compact .mode-button:hover:not(:disabled) {
  background: var(--bg-hover);
  border: none;
}

.effort-icon {
  flex-shrink: 0;
}

/* The chip sits in the composer's bottom menu — an upward dropdown is the
 * only one that fits inside the viewport (downward ran off-screen). */
.mode-picker.compact .dropdown-menu {
  top: auto;
  bottom: calc(100% + 6px);
}

.mode-picker.compact .mode-name {
  font-weight: 500;
  text-transform: capitalize;
}

.mode-button {
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
}

.mode-button:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--text-accent);
}

.mode-button:disabled {
  cursor: not-allowed;
}

.mode-icon {
  font-size: 0.9rem;
}

.mode-name {
  font-weight: 500;
}

.dropdown-arrow {
  font-size: 0.6rem;
  color: var(--text-muted);
  margin-left: 0.25rem;
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  z-index: 100;
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .dropdown-menu {
  }
}

/* On phones the menu's anchored width (`min-width: 240px`) can overflow
   the viewport when the button sits near a screen edge. Re-anchor to the
   viewport itself so the menu becomes a full-width sheet that always fits. */
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
