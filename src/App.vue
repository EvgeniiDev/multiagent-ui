<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { canPickFolder, pickFolder, loadKvStore, type KVStore } from './lib/host';
import { useConfigStore } from './stores/config';
import { useSessionStore } from './stores/session';
import { initTelemetry } from './lib/telemetry';
import AgentSelector from './components/AgentSelector.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import PermissionDialog from './components/PermissionDialog.vue';
import SettingsView from './components/SettingsView.vue';
import AuthMethodDialog from './components/AuthMethodDialog.vue';
import TrafficMonitor from './components/TrafficMonitor.vue';
import StartupProgress from './components/StartupProgress.vue';
import DirectoryPicker from './components/DirectoryPicker.vue';
import ProjectsView from './components/ProjectsView.vue';
import BoardView from './components/BoardView.vue';
import DashboardView from './components/DashboardView.vue';
import { useUiStore, VIEWS } from './stores/ui';
import { useActivityStore } from './stores/activity';
import type { SavedSession } from './lib/types';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const uiStore = useUiStore();
const activityStore = useActivityStore();

const selectedAgent = ref('');
const selectedCwd = ref('');
// On mobile / web there is no native folder picker (and the cwd refers to
// a path on the *agent's* machine, not the local device), so we expose a
// directory tree browser backed by the bridge's fs-list API instead of a
// free-text field.
const folderPickerAvailable = canPickFolder();

/** HTTP base URL of the selected agent's bridge (same origin as its ws URL).
 * The tree picker lists directories through `/api/fs/*` on this bridge. */
const fsBaseUrl = computed(() => {
  if (folderPickerAvailable) return '';
  const cfg = configStore.getAgent(selectedAgent.value);
  if (!cfg || !cfg.url) return '';
  const u = cfg.url.trim();
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return (u.startsWith('wss://') ? 'https://' : 'http://') + u.slice(u.indexOf('://') + 3).replace(/\/+$/, '');
  }
  return '';
});
const showSidebar = ref(true);
const showSettings = ref(false);
const showTrafficMonitor = ref(false);
const showStartupDetails = ref(false);

// Reactive flag tracking whether the viewport is narrow enough to show the
// sidebar as a slide-in drawer (mobile / very narrow desktop windows). Used
// by the template to decide when the backdrop is interactive and by
// onMounted to default the drawer closed.
const isNarrowLayout = ref(false);
let narrowMql: MediaQueryList | null = null;
function syncNarrowLayout() {
  if (narrowMql) isNarrowLayout.value = narrowMql.matches;
}

// Foreground-reconnect plumbing. Mobile OSes freeze the WebView when the
// app is backgrounded and routers may drop the idle TCP connection while
// we're away. When the user returns we ask the session store to silently
// reattach to the last session if we have one.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect() {
  // Coalesce rapid visibility/online flips into a single attempt.
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Skip if the browser still thinks we're offline; we'll be re-triggered
    // by the `online` event when connectivity returns.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void sessionStore.tryReconnect();
  }, 250);
}
function handleVisibilityChange() {
  if (typeof document !== 'undefined' && !document.hidden) scheduleReconnect();
}
function handleOnline() {
  scheduleReconnect();
}

// Preferences store for persisting user selections
let prefsStore: KVStore | null = null;

const isConnected = computed(() => sessionStore.isConnected);
const isLoading = computed(() => sessionStore.isLoading);
const isConnecting = computed(() => sessionStore.isConnecting);
const isReconnecting = computed(() => sessionStore.isReconnecting);
const error = computed(() => sessionStore.error || configStore.error);
const hasAgents = computed(() => configStore.hasAgents);

// Name of the agent the reconnect banner refers to. Falls back to the
// generic "agent" if the saved session has no name (shouldn't happen).
const reconnectingAgentName = computed(
  () => sessionStore.currentSession?.agentName ?? 'agent'
);

// True when there is a saved session we *could* reconnect to but the
// transport is currently down. Surfaces a manual "Reconnect" affordance on
// the error banner so users don't have to background+foreground the app to
// trigger the auto path.
const canManuallyReconnect = computed(
  () =>
    !isConnected.value &&
    !isReconnecting.value &&
    !isConnecting.value &&
    !!sessionStore.currentSession?.supportsLoadSession
);

