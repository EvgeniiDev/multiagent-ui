/** Range selector model for the Dashboard (F5). All panels follow one range. */

export type RangeId = 'today' | '7d' | '30d' | 'all';

export interface RangeDef {
  id: RangeId;
  label: string;
}

export const RANGES: RangeDef[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function rangeBounds(id: RangeId, now = Date.now()): { from: number; to: number } {
  if (id === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: now };
  }
  if (id === 'all') return { from: 0, to: now };
  const days = id === '7d' ? 7 : 30;
  return { from: now - days * DAY_MS, to: now };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDay(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Human label naming the exact window, shown next to every figure (N9). */
export function rangeLabel(id: RangeId, from: number, to: number): string {
  if (id === 'all') return 'All time';
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  if (sameDay) {
    const d = new Date(to);
    return `Today, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  const y = new Date(to).getFullYear();
  return `${shortDay(from)} – ${shortDay(to)}, ${y}`;
}

/** Compact file-safe date stamp for export filenames. */
export function fileDate(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DayBucket {
  key: string;
  label: string;
  tokens: number;
  cost: number;
  turns: number;
}

export interface DayRow {
  day: string; // YYYY-MM-DD (UTC, as produced by usageByDay)
  tokens: number;
  cost: number;
  turns: number;
}

/**
 * Fill every day in [from, to] with zeros where the ledger has nothing, so the
 * chart axis never breaks on gaps. Above ~120 days buckets collapse to weeks.
 */
export function bucketizeDays(rows: DayRow[], from: number, to: number): DayBucket[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
  const step = spanDays > 120 ? 7 : 1;
  const out: DayBucket[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += step * DAY_MS) {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    let tokens = 0;
    let cost = 0;
    let turns = 0;
    if (step === 1) {
      const r = byDay.get(toIsoDay(d));
      if (r) {
        tokens = r.tokens;
        cost = r.cost;
        turns = r.turns;
      }
    } else {
      for (let k = 0; k < 7; k++) {
        const dd = new Date(t + k * DAY_MS);
        if (dd.getTime() > end.getTime()) break;
        const r = byDay.get(toIsoDay(dd));
        if (r) {
          tokens += r.tokens;
          cost += r.cost;
          turns += r.turns;
        }
      }
    }
    out.push({
      key,
      label: `${MONTHS[d.getMonth()]} ${d.getDate()}`,
      tokens,
      cost,
      turns,
    });
  }
  return out;
}

/** UTC day key matching the activity store's usageByDay grouping. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
