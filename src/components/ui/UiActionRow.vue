<script setup lang="ts">
/** One visual tile with separate native primary and trailing actions. */
withDefaults(defineProps<{
  as?: 'div' | 'li';
  variant?: 'row' | 'tab';
  selected?: boolean;
  density?: 'compact' | 'comfortable';
}>(), { as: 'div', variant: 'row', selected: false, density: 'compact' });
</script>

<template>
  <component :is="as" class="ui-action-row ui-action-group" :class="{ 'is-tab': variant === 'tab', 'is-selected': selected, 'is-comfortable': density === 'comfortable' }">
    <div class="ui-action-row__primary"><slot /></div>
    <div v-if="$slots.actions" class="ui-action-row__actions"><slot name="actions" /></div>
  </component>
</template>

<style scoped>
.ui-action-row {
  display: flex;
  align-items: stretch;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  overflow: hidden;
}
.ui-action-row.is-selected {
  border-color: var(--text-accent);
  background: var(--accent-soft);
}
.ui-action-row.is-tab {
  width: auto;
  min-height: 28px;
  border-radius: var(--radius-md, 6px) var(--radius-md, 6px) 0 0;
}
.ui-action-row.is-tab.is-selected {
  background: var(--bg-main);
  border-color: var(--border-faint);
  border-bottom-color: transparent;
  margin-bottom: -1px;
}
.ui-action-row.is-comfortable { min-height: 72px; }
.ui-action-row__primary { display: flex; flex: 1; min-width: 0; }
.ui-action-row__actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}
@media (hover: hover) and (pointer: fine) {
  .ui-action-row:hover:not(.is-selected) { background: var(--tint-hover); }
}
</style>
