<script setup lang="ts">
import UiUsageMeter from './ui/UiUsageMeter.vue';
import SubscriptionLimits from './SubscriptionLimits.vue';
defineProps<{ label: string; contextTitle: string; providerId?: string; active: boolean; anchor?: HTMLElement }>();
</script>

<template>
  <UiUsageMeter :label="label" :active="active" :anchor="anchor">
    <div class="context-detail"><strong>Context</strong><p>{{ label ? contextTitle : 'Context usage has not been reported yet.' }}</p><p v-if="label" class="context-count">{{ label }} tokens</p></div>
    <SubscriptionLimits v-if="providerId" :provider-id="providerId" compact />
    <p v-else class="ui-note">Subscription limits are not available for this agent.</p>
  </UiUsageMeter>
</template>

<style scoped>
.context-detail { margin-bottom: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--border-color); font-size: .8rem; }
.context-detail strong { font-weight: 500; }
.context-detail p { margin: .25rem 0 0; color: var(--text-secondary); font-size: .75rem; }
.context-count { font-family: var(--font-mono); }
</style>
