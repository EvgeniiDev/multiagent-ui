import type { SpendRow } from './aggregate';
import { API_PRICES } from './prices';

const aliases: Record<string, string> = { cx: 'openai', cc: 'anthropic', ds: 'deepseek', glm: 'zai', 'z-ai': 'zai' };
const providerAliases: Record<string, string> = { 'openai-codex': 'openai', 'xai-oauth': 'xai', 'opencode-free': 'opencode', zen: 'opencode', 'zen-relay': 'opencode' };
function modelRates(row: SpendRow) {
  const provider = providerAliases[row.provider] ?? row.provider;
  const direct = API_PRICES[provider]?.[row.model];
  if (direct) return direct;
  // Resolve explicit vendor namespaces, but never guess a model from a prefix.
  const [namespace, ...rest] = row.model.split('/');
  const vendor = aliases[namespace] ?? namespace;
  if (rest.length && API_PRICES[vendor]?.[rest.join('/')]) return API_PRICES[vendor][rest.join('/')];
  for (const vendor of ['openai', 'anthropic', 'deepseek', 'zai', 'xai']) {
    const rates = API_PRICES[vendor]?.[row.model];
    if (rates) return rates;
  }
  return undefined;
}

/** Price deltas, never cumulative counters. Missing token splits stay unknown. */
export function apiCost(row: SpendRow): number | undefined {
  let rates = modelRates(row);
  if (!rates) return undefined;
  const buckets = [row.input ?? 0, row.output ?? 0, row.cacheRead ?? 0, row.cacheWrite ?? 0];
  if (buckets.some(n => !Number.isFinite(n) || n < 0)) return undefined;
  const [input, rawOutput, read, write] = buckets;
  const prompt = input + read + write;
  // Legacy Codex journals included reasoning a second time in the output bucket.
  const output = row.agentName === 'Codex' && prompt + rawOutput > row.tokens
    ? Math.max(0, row.tokens - prompt) : rawOutput;
  if (row.tokens > 0 && prompt + output === 0) return undefined;
  // All prompt tokens, including cached tokens, determine the context tier.
  for (const tier of rates.tiers ?? []) {
    if (tier.tier.type === 'context' && prompt > tier.tier.size) rates = { ...rates, ...tier };
  }
  if ((read && rates.cache_read == null) || (write && rates.cache_write == null)) return undefined;
  return (input * rates.input + output * rates.output + read * (rates.cache_read ?? 0) + write * (rates.cache_write ?? 0)) / 1e6;
}

export function priceUsage(row: SpendRow): SpendRow {
  const cost = apiCost(row);
  return cost == null ? row : { ...row, cost, currency: 'USD' };
}
