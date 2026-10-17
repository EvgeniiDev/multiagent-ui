<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { useTrafficStore, type TrafficEntry } from '../stores/traffic';

const emit = defineEmits<{
  close: [];
  resize: [height: number];
}>();

const trafficStore = useTrafficStore();
const expandedIds = ref<Set<string>>(new Set());
const logContainer = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

// Resize handling
const isResizing = ref(false);
const panelHeight = ref(220);
const MIN_HEIGHT = 100;
const MAX_HEIGHT = window.innerHeight * 0.7;

function startResize(e: MouseEvent) {
  isResizing.value = true;
  e.preventDefault();
  document.addEventListener('mousemove', doResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
}

function doResize(e: MouseEvent) {
  if (!isResizing.value) return;
  const newHeight = window.innerHeight - e.clientY;
  panelHeight.value = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, newHeight));
  emit('resize', panelHeight.value);
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', doResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onUnmounted(() => {
  document.removeEventListener('mousemove', doResize);
  document.removeEventListener('mouseup', stopResize);
});

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
  }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function toggleExpand(id: string) {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
  // Force reactivity
  expandedIds.value = new Set(expandedIds.value);
}

function formatJson(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function getEntryClass(entry: TrafficEntry): string {
  const classes = ['entry', entry.direction];
  if (entry.error) classes.push('error');
  return classes.join(' ');
}

function getDirectionIcon(entry: TrafficEntry): string {
  return entry.direction === 'out' ? '→' : '←';
}

function getTypeLabel(entry: TrafficEntry): string {
  if (entry.type === 'notification') {
    return '(notification)';
  } else if (entry.type === 'response') {
    return '(response)';
  }
  return '';
}

// Auto-scroll when new entries arrive
watch(() => trafficStore.entries.length, async () => {
  if (autoScroll.value && logContainer.value && !trafficStore.isPaused) {
    await nextTick();
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
});

function handleScroll() {
  if (!logContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logContainer.value;
  // Disable auto-scroll if user scrolled up
  autoScroll.value = scrollTop + clientHeight >= scrollHeight - 50;
}

function handleCopy(entry: TrafficEntry) {
  navigator.clipboard.writeText(formatJson(entry.payload));
}
</script>

<template>
  <div class="traffic-monitor" :style="{ height: panelHeight + 'px' }">
    <!-- Resize Handle -->
    <div 
      class="resize-handle" 
      @mousedown="startResize"
      title="Drag to resize"
    ></div>
    
    <div class="monitor-header">
      <span class="title"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a5.5 5.5 0 0 1 0-8.4M12 12h.01M16.7 10.3a3 3 0 0 1 0 4.4M19.6 7.4a7 7 0 0 1 0 10.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg> ACP Traffic</span>
      
      <div class="controls">
        <UiButton variant="secondary" icon
          class="control-btn"
          :aria-pressed="trafficStore.isPaused"
          @click="trafficStore.togglePause()"
          :title="trafficStore.isPaused ? 'Resume' : 'Pause'"
          :aria-label="trafficStore.isPaused ? 'Resume' : 'Pause'"
        >
          <svg v-if="trafficStore.isPaused" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>
        </UiButton>
        
        <UiButton variant="secondary" icon
          class="control-btn"
          @click="trafficStore.clear()"
          title="Clear"
          aria-label="Clear"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>
        </UiButton>
        
        <div class="search-container">
          <span class="search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></span>
          <input 
            type="text"
            class="ui-input search-input"
            placeholder="Search..."
            aria-label="Search ACP traffic"
            :value="trafficStore.searchQuery"
            @input="trafficStore.setSearch(($event.target as HTMLInputElement).value)"
          />
          <UiButton variant="ghost" icon aria-label="Clear search"
            v-if="trafficStore.searchQuery"
            class="search-clear-btn"
            @click="trafficStore.clearSearch()"
            title="Clear search"
          >
            ×
          </UiButton>
        </div>
        
        <span v-if="trafficStore.searchQuery" class="match-count">
          {{ trafficStore.filteredEntries.length }} match{{ trafficStore.filteredEntries.length === 1 ? '' : 'es' }}
        </span>
        
        <select 
          class="ui-input filter-select"
          :value="trafficStore.filter"
          @change="trafficStore.setFilter(($event.target as HTMLSelectElement).value as any)"
        >
          <option value="all">All</option>
          <option value="requests">Requests</option>
          <option value="responses">Responses</option>
          <option value="notifications">Notifications</option>
        </select>
      </div>
      
      <UiButton variant="ghost" icon class="close-btn" @click="emit('close')" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></UiButton>
    </div>
    
    <div 
      class="log-container" 
      ref="logContainer"
      @scroll="handleScroll"
    >
      <div v-if="trafficStore.filteredEntries.length === 0" class="empty-state">
        No traffic captured yet. Connect to an agent to see ACP messages.
      </div>
      
      <div 
        v-for="entry in trafficStore.filteredEntries" 
        :key="entry.id"
        :class="getEntryClass(entry)"
      >
        <div class="entry-header">
          <UiButton variant="row" class="entry-toggle" :aria-expanded="expandedIds.has(entry.id)" @click="toggleExpand(entry.id)">
            <span class="expand-icon">{{ expandedIds.has(entry.id) ? '▾' : '▸' }}</span>
            <span class="timestamp">{{ formatTime(entry.timestamp) }}</span>
            <span class="direction-icon">{{ getDirectionIcon(entry) }}</span>
            <span class="method">{{ entry.method }}</span>
            <span class="type-label">{{ getTypeLabel(entry) }}</span>
            <span v-if="entry.requestId !== undefined" class="request-id">#{{ entry.requestId }}</span>
          </UiButton>
          <UiButton variant="ghost" icon
            class="copy-btn" 
            @click.stop="handleCopy(entry)"
            title="Copy JSON"
            aria-label="Copy JSON"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
          </UiButton>
        </div>
        
        <div v-if="expandedIds.has(entry.id)" class="entry-payload">
          <pre>{{ formatJson(entry.payload) }}</pre>
        </div>
      </div>
    </div>
    
    <div v-if="trafficStore.isPaused" class="paused-indicator">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" style="vertical-align:-1px"><path d="M9 5v14M15 5v14"/></svg> Paused
    </div>
  </div>
</template>

<style scoped>
.entry-toggle { flex: 1; min-width: 0; }
.filter-select { width: auto; }
.traffic-monitor {
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-top: 1px solid var(--border-color);
  font-size: 0.8rem;
  position: relative;
}

.resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  background: transparent;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle:active {
  background: var(--bg-primary);
  opacity: 0.5;
}

.monitor-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-main);
  border-bottom: 1px solid var(--border-color);
}

.title {
  font-weight: 600;
  margin-right: auto;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.search-container { display: flex; align-items: center; position: relative; }

.search-icon {
  font-size: 0.7rem;
  opacity: 0.6;
}
.search-input { width: 120px; }

.match-count {
  font-size: 0.7rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.log-container {
  flex: 1;
  overflow-y: auto;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
}

.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--text-muted);
}

.entry {
  border-bottom: 1px solid var(--border-color);
}

.entry-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
}

