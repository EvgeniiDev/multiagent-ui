/**
 * Session-in-URL: the open session lives in the address bar as `?s=<agent>::<sessionId>`.
 *
 * Why: F5 must reopen the chat the user is LOOKING at, not whatever a persisted
 * pointer happens to hold — those diverge when a resume fails late (a session
 * locked by another client, a transport error) while a background sidebar sync
 * keeps rewriting the pointer's document. The URL is the user's intent, set at
 * click time, immune to later store writes. It also makes a chat shareable.
 *
 * Key format matches `sessionKey` in `src/stores/session.ts`
 * (`${agentName}::${sessionId}`), URL-encoded as one query parameter.
 */

export function sessionUrlKey(agentName: string, sessionId: string): string {
  return `${agentName}::${sessionId}`;
}

/** Write the open session into the URL (replaceState — no history spam). */
export function setSessionInUrl(agentName: string, sessionId: string | null): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = new URL(location.href);
  if (!agentName || !sessionId) {
    url.searchParams.delete('s');
  } else {
    url.searchParams.set('s', sessionUrlKey(agentName, sessionId));
  }
  history.replaceState(null, '', url);
}

/** The session key from the current URL, or null. */
export function sessionFromUrl(): { agentName: string; sessionId: string } | null {
  if (typeof location === 'undefined') return null;
  const raw = new URL(location.href).searchParams.get('s');
  if (!raw) return null;
  const idx = raw.indexOf('::');
  if (idx <= 0 || idx === raw.length - 2) return null;
  return { agentName: raw.slice(0, idx), sessionId: raw.slice(idx + 2) };
}
