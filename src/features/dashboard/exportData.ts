/** Client-side JSON/CSV export of the range data (Blob download, no server). */
import { fileDate, type RangeId } from './range';
import { fmtCost } from './format';

export interface ExportDay {
  day: string;
  tokens: number;
  cost: number | null;
  turns: number;
  costs?: Array<{ currency: string; amount: number }>;
}

export interface ExportAgent {
  agentName: string;
  tokens: number;
  cost: number | null;
  turns: number;
  costs?: Array<{ currency: string; amount: number }>;
}

export interface ExportPayload {
  exportedAt: string;
  range: RangeId;
  from: string;
  to: string;
  summary: { tokens: number; cost: number | null; turns: number; sessions: number; toolCalls: number; costs?: Array<{ currency: string; amount: number }> };
  byAgent: ExportAgent[];
  byDay: ExportDay[];
}

export function exportFileName(range: RangeId, to: number, ext: 'json' | 'csv'): string {
  return `dashboard-${range}-${fileDate(to)}.${ext}`;
}

export function toJson(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** New dashboard exports retain currency groups. Legacy callers without
 * groups keep their existing four-column format. Blank cost means unavailable
 * or multiple currencies, whereas a reported zero stays zero. */
export function toCsv(days: ExportDay[]): string {
  const grouped = days.some(d => d.costs !== undefined);
  const lines = [grouped ? 'day,tokens,cost,turns,currency,reported_costs' : 'day,tokens,cost,turns'];
  const cell = (s: string) => /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  for (const d of days) {
    const groups = d.costs;
    const cost = groups ? (groups.length === 1 ? String(groups[0].amount) : '') : d.cost === null ? '' : fmtCost(d.cost);
    const fields = [d.day, String(Math.round(d.tokens)), cost, String(d.turns)];
    if (grouped) fields.push(groups?.length === 1 ? groups[0].currency : '',
      groups?.map(g => `${g.amount}${g.currency ? ` ${g.currency}` : ''}`).join(' | ') ?? '');
    lines.push(fields.map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

export function downloadFile(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
