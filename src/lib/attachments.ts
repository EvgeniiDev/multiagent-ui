// Turning browser File objects into ACP prompt attachments.
//
// Attachments are always self-contained: an image is sent as base64 and a text
// file as inline text, because the agent commonly runs on another machine and
// cannot read the client's paths. A `resource_link` would therefore arrive as a
// dead URI, which is why nothing here builds one.

import { uuid } from './uuid';
import type { Attachment, AttachmentKind, AttachmentMeta } from './types';
import type { ContentBlock } from '@agentclientprotocol/sdk';

/** Hermes truncates inlined ACP resources at 512 KiB, so the cap is ours to enforce. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
/** Data URLs above a few megabytes get rejected upstream (provider limits). */
export const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Extensions treated as text when the browser reports no (or a vague) MIME type. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'log',
  'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx',
  'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c',
  'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'sql', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'diff', 'patch', 'srt',
  'vtt', 'tex', 'gradle', 'dockerfile', 'makefile', 'gitignore', 'editorconfig',
]);

/** `image`, `text`, or null when the file is neither (binary archives, PDFs, …). */
export function classifyFile(file: File): AttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image';
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (file.type.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  // Browsers often report an empty type for code files saved without one, and
  // some report application/octet-stream — fall back to the extension above.
  if (!file.type && TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Read one picked file, or explain why it can't be attached. */
export async function readAttachment(
  file: File
): Promise<{ attachment: Attachment } | { error: string }> {
  const kind = classifyFile(file);
  if (!kind) {
    return { error: `${file.name}: only images and text files can be attached` };
  }
  const cap = kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (file.size > cap) {
    return { error: `${file.name}: ${formatBytes(file.size)} exceeds the ${formatBytes(cap)} limit` };
  }

  if (kind === 'image') {
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return {
      attachment: {
        id: uuid(),
        name: file.name,
        kind,
        mimeType: file.type || 'image/png',
        size: file.size,
        data: base64,
        previewUrl: dataUrl,
      },
    };
  }

  return {
    attachment: {
      id: uuid(),
      name: file.name,
      kind,
      mimeType: file.type || 'text/plain',
      size: file.size,
      data: await file.text(),
    },
  };
}

/** Read a batch (a multi-file pick), keeping successes and collecting failures. */
export async function readAttachments(
  files: File[]
): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const result = await readAttachment(file);
    if ('attachment' in result) attachments.push(result.attachment);
    else errors.push(result.error);
  }
  return { attachments, errors };
}

// ---------------------------------------------------------------------------
// Replayed attachments
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

/** `attachment://x.txt` -> `x.txt`; a plain name passes through. */
function nameFromMarker(uri: string): string {
  const tail = uri.split(/[\\/]/).filter(Boolean).pop() || uri;
  const withoutScheme = tail.includes('://') ? tail.slice(tail.indexOf('://') + 3) : tail;
  return withoutScheme.replace(/^\/+/, '') || uri;
}

function looksLikeImage(name: string, mime?: string | null): boolean {
  if (mime && mime.startsWith('image/')) return true;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * One attachment marker, in either shape seen in the wild:
 *   `[attachment://notes.txt] <body>`                      (OpenCode)
 *   `[Attached file: notes.txt] URI: file:///notes.txt <body>`  (Hermes)
 * Hermes flattens its newlines into spaces, so the marker, the URI and the body
 * can all sit on one line; parsing is marker-driven rather than line-based.
 * The body runs from the end of a marker to the start of the next one.
 */
const ATTACHMENT_MARKER =
  /\[(?:Attached (file|image): ([^\]]+)|([a-z][a-z0-9+.-]*:\/\/[^\]\s]+))\](?:\s*URI:\s*(\S+))?/g;

/**
 * Recover attachments from a user message the agent replayed.
 *
 * Agents do not return content blocks on `session/load`; they echo the file into
 * the message TEXT, so a resumed conversation otherwise shows markers and file
 * bodies as prose. This pulls them back out so the transcript can render real
 * attachment blocks, and returns the message text with markers and bodies
 * removed.
 *
 * Note: only text attachments survive a replay as recoverable content — agents
 * do not echo image bytes in the message text. An image marker still names the
 * file, so those parse to explicit placeholders (`unavailableReason`) instead
 * of a silent gap; the bytes themselves come back only via the panel's own
 * attachment record (lib/attachmentHistory.ts) or a real image content block.
 */
