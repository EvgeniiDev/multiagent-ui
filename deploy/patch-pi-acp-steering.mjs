// pi-acp queues normal ACP prompts until the active run ends. Expose native Pi
// steering separately: the caller chooses its tool boundary; Pi never aborts it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '// acp-ui: native non-interrupting Pi steering (v1)';
const RPC_METHOD = `  async steer(message, images = []) {
    const res = await this.request({ type: "steer", message, images });
    if (!res.success) throw new Error(\`pi steer failed: \${res.error ?? JSON.stringify(res.data)}\`);
  }`;
const CAPABILITY = '      _meta: { steering: { supported: true } },';
const DISPATCH = `    if (method === '_session/steering') return this.acpUiSteering(params ?? {});`;
const STEERING_METHOD = `  ${MARKER}
  async acpUiSteering(params) {
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw RequestError3.invalidParams('sessionId required');
    // Never restore or create a process: steering belongs to this live turn only.
    const session = this.sessions.maybeGet(sessionId);
    if (!session) throw RequestError3.invalidParams('Unknown live Pi session: ' + sessionId);
    if (!session.pendingTurn) throw RequestError3.invalidParams('Pi steering requires an active turn');
    if (!Array.isArray(params.prompt) || params.prompt.length === 0) throw RequestError3.invalidParams('steering prompt required');
    for (const block of params.prompt) {
      if (block?.type === 'text' && typeof block.text === 'string') continue;
      if (block?.type === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType)
        && typeof block.data === 'string' && block.data.length > 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) continue;
      throw RequestError3.invalidParams('Pi steering supports text and inline PNG/JPEG/GIF/WebP images only');
    }
    const { message, images } = promptToPiMessage(params.prompt);
    if (!message.trim() && images.length === 0) throw RequestError3.invalidParams('steering prompt is empty');
    // Native steer is independent of session.prompt/turnQueue and cancel/abort.
    await session.proc.steer(message, images);
    return { outcome: 'injected' };
  }`;

export function patchPiAcpSteering(source, version) {
  if (version !== '0.0.33') throw new Error(`unsupported pi-acp version ${version}`);
  function expectCount(part, count = 1) {
    const found = source.split(part).length - 1;
    if (found !== count) throw new Error(`pi-acp steering patch shape changed: expected ${count}, found ${found}: ${part}`);
  }
  // Validate the complete owned additions even on repeat application. A stale
  // marker must not make partially patched or edited bundles appear supported.
  if (source.includes(MARKER)) {
    for (const part of [MARKER, RPC_METHOD, CAPABILITY, DISPATCH, STEERING_METHOD]) expectCount(part);
    return source;
  }
  for (const part of ['  async steer(', '  async acpUiSteering(', CAPABILITY, DISPATCH]) expectCount(part, 0);
  function replaceExactly(before, after) {
    expectCount(before);
    source = source.replace(before, after);
  }
  replaceExactly('  async abort() {', `${RPC_METHOD}\n  async abort() {`);
  replaceExactly('      agentCapabilities: {', `${CAPABILITY}\n      agentCapabilities: {`);
  if (source.includes('  async extMethod(method, params) {')) {
    // Preserve dispatchers installed by other repo patches, including cleanup.
    replaceExactly('  async extMethod(method, params) {', `  async extMethod(method, params) {\n${DISPATCH}`);
  } else {
    replaceExactly('  async deleteSession(params) {', `  async extMethod(method, params) {\n${DISPATCH}
    throw RequestError3.methodNotFound(method);
  }
  async deleteSession(params) {`);
  }
  replaceExactly('  async deleteSession(params) {', `${STEERING_METHOD}\n  async deleteSession(params) {`);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node patch-pi-acp-steering.mjs <installed-pi-acp-directory>');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = path.join(root, 'dist/index.js');
  const source = readFileSync(entry, 'utf8');
  const patched = patchPiAcpSteering(source, pkg.version);
  if (patched !== source) writeFileSync(entry, patched);
  console.log(`pi-acp ${pkg.version}: native non-interrupting steering enabled`);
}
