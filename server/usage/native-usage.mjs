import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
let cached = null;
let pending = null;
export async function nativeUsage() {
  if (cached && Date.now() - cached.updatedAt < 60000) return cached;
  if (!pending) {
    // A cold full scan is slow (minutes on a large home); read_native.py
    // keeps a per-source cache under STATE_DIR, so subsequent runs only
    // re-read appended bytes of changed files. The timeout must cover a
    // cold scan — killing it loses that scan's progress entirely.
    pending = execute('python3', [fileURLToPath(new URL('./read_native.py', import.meta.url))],
      { timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout }) => { cached = JSON.parse(stdout); return cached; })
      .catch((e) => { if (cached) return cached; throw e; })
      .finally(() => { pending = null; });
  }
  return pending;
}
