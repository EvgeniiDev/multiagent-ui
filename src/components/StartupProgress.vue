<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  agentName: string;
  phase: string;
  logs: string[];
  elapsedSeconds: number;
  showDetails: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  toggleDetails: [];
}>();

interface StepIcon {
  path: string;
  circle?: boolean;
  line?: boolean;
}

const stepIcons: Record<string, StepIcon> = {
  starting: { path: 'M12 2.5c2.4 2.5 6 6.6 6 10.5a6 6 0 0 1-12 0C6 9.1 9.6 5 12 2.5zM9.5 13.5a2.5 2.5 0 0 0 5 0c0-1.7-2.1-4-2.5-4.5-.4.5-2.5 2.8-2.5 4.5z' },
  downloading: { path: 'M12 3v11M7.5 10.5L12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' },
  installing: { path: 'M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16zM3.5 8L12 12.5 20.5 8M12 12.5v8', line: true },
  building: { path: 'M14.5 4.5l5 5L8 21H3v-5zM13 6l5 5' },
  initializing: { path: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5' },
  connecting: { path: 'M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7' },
};

const defaultStep: StepIcon = { path: 'M12 3a9 9 0 1 0 9 9', circle: true };

const stepIcon = computed<StepIcon>(() => stepIcons[props.phase] ?? defaultStep);

const phaseText = computed(() => {
  switch (props.phase) {
    case 'starting': return 'Starting process...';
    case 'downloading': return 'Downloading packages...';
    case 'installing': return 'Installing dependencies...';
    case 'building': return 'Building...';
    case 'initializing': return 'Initializing agent...';
    case 'connecting': return 'Connecting to agent...';
    default: return 'Please wait...';
  }
});

const formattedTime = computed(() => {
  const mins = Math.floor(props.elapsedSeconds / 60);
  const secs = props.elapsedSeconds % 60;
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
});

const isLongWait = computed(() => props.elapsedSeconds > 10);
</script>

<template>
  <div class="startup-progress">
    <div class="progress-header">
      <span class="agent-name">Connecting to {{ agentName }}...</span>
      <span class="elapsed-time">{{ formattedTime }}</span>
    </div>
    
    <div class="progress-status">
      <span class="phase-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="stepIcon.path"/><circle v-if="stepIcon.circle" cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path v-if="stepIcon.line" d="M12 3v1.5"/></svg></span>
      <span class="phase-text">{{ phaseText }}</span>
    </div>
    
    <div v-if="isLongWait && !showDetails" class="first-run-hint">
      First run may take longer while dependencies are installed.
    </div>
    
    <div class="progress-actions">
      <button 
        class="details-btn"
        @click="emit('toggleDetails')"
      >
        {{ showDetails ? 'Hide Details ▲' : 'Show Details ▼' }}
      </button>
      <button 
        class="cancel-btn"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </div>
    
    <div v-if="showDetails" class="logs-container">
      <div class="logs-header">Output</div>
      <div class="logs-content">
        <div 
          v-for="(log, index) in logs.slice(-50)" 
          :key="index"
          class="log-line"
        >
          {{ log }}
        </div>
        <div v-if="logs.length === 0" class="no-logs">
          Waiting for output...
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.startup-progress {
  padding: 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-top: 0.75rem;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.agent-name {
  font-weight: 600;
  color: var(--text-primary);
}

.elapsed-time {
  font-size: 0.8rem;
  color: var(--text-muted);
  font-family: monospace;
}

.progress-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: var(--bg-hover);
  border-radius: 4px;
  margin-bottom: 0.75rem;
}

.phase-icon {
  font-size: 1.2rem;
}

.phase-text {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.first-run-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  font-style: italic;
  margin-bottom: 0.75rem;
  padding: 0.5rem;
  background: var(--bg-warning);
  border-radius: 4px;
}

.progress-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.details-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
}

.details-btn:hover {
  background: var(--bg-hover);
}

.cancel-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
}

.cancel-btn:hover {
  background: var(--bg-hover);
  border-color: var(--bg-danger);
  color: var(--bg-danger);
}

.logs-container {
  margin-top: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow: hidden;
}

.logs-header {
  padding: 0.375rem 0.5rem;
  background: var(--bg-hover);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.logs-content {
  max-height: 150px;
  overflow-y: auto;
  padding: 0.5rem;
  background: var(--bg-code);
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 0.7rem;
}

.log-line {
  color: var(--text-code);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
}

.no-logs {
  color: var(--text-muted);
  font-style: italic;
}
</style>
