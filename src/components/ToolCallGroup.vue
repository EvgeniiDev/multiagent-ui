<script setup lang="ts">
import { computed, useId } from 'vue';
import UiButton from './ui/UiButton.vue';
import ToolCallChip from './ToolCallChip.vue';
import type { ToolCallInfo } from '../lib/types';

const props = defineProps<{
  tools: ToolCallInfo[];
  expanded: boolean;
  expandedTools: ReadonlySet<string>;
}>();
const emit = defineEmits<{ toggle: []; toggleTool: [id: string] }>();
const bodyId = useId();
const counts = computed(() => props.tools.reduce((counts, tool) => {
  if (tool.status === 'pending' || tool.status === 'in_progress') counts.running++;
  if (tool.status === 'failed') counts.failed++;
  return counts;
}, { running: 0, failed: 0 }));
</script>

<template>
  <div class="tool-call-group">
    <UiButton variant="transcript" class="tool-group-toggle"
      :tone="counts.failed ? 'danger' : counts.running ? 'info' : 'default'"
      :aria-expanded="expanded" :aria-controls="bodyId" @click="emit('toggle')">
      <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span>{{ expanded ? 'Hide' : 'Show' }} {{ tools.length }} tool calls</span>
      <span v-if="counts.running">· {{ counts.running }} running</span>
      <span v-if="counts.failed">· {{ counts.failed }} failed</span>
    </UiButton>
    <div v-if="expanded" :id="bodyId" class="tool-group-body">
      <ToolCallChip v-for="tool in tools" :key="tool.toolCallId" :tc="tool"
        :expanded="expandedTools.has(tool.toolCallId)" @toggle="emit('toggleTool', tool.toolCallId)" />
    </div>
  </div>
</template>

<style scoped>
.tool-call-group { min-width: 0; }
.tool-group-toggle { width: 100%; }
.tool-group-body { display: grid; gap: 4px; margin-top: 4px; }
</style>
