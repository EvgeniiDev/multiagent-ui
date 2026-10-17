// Read-only chat artifacts. Never serve an agent's arbitrary absolute path.
// The project mount is also available in the state container; no bridge or
// agent process participates in a preview request.
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const CHAT_FILE_MAX_BYTES = 32 * 1024 * 1024;
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', xml: 'application/xml',
  zip: 'application/zip',
};
const inside = (root, file) => file.startsWith(root + path.sep);
const privatePath = file => file.split(path.sep).some(part =>
  (part.startsWith('.') && !['.agent-tmp', '.agent-artifacts'].includes(part)) || /^\.env(?:\.|$)/.test(part));

export function createChatFileHandler({ roots = [path.join(homedir(), 'projects')], maxBytes = CHAT_FILE_MAX_BYTES, protectedRoots = [process.env.STATE_DIR || path.join(homedir(), '.hermes/acp-ui-state'), path.join(homedir(), 'projects/acp-ui-state')] } = {}) {
  return async (req, res, url) => {
    const fail = (status, error) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Only reading files is supported');
    // Same panel host across the web/state ports. An unrelated web page may
    // not use this endpoint to read LAN artifacts via wildcard proxy CORS.
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Open files from the panel');
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        const host = new URL(`http://${req.headers.host}`).hostname;
        if (!['http:', 'https:'].includes(origin.protocol) || origin.hostname !== host ||
            !['25808', '25809'].includes(origin.port)) return fail(403, 'Open files from the panel');
      } catch { return fail(403, 'Invalid origin'); }
    }
    const input = url.searchParams.get('path') || '';
    if (!path.isAbsolute(input) || input.includes('\0')) return fail(400, 'An absolute file path is required');
    const normalized = path.resolve(input);
    const blocked = protectedRoots.map(root => path.resolve(root));
    const protectedPath = file => blocked.some(root => file === root || inside(root, file));
    let handle;
    try {
      // Check lexical scope before probing existence outside the project tree.
      const scopedRoots = roots.map(root => path.resolve(root));
      if (!scopedRoots.some(root => inside(root, normalized)) || privatePath(normalized) || protectedPath(normalized)) return fail(403, 'File is outside the allowed project files');
      const canonical = await realpath(normalized);
      const canonicalRoots = await Promise.all(scopedRoots.map(root => realpath(root).catch(() => null)));
      const allowed = file => !privatePath(file) && !protectedPath(file) && canonicalRoots.some(root => root && inside(root, file));
      if (!allowed(canonical)) return fail(403, 'File is outside the allowed project files');
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Linux production: pin the opened inode as well as its pathname, so a
      // swapped parent symlink cannot bypass the realpath boundary.
      if (process.platform === 'linux' && !allowed(await realpath(`/proc/self/fd/${handle.fd}`))) {
        return fail(403, 'File is outside the allowed project files');
      }
      const stat = await handle.stat();
      if (!stat.isFile()) return fail(400, 'This path is not a regular file');
      if (stat.size > maxBytes) return fail(413, `File is too large (maximum ${Math.floor(maxBytes / 1024 / 1024)} MB)`);
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      const name = path.basename(normalized);
      const mime = TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': mime, 'content-length': bytes.length,
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'access-control-allow-origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return fail(404, 'File was not found. It may have been moved or deleted.');
      if (['EACCES', 'EPERM', 'ELOOP'].includes(e.code)) return fail(403, 'File is not accessible');
      console.error('chat file read failed:', e.code || e.message);
      return fail(500, 'Could not read this file');
    } finally { await handle?.close(); }
  };
}