async function handleManualReconnect() {
  await sessionStore.tryReconnect();
}

// Watch for permission requests from session store
const pendingPermission = computed(() => sessionStore.pendingPermission);

// Watch for auth method selection requests
const pendingAuthMethods = computed(() => sessionStore.pendingAuthMethods);
const pendingAuthAgentName = computed(() => sessionStore.pendingAuthAgentName);

onMounted(async () => {
  // Track viewport width so the sidebar can default-collapse into a drawer
  // on phones / narrow windows. We watch a MediaQueryList rather than
  // resize for correctness across orientation changes on iOS.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrowLayout();
    narrowMql.addEventListener('change', syncNarrowLayout);
    if (isNarrowLayout.value) showSidebar.value = false;
  }

  // Load persisted preferences first
  prefsStore = await loadKvStore('preferences.json');
  
  // Initialize telemetry (check user preference)
  const telemetryEnabled = await prefsStore.get<boolean>('telemetryEnabled') ?? true;
  await initTelemetry(telemetryEnabled);
  
  // Initialize stores
  await configStore.loadConfig();
  await configStore.setupHotReload();
  await sessionStore.initStore();
  await activityStore.initActivityStore();
  await uiStore.initUiStore();

  const savedCwd = await prefsStore.get<string>('lastCwd');
  if (savedCwd) {
    selectedCwd.value = savedCwd;
  }

  // Hook foreground-reconnect listeners. `pageshow` fires both on initial
  // navigation and when iOS restores a frozen WebView from the back/forward
  // cache, so it complements `visibilitychange` on Safari/iOS.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', scheduleReconnect);
    window.addEventListener('online', handleOnline);
    window.addEventListener('keydown', handleViewShortcut);
  }
});

async function handleAgentSelect(agentName: string) {
  selectedAgent.value = agentName;
  // Scope the sidebar to this agent: blank the list, show a loader, re-fetch
  // its inventory. Without this a switch looks like nothing happened.
  await sessionStore.setActiveAgent(agentName);
}

async function handleSelectFolder() {
  const folder = await pickFolder('Select Working Directory');
  if (folder) {
    selectedCwd.value = folder;
    // Persist the selection
    if (prefsStore) {
      await prefsStore.set('lastCwd', folder);
      await prefsStore.save();
    }
  }
}

/** Persist a cwd picked from the directory tree. */
async function handleTreeSelect(value: string) {
  selectedCwd.value = value;
  if (prefsStore) {
    await prefsStore.set('lastCwd', value);
    await prefsStore.save();
  }
}

async function handleNewSession() {
  if (!selectedAgent.value) return;

  // ACP requires a working directory. Absolute paths pass through; relative
  // paths (e.g. `./projects/foo` or `projects/foo`) are resolved by the
  // bridge against the agent's home directory. Empty is the only error we
  // can catch client-side.
  const cwd = selectedCwd.value.trim();
  if (!cwd) {
    sessionStore.error = 'Please enter a working directory (absolute path on the agent\u2019s machine, or a path relative to its home directory).';
    return;
  }

  try {
    await sessionStore.createSession(selectedAgent.value, cwd);
  } catch (e) {
    console.error('Failed to create session:', e);
  }
}

async function handleResumeSession(session: SavedSession) {
  selectedAgent.value = session.agentName;
  try {
    await sessionStore.resumeSession(session);
  } catch (e) {
    console.error('Failed to resume session:', e);
  }
}

async function handleDeleteSession(sessionId: string) {
  await sessionStore.deleteSession(sessionId);
}

/**
 * Pull the agent's own session inventory (`session/list`) into the sidebar.
 * When no session is connected there is no live target, so pass the selected
 * agent; the store falls back to the last agent it talked to.
 */
async function handleRefreshSessions() {
  await sessionStore.refreshAgentSessions(
    isConnected.value ? undefined : selectedAgent.value || undefined
  );
}

async function handleDisconnect() {
  await sessionStore.disconnect();
}

async function handleCancelConnection() {
  await sessionStore.cancelConnection();
}

