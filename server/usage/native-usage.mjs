import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
let cached = null;
let pending = null;
export async function nativeUsage() {
  if (cached && Date.now() - cached.updatedAt < 60000) return cached;
  if (!pending) {
    pending = execute('python3', [fileURLToPath(new URL('./read_native.py', import.meta.url))],
      { timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout }) => { cached = JSON.parse(stdout); return cached; })
      .finally(() => { pending = null; });
  }
  return pending;
}
