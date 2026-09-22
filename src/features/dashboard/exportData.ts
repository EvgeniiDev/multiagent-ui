/** Client-side JSON/CSV export of the range data (Blob download, no server). */
import { fileDate, type RangeId } from './range';
import { fmtCost } from './format';

export interface ExportDay {
  day: string;
  tokens: number;
  cost: number;
  turns: number;
}

export interface ExportAgent {
  agentName: string;
  tokens: number;
  cost: number;
  turns: number;
}

export interface ExportPayload {
  exportedAt: string;
  range: RangeId;
  from: string;
  to: string;
  summary: { tokens: number; cost: number; turns: number; sessions: number; toolCalls: number };
  byAgent: ExportAgent[];
  byDay: ExportDay[];
}

export function exportFileName(range: RangeId, to: number, ext: 'json' | 'csv'): string {
  return `dashboard-${range}-${fileDate(to)}.${ext}`;
}

export function toJson(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** One table: per-day totals. Costs keep full precision; formatting is display-only. */
export function toCsv(days: ExportDay[]): string {
  const lines = ['day,tokens,cost,turns'];
  for (const d of days) {
    lines.push(`${d.day},${Math.round(d.tokens)},${fmtCost(d.cost)},${d.turns}`);
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