.entry-header:hover {
  background: var(--bg-hover);
}

.expand-icon {
  color: var(--text-muted);
  width: 1em;
}

.timestamp {
  color: var(--text-muted);
  font-size: 0.7rem;
}

.direction-icon {
  font-weight: bold;
  width: 1em;
}

.entry.out .direction-icon {
  color: var(--text-accent);
}

.entry.in .direction-icon {
  color: var(--bg-success, #5a7d4f);
}

.entry.error .direction-icon,
.entry.error .method {
  color: var(--bg-danger, #b3402e);
}

@media (prefers-color-scheme: dark) {
  .entry.out .direction-icon {
    color: var(--text-accent);
  }
  
  .entry.in .direction-icon {
    color: var(--bg-success, #5a7d4f);
  }
  
  .entry.error .direction-icon,
  .entry.error .method {
    color: var(--bg-danger, #b3402e);
  }
}

.method {
  font-weight: 600;
  color: var(--text-primary);
}

.type-label {
  color: var(--text-muted);
  font-size: 0.7rem;
}

.request-id {
  color: var(--text-accent);
  font-size: 0.7rem;
  margin-left: auto;
}

.entry-payload {
  padding: 0.5rem 0.75rem 0.75rem 2rem;
  background: var(--bg-code);
  overflow-x: auto;
}

.entry-payload pre {
  margin: 0;
  color: var(--text-code);
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-all;
}

.paused-indicator {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
  padding: 0.25rem 0.5rem;
  background: var(--bg-warning);
  border-radius: 4px;
  font-size: 0.7rem;
  color: var(--text-secondary, #6b6259);
}
/* Shared touch controls wrap instead of pushing search/filter off-screen. */
@media (max-width: 800px) {
  .monitor-header { flex-wrap: wrap; }
  .title { flex: 1 1 auto; }
  .close-btn { order: 1; }
  .controls { order: 2; flex: 1 1 100%; min-width: 0; flex-wrap: wrap; }
  .search-container { flex: 1 1 100px; min-width: 0; }
  .search-input { width: 100%; min-width: 0; flex: 1 1 auto; }
  .filter-select { flex: 1 1 100px; width: auto; min-width: 0; }
}

</style>