function handlePermissionSelect(optionId: string) {
  sessionStore.resolvePermission(optionId);
}

function handlePermissionCancel() {
  sessionStore.cancelPermission();
}

function handleAuthMethodSelect(methodId: string) {
  sessionStore.selectAuthMethod(methodId);
}

function handleAuthMethodCancel() {
  sessionStore.cancelAuthSelection();
}

function toggleSidebar() {
  showSidebar.value = !showSidebar.value;
}

/** Close the drawer when the user taps the backdrop on a narrow viewport. */
function handleBackdropClick() {
  if (isNarrowLayout.value) showSidebar.value = false;
}

/**
 * Bare digits 1..4 switch views; the rail advertises its key in the tooltip.
 * Ignored while typing, so the composer and search fields keep their digits.
 */
function handleViewShortcut(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
  const view = VIEWS.find((candidate) => candidate.key === event.key);
  if (!view) return;
  event.preventDefault();
  uiStore.setView(view.id);
}
onBeforeUnmount(() => {
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrowLayout);
    narrowMql = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pageshow', scheduleReconnect);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('keydown', handleViewShortcut);
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
});

function clearError() {
  sessionStore.clearError();
  configStore.clearError();
}
</script>

<template>
  <div class="app-container" :class="{ 'narrow-layout': isNarrowLayout }">
    <!-- View rail: the shell's top-level navigation (Chat · Projects · Board · Dashboard) -->
    <nav class="view-rail" aria-label="Main views">
      <button
        v-for="view in VIEWS"
        :key="view.id"
        class="rail-btn"
        :class="{ active: uiStore.activeView === view.id }"
        :title="`${view.label} (${view.key})`"
        :aria-label="view.label"
        :aria-current="uiStore.activeView === view.id ? 'page' : undefined"
        @click="uiStore.setView(view.id)"
      >
        <svg
          v-if="view.id === 'chat'"
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.9 8.9 0 01-3.8-.9L3 20l1.1-3.3A8.4 8.4 0 013 11.5 8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z" /></svg>
        <svg
          v-else-if="view.id === 'projects'"
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
        <svg
          v-else-if="view.id === 'board'"
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z" /></svg>
        <svg
          v-else
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M12 20a8 8 0 110-16 8 8 0 010 16zM12 15.5l3-4.5M12 8.5v4" /></svg>
      </button>
    </nav>

    <!-- Sidebar (slides in as a drawer on narrow viewports) -->
    <aside
      v-show="showSidebar && uiStore.activeView === 'chat'"
      class="sidebar"
      :class="{ 'is-drawer': isNarrowLayout }"
    >
      <div class="sidebar-header">
        <h1>ACP UI</h1>
        <div class="header-actions">
          <button 
            class="settings-btn" 
            :class="{ active: showTrafficMonitor }"
            @click="showTrafficMonitor = !showTrafficMonitor" 
            title="ACP Traffic Monitor"
          >📡</button>
          <button class="settings-btn" @click="showSettings = true" title="Settings">⚙</button>
          <button class="toggle-btn" @click="toggleSidebar">◀</button>
        </div>
      </div>
      
      <div class="sidebar-content">
        <!-- Agent Selection -->
        <div class="section">
          <AgentSelector 
            v-model:selected="selectedAgent"
            @select="handleAgentSelect"
          />
          
          <!-- Working Directory Picker -->
          <div class="cwd-picker">
            <label>Working Directory:</label>
            <!-- Desktop: read-only display + folder picker. -->
            <div v-if="folderPickerAvailable" class="cwd-row">
              <span class="cwd-path" :title="selectedCwd || 'Current directory'">
                {{ selectedCwd ? selectedCwd.split(/[\\/]/).pop() : '.' }}
              </span>
              <button 
                class="cwd-btn" 
                @click="handleSelectFolder"
                title="Select folder"
                :disabled="isConnecting || isConnected"
              >
                📁
              </button>
            </div>
            <!-- Mobile / web: directory tree browser (bridge fs API) + editable
                 path. The path is interpreted on the agent's host. -->
            <DirectoryPicker
              v-else
              :base-url="fsBaseUrl"
              v-model="selectedCwd"
              :disabled="isConnecting || isConnected"
              @select="handleTreeSelect"
            />
          </div>
          
          <button 
            v-if="hasAgents && !isConnected && !isConnecting"
            class="new-session-btn"
            :disabled="!selectedAgent || isLoading"
            @click="handleNewSession"
          >
            {{ isLoading ? 'Connecting...' : 'New Session' }}
          </button>
          
          <!-- Startup Progress -->
          <StartupProgress 
            v-if="isConnecting"
            :agent-name="selectedAgent"
            :phase="sessionStore.startupPhase"
            :logs="sessionStore.startupLogs"
            :elapsed-seconds="sessionStore.startupElapsed"
            :show-details="showStartupDetails"
            @cancel="handleCancelConnection"
            @toggle-details="showStartupDetails = !showStartupDetails"
          />
          
          <button 
            v-if="isConnected"
            class="disconnect-btn"
            @click="handleDisconnect"
          >
            Disconnect
          </button>
        </div>
        
        <!-- Session List -->
        <div class="section">
          <SessionList 
            @resume="handleResumeSession"
            @delete="handleDeleteSession"
            @refresh="handleRefreshSessions"
          />
        </div>
      </div>
    </aside>
    
    <!-- Backdrop behind the drawer on narrow viewports. Only intercepts
         taps when the layout is narrow; on desktop it's display:none. -->
    <div
      v-show="isNarrowLayout && showSidebar && uiStore.activeView === 'chat'"
      class="drawer-backdrop"
      @click="handleBackdropClick"
    />

    <!-- Mobile hamburger to open the drawer when collapsed. The desktop
         chevron toggle (`.sidebar-toggle-collapsed`) is hidden on narrow
         viewports via CSS so we don't show two affordances. -->
    <button
      v-show="isNarrowLayout && !showSidebar"
      class="mobile-hamburger"
      @click="showSidebar = true"
      aria-label="Open menu"
    >☰</button>

    <!-- Collapsed sidebar toggle -->
    <button 
      v-if="!showSidebar" 
      class="sidebar-toggle-collapsed"
      @click="toggleSidebar"
    >
      ▶
    </button>
    
    <!-- Main Content Area -->
    <div class="main-area">
      <main class="main-content">
        <!-- Reconnect banner takes priority over the error banner: while a
             reconnect is in progress we don't want a contradictory red
             "Connection lost" pill. -->
        <div v-if="isReconnecting" class="reconnect-banner">
          <span class="reconnect-spinner" aria-hidden="true"></span>
          <span class="reconnect-text">
            Reconnecting to <strong>{{ reconnectingAgentName }}</strong>…
          </span>
        </div>

        <!-- Error display (suppressed while reconnecting). -->
        <div v-else-if="error" class="error-banner">
          <span class="error-icon">⚠</span>
          <span class="error-text">{{ error }}</span>
          <button
            v-if="canManuallyReconnect"
            class="error-action"
            @click="handleManualReconnect"
            title="Reconnect"
          >Reconnect</button>
          <button class="error-close" @click="clearError" title="Dismiss">×</button>
        </div>
        
        <!-- Chat View when connected -->
        <ChatView v-if="uiStore.activeView === 'chat' && isConnected" />

        <!-- Welcome screen when the chat view has no session yet -->
        <div v-else-if="uiStore.activeView === 'chat'" class="welcome-screen">
          <h2>Welcome to ACP UI</h2>
          <p>Select an agent and create a new session to get started.</p>
          <p v-if="!hasAgents" class="hint">
            Configure agents in your config file to begin.
          </p>
        </div>

        <ProjectsView v-else-if="uiStore.activeView === 'projects'" />
        <BoardView v-else-if="uiStore.activeView === 'board'" />
        <DashboardView v-else />
      </main>
      
      <!-- Traffic Monitor Panel -->
      <div v-if="showTrafficMonitor" class="traffic-panel">
        <TrafficMonitor @close="showTrafficMonitor = false" />
      </div>
    </div>
    
    <!-- Permission Dialog -->
    <PermissionDialog 
      v-if="pendingPermission"
      :request="pendingPermission"
      @select="handlePermissionSelect"
      @cancel="handlePermissionCancel"
    />

    <!-- Auth Method Dialog -->
    <AuthMethodDialog 
      v-if="pendingAuthMethods.length > 0"
      :auth-methods="pendingAuthMethods"
      :agent-name="pendingAuthAgentName"
      @select="handleAuthMethodSelect"
      @cancel="handleAuthMethodCancel"
    />

    <!-- Settings -->
    <SettingsView 
      v-if="showSettings"
      @close="showSettings = false"
    />
  </div>
