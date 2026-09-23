// Text-file read/write through the agent host bridge's fs API.
//
// The browser build has no filesystem of its own; files under the project
// directory on the host (e.g. role prompt files like `.acp/roles/dev.md`)
// are reached over HTTP:
//   GET  <bridge>/api/fs/read?path=<p>  -> { path, bytes, content }
//   POST <bridge>/api/fs/write          { path, content } -> { path, bytes, created? }
// Bridge errors are surfaced verbatim so the UI can show them honestly:
// 403 outside the bridge root, 415 binary file, 413 over 512 KB, 404 missing.
//
// The bridge base URL is resolved by the caller the same way
// DirectoryPicker.vue / features/settings/fsApi.ts do it (agent ws URL, or
// the default bridge port on the page host).

export interface FsReadResult {
  /** Absolute path the bridge actually read (relative inputs resolve
   * against the bridge root). */
  path: string;
  bytes: number;
  content: string;
}

export interface FsWriteResult {
  path: string;
  bytes: number;
  created?: boolean;
}

/** Pull the bridge's own `error` field out of a non-2xx response. */
async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* not JSON — fall through to the status */
  }
  return `HTTP ${resp.status}`;
}

export async function readTextFile(baseUrl: string, path: string): Promise<FsReadResult> {
  const q = new URLSearchParams({ path });
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/read?${q.toString()}`);
  } catch (e) {
    throw new Error(
      `Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!resp.ok) throw new Error(await readError(resp));
  return (await resp.json()) as FsReadResult;
}

export async function writeTextFile(
  baseUrl: string,
  path: string,
  content: string
): Promise<FsWriteResult> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!resp.ok) throw new Error(await readError(resp));
  return (await resp.json()) as FsWriteResult;
}
