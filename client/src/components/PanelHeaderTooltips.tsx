/**
 * Hover popovers for the two simpler panel-header badges:
 * - SessionTimeTooltip — explains what the elapsed time on the
 *   `.panel-session-time` chip actually measures.
 * - ContextSizeTooltip — explains the `.panel-context` chip's number
 *   (current window size, not cumulative).
 *
 * Both are short, narrative-style; no per-bucket tables (the token
 * popover already owns that style). Sibling to `TokenTooltip.tsx`.
 */

import { formatTokens } from '../lib/format.ts';

export function SessionTimeTooltip({
  startedAt,
  isLive,
}: {
  startedAt: number;
  isLive: boolean;
}) {
  const startedDate = new Date(startedAt);
  const startedISO = isFinite(startedAt) ? startedDate.toLocaleString() : '—';
  return (
    <div className="header-tooltip">
      <div className="header-tooltip-title">session elapsed</div>
      <p className="header-tooltip-body">
        Wall-clock time from when this session started.{' '}
        {isLive
          ? 'Ticks live; updates on every render.'
          : 'Frozen at the last event — done sessions don’t keep counting.'}
      </p>
      <div className="header-tooltip-meta">started {startedISO}</div>
    </div>
  );
}

export function ContextSizeTooltip({
  contextSize,
  hookOverheadTokens = 0,
}: {
  contextSize: number;
  hookOverheadTokens?: number;
}) {
  const overheadPct =
    contextSize > 0 && hookOverheadTokens > 0
      ? (hookOverheadTokens / contextSize) * 100
      : null;
  return (
    <div className="header-tooltip">
      <div className="header-tooltip-title">current context window</div>
      <p className="header-tooltip-body">
        How many tokens were in the model’s context on the most recent turn —{' '}
        <code>input + cache_create + cache_read</code>. This is *not* cumulative;
        it’s overwritten each turn and reflects what’s actively
        loaded right now.
      </p>
      <div className="header-tooltip-meta">
        {contextSize.toLocaleString()} tokens ({formatTokens(contextSize)})
      </div>
      {hookOverheadTokens > 0 && (
        <div className="header-tooltip-meta">
          + ~{hookOverheadTokens.toLocaleString()} tokens (
          {formatTokens(hookOverheadTokens)}) from brainhouse hook instrumentation
          {overheadPct !== null && ` · ${overheadPct.toFixed(1)}% of context`}
        </div>
      )}
    </div>
  );
}
