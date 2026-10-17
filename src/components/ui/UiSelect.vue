<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue';
import UiButton from './UiButton.vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
const root = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const opened = ref(false);
const position = ref<Record<string, string>>({});
const selected = computed(() => props.options.find(o => o.value === props.modelValue));
const trigger = () => root.value?.querySelector('button');

function close(restoreFocus = false) {
  menu.value?.hidePopover();
  if (restoreFocus) trigger()?.focus();
}
async function open() {
  if (props.disabled || !menu.value || !trigger()) return;
  if (opened.value) { close(); return; }
  const box = trigger()!.getBoundingClientRect();
  const below = window.innerHeight - box.bottom - 12;
  const above = box.top - 12;
  const upwards = below < 220 && above > below;
  position.value = {
    left: `${Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8))}px`,
    width: `${Math.min(box.width, window.innerWidth - 16)}px`,
    maxHeight: `${Math.max(44, upwards ? above : below)}px`,
    ...(upwards ? { bottom: `${window.innerHeight - box.top + 6}px` } : { top: `${box.bottom + 6}px` }),
  };
  menu.value.showPopover();
  opened.value = true;
  await nextTick();
  const option = menu.value.querySelector<HTMLElement>('[aria-selected="true"]')
    ?? menu.value.querySelector<HTMLElement>('[role="option"]');
  option?.focus();
}
function choose(value: string) {
  emit('update:modelValue', value);
  close(true);
}
function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
  if (event.key === 'Tab') { close(); return; }
  const options = [...(menu.value?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  const current = options.indexOf(document.activeElement as HTMLElement);
  let index: number;
  if (event.key === 'ArrowDown') index = (current + 1) % options.length;
  else if (event.key === 'ArrowUp') index = (current - 1 + options.length) % options.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = options.length - 1;
  else return;
  event.preventDefault();
  options[index]?.focus();
}
function syncOpen() { opened.value = menu.value?.matches(':popover-open') ?? false; }
function onResize() { close(); }
onMounted(() => window.addEventListener('resize', onResize));
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div ref="root" class="ui-select">
    <UiButton variant="select" :disabled="disabled" :aria-label="`${label}: ${selected?.label ?? ''}`"
      aria-haspopup="listbox" :aria-expanded="opened" :aria-controls="id"
      @click="open" @keydown.down.prevent="open" @keydown.up.prevent="open">
      <slot name="icon" />
      <span class="select-label">{{ selected?.label }}</span>
      <svg class="select-chevron" :class="{ rotated: opened }" viewBox="0 0 20 20" width="16" height="16"
        fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg>
    </UiButton>
    <div :id="id" ref="menu" class="ui-select-menu" popover="auto" role="listbox" :aria-label="label"
      :style="position" @toggle="syncOpen" @keydown="navigate">
      <UiButton v-for="option in options" :key="option.value" variant="option" role="option" tabindex="-1"
        :aria-selected="option.value === modelValue" @click="choose(option.value)">
        <span class="select-label">{{ option.label }}</span>
        <svg class="select-check" :class="{ selected: option.value === modelValue }" viewBox="0 0 20 20"
          width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg>
      </UiButton>
    </div>
  </div>
</template>

<style scoped>
.ui-select { min-width: 0; width: 100%; }
.select-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.select-chevron, .select-check { flex-shrink: 0; color: var(--text-muted); }
.select-chevron { transition: transform 120ms ease; }
.select-chevron.rotated { transform: rotate(180deg); }
.select-check { visibility: hidden; }
.select-check.selected { visibility: visible; color: var(--text-primary); }
.ui-select-menu {
  position: fixed; inset: auto; margin: 0; padding: 4px; box-sizing: border-box;
  overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--border-color); border-radius: var(--radius-lg);
  background: var(--bg-sidebar); color: var(--text-primary); font-family: var(--font-ui);
  box-shadow: 0 12px 32px #0005;
}
.ui-select-menu::backdrop { background: transparent; }
@media (prefers-reduced-motion: reduce) { .select-chevron { transition: none; } }
</style>
