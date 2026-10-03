// deploy/execution/tarx.mjs — minimal ustar extractor for `git archive`.
//
// Why not shell tar: the worker/controller image may not ship it; the
// stream source here is always `git archive` (trusted, well-formed ustar
// with pax paths). We parse regular files, dirs, and symlinks; anything
// else is skipped. Paths are sanitized — '..' and absolute entries are
// refused, never written outside destDir.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeError } from '../../server/execution/common.mjs';

function parseName(buf, off) {
  const raw = buf.subarray(off, off + 100);
  const z = raw.indexOf(0);
  return raw.subarray(0, z < 0 ? 100 : z).toString('utf8');
}
function parseNum(buf, off, len) {
  const raw = buf.subarray(off, off + len).toString('utf8').replace(/\0.*$/, '').trim();
  return raw ? parseInt(raw, 8) : 0;
}

// Extract a tar Buffer into destDir. Only file/dir/symlink entries.
export async function extractTarBuffer(buf, destDir) {
  const dest = path.resolve(destDir);
  let off = 0;
  let paxPath = null;             // GNU/pax extended name for the NEXT entry
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;               // end marker
    const size = parseNum(header, 124, 12);
    const mode = parseNum(header, 100, 8) & 0o777;
    const typeflag = String.fromCharCode(header[156]);
    let name = paxPath ?? parseName(header, 0);
    const linkname = parseName(header, 157);
    paxPath = null;
    off += 512;
    const dataEnd = off + size;
    const data = buf.subarray(off, dataEnd);
    off = dataEnd + ((512 - (size % 512)) % 512);
    if (typeflag === 'x' || typeflag === 'g') {
      // pax extended header: parse path= overrides (used for long names)
      const text = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      if (m) paxPath = m[1];
      continue;
    }
    if (!name || name === './' || name === '.') continue;
    const norm = path.normalize(name);
    if (norm.startsWith('..') || path.isAbsolute(norm) || norm === '..') {
      throw new RuntimeError('unsafe_tar_entry', `tar entry escapes dest: ${name}`);
    }
    const target = path.join(dest, norm);
    if (!target.startsWith(dest + '/') && target !== dest) {
      throw new RuntimeError('unsafe_tar_entry', `tar entry escapes dest: ${name}`);
    }
    if (typeflag === '5' || name.endsWith('/')) {
      await fs.mkdir(target, { recursive: true });
      await fs.chmod(target, mode || 0o755).catch(() => {});
    } else if (typeflag === '2') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!linkname || linkname.includes('..') || path.isAbsolute(linkname)) {
        // refuse absolute/parent symlinks; relative-only kept
        if (linkname && (linkname.includes('..') || path.isAbsolute(linkname))) continue;
      }
      if (linkname) await fs.symlink(linkname, target).catch(() => {});
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      await fs.chmod(target, mode || 0o644).catch(() => {});
    }
    // other types (char/block/fifo) skipped — git trees never produce them
  }
}

// `git -C <repo> archive <sha>` piped through the extractor. Bounded output:
// the whole tar lands in memory — callers bound project size via maxBytes.
export function gitArchiveExtract(repoDir, sha, destDir, { timeoutMs = 120_000, maxBytes = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolveP, rejectP) => {
    // Git archive defaults to tar.umask=0002, which exposes 0664/0775
    // even though Git records 0644/0755. Snapshot consumers must observe
    // the same modes as canonical broker preconditions, independent of config.
    const child = spawn('git', ['-C', repoDir, '-c', 'tar.umask=0022', 'archive', '--format=tar', sha],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); if (err.length > 8192) err = err.slice(-8192); });
    child.on('error', (e) => { clearTimeout(timer); rejectP(new RuntimeError('git_archive_spawn', e.message)); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (killed) return rejectP(new RuntimeError('git_archive_timeout', `git archive exceeded ${timeoutMs}ms`));
      if (code !== 0) return rejectP(new RuntimeError('git_archive_failed',
        `git archive ${sha} exited ${code}: ${err.slice(0, 300)}`));
      if (size > maxBytes) return rejectP(new RuntimeError('git_archive_too_large',
        `archive exceeds ${maxBytes} bytes`));
      try {
        await extractTarBuffer(Buffer.concat(chunks), destDir);
        resolveP({ bytes: size });
      } catch (e) { rejectP(e); }
    });
  });
}