</template>

<style>
:root {
  /* Calm paper palette: warm neutral background, terracotta accent,
   * dark ink text. Flat colors only — no gradients, no glows. */
  --bg-primary: #c2532f;
  --bg-primary-hover: #a8431f;
  --bg-sidebar: #f6f2ec;
  --bg-main: #fbf8f3;
  --bg-hover: #efe9e0;
  --bg-user: #f3e3d3;
  --bg-assistant: #f1ece4;
  --bg-code: #2b2723;
  --bg-success: #5a7d4f;
  --bg-danger: #b3402e;
  --bg-warning: #f5e9cf;
  --text-primary: #2b2723;
  --text-secondary: #6b6259;
  --text-muted: #a39a8e;
  --text-on-accent: #fbf8f3;
  --text-accent: #c2532f;
  --text-code: #e8e0d5;
  --border-color: #e3dbcf;
  /* Design tokens: density + faint chrome. Flat colors, thin hairline
   * borders, no shadows-as-decoration. */
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --sidebar-w: 288px;
  --border-faint: rgba(43, 39, 35, 0.09);
  --tint-hover: rgba(43, 39, 35, 0.045);
  --tint-active: rgba(194, 83, 47, 0.10);
  --accent-soft: rgba(194, 83, 47, 0.14);

  font-family: var(--font-ui);
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  background-color: var(--bg-main);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #e07450;
    --bg-primary-hover: #ea8a69;
    --bg-sidebar: #211d1a;
    --bg-main: #2a2521;
    --bg-hover: #363029;
    --bg-user: #3d3128;
    --bg-assistant: #332d28;
    --text-primary: #ece5da;
    --text-secondary: #b0a496;
    --text-muted: #7d7266;
    --text-accent: #e07450;
    --border-color: #3d362f;
    --border-faint: rgba(236, 229, 218, 0.13);
    --tint-hover: rgba(236, 229, 218, 0.06);
    --tint-active: rgba(224, 116, 80, 0.16);
    --accent-soft: rgba(224, 116, 80, 0.20);
    background-color: var(--bg-main);
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #app {
  height: 100%;
}
</style>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-faint);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-faint);
}

