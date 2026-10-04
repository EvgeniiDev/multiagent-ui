#!/usr/bin/env node
// Exercise the real browser bridge response handler with a deterministic transport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/acp-bridge.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText.replace(/^import .*;$/gm, '');
const module = await import('data:text/javascript;base64,' + Buffer.from(`
const ref = value => ({ value });
const hasLocalFs = () => false;
const useTrafficStore = () => ({ addEntry() {} });
${js}`).toString('base64'));
module.setRpcIdleTimeoutMs(0);

async function responseError(error) {
  let receive;
  const transport = {
    onMessage(fn) { receive = fn; return () => {}; },
    onClose() { return () => {}; },
    async send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, error })));
    },
    async close() {},
  };
  const bridge = new module.AcpClientBridge(transport);
  try {
    await bridge.loadSession({ sessionId: 'broken-pi', cwd: '/tmp', mcpServers: [] });
    assert.fail('RPC error must reject session/load');
  } catch (e) {
    return e.message;
  } finally {
    await bridge.disconnect();
  }
}
assert.equal(await responseError({ code: -32603, message: 'Internal error', data: {
  details: 'pi process exited (code=143, signal=null)',
}}), 'Internal error: pi process exited (code=143, signal=null)');
assert.equal(await responseError({ code: -32601, message: 'Method not found' }), 'Method not found');
assert.equal(await responseError({ message: 'Denied', data: { details: { secret: 'do not stringify' } } }), 'Denied');
assert.equal(await responseError({ message: 'Denied', data: { details: 'Denied' } }), 'Denied');
console.log('PASS session/load preserves actual string details; plain, malformed and duplicate details stay readable');

// Execute the actual resume function with a controlled session/load boundary.
const runtimeSource = readFileSync(new URL('../src/lib/sessionRuntime.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('sessionRuntime.ts', runtimeSource, ts.ScriptTarget.Latest, true);
let resumeSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'resume') resumeSource = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(resumeSource, 'actual resume function exists');
const resumeJs = ts.transpileModule(resumeSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText;
const runtimeJs = `export function scenario() {
  const ref = value => ({value});
  const error = ref('previous failure');
  const isLoading = ref(false), isConnected = ref(false), autonomous = ref(false);
  const agentName = ref(''), descriptor = ref(null), historyCacheNote = ref(null), session = ref(null);
  const availableModes = ref([]), currentModeId = ref(''), availableModels = ref([]), currentModelId = ref('');
  const messages = ref([]), toolCalls = ref(new Map());
  let connectionAborted = false, cacheScope, replayMerge = null, acpClient = null, loadingHistory = false;
  let autoReconnectAttempts = 0, inFlightPrompts = 0;
  let finishLoad, failLoad, started;
  const loadStarted = new Promise(resolve => {started = resolve;});
  const client = {loadSession() {started();return new Promise((resolve,reject) => {finishLoad=resolve;failLoad=reject;});},async disconnect(){}};
  const deps = {async persistSessions(){}};
  const useConfigStore = () => ({getAgent: () => ({})});
  const createAcpClient = async () => client;
  const initializeClient = async () => ({});
  const useActivityStore = () => ({recordEntry(){}});
  const disarmAutoReconnect = () => {}, hydrateHistoryCache = () => {}, handleSessionUpdate = () => {};
  const handleUnexpectedClose = () => {}, watchPermissionRequests = () => {}, settleReplayMerge = () => {};
  const abortReplayMerge = () => {}, trackEvent = () => {}, trackError = () => {};
  ${resumeJs}
  return {error,isConnected,loadStarted,start:() => resume({agentName:'Pi',sessionId:'test',cwd:'/tmp'}),
    succeed:() => finishLoad({}), fail:() => failLoad(new Error('pi process exited (code=143, signal=null)'))};
}`;
const {scenario} = await import('data:text/javascript;base64,' + Buffer.from(runtimeJs).toString('base64'));
const recovered = scenario();
const recovery = recovered.start();
await recovered.loadStarted;
assert.equal(recovered.error.value, 'previous failure', 'pending reconnect keeps the failure');
assert.equal(recovered.isConnected.value, false);
recovered.succeed();
await recovery;
assert.equal(recovered.error.value, null, 'verified session/load clears the failure');
assert.equal(recovered.isConnected.value, true);
const broken = scenario();
const failed = broken.start();
await broken.loadStarted;
broken.fail();
await assert.rejects(failed, /pi process exited/);
assert.equal(broken.error.value, 'pi process exited (code=143, signal=null)');
assert.equal(broken.isConnected.value, false);
console.log('PASS actual resume retains failure while pending, clears on success, exposes failed recovery');
