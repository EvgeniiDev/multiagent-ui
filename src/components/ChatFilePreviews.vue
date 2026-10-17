<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import ChatFileCard from './ChatFileCard.vue';
import { chatFileFromLink, previewKind, type ChatFile } from '../lib/chatFiles';
const props = defineProps<{ text: string; cwd?: string; active: boolean }>();
const emit = defineEmits<{ open: [file: ChatFile] }>();
const files = computed(() => {
  if (!props.text.includes('[')) return [];
  const found = new Map<string, ChatFile>();
  marked.walkTokens(marked.lexer(props.text), token => {
    if (token.type !== 'link') return;
    const file = chatFileFromLink(token.href, props.cwd);
    if (file && ['text', 'pdf'].includes(previewKind(file))) found.set(file.url, file);
  });
  return [...found.values()];
});
</script>

<template>
  <div v-if="files.length" class="file-previews">
    <ChatFileCard v-for="file in files" :key="file.url" :file="file" :active="active" @open="emit('open', $event)" />
  </div>
</template>

<style scoped>
.file-previews { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 0.75rem; min-width: 0; margin: 0.75rem 0; }
</style>
