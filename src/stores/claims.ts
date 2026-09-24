// Claims ledger (claims.json): which agent holds which board card right
// now. Written by the runner and boardctl; the panel only reads it — this
// is the factual "who is running" behind a card's run block (FPF A.15.1:
// the claim is a record of work in flight, not an intention).
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';

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

  return { claims, now, ready, initClaimsStore, claimFor };
});
