// Filesystem bridge access for the Settings → Projects admin section.
//
// The browser build has no filesystem of its own; folder listing/creation
// goes through the agent host bridge (`GET /api/fs/*`, `POST /api/fs/mkdir`),
// exactly like `src/components/DirectoryPicker.vue` does. The bridge base URL
// is derived from an agent's configured ws:// URL the same way App.vue and
// NewSessionDialog.vue do it: same host, http(s) scheme, ws(s) port.
//
// This module deliberately mirrors that logic instead of sharing it —
// `src/lib/**` is owned by another workstream (off-limits for W1).

import { toSecureUrl } from '../../lib/host/secure';

export interface FsDirEntry {
  name: string;
  path: string;
}

export interface FsRoot {
  root: string;
  home: string;
}

export interface FsList {
  path: string;
  parent: string;
  root: string;
  dirs: FsDirEntry[];
}

/** Derive the bridge HTTP base URL from an agent ws(s) URL. '' when the
 * agent has no remote URL (nothing to talk to). */
export function bridgeBaseUrlForAgentUrl(url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return (
      (u.startsWith('wss://') ? 'https://' : 'http://') +
      u.slice(u.indexOf('://') + 3).replace(/\/+$/, '')
    );
  }
  return '';
}

/** Default bridge base URL when the deployment only serves the panel: the
 * page host with the default Hermes bridge port. Matches how the web config
 * seeds `Hermes Agent` on `location.hostname` (see `src/lib/host/index.ts`
 * `defaultWebConfig`). Used as a fallback so Settings → Projects works in
 * the e2e harness, which serves dist-web directly with no agents configured. */
export function defaultBridgeBaseUrl(): string {
  if (typeof location === 'undefined') return '';
  const hostname = location.hostname || '127.0.0.1';
  // Untouched over http; on an https page the ws-twin of the seeded wss://
  // bridge URL is the TLS front on port + 10, so the fallback must not emit
  // a mixed-content http:// base.
  return toSecureUrl(`http://${hostname}:25901`);
}

async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* not JSON — fall through to the status */
  }
  return `HTTP ${resp.status}`;
}

export async function fsRoot(baseUrl: string): Promise<FsRoot> {
  const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/root`);
  if (!resp.ok) throw new Error(await readError(resp));
  return (await resp.json()) as FsRoot;
}

export async function fsList(baseUrl: string, path?: string): Promise<FsList> {
  const q = new URLSearchParams();
  if (path) q.set('path', path);
  q.set('hidden', '1');
  const resp = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/api/fs/list?${q.toString()}`
  );
  if (!resp.ok) throw new Error(await readError(resp));
  return (await resp.json()) as FsList;
}

/** Create a directory tree on the host. Resolves to the created absolute
 * path; throws a human-readable Error (including the bridge's 403 for paths
 * outside its root) on failure. */
export async function fsMkdir(baseUrl: string, path: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!resp.ok) throw new Error(`Cannot create folder: ${await readError(resp)}`);
  const data = (await resp.json()) as { path?: string };
  return data.path ?? path;
}
