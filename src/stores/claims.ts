// Claims ledger (claims.json): which agent holds which board card right
// now. Written by the runner and boardctl; the panel only reads it — this
// is the factual "who is running" behind a card's run block (FPF A.15.1:
// the claim is a record of work in flight, not an intention).
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { loadKvStore, mutateRemoteDoc, type KVStore } from '../lib/host/storage';

export interface CardClaim {
  agentName: string;
  sessionId: string;
  leaseUntil: number;
  startedAt: number;
  claimedAt: number;
  pid?: number | null;
  roleId?: string;
  runnerId?: string;
  runnerPid?: number;
  /** Stage the card was in when claimed (the sweep returns it there). */
  stage?: string;
  /** Last heartbeat the runner wrote while renewing the lease. */
  hbAt?: number;
}

const STORE_PATH = 'claims.json';
const POLL_MS = 5000;

export const useClaimsStore = defineStore('claims', () => {
  const claims = ref<Record<string, CardClaim>>({});
  /** Ticking clock for lease/duration display — one timer for the app. */
  const now = ref(Date.now());
  const ready = ref(false);
  let store: KVStore | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function reload(): Promise<void> {
    if (!store) return;
    claims.value = (await store.get<Record<string, CardClaim>>('claims')) ?? {};
  }

  async function initClaimsStore(): Promise<void> {
    if (ready.value) return;
    store = await loadKvStore(STORE_PATH);
    await reload();
    ready.value = true;
    if (!timer && typeof window !== 'undefined') {
      timer = setInterval(() => {
        now.value = Date.now();
        // RemoteKVStore adopts the newer server doc on its own poll; a
        // fresh get() then returns whoever holds a claim right now.
        void reload();
      }, POLL_MS);
    }
  }

  /** The claim recorded for a card, live or expired — the caller decides
   * what `leaseUntil > now` means for its display. */
  function claimFor(cardId: string): CardClaim | null {
    return claims.value[cardId] ?? null;
  }

  /**
   * Operator release: drop claims from `claims.json` — the same document
   * the runner's stop-all/release-all and `boardctl release` mutate, over
   * the same rev-checked PUT. The panel never signals pids: a released
   * child keeps running until its runner exits it (the owning runner reads
   * the missing claim as "released on purpose", not a failed attempt).
   * Returns the claims actually dropped.
   */
  async function releaseClaims(cardIds: string[]): Promise<[string, CardClaim][]> {
    const ids = new Set(cardIds);
    const released: [string, CardClaim][] = [];
    // Preferred path: CAS on the shared document (web + state server).
    const remoteOk = await mutateRemoteDoc(STORE_PATH, (data) => {
      const map = { ...((data.claims ?? {}) as Record<string, CardClaim>) };
      released.length = 0;
      for (const id of ids) {
        if (map[id]) {
          released.push([id, map[id]]);
          delete map[id];
        }
      }
      if (!released.length) return null;
      data.claims = map;
      return data;
    });
    if (remoteOk) {
      const next = { ...claims.value };
      for (const id of ids) delete next[id];
      claims.value = next;
      return released;
    }
    // Fallback: the local mirror / plugin-store document (Tauri, offline).
    if (!store) return [];
    released.length = 0;
    const next = { ...claims.value };
    for (const id of ids) {
      if (next[id]) {
        released.push([id, next[id]]);
        delete next[id];
      }
    }
    if (!released.length) return [];
    await store.set('claims', next);
    await store.save();
    claims.value = next;
    return released;
  }

  return { claims, now, ready, initClaimsStore, claimFor, releaseClaims };
});
