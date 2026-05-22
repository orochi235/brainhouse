/**
 * Structured content of the panel-tokens hover popover. Replaces the
 * plain-text browser `title` attribute the chip used to carry.
 *
 * Layout: header → per-bucket table with coefficients → divider →
 * input-equivalent total → optional $ estimate → cache hit rate block,
 * which expands into an explanatory paragraph when the chip turned
 * amber/red so the user can see *why* without having to remember the
 * threshold rules.
 */

import type { PanelState } from '../useDeltaStream.ts';
import { formatTokens } from '../lib/format.ts';
import {
  TOKEN_COEFFICIENTS,
  cacheHealth,
  cacheHitRate,
  estimateCostUsd,
  formatUsd,
  inputEquivalentTokens,
} from '../lib/tokenCost.ts';

type Tokens = PanelState['tokens'];

const BUCKET_ROWS: Array<{
  key: 'input' | 'cache_create' | 'cache_read' | 'output';
  label: string;
  coef: number;
}> = [
  { key: 'input', label: 'input', coef: TOKEN_COEFFICIENTS.input },
  { key: 'cache_create', label: 'cache create', coef: TOKEN_COEFFICIENTS.cache_create },
  { key: 'cache_read', label: 'cache read', coef: TOKEN_COEFFICIENTS.cache_read },
  { key: 'output', label: 'output', coef: TOKEN_COEFFICIENTS.output },
];

export function TokenTooltip({ tokens }: { tokens: Tokens }) {
  const weighted = inputEquivalentTokens(tokens);
  const rawTotal = tokens.input + tokens.output + tokens.cache_create + tokens.cache_read;
  const usd = estimateCostUsd(tokens);
  const rate = cacheHitRate(tokens);
  const health = cacheHealth(tokens);

  return (
    <div className="token-tooltip">
      <div className="token-tooltip-title">tokens</div>
      <table className="token-tooltip-table">
        <tbody>
          {BUCKET_ROWS.map((row) => (
            <tr key={row.key}>
              <td className="label">{row.label}</td>
              <td className="num">{tokens[row.key].toLocaleString()}</td>
              <td className="coef">×{row.coef}</td>
            </tr>
          ))}
          <tr className="divider">
            <td colSpan={3} />
          </tr>
          <tr className="total">
            <td className="label">input-equiv</td>
            <td className="num">{formatTokens(weighted)}</td>
            <td className="coef" />
          </tr>
          <tr className="raw">
            <td className="label">raw sum</td>
            <td className="num">{rawTotal.toLocaleString()}</td>
            <td className="coef" />
          </tr>
          {usd != null && (
            <tr className="cost">
              <td className="label">est. cost</td>
              <td className="num">{formatUsd(usd)}</td>
              <td className="coef" />
            </tr>
          )}
        </tbody>
      </table>
      {rate != null && (
        <div className={`token-tooltip-cache cache-${health}`}>
          <div className="cache-row">
            <span className="cache-label">cache hit rate</span>
            <span className="cache-rate">{(rate * 100).toFixed(1)}%</span>
            {health !== 'unknown' && <span className="cache-badge">{health}</span>}
          </div>
          {(health === 'mixed' || health === 'poor') && (
            <p className="cache-note">
              {health === 'poor' ? 'Cache hit rate is low. ' : 'Cache hit rate is below typical. '}
              Each cache miss re-bills the cached prefix at full input rate (10×
              cache-read cost). Common causes: a 5-minute gap broke the cache TTL, the
              system prompt prefix shifted between turns, or tools / MCP servers are
              loading in a different order each turn.
            </p>
          )}
        </div>
      )}
      {tokens.model && <div className="token-tooltip-model">{tokens.model}</div>}
    </div>
  );
}
