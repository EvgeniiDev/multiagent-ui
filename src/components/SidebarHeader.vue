<script setup lang="ts">
import UiButton from './ui/UiButton.vue';

defineProps<{ trafficActive: boolean }>();
defineEmits<{ traffic: []; settings: []; collapse: [] }>();
</script>

<template>
  <header class="sidebar-header">
    <div class="sidebar-brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18M6 6h12v12H6z" opacity=".45" />
        <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" /><circle cx="18" cy="6" r="2.5" fill="currentColor" stroke="none" />
        <circle cx="6" cy="18" r="2.5" fill="currentColor" stroke="none" /><circle cx="18" cy="18" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <h1>Multiagent UI</h1>
    </div>
    <div class="header-actions">
      <UiButton variant="ghost" icon aria-label="ACP Traffic Monitor" title="ACP Traffic Monitor" :aria-pressed="trafficActive" @click="$emit('traffic')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a5.5 5.5 0 0 1 0-8.4M16.2 7.8a5.5 5.5 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>
      </UiButton>
      <UiButton variant="ghost" icon aria-label="Settings" title="Settings" @click="$emit('settings')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M9.5 3h5l.6 2.5 2.2 1.3 2.5-.7 2.5 4.3-1.9 1.8v2.6l1.9 1.8-2.5 4.3-2.5-.7-2.2 1.3-.6 2.5h-5l-.6-2.5-2.2-1.3-2.5.7-2.5-4.3 1.9-1.8v-2.6L1.8 8.4l2.5-4.3 2.5.7L9 3.5z" transform="translate(1 1) scale(.85)"/></svg>
      </UiButton>
      <UiButton variant="ghost" icon aria-label="Collapse sidebar" aria-controls="app-sidebar" title="Close menu" @click="$emit('collapse')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 6l-6 6 6 6" /></svg>
      </UiButton>
    </div>
  </header>
</template>

<style scoped>
.sidebar-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.875rem 0.75rem 0.5rem; }
.sidebar-brand { display: flex; align-items: center; gap: 0.625rem; min-width: 0; color: var(--text-primary); }
.sidebar-brand svg { flex-shrink: 0; }
h1 { margin: 0; font-size: 0.9375rem; font-weight: 650; letter-spacing: -0.025em; white-space: nowrap; }
.header-actions { display: flex; align-items: center; gap: 0.125rem; }
</style>
