import { stateServerBase } from './host/storage';

export interface ChatFile {
  name: string;
  url: string;
  mimeType?: string;
  /** Ephemeral content for a loaded preview; never persisted in chat history. */
  blob?: Blob;
  text?: string;
}
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const FILE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|pdf|txt|md|markdown|jsonl?|csv|tsv|log|ya?ml|xml|html?|css|[cm]?js|tsx?|vue|py|sh|sql|toml|ini|cfg|conf|diff|patch|zip|gz|tar|docx?|xlsx?|pptx?)(?:$|[?#])/i;

/** Local links come from the agent host, never the phone's filesystem. */
export function chatFileFromLink(raw: string, cwd = '', image = false): ChatFile | null {
  let value = raw.trim();
  if (!value || value.startsWith('#') || /^(?:https?:|data:|blob:|mailto:|javascript:|\/\/)/i.test(value)) return null;
  if (/^file:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = url.pathname; }
    catch { return null; }
  } else if (value.startsWith('sandbox:/')) value = value.slice('sandbox:'.length);
  else if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  try { value = decodeURIComponent(value); } catch { return null; }
  value = value.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
  if (!image && !FILE_EXT.test(value)) return null;
  if (!value.startsWith('/')) {
    if (!cwd.startsWith('/')) return null;
    value = `${cwd.replace(/\/$/, '')}/${value}`;
  }
  const name = value.split('/').pop() || 'File';
  return { name, url: `${stateServerBase()}/api/chat-files?${new URLSearchParams({ path: value })}` };
}

export function previewKind(file: ChatFile, mime = file.mimeType || ''): 'image' | 'pdf' | 'text' | 'binary' {
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(name)) return 'image';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('text/') || /(?:json|xml|javascript)/.test(mime) || /\.(txt|md|markdown|jsonl?|csv|tsv|log|ya?ml|xml|html?|css|[cm]?js|tsx?|vue|py|sh|sql|toml|ini|cfg|conf|diff|patch)$/.test(name)) return 'text';
  return 'binary';
}

export function isMarkdownFile(file: ChatFile): boolean {
  return /\.(md|markdown)$/i.test(file.name) || file.mimeType?.split(';', 1)[0]?.trim() === 'text/markdown';
}

export function downloadChatBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Android can hand a download to another process after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function fetchChatFile(file: ChatFile, signal: AbortSignal): Promise<Blob> {
  const embedded = file.blob ?? (file.text !== undefined ? new Blob([file.text], { type: file.mimeType || 'text/plain' }) : null);
  if (embedded) {
    if (embedded.size > MAX_PREVIEW_BYTES) throw new Error('File is too large (maximum 32 MB)');
    return embedded;
  }
  const response = await fetch(file.url, { signal, credentials: 'omit' });
  if (!response.ok) {
    let reason = `Could not open file (HTTP ${response.status})`;
    try { const body = await response.json(); if (typeof body.error === 'string') reason = body.error; } catch { /* use HTTP reason */ }
    throw new Error(reason);
  }
  if (Number(response.headers.get('content-length')) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new Error('File is too large (maximum 32 MB)');
  }
  // Enforce the limit even for a response without Content-Length.
  const reader = response.body?.getReader();
  if (!reader) return new Blob([]);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREVIEW_BYTES) { await reader.cancel(); throw new Error('File is too large (maximum 32 MB)'); }
    chunks.push(value);
  }
  return new Blob(chunks, { type: file.mimeType || response.headers.get('content-type') || '' });
}
