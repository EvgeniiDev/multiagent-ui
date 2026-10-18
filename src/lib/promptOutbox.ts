import { ref } from 'vue';
import type { Attachment } from './types';

export type DeliveryMode = 'queue' | 'steer';
export interface PendingMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  mode: DeliveryMode;
  error?: string;
  delivery?: { userTurn: number; text: string };
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** One runtime owns its outbox. A reload restores it paused, never as a resend. */
export function createPromptOutbox(deps: {
  busy: () => boolean;
  connected: () => boolean;
  send: (text: string, files: Attachment[]) => Promise<void>;
  steer: (text: string, files: Attachment[], failed: (error: unknown) => void) => Promise<'injected' | 'startedNewTurn'>;
  deliveryAnchor?: (text: string, files: Attachment[], mode: DeliveryMode) => PendingMessage['delivery'];
  storage?: StorageLike | null;
}) {
  const messages = ref<PendingMessage[]>([]);
  const paused = ref(false);
  const notice = ref('');
  let key = '', sending = false, steering = false;
  const eligibleSteers = new Set<string>();
  let storage = deps.storage;
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  function save(next = messages.value) {
    if (!storage || !key) return;
    if (next.length) storage.setItem(key, JSON.stringify(next));
    else storage.removeItem(key);
  }
  function commit(next: PendingMessage[]) { save(next); messages.value = next; }
  function restore(scope: string) {
    const nextKey = `acp-ui:outbox:${scope}`;
    if (key === nextKey) return;
    key = nextKey;
    messages.value = []; eligibleSteers.clear();
    try {
      const saved: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
      if (!Array.isArray(saved) || !saved.every(m => m && typeof m.id === 'string'
        && typeof m.text === 'string' && Array.isArray(m.attachments)
        && m.attachments.every((a: Partial<Attachment> | null) => a && typeof a.name === 'string'
          && typeof a.data === 'string' && (a.kind === 'text' || a.kind === 'image'))
        && (m.mode === 'queue' || m.mode === 'steer'))) throw new Error('Invalid saved queue');
      messages.value = saved;
      paused.value = saved.length > 0;
      notice.value = saved.length ? 'Queue restored. Resume when the agent is ready.' : '';
    } catch (e) {
      paused.value = true;
      notice.value = `Could not restore queue: ${String(e)}`;
    }
  }
  function pause() { paused.value = true; }
  function resume() {
    if (messages.value.some(m => m.error)) return;
    paused.value = false; notice.value = ''; ready();
  }
  function remove(id: string) {
    commit(messages.value.filter(m => m.id !== id));
    eligibleSteers.delete(id);
  }
  function submit(text: string, attachments: Attachment[] = [], mode: DeliveryMode = 'queue') {
    if (messages.value.length === 0 && !notice.value) paused.value = false;
    const item = { id: crypto.randomUUID(), text, attachments: attachments.map(a => ({ ...a })), mode };
    // An idle prompt goes straight to the transport, as before. Do not put a
    // large image through sessionStorage just to remove it in the same tick.
    if (!messages.value.length && !paused.value && !deps.busy() && deps.connected() && !sending && !steering) messages.value = [item];
    else commit([...messages.value, item]);
    ready();
    return item.id;
  }
  function fail(item: PendingMessage, e: unknown) {
    paused.value = true;
    const failed = { ...item, error: e instanceof Error ? e.message : String(e) };
    messages.value = [failed, ...messages.value];
    try { save(); } catch { notice.value = 'Could not save queue. Keep this page open.'; }
  }
  function deliveryFailed(item: PendingMessage, e: unknown) {
    if (!messages.value.some(m => m.id === item.id)) fail(item, e);
    else { paused.value = true; notice.value = String(e); }
  }
  function canSend() { return !paused.value && deps.connected(); }
  function ready() { void drain(); }
  async function drain() {
    if (sending || steering || !canSend() || deps.busy() || !messages.value.length) return;
    const item = messages.value[0];
    sending = true;
    try {
      item.delivery = deps.deliveryAnchor?.(item.text, item.attachments, item.mode);
      commit(messages.value.slice(1));
      eligibleSteers.delete(item.id);
      await deps.send(item.text, item.attachments);
    } catch (e) {
      // A failed request can already have reached the agent. Keep it visible,
      // but require removal before resuming instead of automatically retrying.
      deliveryFailed(item, e);
    } finally {
      sending = false;
      ready();
    }
  }
  function toolBoundary() {
    for (const item of messages.value) if (item.mode === 'steer') eligibleSteers.add(item.id);
    void deliverSteer();
  }
  async function deliverSteer() {
    if (steering || !canSend() || !deps.busy()) return;
    const index = messages.value.findIndex(m => m.mode === 'steer' && eligibleSteers.has(m.id));
    if (index < 0) return;
    const item = messages.value[index];
    steering = true;
    try {
      commit(messages.value.filter(m => m.id !== item.id));
      eligibleSteers.delete(item.id);
      const outcome = await deps.steer(item.text, item.attachments, e => deliveryFailed(item, e));
      if (outcome === 'startedNewTurn') {
        // The native adapter raced turn completion and started another turn.
        // It returns an acceptance ACK, not that turn's completion. Never
        // release queued messages on this ACK or guess that the agent is idle.
        paused.value = true;
        notice.value = 'Steer started a new turn. Resume the queue after it finishes.';
      }
    } catch (e) {
      deliveryFailed(item, e);
    } finally {
      steering = false;
      ready();
      if (canSend() && deps.busy()) void deliverSteer();
    }
  }
  /** Only a successfully loaded remote transcript can acknowledge an
   * uncertain send. Optimistic local text and matching older turns cannot. */
  function reconcile(history: { role: string; content: string }[], cached?: {
    userTurnBase: number; messages: { role: string; content: string }[];
  } | null) {
    const users = history.filter(m => m.role === 'user');
    const claimed = new Set<number>();
    const next = messages.value.filter(item => {
      if (!item.error || item.attachments.length || item.mode !== 'queue') return true;
      let anchor = item.delivery;
      if (!anchor && cached) {
        const previous = cached.messages.filter(m => m.role === 'user');
        const matches = previous.map((m, i) => m.content === item.text ? i : -1).filter(i => i >= 0);
        if (matches.length === 1) anchor = { userTurn: cached.userTurnBase + matches[0] + 1, text: item.text };
      }
      if (!anchor || !Number.isInteger(anchor.userTurn) || anchor.userTurn < 1
        || anchor.text !== item.text || claimed.has(anchor.userTurn)
        || users[anchor.userTurn - 1]?.content !== anchor.text) return true;
      claimed.add(anchor.userTurn);
      return false;
    });
    const confirmed = messages.value.length - next.length;
    if (confirmed) {
      commit(next);
      if (!next.length) notice.value = '';
    }
    return confirmed;
  }
  return { messages, paused, notice, restore, submit, remove, pause, resume, ready, toolBoundary, reconcile };
}
