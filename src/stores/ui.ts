// Which top-level view the shell shows. Persisted so a reload lands where the
// user was working.
//
// This store is also the scope entry point for views: `activeProjectId`
// (`'all' | projectId`) is the single source the header selector writes and
// every view reads. The value itself lives in the projects registry (W1's
// `stores/projects.ts`, reached through the features/scope seam) — the
// registry owns persistence in `projects.json`; what is kept here is only the
// delegating computed so no view ever holds a private copy.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { useProjectsStore } from '../features/scope/registry';

export type ViewId = 'chat' | 'projects' | 'board' | 'dashboard';

export const VIEWS: { id: ViewId; label: string; key: string }[] = [
  { id: 'chat', label: 'Chat', key: '1' },
  { id: 'projects', label: 'Projects', key: '2' },
  { id: 'board', label: 'Board', key: '3' },
  { id: 'dashboard', label: 'Dashboard', key: '4' },
];

const STORE_PATH = 'preferences.json';
const KEY = 'activeView';

export const useUiStore = defineStore('ui', () => {
  const projectsStore = useProjectsStore();
  const activeView = ref<ViewId>('chat');
  const showSettings = ref(false);
  const showTraffic = ref(false);
  let store: KVStore | null = null;

  // Global project scope ('all' | project id). Reads/writes delegate to the
  // registry — persistence, validation and the Common default live there.
  const activeProjectId = computed<string>(() => projectsStore.activeProjectId);
  const activeProject = computed(() => projectsStore.activeProject);

  async function setActiveProject(id: string): Promise<void> {
    await projectsStore.setActiveProject(id);
  }

  async function initUiStore(): Promise<void> {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<ViewId>(KEY);
    if (saved && VIEWS.some((v) => v.id === saved)) activeView.value = saved;
    bindShortcuts();
  }

  async function setView(view: ViewId): Promise<void> {
    activeView.value = view;
    if (store) {
      await store.set(KEY, view);
      await store.save();
    }
  }

  // 1-4 switch views, Esc closes overlays. This is the single owner of the
  // view-switch shortcuts, registered once at store init; ignored while the
  // user is typing in a field (any <input> — including type="number" —
  // textarea, select or contentEditable) so shortcuts never eat a prompt.
  function bindShortcuts(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (event.key === 'Escape') {
        showSettings.value = false;
        showTraffic.value = false;
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const hit = VIEWS.find((v) => v.key === event.key);
      if (hit) {
        event.preventDefault();
        void setView(hit.id);
      }
    });
  }

  return {
    activeView,
    showSettings,
    showTraffic,
    activeProjectId,
    activeProject,
    initUiStore,
    setView,
    setActiveProject,
    VIEWS,
  };
});
