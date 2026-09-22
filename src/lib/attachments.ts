// Turning browser File objects into ACP prompt attachments.
//
// Attachments are always self-contained: an image is sent as base64 and a text
// file as inline text, because the agent commonly runs on another machine and
// cannot read the client's paths. A `resource_link` would therefore arrive as a
// dead URI, which is why nothing here builds one.

import { uuid } from './uuid';
import type { Attachment, AttachmentKind } from './types';

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
