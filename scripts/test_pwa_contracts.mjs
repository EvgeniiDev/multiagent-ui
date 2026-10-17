import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual TS module with browser/platform services supplied at its
// boundary. The routing implementation itself is never replaced by a stub.
const storage = new Map();
let tauri = false;
const exports = {};
const runtime = vm.createContext({ exports, URL, EventTarget,
  matchMedia: () => ({ matches: false }), navigator: {}, location: new URL('https://acp.lan:25809/chat'),
  window: new EventTarget(),
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  require: name => name === 'vue' ? { ref: value => ({ value }), shallowRef: value => ({ value }) }
    : name === './platform' ? { isTauriHost: () => tauri }
    : name === './host/storage' ? { stateServerBase: () => 'https://acp.lan:25910' }
    : assert.fail(`Unexpected dependency ${name}`),
});
const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/pwa.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInContext(compiled, runtime);
const protocols = ['acp.v1', 'bearer.test'];
const original = 'wss://acp.lan:25917/';
assert.equal(exports.notificationConnection(original, protocols).url, original);
exports.setPushToken('c'.repeat(64));
const bridges = { '25901': 'Hermes Agent', '25902': 'OpenCode', '25903': 'Devin', '25904': 'Pi', '25907': 'Codex' };
for (const [port, agent] of Object.entries(bridges)) for (const actual of [Number(port), Number(port) + 10]) {
  const routed = exports.notificationConnection(`wss://acp.lan:${actual}/`, protocols);
  assert.equal(new URL(routed.url).searchParams.get('agent'), agent);
  assert.equal(new URL(routed.url).origin, 'wss://acp.lan:25910');
  assert.equal(routed.protocols[0], 'acp.v1');
  assert.equal(routed.protocols[1], 'bearer.test');
  assert.equal(routed.protocols[2], 'acp-push.' + 'c'.repeat(64));
}
for (const url of ['wss://remote.example:25917/', 'wss://acp.lan:25917/custom', 'wss://acp.lan:25917/?token=a', 'wss://acp.lan:10000/']) {
  assert.equal(exports.notificationConnection(url, protocols).url, url);
}
tauri = true; assert.equal(exports.notificationConnection(original, protocols).url, original);
tauri = false; exports.setPushToken(''); assert.equal(exports.notificationConnection(original, protocols).url, original);

const handlers = {};
const shown = [], opened = [];
let focused = 0;
let clients = [];
const self = {
  location: { origin: 'https://acp.lan:25809' },
  addEventListener: (name, handler) => { handlers[name] = handler; },
  registration: { showNotification: async (...args) => { shown.push(args); } },
  clients: { matchAll: async () => clients, openWindow: async url => opened.push(url) },
};
vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
let promise;
handlers.push({ data: { json: () => ({ title: 'Pi: response ready', body: 'Done', tag: 'one', url: '/chat?s=Pi%3A%3Aone' }) }, waitUntil: value => { promise = value; } });
await promise;
assert.equal(shown[0][0], 'Pi: response ready');
assert.equal(shown[0][1].data.url, '/chat?s=Pi%3A%3Aone');
const click = url => {
  promise = undefined;
  handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: value => { promise = value; } });
  return promise;
};
clients = [{ url: 'https://acp.lan:25809/chat?s=Pi%3A%3Aone', focus: async () => { focused++; } }];
await click('/chat?s=Pi%3A%3Aone'); assert.equal(focused, 1); assert.equal(opened.length, 0);
await click('/chat?s=Codex%3A%3Atwo'); assert.equal(opened[0], 'https://acp.lan:25809/chat?s=Codex%3A%3Atwo');
await click('https://attacker.example/chat'); await click('/other'); assert.equal(opened.length, 1);
console.log('PASS actual client routing for five plain/TLS bridges, protocol retention, remote/Tauri/direct bypass; worker push, exact focus, new-chat deep link, draft preservation, origin/path validation');
