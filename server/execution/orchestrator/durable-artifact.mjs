// server/execution/orchestrator/durable-artifact.mjs — O2-owned durable
// exclusive artifact writer.
//
// Scoped to the canonical integration-artifact store: shared
// server/execution/common.mjs is untouched. Protocol:
//   1. write the FULL record to a unique temp file in the same directory,
//      fsync the temp file (content durable before it is ever visible);
//   2. fs.link(temp, final) — atomic exclusive publish: exactly one racer
//      wins, losers get EEXIST. The final path NEVER holds a partial or
//      empty record, so a concurrent reader/writer only ever sees the
//      complete winner or ENOENT (absent);
//   3. fsync the directory (the link durable), then unlink the temp copy.
// A crash before link leaves only an orphan temp (same-dir, dot-prefixed,
// safe to ignore/GC); a crash after link leaves the complete record.
//
// exclusiveCreateArtifact(finalPath, data, mode): resolves undefined on
// win; throws RuntimeError('file_exists') for losers (caller maps to a 409
// after re-reading the canonical winner). Uses FileHandle APIs only.

import { promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RuntimeError } from '../common.mjs';

export async function exclusiveCreateArtifact(finalPath, data, mode = 0o600) {
  const dir = dirname(finalPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${finalPath.split(sep).pop()}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.link(tmp, finalPath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    if (e.code === 'EEXIST') {
      throw new RuntimeError('file_exists', `exclusive create lost: ${finalPath}`);
    }
    throw e;
  }
  try {
    const dfd = await fs.open(dir, 'r');
    try {
      await dfd.sync();
    } finally {
      await dfd.close();
    }
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await fs.chmod(finalPath, mode).catch(() => {});
}
