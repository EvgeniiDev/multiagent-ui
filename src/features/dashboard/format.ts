/** Number/date formatting for the Dashboard. All UI strings are English, short. */

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Token figure with its estimated part marked. Exact numbers stay plain;
 * bridge estimates are prefixed `~` — "8,345 + ~4,500" when a row mixes both
 * layers, "~4,500" when the whole figure is an estimate.
 */
export function fmtTokensWithEst(tokens: number, estTokens = 0): string {
  const est = Math.min(Math.max(0, estTokens), Math.max(0, tokens));
  if (est <= 0) return fmtInt(tokens);
  if (est >= tokens) return `~${fmtInt(tokens)}`;
  return `${fmtInt(tokens - est)} + ~${fmtInt(est)}`;
}

/** Compact axis scale: 950 -> "950", 1500 -> "1.5k", 2.3M etc. */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [div, suffix] of units) {
    if (abs >= div) {
      const v = n / div;
      return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** Trimmed money amount: 0.0200 -> "0.02", 2.50 -> "2.5". */
export function fmtCost(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  const abs = Math.abs(amount);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  return amount
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

export interface CostSample {
  cost?: number;
  currency?: string;
}

/**
 * Costs stay grouped by currency — mixed currencies are never summed (N9).
 * Samples without a currency form their own group shown without a code.
 */
export function groupCost(samples: CostSample[]): Array<{ currency: string; amount: number }> {
  const map = new Map<string, number>();
  for (const s of samples) {
    if (typeof s.cost !== 'number' || !Number.isFinite(s.cost)) continue;
    const key = s.currency ?? '';
    map.set(key, (map.get(key) ?? 0) + s.cost);
  }
  return [...map.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export function fmtMoney(amount: number, currency?: string): string {
  return currency ? `${fmtCost(amount)} ${currency}` : fmtCost(amount);
}

export function fmtCostGroups(groups: Array<{ currency: string; amount: number }>): string {
  if (groups.length === 0) return '—';
  return groups.map((g) => fmtMoney(g.amount, g.currency || undefined)).join(' · ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-03-10" -> "Mar 10". */
export function shortDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  if (!y || !m || !d) return isoDay;
  return `${MONTHS[m - 1]} ${d}`;
}

/** Compact stamp: today -> "14:05", this year -> "Mar 4", else "2025-12-01". */
export function fmtStamp(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "5m ago" / "3h ago" / "Mar 4" — for "last activity" cells. */
export function fmtAgo(at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}d ago`;
  return fmtStamp(at);
}
