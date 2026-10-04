import type { ViewId } from '../stores/ui';
import { isTauriHost } from './platform';
const VIEWS: ViewId[] = ['chat', 'projects', 'board', 'dashboard'];
export function viewFromUrl(href?: string): ViewId | null {
  if (isTauriHost()) return null;
  const address = href ?? (typeof location === 'undefined' ? null : location.href);
  if (!address) return null;
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const view = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  return VIEWS.includes(view as ViewId) ? view as ViewId : null;
}
export function setViewInUrl(view: ViewId, replace = false): void {
  if (isTauriHost()) return;
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  if (!['http:', 'https:'].includes(url.protocol)) return;
  url.pathname = `/${view}`;
  if (url.href === location.href) return;
  history[replace ? 'replaceState' : 'pushState'](history.state, '', url);
}
