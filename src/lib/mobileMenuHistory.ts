/** A mobile page sits above its menu in browser history. Back reveals the
 * menu; Back again can leave. Entries survive reload without growing a trap.
 */
const KEY = 'acpMobileMenu';
const URL_CHANGED = 'acp:menu-url-changed';
type Entry = 'menu' | 'page';
type Marker = { id: string; entry: Entry };
function marker(): Marker | undefined {
  const value = history.state?.[KEY];
  return value && typeof value.id === 'string' && ['menu', 'page'].includes(value.entry) ? value : undefined;
}
export function hasMobileMenuHistory(): boolean {
  return window.matchMedia('(max-width: 800px)').matches && !!marker();
}
/** Desktop navigation starts an ordinary entry instead of inheriting a pair. */
export function viewHistoryState() {
  const state = { ...history.state };
  if (!hasMobileMenuHistory()) delete state[KEY];
  return state;
}
/** Session creation can write its URL long after the active tab changed. */
export function noteMobileMenuUrlChange() {
  window.dispatchEvent(new Event(URL_CHANGED));
}

export function createMobileMenuHistory(options: {
  enabled: () => boolean;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
}) {
  let active = false;
  let pairId = '';
  let movingBack = false;
  let pageUrl = location.href;
  const state = (entry: Entry) => ({ ...history.state, [KEY]: { id: pairId, entry } });
  const rememberUrl = () => { pageUrl = location.href; };

  function sync() {
    if (!options.enabled()) { active = false; return; }
    if (movingBack) return;
    rememberUrl();
    if (!active) {
      active = true;
      const existing = marker();
      if (existing) {
        pairId = existing.id;
        options.setOpen(existing.entry === 'menu');
        return;
      }
      pairId = crypto.randomUUID();
      history.replaceState(state('menu'), '');
      if (!options.isOpen()) history.pushState(state('page'), '');
      return;
    }
    if (options.isOpen() && marker()?.entry === 'page') {
      movingBack = true;
      history.back();
    } else if (!options.isOpen() && marker()?.entry === 'menu') {
      history.pushState(state('page'), '');
    }
  }

  function onPop(event: PopStateEvent) {
    if (!options.enabled()) return;
    movingBack = false;
    const target = marker();
    if (target?.id !== pairId) {
      // A normal older section/document is owned by the usual route handlers.
      active = false;
      queueMicrotask(sync);
      return;
    }
    const open = target.entry === 'menu';
    // The menu belongs to the current session, not the URL at pair creation.
    history.replaceState(history.state, '', pageUrl);
    event.stopImmediatePropagation();
    options.setOpen(open);
  }
  window.addEventListener('popstate', onPop, true);
  window.addEventListener(URL_CHANGED, rememberUrl);
  return { sync, dispose() {
    window.removeEventListener('popstate', onPop, true);
    window.removeEventListener(URL_CHANGED, rememberUrl);
  } };
}