export function extractReplayedAttachments(text: string): {
  text: string;
  attachments: AttachmentMeta[];
} {
  if (!text || (!text.includes('://') && !text.includes('[Attached '))) {
    return { text, attachments: [] };
  }

  const matches = [...text.matchAll(ATTACHMENT_MARKER)];
  if (matches.length === 0) return { text, attachments: [] };

  const prose = text.slice(0, matches[0].index ?? 0);
  /**
   * A candidate body that repeats the message's own prose is a merged turn
   * boundary, not file content. Either direction counts: Hermes can store the
   * shorter prompt after the marker and the longer one before it.
   */
  const isEchoOfProse = (candidate: string) => {
    const p = prose.trim();
    const c = candidate.trim();
    return c.length > 0 && p.length > 20 && (p.includes(c) || c.includes(p));
  };

  const attachments: AttachmentMeta[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const [marker, explicitKind, explicitName, bareUri, explicitUri] = match;
    const uri = (explicitUri || bareUri || '').trim();
    const name = (explicitName || '').trim() || nameFromMarker(uri);
    if (!name) continue;

    const bodyStart = (match.index ?? 0) + marker.length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const candidate = text.slice(bodyStart, bodyEnd).replace(/\s+/g, ' ').trim();
    const body = isEchoOfProse(candidate) ? '' : candidate;

    const image = explicitKind === 'image' || looksLikeImage(name);
    attachments.push({
      name,
      kind: image ? 'image' : 'text',
      mimeType: image ? 'image/*' : 'text/plain',
      // Bytes are gone on replay; the echoed text is all that is left to measure.
      size: body.length,
      // Whatever text followed an image marker is not the image — it is the
      // next chunk of prose, so it stays out of `body`. The placeholder gets
      // an explicit reason instead of pretending there was a text body.
      body: image ? undefined : body || undefined,
      unavailableReason: image
        ? 'the agent replayed the marker but not the image bytes'
        : undefined,
    });
  }

  if (attachments.length === 0) return { text, attachments: [] };

  return {
    text: prose.replace(/[ \t]+$/, '').trim(),
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Content blocks in a replayed / streamed message
// ---------------------------------------------------------------------------

/**
 * Turn a non-text ACP `ContentBlock` from a `user_message_chunk` or
 * `agent_message_chunk` into transcript attachment metadata.
 *
 * An agent that keeps a faithful history replays the original blocks on
 * `session/load` — including `image` blocks with their base64 bytes, which
 * this hands back as a data URL the transcript can render. Blocks that carry
 * no recoverable bytes (an empty image block, a `resource_link` the panel
 * cannot open) still produce a named placeholder so the turn does not pretend
 * it had no file. Returns null only for `text` blocks — the caller handles
 * those itself — and for shapes with nothing displayable.
 */
export function attachmentFromContentBlock(block: ContentBlock): AttachmentMeta | null {
  switch (block.type) {
    case 'image': {
      const name = block.uri ? nameFromMarker(block.uri) : 'image';
      const mimeType = block.mimeType || 'image/*';
      if (block.data) {
        return {
          name, kind: 'image', mimeType, size: block.data.length,
          previewUrl: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
        };
      }
      return {
        name, kind: 'image', mimeType, size: 0,
        unavailableReason: 'the agent replayed an empty image block — no bytes',
      };
    }
    case 'resource': {
      const res = block.resource;
      const name = nameFromMarker(res.uri || 'resource');
      if ('blob' in res && res.blob) {
        if (looksLikeImage(name, res.mimeType)) {
          return {
            name, kind: 'image', mimeType: res.mimeType || 'image/*',
            size: res.blob.length,
            previewUrl: `data:${res.mimeType || 'image/png'};base64,${res.blob}`,
          };
        }
        return {
          name, kind: 'text', mimeType: res.mimeType || 'application/octet-stream',
          size: res.blob.length,
          previewUrl: `data:${res.mimeType || 'application/octet-stream'};base64,${res.blob}`,
        };
      }
      if ('text' in res && res.text != null) {
        if (looksLikeImage(name, res.mimeType)) {
          return {
            name, kind: 'image', mimeType: res.mimeType || 'image/*', size: 0,
            unavailableReason: 'the replay named this image but carried no bytes',
          };
        }
        return {
          name, kind: 'text', mimeType: res.mimeType || 'text/plain',
          size: res.text.length, body: res.text,
        };
      }
      return null;
    }
    case 'resource_link': {
      const name = block.name || nameFromMarker(block.uri || 'resource');
      const image = looksLikeImage(name, block.mimeType);
      return {
        name, kind: image ? 'image' : 'text',
        mimeType: block.mimeType || (image ? 'image/*' : 'text/plain'),
        size: block.size != null ? Number(block.size) : 0,
        uri: block.uri,
        unavailableReason: 'the replay only carries a link — the panel cannot read it',
      };
    }
    case 'audio':
      return {
        name: 'audio clip', kind: 'text',
        mimeType: block.mimeType || 'audio/*', size: block.data.length,
        unavailableReason: 'audio — the transcript cannot render it',
      };
    default:
      return null;
  }
}

