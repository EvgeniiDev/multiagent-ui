/** USD per million tokens, standard API rates. Snapshot: 2026-10-17.
 * Source: https://models.dev/api.json (provider model catalog).
 * OpenAI rates/long-context thresholds checked against:
 * https://developers.openai.com/api/docs/pricing
 * Refresh this snapshot when adding models or when providers change prices.
 * Subscription fees, batch/priority discounts and tool charges are excluded.
 */
interface Rates { input: number; output: number; cache_read?: number; cache_write?: number;
  tiers?: Array<Rates & { tier: { type: string; size: number } }> }
export const API_PRICES: Record<string, Record<string, Rates>> = {
  "openai": {
    "gpt-5.4": {"input": 2.5,"output": 15,"cache_read": 0.25,"tiers": [{"input": 5,"output": 22.5,"cache_read": 0.5,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.4-pro": {"input": 30,"output": 180,"tiers": [{"input": 60,"output": 270,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.4-nano": {"input": 0.2,"output": 1.25,"cache_read": 0.02},
    "gpt-5.3-codex": {"input": 1.75,"output": 14,"cache_read": 0.175},
    "gpt-5.6": {"input": 4,"output": 20,"cache_read": 0.4,"cache_write": 5,"tiers": [{"input": 8,"output": 30,"cache_read": 0.8,"cache_write": 10,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.3-codex-spark": {"input": 1.75,"output": 14,"cache_read": 0.175},
    "gpt-6.1-sol": {"input": 2,"output": 10,"cache_read": 0.1,"cache_write": 2.5,"tiers": [{"input": 4,"output": 15,"cache_read": 0.2,"cache_write": 5,"tier": {"type": "context","size": 272000}}]},
    "gpt-6-astra": {"input": 10,"output": 50,"cache_read": 1,"cache_write": 12.5,"tiers": [{"input": 20,"output": 75,"cache_read": 2,"cache_write": 25,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.4-mini": {"input": 0.75,"output": 4.5,"cache_read": 0.075},
    "gpt-5.6-luna": {"input": 0.2,"output": 1.2,"cache_read": 0.02,"cache_write": 0.25,"tiers": [{"input": 0.4,"output": 1.8,"cache_read": 0.04,"cache_write": 0.5,"tier": {"type": "context","size": 272000}}]},
    "gpt-6-luna": {"input": 0.1,"output": 0.5,"cache_read": 0.01,"cache_write": 0.125,"tiers": [{"input": 0.2,"output": 0.75,"cache_read": 0.02,"cache_write": 0.25,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.6-terra": {"input": 2,"output": 12,"cache_read": 0.2,"cache_write": 2.5,"tiers": [{"input": 4,"output": 18,"cache_read": 0.4,"cache_write": 5,"tier": {"type": "context","size": 272000}}]},
    "gpt-5.6-sol": {"input": 4,"output": 20,"cache_read": 0.4,"cache_write": 5,"tiers": [{"input": 8,"output": 30,"cache_read": 0.8,"cache_write": 10,"tier": {"type": "context","size": 272000}}]},
    "gpt-6-sol": {"input": 2,"output": 10,"cache_read": 0.2,"cache_write": 2.5,"tiers": [{"input": 4,"output": 15,"cache_read": 0.4,"cache_write": 5,"tier": {"type": "context","size": 272000}}]},
  },
  "anthropic": {
    "claude-haiku-4-5": {"input": 1,"output": 5,"cache_read": 0.1,"cache_write": 1.25},
    "claude-opus-4-5": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
    "claude-sonnet-4-5": {"input": 3,"output": 15,"cache_read": 0.3,"cache_write": 3.75},
    "claude-opus-4-5-20251101": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
    "claude-opus-4-8": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
    "claude-sonnet-4-5-20250929": {"input": 3,"output": 15,"cache_read": 0.3,"cache_write": 3.75},
    "claude-opus-4-6": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
    "claude-haiku-4-5-20251001": {"input": 1,"output": 5,"cache_read": 0.1,"cache_write": 1.25},
    "claude-sonnet-4-6": {"input": 3,"output": 15,"cache_read": 0.3,"cache_write": 3.75},
    "claude-opus-4-7": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
  },
  "deepseek": {
    "deepseek-v4-flash-vision-exp": {"input": 0.15,"output": 0.6,"cache_read": 0.003},
    "deepseek-v4-pro": {"input": 0.66,"output": 1.98,"cache_read": 0.022},
    "deepseek-v4-flash": {"input": 0.15,"output": 0.6,"cache_read": 0.003},
  },
  "zai": {
    "glm-5.3-flash": {"input": 0.15,"output": 0.5,"cache_read": 0.03,"cache_write": 0},
    "glm-5.3-flashx": {"input": 0.37,"output": 1.25,"cache_read": 0.075,"cache_write": 0},
    "glm-5.3": {"input": 1.4,"output": 4.4,"cache_read": 0.26,"cache_write": 0},
  },
  "xai": {
    "grok-4.6": {"input": 2,"output": 6,"cache_read": 0.5,"tiers": [{"input": 4,"output": 12,"cache_read": 1,"tier": {"type": "context","size": 200000}}]},
  },
  "opencode": {
    "ling-3.0-flash-fin-free": {"input": 0,"output": 0,"cache_read": 0},
    "muse-spark-1.2-contributor-free": {"input": 0,"output": 0,"cache_read": 0},
    "glm-5.3-flash": {"input": 0.15,"output": 0.5,"cache_read": 0.03},
    "kimi-k3": {"input": 3,"output": 15,"cache_read": 0.3},
    "deepseek-v4.1-flash": {"input": 0.3,"output": 1.2,"cache_read": 0.006},
    "gpt-6.1-sol": {"input": 2,"output": 10,"cache_read": 0.1,"cache_write": 2.5,"tiers": [{"input": 4,"output": 15,"cache_read": 0.2,"cache_write": 5,"tier": {"type": "context","size": 272000}}]},
    "gpt-6-astra": {"input": 10,"output": 50,"cache_read": 1,"cache_write": 12.5,"tiers": [{"input": 20,"output": 75,"cache_read": 2,"cache_write": 25,"tier": {"type": "context","size": 272000}}]},
    "space-bunny-free": {"input": 0,"output": 0,"cache_read": 0,"cache_write": 0},
    "mimo-v2.6-flash-free": {"input": 0,"output": 0,"cache_read": 0},
    "nemotron-3-ultra-free": {"input": 0,"output": 0,"cache_read": 0},
    "gpt-5.6-luna": {"input": 0.2,"output": 1.2,"cache_read": 0.02,"cache_write": 0.25,"tiers": [{"input": 0.4,"output": 1.8,"cache_read": 0.04,"cache_write": 0.5,"tier": {"type": "context","size": 272000}}]},
    "mimo-v2.5-free": {"input": 0,"output": 0,"cache_read": 0},
    "claude-opus-4-8": {"input": 5,"output": 25,"cache_read": 0.5,"cache_write": 6.25},
    "nemotron-3.5-lightning-free": {"input": 0,"output": 0,"cache_read": 0},
    "gpt-6-luna": {"input": 0.1,"output": 0.5,"cache_read": 0.01,"cache_write": 0.125,"tiers": [{"input": 0.2,"output": 0.75,"cache_read": 0.02,"cache_write": 0.25,"tier": {"type": "context","size": 272000}}]},
    "big-pickle": {"input": 0,"output": 0,"cache_read": 0,"cache_write": 0},
    "grok-4.6": {"input": 2,"output": 6,"cache_read": 0.5,"tiers": [{"input": 4,"output": 12,"cache_read": 1,"tier": {"type": "context","size": 200000}}]},
    "muse-spark-1.3-contributor-free": {"input": 0,"output": 0,"cache_read": 0},
    "deepseek-v4-flash": {"input": 0.14,"output": 0.28,"cache_read": 0.028},
  },
  "opencode-go": {
    "glm-5.3-flash": {"input": 0.15,"output": 0.5,"cache_read": 0.03},
    "kimi-k3": {"input": 3,"output": 15,"cache_read": 0.3},
    "deepseek-v4.1-flash": {"input": 0.15,"output": 0.6,"cache_read": 0.003},
    "gpt-5.6-luna": {"input": 0.2,"output": 1.2,"cache_read": 0.02,"cache_write": 0.25,"tiers": [{"input": 0.4,"output": 1.8,"cache_read": 0.04,"cache_write": 0.5,"tier": {"type": "context","size": 272000}}]},
    "gpt-6-luna": {"input": 0.1,"output": 0.5,"cache_read": 0.01,"cache_write": 0.125,"tiers": [{"input": 0.2,"output": 0.75,"cache_read": 0.02,"cache_write": 0.25,"tier": {"type": "context","size": 272000}}]},
  },
  "openrouter": {
    "poolside/laguna-s-2.1:free": {"input": 0,"output": 0},
    "cohere/north-mini-code:free": {"input": 0,"output": 0},
    "deepseek/deepseek-v4-flash-0731": {"input": 0.0071,"output": 1.28,"cache_read": 0.0071},
    "z-ai/glm-5.3-flash": {"input": 0.15,"output": 0.5,"cache_read": 0.03},
    "openrouter/free": {"input": 0,"output": 0},
    "google/gemini-3.6-flash": {"input": 0.75,"output": 3.75,"cache_read": 0.075,"cache_write": 0.041667},
    "nvidia/nemotron-3-ultra-550b-a55b:free": {"input": 0,"output": 0},
    "amazon/nova-lite-v1": {"input": 0.06,"output": 0.24},
  },
  "alibaba": {
    "kimi-k3": {"input": 3,"output": 15,"cache_read": 0.3},
  },
};
