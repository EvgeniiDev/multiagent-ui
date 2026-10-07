<script setup lang="ts">
import UiButton from './UiButton.vue';
import { fmtInt, fmtTokensWithEst } from '../../features/dashboard/format';
export interface UsageTableRow {
  key: string; name: string; detail: string; tokens: number; estTokens: number;
  costs: string; share: number; title?: string; canResume?: boolean; actionLabel?: string;
  agentName?: string; model?: string; day?: string;
}
defineProps<{ rows: UsageTableRow[]; id: string; testId: string; rowTestId?: string;
  caption: string; nameLabel: string; detailLabel: string }>();
defineEmits<{ open: [key: string] }>();
</script>

<template>
  <table :id="id" class="usage-table" :data-testid="testId">
    <caption class="sr-only">{{ caption }}</caption>
    <thead><tr><th scope="col">{{ nameLabel }}</th><th scope="col">{{ detailLabel }}</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Reported cost</th><th scope="col" class="num">Share</th></tr></thead>
    <tbody>
      <tr v-for="row in rows" :key="row.key" :data-testid="rowTestId" :data-agent="row.agentName" :data-model="row.model" :data-day="row.day" :data-tokens="row.tokens" :data-est="row.estTokens > 0">
        <td class="name-cell" :data-label="nameLabel" :title="row.title || row.name">
          <UiButton v-if="row.actionLabel || row.canResume" variant="ghost" size="xs" :aria-label="row.actionLabel || `Open ${row.name} in chat`" @click="$emit('open', row.key)"><span class="name-text">{{ row.name }}</span></UiButton>
          <span v-else class="name-text mono">{{ row.name }}</span>
        </td>
        <td class="detail-cell" :data-label="detailLabel"><span class="detail-tag" :title="row.detail">{{ row.detail }}</span></td>
        <td class="num token-cell mono" data-label="Tokens" :title="row.estTokens ? `${fmtInt(row.estTokens)} tokens are estimated` : ''">{{ fmtTokensWithEst(row.tokens, row.estTokens) }}</td>
        <td class="num cost-cell mono" data-label="Cost">{{ row.costs }}</td>
        <td class="num share-cell" data-label="Share"><span class="share-content"><span class="share-track" aria-hidden="true"><span :style="{ width: Math.min(100, row.share) + '%' }"></span></span><span>{{ row.share.toFixed(0) }}%</span></span></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.usage-table { width: 100%; border-collapse: collapse; font-size: .75rem; }
.usage-table th { font-size: .625rem; font-weight: 500; letter-spacing: .03em; text-transform: uppercase; color: var(--text-muted); text-align: left; padding: .75rem .75rem .75rem 0; border-bottom: 1px solid var(--border-color); }
.usage-table td { padding: .875rem .75rem .875rem 0; border-bottom: 1px solid var(--border-faint); vertical-align: middle; }
.usage-table tbody tr:last-child td { border-bottom: 0; }
.name-cell { max-width: 360px; overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.num { text-align: right !important; }
.token-cell { white-space: nowrap; }
.cost-cell { color: var(--text-secondary); }
.detail-tag { display: inline-block; padding: .125rem .375rem; background: var(--tint-hover); color: var(--text-secondary); border-radius: var(--radius-sm); font-size: .6875rem; }
.share-content { display: flex; align-items: center; justify-content: flex-end; gap: .5rem; white-space: nowrap; color: var(--text-muted); font-size: .6875rem; }
.share-track { width: 64px; height: 4px; border-radius: 3px; background: var(--border-faint); overflow: hidden; }
.share-track > span { display: block; height: 100%; background: var(--text-accent); border-radius: 3px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
@media (hover: hover) { .usage-table tbody tr:hover td { background: var(--tint-hover); } }
@media (max-width: 600px) {
  .usage-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .usage-table, .usage-table tbody { display: block; width: 100%; }
  .usage-table tr { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr); align-items: start; gap: 10px 8px; padding: 13px 0; border-bottom: 1px solid var(--border-faint); }
  .usage-table tbody tr:last-child { border: 0; }
  .usage-table td { display: block; width: auto; min-width: 0; padding: 0; border: 0; font-size: 11px; text-align: left !important; }
  .usage-table td::before { display: block; content: attr(data-label); margin-bottom: 3px; font-family: var(--font-ui); color: var(--text-muted); font-size: 9px; font-weight: 400; line-height: 1.3; }
  .usage-table .name-cell { grid-column: 1 / 3; grid-row: 1; font-size: 11px; font-weight: 600; line-height: 1.5; }
  .usage-table .name-cell::before, .usage-table .detail-cell::before { display: none; }
  .name-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .usage-table .detail-cell { grid-column: 3; grid-row: 1; text-align: right !important; }
  .detail-tag { max-width: 100%; padding: 2px 5px; font-size: 9px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
  .token-cell { grid-column: 1; grid-row: 2; font-weight: 600; }
  .cost-cell { grid-column: 2; grid-row: 2; overflow-wrap: anywhere; }
  .usage-table .share-cell { grid-column: 3; grid-row: 2; text-align: right !important; }
  .share-content { gap: 5px; font-size: 11px; }
  .share-track { width: 29px; }
}
@media (max-width: 360px) { .usage-table td { font-size: 10px; } .share-content { font-size: 10px; } .share-track { width: 18px; } }
</style>
