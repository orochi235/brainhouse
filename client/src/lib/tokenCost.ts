/**
 * Token weighting + cost estimation.
 *
 * Raw token totals overstate by ~5× in typical Claude Code sessions
 * because cache_read dominates the sum but is billed at 0.1× input. We
 * surface an input-equivalent total instead — sum each bucket weighted
 * by its billing coefficient — so the headline number tracks effective
 * usage. Coefficients are model-invariant across Anthropic's current
 * tiers (Opus / Sonnet / Haiku): only the absolute $/MTok shifts.
 *
 * Dollar estimates are computed alongside (looked up per-model) but the
 * UI deliberately keeps them in the tooltip, not the chip — live $
 * counters are stressful and tokens convey the same information at
 * lower stakes.
 */

/** Billing coefficients relative to input tokens. */
export const TOKEN_COEFFICIENTS = {
  input: 1,
  cache_create: 1.25,
  cache_read: 0.1,
  output: 5,
} as const;

export interface TokenBuckets {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  model?: string | null;
}

/** Weighted total, expressed in input-equivalent tokens. */
export function inputEquivalentTokens(t: TokenBuckets): number {
  return Math.round(
    t.input * TOKEN_COEFFICIENTS.input +
      t.cache_create * TOKEN_COEFFICIENTS.cache_create +
      t.cache_read * TOKEN_COEFFICIENTS.cache_read +
      t.output * TOKEN_COEFFICIENTS.output,
  );
}

/** USD per 1M tokens, by bucket. `null` for unknown models. */
interface ModelPricing {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
}

/** Public pricing per 1M tokens. Update when Anthropic changes rates.
 * Keys match prefixes of `usage.model` on assistant events. Order
 * matters — first prefix match wins. */
const PRICING: Array<[string, ModelPricing]> = [
  ['claude-opus-4', { input: 15, output: 75, cache_create: 18.75, cache_read: 1.5 }],
  ['claude-sonnet-4', { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 }],
  ['claude-haiku-4', { input: 0.8, output: 4, cache_create: 1, cache_read: 0.08 }],
];

function pricingFor(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  for (const [prefix, p] of PRICING) {
    if (model.startsWith(prefix)) return p;
  }
  return null;
}

/** Estimated cost in USD. Returns null if the model isn't in our table. */
export function estimateCostUsd(t: TokenBuckets): number | null {
  const p = pricingFor(t.model);
  if (!p) return null;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cache_create * p.cache_create +
      t.cache_read * p.cache_read) /
    1_000_000
  );
}

/** Fraction of cacheable input traffic served from cache. Returns null
 * if there's no cacheable input yet (e.g. brand-new session before any
 * resource_usage record). `output` is excluded — it isn't cacheable. */
export function cacheHitRate(t: TokenBuckets): number | null {
  const denom = t.cache_read + t.cache_create + t.input;
  if (denom === 0) return null;
  return t.cache_read / denom;
}

/** Healthy steady-state Claude Code sessions sit well above 0.7 cache
 * hit rate; below that strongly suggests cache invalidation churn (TTL
 * expiry, shifting prompt prefix, tools re-ordering). */
export const CACHE_HIT_HEALTHY = 0.7;
export const CACHE_HIT_POOR = 0.4;

export type CacheHealth = 'healthy' | 'mixed' | 'poor' | 'unknown';

/** Below this many cacheable input tokens, ratios are too noisy to
 * judge — a fresh session with one turn isn't "poor", it just hasn't
 * had a chance to cache anything yet. */
const CACHE_HEALTH_MIN_DENOM = 50_000;

export function cacheHealth(t: TokenBuckets): CacheHealth {
  const denom = t.cache_read + t.cache_create + t.input;
  if (denom < CACHE_HEALTH_MIN_DENOM) return 'unknown';
  const rate = t.cache_read / denom;
  if (rate >= CACHE_HIT_HEALTHY) return 'healthy';
  if (rate >= CACHE_HIT_POOR) return 'mixed';
  return 'poor';
}

/** Format a USD figure for tooltips. `<$0.01` floor; otherwise 2 decimals. */
export function formatUsd(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}
