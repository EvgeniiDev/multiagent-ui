// The pinned adapter assumes one active session, while our ACP bridge serves
// multiple tabs through one child. Patch that mismatch without changing routing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '// acp-ui shared bridge: retain independent Pi sessions (v2)';
export function patchPiAcp(source, version) {
  if (version !== '0.0.33') throw new Error(`unsupported pi-acp version ${version}`);
  if (source.includes(MARKER)) return source;
  function replaceExactly(before, after, count = 1) {
    const found = source.split(before).length - 1;
    if (found !== count) throw new Error(`pi-acp patch shape changed: expected ${count}, found ${found}: ${before}`);
    source = source.split(before).join(after);
  }
  replaceExactly('    this.sessions.closeAllExcept?.(session.sessionId);',
    '    // Other browser tabs own their sessions; loading this one never evicts them.', 2);
  replaceExactly('    this.sessions.close(params.sessionId);',
    '    // Reuse the existing process: another socket may be replaying or prompting it.');
  replaceExactly('    const existing = this.sessions.maybeGet(sessionId);\n    if (existing) return existing;', `    const existing = this.sessions.maybeGet(sessionId);
    if (existing) {
      const child = existing.proc?.child;
      const terminated = child && (child.exitCode != null || child.signalCode != null || child.killed === true);
      if (!terminated) {
        this.validateRestoredSessionOptions(existing, opts);
        return existing;
      }
      // Only a proven dead/stopping process is replaced; healthy peers survive.
      this.sessions.close(sessionId);
    }`);
  replaceExactly('  async restoreSession(sessionId, opts) {', `  validateRestoredSessionOptions(session, opts) {
    if (opts?.cwd !== undefined && opts.cwd !== session.cwd) {
      throw RequestError3.invalidParams('This Pi session is already open in a different working directory; use its original directory or create a new session.');
    }
    if (opts?.mcpServers !== undefined && JSON.stringify(opts.mcpServers) !== JSON.stringify(session.mcpServers ?? [])) {
      throw RequestError3.invalidParams('This Pi session is already open with different MCP servers; keep its existing configuration or create a new session.');
    }
  }
  async restoreSession(sessionId, opts) {`);
  replaceExactly('    if (inFlight) return inFlight;', `    if (inFlight) {
      const restored = await inFlight;
      this.validateRestoredSessionOptions(restored, opts);
      return restored;
    }`);
  replaceExactly('  async loadSession(params) {', `  ${MARKER}
  loadingSessions = new Map();
  async loadSession(params) {
    // Coalesce only identical reloads. A different cwd must still be validated.
    const key = JSON.stringify([params.sessionId, params.cwd, params.mcpServers ?? []]);
    const existing = this.loadingSessions.get(key);
    if (existing) return existing;
    const pending = this.loadSessionRetainingPeers(params);
    this.loadingSessions.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.loadingSessions.get(key) === pending) this.loadingSessions.delete(key);
    }
  }
  async loadSessionRetainingPeers(params) {`);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node patch-pi-acp-multisession.mjs <installed-pi-acp-directory>');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = path.join(root, 'dist/index.js');
  const source = readFileSync(entry, 'utf8');
  const patched = patchPiAcp(source, pkg.version);
  if (patched !== source) writeFileSync(entry, patched);
  console.log(`pi-acp ${pkg.version}: shared-session process retention enabled`);
}
