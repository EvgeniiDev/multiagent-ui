<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { canPickFolder, pickFolder, loadKvStore, type KVStore } from './lib/host';
import { useConfigStore } from './stores/config';
import { useSessionStore } from './stores/session';
import { initTelemetry } from './lib/telemetry';
import AgentSelector from './components/AgentSelector.vue';
import SessionList from './components/SessionList.vue';
import SessionTabs from './components/SessionTabs.vue';
import ChatView from './components/ChatView.vue';
import UiButton from './components/ui/UiButton.vue';
import { createDrawerSwipe } from './lib/drawerSwipe';
import PermissionDialog from './components/PermissionDialog.vue';
import SettingsView from './components/SettingsView.vue';
import AuthMethodDialog from './components/AuthMethodDialog.vue';
import TrafficMonitor from './components/TrafficMonitor.vue';
import StartupProgress from './components/StartupProgress.vue';
import DirectoryPicker from './components/DirectoryPicker.vue';
import ProjectsView from './components/ProjectsView.vue';
import BoardView from './components/BoardView.vue';
import DashboardView from './components/DashboardView.vue';
import ProjectScopeSelector from './components/ProjectScopeSelector.vue';
import NewSessionDialog from './features/projects/NewSessionDialog.vue';
import { useUiStore, VIEWS } from './stores/ui';
import { useActivityStore } from './stores/activity';
import { useClaimsStore } from './stores/claims';
import { useProjectsStore } from './features/scope/registry';
import type { SavedSession } from './lib/types';
import { setSessionInUrl, sessionFromUrl } from './lib/sessionUrl';
import { viewFromUrl } from './lib/viewUrl';
import type { ViewId } from './stores/ui';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const uiStore = useUiStore();
const activityStore = useActivityStore();
const claimsStore = useClaimsStore();
const projectsStore = useProjectsStore();

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
// "New session" on the welcome screen — the same dialog the Projects header
// uses, so starting a session works before any connection exists.
const showWelcomeNewSession = ref(false);

/** Working directory a scoped "New session" starts in: the active project's
 * path, or empty (agent's default) at All. */
const scopeCwd = computed(() => projectsStore.activeProject?.path ?? '');

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

// A cached tail keeps the chat up while the replay is in flight — and when
// the replay died, the tail is all there is (marked stale by the store).
// Per-tab now: the per-runtime ChatView v-show reads it off the runtime.

async function handleManualReconnect() {
  await sessionStore.tryReconnect();
}

// Watch for permission requests from session store
const pendingPermission = computed(() => sessionStore.pendingPermission);

// Watch for auth method selection requests
const pendingAuthMethods = computed(() => sessionStore.pendingAuthMethods);
const pendingAuthAgentName = computed(() => sessionStore.pendingAuthAgentName);

