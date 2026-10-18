<script setup lang="ts">
/** Shared native button: attributes, listeners, aria state and focus stay on the button. */
withDefaults(defineProps<{
  variant?: 'secondary' | 'primary' | 'danger' | 'ghost' | 'image' | 'select' | 'option' | 'row' | 'tab' | 'chip' | 'transcript' | 'session-tab' | 'meter' | 'row-primary';
  tone?: 'default' | 'danger' | 'success' | 'warning' | 'muted' | 'info';
  size?: 'sm' | 'xs';
  icon?: boolean;
  reveal?: boolean;
  layout?: 'inline' | 'stacked';
  type?: 'button' | 'submit' | 'reset';
}>(), { tone: 'default', variant: 'secondary', size: 'sm', icon: false, reveal: false, layout: 'inline', type: 'button' });
</script>

<template>
  <button :type="type" class="ds-button" :class="[`ds-button--${variant}`, `ds-button--${size}`, `ds-button--tone-${tone}`, `ds-button--${layout}`, { 'ds-button--icon': icon, 'ds-button--reveal': reveal }]">
    <slot />
  </button>
</template>

<style scoped>
.ds-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  box-sizing: border-box;
  min-height: 28px;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-primary, #2b2723);
  font-family: var(--font-ui, sans-serif);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap;
}
.ds-button:hover:not(:disabled) { background: var(--tint-hover, rgba(43,39,35,0.045)); }
.ds-button--primary {
  background: var(--bg-primary, #c2532f);
  border-color: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fff);
}
.ds-button--primary:hover:not(:disabled) { background: var(--bg-primary-hover, #a8431f); border-color: var(--bg-primary-hover, #a8431f); }
.ds-button--danger { color: var(--bg-danger, #b3402e); }
.ds-button--danger:hover:not(:disabled) { border-color: var(--bg-danger, #b3402e); }
.ds-button--ghost { border-color: transparent; color: var(--text-secondary, #6b6259); }
.ds-button--meter { border-color: transparent; color: var(--text-muted); font-family: var(--font-mono); font-size: .7rem; padding: 0 .375rem; }
.ds-button--image { padding: 0; border-color: transparent; overflow: hidden; cursor: zoom-in; }
.ds-button--image:hover:not(:disabled) { border-color: var(--text-accent, #b04a28); }
.ds-button[aria-selected='true'], .ds-button[aria-pressed='true'], .ds-button[aria-checked='true'] {
  background: var(--accent-soft, rgba(194,83,47,0.14));
  border-color: var(--text-accent, #b04a28);
  color: var(--text-accent, #b04a28);
}
.ds-button[aria-current='step'], .ds-button[aria-current='page'] { background: var(--bg-hover); border-color: transparent; color: var(--text-primary); }
.ds-button.ds-button--stacked { flex-direction: column; gap: 0.375rem; min-height: 60px; padding: 0.5rem 0.25rem; font-size: 0.6875rem; border-radius: var(--radius-lg); }
.ds-button--select, .ds-button--option {
  white-space: normal; width: 100%; min-height: 44px; justify-content: flex-start;
  padding: 0.625rem 0.75rem; font-size: 0.8125rem; text-align: left;
}
.ds-button--select { background: var(--bg-main); }
.ds-button--select[aria-expanded='true'] { border-color: var(--border-strong); }
.ds-button--option { border-color: transparent; }
.ds-button--option[aria-selected='true'] { border-color: transparent; }
.ds-button--option:focus-visible { outline-offset: -2px; }
.ds-button--row { white-space: normal; width: 100%; justify-content: flex-start; text-align: left; border-color: transparent; }
/* UiActionRow owns the tile; its primary action stays visually joined. */
.ds-button--row-primary {
  width: 100%; min-width: 0; justify-content: flex-start; text-align: left;
  white-space: normal; padding: .25rem .5rem;
  border: 0; border-color: transparent; border-radius: 0; background: transparent;
}
.ds-button--row-primary[aria-pressed='true'],
.ds-button--row-primary:hover:not(:disabled) { background: transparent; border-color: transparent; }
.ds-button.ds-button--row-primary:focus-visible { outline-offset: -2px; }

.ds-button--tab { border-color: transparent; border-radius: 0; color: var(--text-secondary); }
.ds-button--tab[aria-selected='true'] {
  background: transparent; color: var(--text-primary); border-color: transparent;
  border-bottom-color: var(--text-accent);
}
.ds-button--session-tab { border: 0; border-radius: 0; background: transparent; color: var(--text-secondary); }
.ds-button--session-tab[aria-selected='true'],
.ds-button--session-tab:hover:not(:disabled) {
  background: transparent; color: var(--text-primary); border-color: transparent;
}
.ds-button--chip { border-radius: var(--radius-sm); white-space: normal; overflow-wrap: anywhere; }
.ds-button--tone-danger { color: var(--bg-danger); }
.ds-button--tone-success { color: var(--bg-success); }
.ds-button--tone-muted { color: var(--text-secondary); }
.ds-button--tone-info { color: var(--text-info); }
.ds-button--tone-warning { color: var(--text-warning); }
.ds-button--tone-danger:hover:not(:disabled) { background: var(--accent-danger-soft, var(--tint-hover)); color: var(--bg-danger); }
.ds-button--xs { min-height: 24px; padding: 0.125rem 0.375rem; font-size: 0.6875rem; }
.ds-button--icon { width: 28px; padding: 0; flex-shrink: 0; }
.ds-button--icon.ds-button--xs { width: 24px; }
.ds-button:focus-visible { outline: 2px solid var(--text-accent, #b04a28); outline-offset: 2px; }
:global(.ui-action-row .ds-button:focus-visible) { outline-offset: -2px; }
.ds-button:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 800px), (pointer: coarse) {
  .ds-button, .ds-button--xs { min-height: 44px; min-width: 44px; }
  .ds-button--icon, .ds-button--icon.ds-button--xs { width: 44px; }
}
/* Dense transcript disclosures: deliberate 32px touch target instead of form-button spacing. */
.ds-button--transcript {
  width: 100%; justify-content: flex-start; text-align: left;
  min-height: 24px; padding: 0 0.5rem; border: none;
  border-radius: var(--radius-sm); background: var(--tint-hover);
  font-family: var(--font-mono); font-size: 0.6875rem; font-weight: 400;
  line-height: 1.4; gap: 0.4375rem;
}
.ds-button--transcript.ds-button--tone-danger { background: var(--accent-danger-soft); }
.ds-button--transcript.ds-button--tone-info { background: var(--surface-info); }
.ds-button--transcript:hover:not(:disabled) { background: var(--tint-active, var(--bg-hover)); }
.ds-button--transcript.ds-button--tone-danger:hover:not(:disabled) { background: var(--accent-danger-soft); }
.ds-button--transcript.ds-button--tone-info:hover:not(:disabled) { background: var(--surface-info); }
.ds-button--transcript:focus-visible { outline-offset: -2px; }
@media (max-width: 800px), (pointer: coarse) {
  .ds-button--transcript { min-height: 32px; }
}
/* Keep secondary actions quiet with a pointer; touch and keyboard retain access. */
@media (hover: hover) and (pointer: fine) {
  .ds-button--reveal { opacity: 0; }
  :global(.ui-action-group:hover .ds-button--reveal),
  :global(.ui-action-group:focus-within .ds-button--reveal),
  .ds-button--reveal:focus-visible { opacity: 1; }
  :global(.ui-action-group:hover .ds-button--reveal:disabled),
  :global(.ui-action-group:focus-within .ds-button--reveal:disabled) { opacity: 0.5; }
}
</style>
