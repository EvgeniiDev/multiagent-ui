<script setup lang="ts">
import UiActionRow from './UiActionRow.vue';
import UiButton from './UiButton.vue';

defineProps<{
  messages: { id: string; text: string; mode: 'queue' | 'steer'; attachmentNames: string[]; error?: string }[];
  paused: boolean;
  notice?: string;
  disabled?: boolean;
}>();
defineEmits<{ remove: [id: string]; resume: [] }>();
</script>

<template>
  <section v-if="messages.length || notice" class="ui-pending" aria-label="Pending messages">
    <div class="pending-heading">
      <span role="status">{{ paused ? 'Queue paused' : 'Pending' }} · {{ messages.length }}</span>
      <UiButton v-if="paused" variant="ghost" size="xs"
        :disabled="disabled" @click="$emit('resume')">Resume queue</UiButton>
    </div>
    <p v-if="notice" class="pending-note" role="status">{{ notice }}</p>
    <ul class="pending-list">
      <UiActionRow v-for="message in messages" :key="message.id" as="li" :data-pending-id="message.id">
        <div class="pending-message">
          <span class="pending-mode">{{ message.mode === 'steer' ? 'Steer · after next tool' : 'Queue · after response' }}</span>
          <span class="pending-text" :title="message.text">{{ message.text || message.attachmentNames.join(', ') }}</span>
          <span v-if="message.text && message.attachmentNames.length" class="pending-note">{{ message.attachmentNames.join(', ') }}</span>
          <span v-if="message.error" class="pending-error" role="alert">{{ message.error }}. Remove this message before resuming; it may already have reached the agent.</span>
        </div>
        <template #actions>
          <UiButton variant="ghost" size="xs" icon aria-label="Remove pending message" @click="$emit('remove', message.id)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </UiButton>
        </template>
      </UiActionRow>
    </ul>
  </section>
</template>

<style scoped>
.ui-pending { padding: 4px 0; color: var(--text-secondary); font-size: 12px; }
.pending-heading { display: flex; align-items: center; justify-content: space-between; min-height: 24px; }
.pending-list { margin: 0; padding: 0; list-style: none; max-height: 160px; overflow-y: auto; }
.pending-message { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 4px 8px; gap: 2px; }
.pending-mode, .pending-note { font-size: 11px; color: var(--text-muted); }
p.pending-note { margin: 4px 0; }
.pending-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.pending-error { color: var(--bg-danger); overflow-wrap: anywhere; }
</style>
