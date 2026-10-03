// scripts/fixtures/fake-pi-rpc.mjs — a deterministic in-memory stand-in for
// the pi --mode rpc wire (createPiRpcTransport's surface). The preparation
// lead driver talks to it exactly like the real transport: prompt() queues
// the scripted turn's frames, respond() delivers extension_ui_response and
// runs the scripted continuation, nextFrame() is the same bounded-read
// contract ({frame}|{exited}|{timeout}).
//
// Each prompt() consumes one turn descriptor; spawns are per-factory-call —
// a "CLI loss" test supplies a fresh script per spawn. Turn descriptors:
//
//   { type:'settle', text }                 agent_start → turn_end(text) → agent_end
//   { type:'dialog', dialog:{method,title,options}, after }  agent_start →
//         extension_ui_request; waits for respond(id). `after` is a
//         descriptor or fn(responseFields) → descriptor run on respond().
//         after===null leaves the turn blocked forever (parked).
//   { type:'die', code? }                   the process exits immediately
//   { type:'silence' }                      agent_start, then nothing —
//         exercises idle/never-started timeouts with instantTimeouts
//   { type:'frames', frames:[…] }           raw frame injection
//   function(prompt) → descriptor|null      escape hatch per prompt
//
// Evidence: prompts[], responses[] ({id, fields}), spawned argv/env,
// aborted flag — the tests assert on real behavior, never on internals.

export function createFakePiTransport({
  turns = [],
  fallback = { type: 'settle', text: '```acp-prep\n{"note":"no scripted turn"}\n```' },
  spawnIndex = 0,
} = {}) {
  let alive = false;
  let exitedInfo = null;
  let streaming = false;
  let lastText = '';
  let promptIdx = 0;
  let uiSeq = 0;
  let reqSeq = 0;
  const queue = [];
  const waiters = [];
  const pendingDialogs = new Map();   // requestId -> after descriptor|fn|null
  const prompts = [];
  const responses = [];
  let aborted = false;

  const push = (f) => {
    if (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve({ frame: f });
    } else {
      queue.push(f);
    }
  };

  const exit = (info) => {
    if (!alive) return;
    alive = false;
    streaming = false;
    exitedInfo = info;
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ exited: info });
    }
  };

  const runDescriptor = (d, ctx = {}) => {
    if (typeof d === 'function') d = d(ctx);
    if (!d) return;
    switch (d.type) {
      case 'settle': {
        streaming = true;
        push({ type: 'agent_start' });
        push({ type: 'turn_start' });
        const text = String(d.text ?? '');
        lastText = text;
        push({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        streaming = false;
        push({ type: 'agent_settled' });
        push({ type: 'agent_end' });
        break;
      }
      case 'dialog': {
        streaming = true;
        push({ type: 'agent_start' });
        push({ type: 'turn_start' });
        // request ids are per-PROCESS — namespaced by spawnIndex so a stale
        // id from a dead spawn can never alias a fresh one in assertions
        const id = `ui-${spawnIndex}-${++uiSeq}`;
        pendingDialogs.set(id, d.after ?? null);
        push({
          type: 'extension_ui_request', id,
          method: d.dialog?.method ?? 'input',
          title: d.dialog?.title ?? d.title ?? '',
          ...(d.dialog?.options ? { options: d.dialog.options } : {}),
        });
        // No settle — the turn stays mid-flight until respond() continues it.
        break;
      }
      case 'die':
        push({ type: 'agent_start' });
        exit({ code: d.code ?? 1, signal: d.signal ?? null });
        break;
      case 'silence':
        streaming = true;
        push({ type: 'agent_start' });
        break;
      case 'frames':
        for (const f of d.frames ?? []) push(f);
        break;
      default:
        throw new Error(`fake transport: unknown turn descriptor ${d.type}`);
    }
  };

  return {
    kind: 'fake-pi-rpc',
    spawnIndex,

    pid: () => (alive ? 90000 + spawnIndex : null),
    alive: () => alive && exitedInfo === null,
    exited: () => exitedInfo,
    aborted: () => aborted,
    prompts,
    responses,
    pendingDialogs: () => [...pendingDialogs.keys()],

    open() {
      alive = true;
      return { pid: this.pid() };
    },

    prompt(message) {
      if (!alive || exitedInfo) return Promise.reject(new Error('fake transport dead'));
      prompts.push(message);
      const d = promptIdx < turns.length ? turns[promptIdx] : fallback;
      promptIdx += 1;
      runDescriptor(d, { prompt: message, promptIdx: promptIdx - 1, spawnCtx: this.spawnCtx });
      return Promise.resolve();
    },

    respond(requestId, fields = {}) {
      responses.push({ id: requestId, fields });
      const after = pendingDialogs.get(requestId) ?? null;
      pendingDialogs.delete(requestId);
      if (after) runDescriptor(after, { response: fields, requestId, spawnCtx: this.spawnCtx });
      return Promise.resolve();
    },

    abort() {
      aborted = true;
      return Promise.resolve();
    },

    request(command, params = {}, _timeoutMs = 10_000) {
      const id = `r${++reqSeq}`;
      if (command === 'get_state') {
        return Promise.resolve({
          type: 'response', id, success: true,
          data: { isStreaming: streaming, messageCount: prompts.length * 2 },
        });
      }
      if (command === 'get_last_assistant_text') {
        return Promise.resolve({ type: 'response', id, success: true, data: { text: lastText } });
      }
      return Promise.resolve({ type: 'response', id, success: false, error: `unknown command ${command}` });
    },

    getState(timeoutMs = 10_000) {
      return this.request('get_state', {}, timeoutMs).then((r) => r?.data ?? null);
    },

    nextFrame(timeoutMs = null) {
      if (queue.length) return Promise.resolve({ frame: queue.shift() });
      if (!alive || exitedInfo) return Promise.resolve({ exited: exitedInfo ?? { code: null, signal: 'closed' } });
      return new Promise((resolve) => {
        const w = { resolve, timer: null };
        if (timeoutMs !== null) {
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            resolve({ timeout: true });
          }, timeoutMs);
          w.timer.unref?.();
        }
        waiters.push(w);
      });
    },

    close() {
      exit({ code: exitedInfo?.code ?? null, signal: 'closed' });
      return Promise.resolve({ exited: exitedInfo });
    },
  };
}

// A transport factory for createPreparationLead: each spawn consumes the
// next script (per-process turn scripts; the last one repeats). `spawns`
// collects each fake for assertions.
export function fakeTransportFactory(spawnScripts, spawns = []) {
  let n = 0;
  return (plan, ctx) => {
    const script = spawnScripts[Math.min(n, spawnScripts.length - 1)] ?? [];
    const t = createFakePiTransport({ turns: script, spawnIndex: n });
    t.plan = plan;
    t.spawnCtx = ctx;
    spawns.push(t);
    n += 1;
    return t;
  };
}
