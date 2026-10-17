<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
// The stepper: one row per NODE_DEFS[direction] node, expandable to the
// blocks its events project to.
//
// Node status (Paseo rule + the terminal addition): the last node with a
// matched event is active — unless the run is terminal, in which case it
// is done; all nodes before it are done; everything after is idle.
import type { EventBlock, NodeDef } from '../../lib/porch/types';
import WorkflowBlock from './WorkflowBlock.vue';

const props = defineProps<{
  nodes: NodeDef[];
  activeIndex: number;
  terminal: boolean;
  expandedNodeId: string | null;
  /** Blocks for the expanded node only (computed lazily by the store). */
  expandedBlocks: EventBlock[];
  /** Matched-event count per node id, for the badge. */
  counts: Record<string, number>;
}>();

const emit = defineEmits<{ toggle: [nodeId: string] }>();

function statusOf(index: number): 'idle' | 'active' | 'done' {
  if (props.activeIndex === -1 || index > props.activeIndex) return 'idle';
  if (index < props.activeIndex || props.terminal) return 'done';
  return 'active';
}
</script>

<template>
  <div class="wf-stepper">
    <div
      v-for="(node, i) in props.nodes"
      :key="node.id"
      class="wf-node"
      :data-node="node.id"
    >
      <UiButton variant="row"
        class="wf-node-row"
        :aria-current="statusOf(i) === 'active' ? 'step' : undefined"
        type="button"
        :aria-expanded="props.expandedNodeId === node.id"
        @click="emit('toggle', node.id)"
      >
        <span class="wf-node-index mono">{{ i + 1 }}</span>
        <span class="wf-node-label" :class="{ idle: statusOf(i) === 'idle' }">{{ node.label }}</span>
        <span v-if="props.counts[node.id]" class="wf-node-count mono">{{ props.counts[node.id] }}</span>
        <span v-if="statusOf(i) === 'active'" class="wf-node-live" aria-label="active">●</span>
        <span v-else-if="statusOf(i) === 'done'" class="wf-node-done" aria-label="done">✓</span>
      </UiButton>
      <div v-if="props.expandedNodeId === node.id" class="wf-node-body">
        <div v-if="props.expandedBlocks.length === 0" class="wf-node-empty">—</div>
        <div v-else class="wf-node-scroll">
          <WorkflowBlock
            v-for="(block, bi) in props.expandedBlocks"
            :key="bi"
            :block="block"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-stepper {
  min-height: 0;
}

.wf-node {
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.wf-node-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 32px;
  text-align: left;
}

.mono {
  font-family: var(--font-mono, monospace);
}
.wf-node-index {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  min-width: 18px;
}
.wf-node-label {
  flex: 1;
  font-size: 0.8125rem;
  color: var(--text-primary, #2b2723);
  min-width: 0;
}
.wf-node-label.idle {
  color: var(--text-muted, #a39a8e);
}
.wf-node-count {
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}
.wf-node-live {
  font-size: 0.75rem;
  color: var(--text-accent, #c2532f);
}
.wf-node-done {
  font-size: 0.75rem;
  color: var(--text-muted, #a39a8e);
}

.wf-node-body {
  padding: 0.125rem 1rem 0.625rem calc(1rem + 18px + 0.5rem);
}
.wf-node-empty {
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  padding: 0.25rem 0;
}
.wf-node-scroll {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
</style>
