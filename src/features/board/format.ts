// Formatting helpers shared by the board tabs. Everything renders either a
// clock stamp, a day key, or a compact number — no date library, per N5.

const pad = (n: number): string => String(n).padStart(2, '0');

/** `HH:MM` local time. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `HH:MM:SS` local time — the Events stream's per-row stamp. */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `YYYY-MM-DD` local day key (matches the ledger's `usageByDay` keys). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Row stamp: `HH:MM` today, `22 Sep` this year, else `YYYY-MM-DD`. */
export function fmtStamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtClock(ts);
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return dayKey(ts);
}

/** Compact integer: 1234 -> `1.2k`. Counts stay exact below 1000. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Ledger cost: `—` when nothing was reported, else a compact amount. */
export function fmtCost(cost: number, currency?: string): string {
  if (!cost || !Number.isFinite(cost)) return '—';
  const amount = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
  return currency && currency !== 'USD' ? `${amount} ${currency}` : `$${amount}`;
}