.sidebar-header h1 {
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.25rem;
}

.settings-btn,
.toggle-btn {
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.settings-btn:hover,
.toggle-btn:hover {
  color: var(--text-primary);
}

.settings-btn.active {
  color: var(--text-accent);
  background: var(--bg-hover);
  border-radius: 4px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.section {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border-faint);
}

.new-session-btn,
.disconnect-btn {
  width: 100%;
  margin-top: 0.625rem;
  height: 30px;
  padding: 0 0.75rem;
  border: none;
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: -0.005em;
  cursor: pointer;
}

.new-session-btn {
  background: var(--bg-primary);
  color: white;
}

.new-session-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.new-session-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cwd-picker {
  margin-top: 0.75rem;
}

.cwd-picker label {
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
}

.cwd-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cwd-path {
  flex: 1;
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 0.5rem;
  background: var(--bg-main);
  border: 1px solid var(--border-faint);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cwd-btn {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 1rem;
}

.cwd-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.cwd-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Mobile-only free-text cwd input. */
.cwd-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 16px; /* 16px = no iOS auto-zoom */
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.cwd-input:disabled {
  opacity: 0.5;
}

.disconnect-btn {
  background: var(--bg-danger);
  color: white;
}

.disconnect-btn:hover {
  background: #c82333;
}

.sidebar-toggle-collapsed {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-left: none;
  border-radius: 0 4px 4px 0;
  background: var(--bg-sidebar);
  cursor: pointer;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-main);
}

.traffic-panel {
  flex-shrink: 0;
  border-top: 2px solid var(--border-color);
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: #fee;
  color: #c00;
  border-bottom: 1px solid #fcc;
}

.error-icon {
  flex-shrink: 0;
}

.error-text {
  flex: 1;
}

.error-close {
  flex-shrink: 0;
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: #c00;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  border-radius: 4px;
}

.error-close:hover {
  opacity: 1;
  background: rgba(204, 0, 0, 0.1);
}

/* Inline "Reconnect" affordance shown next to a stale error when we have a
   saved session we could reattach to. */
.error-action {
  flex-shrink: 0;
  padding: 0.25rem 0.6rem;
  margin-right: 0.25rem;
  border: 1px solid #c00;
  border-radius: 4px;
  background: transparent;
  color: #c00;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}

.error-action:hover {
  background: rgba(204, 0, 0, 0.1);
}

/* Foreground-reconnect banner. Distinct visual style from the red error
   banner so users immediately read it as transient progress, not failure. */
.reconnect-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 1rem;
  background: #e0f2fe;
  color: #0369a1;
  border-bottom: 1px solid #bae6fd;
}

.reconnect-text {
  flex: 1;
  font-size: 0.9rem;
}

.reconnect-text strong {
  font-weight: 600;
}

.reconnect-spinner {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: reconnect-spin 0.9s linear infinite;
}

@keyframes reconnect-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-color-scheme: dark) {
  .reconnect-banner {
    background: #082f49;
    color: #7dd3fc;
    border-bottom-color: #0c4a6e;
  }
}