onMounted(async () => {
  window.addEventListener('popstate', restoreSessionFromHistory);
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
  await claimsStore.initClaimsStore();
  // e2e seam — same shape as window.__projects / __pipeline: the ledger
  // write path tests use to append facts (recordEntry) on a live page.
  (window as unknown as { __activity: unknown }).__activity = activityStore;
  // Registry first: ui's project-scope reads delegate to it.
  await projectsStore.initProjectsStore();
  await uiStore.initUiStore();

  const savedCwd = await prefsStore.get<string>('lastCwd');
  if (savedCwd) {
    selectedCwd.value = savedCwd;
  }

  // F5 restores the open TABS: initStore read the persisted openTabs set,
  // but the live bridges are gone — restoreTabs reconnects each tab (the
  // URL's `?s=<agent>::<sessionId>` wins as the focused one, since it's the
  // newest intent). Tabs whose session the agent no longer holds fall back
  // to an error banner inside the tab; with no tabs at all we land on the
  // welcome screen like before.
  const fromUrl = sessionFromUrl();
  if (sessionStore.hasStoredTabs || fromUrl) {
    const focus = fromUrl ? { agentName: fromUrl.agentName, sessionId: fromUrl.sessionId } : null;
    const focusSaved = focus
      ? sessionStore.savedSessions.find(
          (s) => s.agentName === focus.agentName && s.sessionId === focus.sessionId
        )
      : null;
    if (focusSaved) {
      selectedAgent.value = focusSaved.agentName;
      selectedCwd.value = focusSaved.cwd || selectedCwd.value;
      // Scope the sidebar to the URL's agent as well — without this the
      // dropdown shows the URL agent while the header list still shows whatever
      // the last sync scoped to (the previous agent).
      try {
        await sessionStore.setActiveAgent(focusSaved.agentName);
      } catch (e) {
        console.warn('Failed to scope sidebar to URL agent:', e);
      }
    }
    await sessionStore.restoreTabs(focus);
  }
  if (sessionStore.openTabs.length === 0) {
    // No open session — pre-select the last used agent + cwd so a reload
    // with no session (or after Disconnect) keeps the new-session form
    // filled instead of dropping to blanks. The sidebar scope follows the
    // agent the same way a manual pick would.
    const lastAgent = sessionStore.lastAgentName;
    if (lastAgent && configStore.getAgent(lastAgent)) {
      selectedAgent.value = lastAgent;
      try {
        await sessionStore.setActiveAgent(lastAgent);
      } catch (e) {
        console.warn('Failed to scope sidebar to last agent:', e);
      }
    }
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

/** Start another session from the session list's header. Each session gets
 *  its own tab and its own connection — nothing to tear down first. */
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

function restoreSessionFromHistory(): void {
  if (viewFromUrl() !== 'chat') return;
  const target = sessionFromUrl();
  if (!target) return;
  const active = sessionStore.activeRuntime?.descriptor;
  if (active?.agentName === target.agentName && active.sessionId === target.sessionId) return;
  const saved = sessionStore.savedSessions.find(
    (s) => s.agentName === target.agentName && s.sessionId === target.sessionId,
  );
  if (saved) void handleResumeSession(saved);
}

async function handleResumeSession(session: SavedSession) {
  selectedAgent.value = session.agentName;
  // The URL carries the user's intent at click time — F5 restores exactly this
  // chat even when the resume fails or a background sync rewrites the store.
  setSessionInUrl(session.agentName, session.sessionId);
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

/** "New session" from the auth prompt: drop the half-open connect and open
 *  the same dialog the welcome screen uses, so a wrong agent/cwd is not a
 *  dead end. The cancelled auth rejects into createSession, whose catch
 *  paints a red "Authentication cancelled by user" banner a tick or two
 *  later — wait the teardown out, then wipe it. The user is starting over,
 *  not failing. */
async function handleAuthNewSession() {
  sessionStore.cancelAuthSelection();
  showWelcomeNewSession.value = true;

  // Bounded: if the bridge hangs, never leave a waiter spinning.
  for (let i = 0; i < 60 && (isLoading.value || isConnecting.value); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  sessionStore.clearError();
}

const drawerSwipe = createDrawerSwipe({
  isEnabled: () => isNarrowLayout.value,
  isOpen: () => showSidebar.value,
  setOpen: (open) => { showSidebar.value = open; },
});

async function openDrawer() {
  showSidebar.value = true;
  await nextTick();
  document.getElementById('app-sidebar')?.querySelector<HTMLButtonElement>('[aria-label="Collapse sidebar"]')?.focus();
}

function handleDrawerEscape() {
  if (isNarrowLayout.value) showSidebar.value = false;
}

function toggleSidebar() {
  showSidebar.value = !showSidebar.value;
}

/** Close the drawer when the user taps the backdrop on a narrow viewport. */
function handleBackdropClick() {
  if (isNarrowLayout.value) showSidebar.value = false;
}

/** Current view name for the drawer's view-switcher label (narrow only). */
const drawerViewLabel = computed(
  () => uiStore.ready ? (VIEWS.find((v) => v.id === uiStore.activeView)?.label ?? 'Chat') : 'Loading…'
);

/** Pick a view from the drawer's view row (narrow only): switch, then close
 *  the drawer so the chosen view fills the screen. */
function handleDrawerViewClick(view: ViewId) {
  void uiStore.setView(view);
  if (isNarrowLayout.value) showSidebar.value = false;
}

onBeforeUnmount(() => {
  window.removeEventListener('popstate', restoreSessionFromHistory);
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
  <div
    class="app-container"
    :class="{ 'narrow-layout': isNarrowLayout }"
    @pointerdown="drawerSwipe.start"
    @pointermove="drawerSwipe.move"
    @pointerup="drawerSwipe.end"
    @pointercancel="drawerSwipe.cancel"
    @keydown.esc="handleDrawerEscape"
  >
    <!-- View rail: the shell's top-level navigation (Chat · Projects · Board · Dashboard) -->
    <nav class="view-rail" aria-label="Main views">
      <button
        v-for="view in VIEWS"
        :key="view.id"
        class="rail-btn"
        :class="{ active: uiStore.ready && uiStore.activeView === view.id }"
        :title="`${view.label} (${view.key})`"
        :aria-label="view.label"
        :aria-current="uiStore.ready && uiStore.activeView === view.id ? 'page' : undefined"
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
          v-else-if="view.id === 'dashboard'"
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M12 20a8 8 0 110-16 8 8 0 010 16zM12 15.5l3-4.5M12 8.5v4" /></svg>
        <svg
          v-else
          viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="12" r="2.4" /><path d="M8.4 6H12a3 3 0 0 1 3 3v.6M8.4 18H12a3 3 0 0 0 3-3v-.6" /></svg>
      </button>
    </nav>

    <!-- Sidebar (slides in as a drawer on narrow viewports). Global on
         narrow: the drawer is reachable from every view there, not just
         chat — an edge swipe opens it on all of them.
         On desktop unchanged: only the chat view shows the sidebar. -->
    <aside
      v-show="uiStore.ready && showSidebar && (isNarrowLayout || uiStore.activeView === 'chat')"
      id="app-sidebar"
      class="sidebar"
      :class="{ 'is-drawer': isNarrowLayout }"
    >
      <div class="sidebar-header">
        <h1>ACP UI</h1>
        <div class="header-actions">
          <button
            class="scope-icon-btn"
            :class="{ active: showTrafficMonitor }"
            type="button"
            title="ACP Traffic Monitor"
            aria-label="ACP Traffic Monitor"
            @click="showTrafficMonitor = !showTrafficMonitor"
          ><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a5.5 5.5 0 0 1 0-8.4M12 12h.01M16.7 10.3a3 3 0 0 1 0 4.4M19.6 7.4a7 7 0 0 1 0 10.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg></button>
          <button
            class="scope-icon-btn"
            type="button"
            title="Settings"
            aria-label="Settings"
            @click="showSettings = true"
          ><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z"/></svg></button>
          <UiButton variant="ghost" icon aria-label="Collapse sidebar" aria-controls="app-sidebar" @click="toggleSidebar"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg></UiButton>
        </div>
      </div>
      
      <div class="sidebar-content">
        <!-- Narrow layout only: view switching. Since the narrow layout hides
             the view rail, its four buttons are mirrored here as the drawer's
             first row — same labels, icons, aria/title; picking a view closes
             the drawer. -->
        <nav v-if="isNarrowLayout" class="drawer-view-nav" aria-label="Main views">
          <button
            v-for="view in VIEWS"
            :key="view.id"
            class="rail-btn"
            :class="{ active: uiStore.ready && uiStore.activeView === view.id }"
            :title="`${view.label} (${view.key})`"
            :aria-label="view.label"
            :aria-current="uiStore.ready && uiStore.activeView === view.id ? 'page' : undefined"
            @click="handleDrawerViewClick(view.id)"
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
              v-else-if="view.id === 'dashboard'"
              viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M12 20a8 8 0 110-16 8 8 0 010 16zM12 15.5l3-4.5M12 8.5v4" /></svg>
            <svg
              v-else
              viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="12" r="2.4" /><path d="M8.4 6H12a3 3 0 0 1 3 3v.6M8.4 18H12a3 3 0 0 0 3-3v-.6" /></svg>
            </button>
          <span class="drawer-view-label">{{ drawerViewLabel }}</span>
        </nav>
        <!-- Project scope next to the session list it filters. Was the
              scope-bar's global selector; the sidebar is chat-only on
              desktop, so the board keeps its own filter row instead of this
              hidden global one. One instance for both layouts. -->
        <div class="section drawer-project-scope">
          <label>Project:</label>
          <ProjectScopeSelector />
        </div>
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
                aria-label="Select folder"
                :disabled="isConnecting || isConnected"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
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
          <!-- New session lives in the session list's header; there is no
               Disconnect — the connection re-establishes on its own. -->
          
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
          
        </div>
        
        <!-- Session List -->
        <div class="section">
          <SessionList 
            :can-start="hasAgents && !!selectedAgent"
            @resume="handleResumeSession"
            @delete="handleDeleteSession"
            @refresh="handleRefreshSessions"
            @new-session="handleNewSession"
          />
        </div>
      </div>
    </aside>
    
    <!-- Backdrop behind the drawer on narrow viewports. Only intercepts
         taps when the layout is narrow; on desktop it's display:none. Like
         the drawer itself it is view-independent. -->
    <div
      v-show="isNarrowLayout && showSidebar"
      class="drawer-backdrop"
      @click="handleBackdropClick"
    />

    <!-- Collapsed sidebar toggle -->
    <button 
      v-if="!showSidebar" 
      class="sidebar-toggle-collapsed"
      aria-label="Expand sidebar"
      @click="toggleSidebar"
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>
    </button>
    
    <!-- Main Content Area -->
    <div class="main-area">
      <!-- No in-flow menu bar: touch opens the drawer from the left edge.
           Keep a keyboard/screen-reader opener that appears when focused. -->
      <UiButton
        v-if="isNarrowLayout && !showSidebar"
        class="drawer-menu-access"
        variant="ghost"
        icon
        aria-label="Open menu"
        aria-controls="app-sidebar"
        :aria-expanded="showSidebar"
        @click="openDrawer"
      >☰</UiButton>
      <div
        v-if="isNarrowLayout && !showSidebar"
        class="drawer-swipe-edge"
        aria-hidden="true"
      />
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
          <span class="error-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19zM12 10v4.5M12 17.5h.01"/></svg></span>
          <span class="error-text">{{ error }}</span>
          <button
            v-if="canManuallyReconnect"
            class="error-action"
            @click="handleManualReconnect"
            title="Reconnect"
          >Reconnect</button>
          <button class="error-close" @click="clearError" title="Dismiss">×</button>
        </div>
        
        <div v-if="!uiStore.ready" class="welcome-screen" role="status" data-testid="view-loading">
          <span class="reconnect-spinner" aria-hidden="true"></span>
          <p>Restoring view…</p>
        </div>
        <template v-else>
        <!-- IDE-style tab strip: one tab per open session, each with its own
             live connection — background tabs keep streaming and flag unread
             output, pending permissions and dropped transports. On narrow
             viewports a single tab doesn't earn a strip — the drawer's
             SESSIONS list highlights the open session — so the strip only
             appears with 2+ tabs. -->
        <SessionTabs
          v-if="uiStore.activeView === 'chat' && sessionStore.openTabs.length > (isNarrowLayout ? 1 : 0)"
        />

        <!-- Chat View per open tab. v-show (not v-if) keeps every mounted
             instance alive across switches: scroll position, expanded tool
             calls and the composer draft survive. The pane shows whenever its
             tab is active — a replay streams live under isLoading before
             isConnected lands, and a failed connect keeps the tab's error
             visible. The composer disables itself when !isConnected. -->
        <template v-if="uiStore.activeView === 'chat'">
          <ChatView
            v-for="rt in sessionStore.openTabs"
            v-show="rt.id === sessionStore.activeTabId"
            :key="rt.id"
            :runtime="rt"
            :sidebar-cwd="selectedCwd"
          />
        </template>

        <!-- Welcome screen when no tabs are open at all. The New session
             dialog is reachable here too — a session start must not depend
             on an existing connection. -->
        <div v-if="uiStore.activeView === 'chat' && sessionStore.openTabs.length === 0" class="welcome-screen">
          <h2>Welcome to ACP UI</h2>
          <p>Select an agent and create a new session to get started.</p>
          <button
            class="welcome-new-session"
            type="button"
            @click="showWelcomeNewSession = true"
          >
            New session
          </button>
          <p v-if="!hasAgents" class="hint">
            Configure agents in your config file to begin.
          </p>
        </div>

        <ProjectsView v-if="uiStore.activeView === 'projects'" />
        <BoardView v-if="uiStore.activeView === 'board'" />
        <DashboardView v-if="uiStore.activeView === 'dashboard'" />
        </template>
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
      @new-session="handleAuthNewSession"
    />

    <!-- Settings -->
    <SettingsView 
      v-if="showSettings"
      @close="showSettings = false"
    />

    <!-- New session from the welcome screen (no connection required).
         Prefills with the path shown in the sidebar's Working Directory
         field; the project scope fills in only when that field is empty. -->
    <NewSessionDialog
      v-if="showWelcomeNewSession"
      :initial-cwd="selectedCwd || scopeCwd"
      @close="showWelcomeNewSession = false"
    />
  </div>
</template>

<style src="./styles/tokens.css"></style>
<style src="./styles/controls.css"></style>

<style>
/* One painted scrollbar for the whole app. `scrollbar-color` is the standard
   property (Chromium 121+, Firefox); the ::-webkit-* rules below are the
   fallback for engines that still ignore it. */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
  background-clip: padding-box;
}

::-webkit-scrollbar-corner {
  background: transparent;
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

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.section {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border-faint);
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

/* Project scope in the sidebar, above the session list it filters (all
   layouts — on narrow it's the same drawer block). Shares the AGENT /
   WORKING DIRECTORY label language, and the selector's internal narrow
   media query already stretches its select, so just force full width. */
.drawer-project-scope label {
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
}

.drawer-project-scope .scope-selector {
  width: 100%;
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

.sidebar-toggle-collapsed {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  /* Above the view rail (z 95) that covers the whole left edge — without
   * this the expand handle is unreachable and the sidebar can never come
   * back once collapsed. */
  z-index: 96;
  padding: 0.75rem 0.375rem;
  border: 1px solid var(--border-color);
  border-left: none;
  border-radius: 0 4px 4px 0;
  background: var(--bg-sidebar);
  cursor: pointer;
}

.sidebar-toggle-collapsed:hover {
  color: var(--text-primary);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Sidebar-header icon buttons (Traffic + Settings). Same geometry as the
 * view rail (34×34, radius-md, hairline/ghost) so the header reads as one
 * chrome row. */
.scope-icon-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
}

.scope-icon-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.scope-icon-btn.active {
  color: var(--text-accent, #c2532f);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.scope-icon-btn:focus-visible {
  outline: 2px solid var(--text-accent, #c2532f);
  outline-offset: 2px;
}

/* Accessible menu opener is out of flow; keyboard focus reveals it. */
.drawer-menu-access {
  position: fixed;
  top: calc(0.5rem + env(safe-area-inset-top, 0px));
  left: 0.5rem;
  z-index: 110;
  clip-path: inset(50%);
}

.drawer-menu-access:focus-visible {
  clip-path: none;
}

.drawer-swipe-edge {
  position: fixed;
  inset: 0 auto 0 0;
  width: 24px;
  z-index: 80;
  /* A fallback for views without a chat feed; the chat edge belongs to
     its scroll container so vertical edge swipes scroll the transcript. */
  touch-action: pan-y pinch-zoom;
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

/* Same accent CTA language as the Projects header's .new-session-cta. */
.welcome-new-session {
  margin-top: 1.25rem;
  height: 34px;
  padding: 0 1.25rem;
  border: none;
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-on-accent, #fbf8f3);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.welcome-new-session:hover {
  background: var(--bg-primary-hover);
}

@media (max-width: 800px) {
  .welcome-new-session {
    min-height: 44px;
  }
}

/* ---------- Mobile / narrow-viewport layout ---------- */

.drawer-backdrop {
  display: none;
}

/* ---------- View rail: top-level navigation ---------- */

.view-rail {
  position: relative;
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
}.rail-btn {
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
  /* On phones the downward rail becomes a hamburger: it's hidden entirely and
     view switching lives in the drawer's top row instead — content starts one
     chrome strip higher. */
  .app-container.narrow-layout {
    flex-direction: column;
  }

  .view-rail {
    display: none;
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
    touch-action: pan-y pinch-zoom;
    /* Honour iOS notch / Android status bar. */
    padding-top: env(safe-area-inset-top, 0px);
  }

  .sidebar.is-drawer .sidebar-content {
    touch-action: pan-y pinch-zoom;
  }

  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
  }

  /* Mobile navigation uses the edge gesture instead of the desktop handle. */
  .sidebar-toggle-collapsed {
    display: none;
  }

  /* Drawer's first row: the view switcher that replaced the hidden rail.
     Same icon buttons as the rail (44px tap targets), current view accented,
     followed by the view's name. */
  .drawer-view-nav {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 0 0 auto;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
    background: var(--bg-sidebar, #f6f2ec);
  }

  .drawer-view-nav .rail-btn {
    width: 44px;
    height: 44px;
    border-radius: var(--radius-md, 6px);
  }

  .drawer-view-label {
    margin-left: auto;
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-secondary, #6b6259);
    white-space: nowrap;
  }

  .scope-icon-btn {
    width: 44px;
    height: 44px;
  }

  /* Honour the iOS home indicator at the bottom of the main area. */
  .main-area {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
</style>