// Quota store (the "subscription tracker" block on the Dashboard, F5).
// User-defined limits, persisted in `limits.json` with a version key (N3).
// Period-to-date usage is computed from the activity ledger, never stored.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';

export type LimitScope = 'agent' | 'project' | 'global';
export type LimitPeriod = 'day' | 'week' | 'month';

export interface UsageLimit {
  id: string;
  label: string;
  scope: LimitScope;
  /** Agent name or project name; empty for global. */
  target: string;
  period: LimitPeriod;
  targetTokens: number;
}

interface Persisted {
  version: 1;
  limits: UsageLimit[];
}

const STORE_PATH = 'limits.json';

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Start of the current period (local midnight / Monday / 1st), for the period label + window. */
export function periodStart(period: LimitPeriod, now = Date.now()): number {
  const d = new Date(now);
  if (period === 'day') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'week') {
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7; // Monday-first
    return d.getTime() - dow * 24 * 60 * 60 * 1000;
  }
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function periodLabel(period: LimitPeriod): string {
  return period === 'day' ? 'today' : period === 'week' ? 'this week' : 'this month';
}

export const useLimitsStore = defineStore('limits', () => {
  const limits = ref<UsageLimit[]>([]);
  const loaded = ref(false);
  let store: KVStore | null = null;

  async function initLimitsStore(): Promise<void> {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<Persisted | UsageLimit[]>('limits');
    if (Array.isArray(saved)) {
      limits.value = saved; // pre-version data, best effort
    } else if (saved && saved.version === 1) {
      limits.value = saved.limits;
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    if (!store) return;
    const payload: Persisted = { version: 1, limits: limits.value };
    await store.set('limits', payload);
    await store.save();
  }

  async function addLimit(input: Omit<UsageLimit, 'id'>): Promise<UsageLimit> {
    const limit: UsageLimit = { ...input, id: uid() };
    limits.value.push(limit);
    await persist();
    return limit;
  }

  async function updateLimit(id: string, input: Omit<UsageLimit, 'id'>): Promise<void> {
    const i = limits.value.findIndex((l) => l.id === id);
    if (i >= 0) {
      limits.value[i] = { ...input, id };
      await persist();
    }
  }

  async function removeLimit(id: string): Promise<void> {
    limits.value = limits.value.filter((l) => l.id !== id);
    await persist();
  }

  return { limits, loaded, initLimitsStore, addLimit, updateLimit, removeLimit };
});
