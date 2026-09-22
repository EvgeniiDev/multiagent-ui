// Which top-level view the shell shows. Persisted so a reload lands where the
// user was working.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';

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
  const activeView = ref<ViewId>('chat');
  const showSettings = ref(false);
  const showTraffic = ref(false);
  let store: KVStore | null = null;

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

  // 1-4 switch views, Esc closes overlays. Registered once; ignored while the
  // user is typing in a field so shortcuts never eat a prompt.
  function bindShortcuts(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === 'Escape') {
        showSettings.value = false;
        showTraffic.value = false;
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const hit = VIEWS.find((v) => v.key === event.key);
      if (hit) {
        event.preventDefault();
        void setView(hit.id);
      }
    });
  }

  return { activeView, showSettings, showTraffic, initUiStore, setView, VIEWS };
});