.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.welcome-screen h2 {
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.welcome-screen .hint {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}

/* ---------- Mobile / narrow-viewport layout ---------- */

.drawer-backdrop {
  display: none;
}

.mobile-hamburger {
  display: none;
}

/* ---------- View rail: top-level navigation ---------- */

.view-rail {
  position: relative;
  /* Above the mobile drawer backdrop (z-index 90), or the rail is unclickable
     on a narrow viewport with the session drawer open. */
  z-index: 95;
  flex: 0 0 auto;
  width: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0;
  background: var(--bg-sidebar, #f6f2ec);
  border-right: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.rail-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
}

.rail-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.rail-btn.active {
  color: var(--text-accent, #c2532f);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.rail-btn:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 2px;
}

@media (max-width: 800px) {
  /* On phones the app stacks: the rail becomes a top bar above the content, so
     it never steals width from the reading column. */
  .app-container.narrow-layout {
    flex-direction: column;
  }

  .view-rail {
    flex: 0 0 auto;
    flex-direction: row;
    width: 100%;
    height: auto;
    justify-content: flex-start;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-right: none;
    border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  }

  .rail-btn {
    width: 44px;
    height: 44px;
  }
}

@media (max-width: 800px) {
  .app-container {
    /* Prevent the off-screen drawer from causing horizontal scroll. */
    overflow-x: hidden;
  }

  /* Banners sit at the very top of the main area, where the OS status bar
     / camera notch overlap on phones. Extend the banner colour through the
     safe-area inset and push the text below it so the status bar reads as
     a tinted continuation of the banner instead of clipping its content. */
  .reconnect-banner,
  .error-banner {
    padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
  }

  .sidebar.is-drawer {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 85vw;
    max-width: 360px;
    z-index: 100;
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.3);
    /* Honour iOS notch / Android status bar. */
    padding-top: env(safe-area-inset-top, 0px);
  }

  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
  }

  /* The rail sits above the scrim and keeps working while the drawer is open. */
  .view-rail {
    position: relative;
    z-index: 95;
  }

  /* Hide the desktop chevron when the mobile hamburger is in play. */
  .sidebar-toggle-collapsed {
    display: none;
  }

  .mobile-hamburger {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
    left: 0.5rem;
    z-index: 50;
    width: 44px;
    height: 44px;
    padding: 0;
    background: var(--bg-sidebar);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
  }

  /* Tap-target sizing for the icon buttons inside the sidebar header. */
  .settings-btn,
  .toggle-btn {
    min-width: 40px;
    min-height: 40px;
    font-size: 1rem;
  }

  /* Honour the iOS home indicator at the bottom of the main area. */
  .main-area {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
</style>