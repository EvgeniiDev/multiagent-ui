<script setup lang="ts">
/** Shared native button: attributes, listeners, aria state and focus stay on the button. */
withDefaults(defineProps<{
  variant?: 'secondary' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'xs';
  icon?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), { variant: 'secondary', size: 'sm', icon: false, type: 'button' });
</script>

<template>
  <button :type="type" class="ds-button" :class="[`ds-button--${variant}`, `ds-button--${size}`, { 'ds-button--icon': icon }]">
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
.ds-button[aria-selected='true'], .ds-button[aria-pressed='true'] {
  background: var(--accent-soft, rgba(194,83,47,0.14));
  border-color: var(--text-accent, #b04a28);
  color: var(--text-accent, #b04a28);
}
.ds-button--xs { min-height: 24px; padding: 0.125rem 0.375rem; font-size: 0.6875rem; }
.ds-button--icon { width: 28px; padding: 0; flex-shrink: 0; }
.ds-button--icon.ds-button--xs { width: 24px; }
.ds-button:focus-visible { outline: 2px solid var(--text-accent, #b04a28); outline-offset: 2px; }
.ds-button:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 800px), (pointer: coarse) {
  .ds-button, .ds-button--xs { min-height: 44px; }
  .ds-button--icon, .ds-button--icon.ds-button--xs { width: 44px; }
}
</style>
