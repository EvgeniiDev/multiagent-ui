<script setup lang="ts">
// Permission gate: one focused question, one primary action. Styled with the
// app's own tokens (warm paper, terracotta accent, hairline borders) — the
// upstream dialog shipped gray bands, emoji and bootstrap green/red that had
// nothing to do with this UI.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { PermissionRequest } from '../lib/types';

const props = defineProps<{
  request: PermissionRequest;
}>();

const emit = defineEmits<{
  select: [optionId: string];
  cancel: [];
}>();

const primaryRef = ref<HTMLButtonElement | null>(null);

/** Allow before reject, and reject before a plain cancel. */
const OPTION_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

const options = computed(() =>
  [...props.request.options].sort(
    (a, b) => (OPTION_ORDER[a.kind] ?? 9) - (OPTION_ORDER[b.kind] ?? 9)
  )
);

const isAllow = (kind: string) => kind.startsWith('allow');
const isReject = (kind: string) => kind.startsWith('reject');

/** Short kind label, matching the app's mono chips ("read", "run", …). */
const kindLabel = computed(() => props.request.toolCall.kind || 'tool');

const locations = computed(() =>
  // The agent's title usually already names the path ("Read /x/y.txt"); printing
  // it again as a location is a duplicated line, not information.
  (props.request.toolCall.locations ?? []).filter(
    (loc) => !props.request.toolCall.title.includes(loc.path)
  )
);

function handleSelect(optionId: string) {
  emit('select', optionId);
}

function handleCancel() {
  emit('cancel');
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    handleCancel();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  // Focus the primary action so Enter/space resolves the prompt without a mouse.
  primaryRef.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div class="permission-overlay" @click.self="handleCancel">
    <div class="permission-dialog" role="dialog" aria-modal="true" aria-label="Permission required">
      <div class="dialog-head">
        <span class="head-label">Permission</span>
        <span class="head-kind">{{ kindLabel }}</span>
      </div>

      <div class="dialog-body">
        <p class="tool-title">{{ request.toolCall.title }}</p>

        <div v-if="locations.length" class="locations">
          <p v-for="(loc, index) in locations" :key="index" class="location">{{ loc.path }}</p>
        </div>
      </div>

      <div class="dialog-actions">
        <button
          v-for="(option, index) in options"
          :key="option.optionId"
          :ref="(el) => { if (index === 0) primaryRef = el as HTMLButtonElement | null; }"
          :class="[
            'option-btn',
            isAllow(option.kind) ? 'option-allow' : (isReject(option.kind) ? 'option-reject' : ''),
          ]"
          @click="handleSelect(option.optionId)"
        >
          {{ option.name }}
        </button>
        <button class="cancel-btn" @click="handleCancel">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Warm ink scrim, flat — no black wash, no blur. */
.permission-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(43, 39, 35, 0.28);
  z-index: 1000;
  padding: 1rem;
}

.permission-dialog {
  width: 100%;
  max-width: 420px;
  background: var(--bg-main, #fbf8f3);
  border: 1px solid rgba(43, 39, 35, 0.16);
  border-radius: var(--radius-lg, 10px);
  overflow: hidden;
}

/* Uppercase label + mono kind, same pattern as the sidebar section heads. */
.dialog-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.head-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.head-kind {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.dialog-body {
  padding: 0.75rem 0.875rem;
}

.tool-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.4;
  color: var(--text-primary, #2b2723);
  word-break: break-word;
}

/* Paths read as data, not as a decoration: mono, no icon, no box. */
.locations {
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.location {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--text-secondary, #6b6259);
  word-break: break-all;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.375rem;
  padding: 0.625rem 0.875rem 0.75rem;
}

.option-btn,
.cancel-btn {
  height: 30px;
  padding: 0 0.75rem;
  border-radius: var(--radius-md, 6px);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.option-btn:focus-visible,
.cancel-btn:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 2px;
}

/* Allow is the one filled control on screen. */
.option-allow {
  background: var(--bg-primary, #c2532f);
  color: #fff;
  border: 1px solid var(--bg-primary, #c2532f);
}

.option-allow:hover {
  background: var(--bg-primary-hover, #a8431f);
  border-color: var(--bg-primary-hover, #a8431f);
}

/* Reject reads as a warning without a second filled colour competing. */
.option-reject {
  background: transparent;
  color: var(--bg-danger, #b3402e);
  border: 1px solid rgba(179, 64, 46, 0.45);
}

.option-reject:hover {
  background: rgba(179, 64, 46, 0.08);
}

.cancel-btn {
  background: transparent;
  color: var(--text-secondary, #6b6259);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.cancel-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}
</style>
