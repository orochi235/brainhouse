/**
 * Cross-session event-type frequency table. Reads `trpc.eventStats`, which
 * is fed by `Store.incrementEventStat` on every ingested event. Each row
 * is one (kind, subkey) pair — tool name for tool_use, ok/error for
 * tool_result, model for resource_usage, subtype for system, record_type
 * for meta. Kinds with no useful subkey collapse into a single row.
 *
 * This is intentionally minimal: a sortable table, no charts. The goal
 * is to answer "what should we attack next?" — i.e., which event types
 * actually show up enough to be worth dedicated transform / UI work.
 */

import { useEffect, useState } from 'react';
import { trpc } from '../trpc.ts';

interface StatRow {
  kind: string;
  subkey: string;
  count: number;
  last_seen: number;
}

type SortKey = 'count' | 'kind' | 'last_seen';

export function StatsModal() {
  const [rows, setRows] = useState<StatRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('count');

  useEffect(() => {
    let cancelled = false;
    trpc.eventStats
      .query()
      .then((data) => {
        if (!cancelled) setRows(data as StatRow[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = rows
    ? [...rows].sort((a, b) => {
        if (sortKey === 'count') return b.count - a.count || a.kind.localeCompare(b.kind);
        if (sortKey === 'last_seen') return b.last_seen - a.last_seen;
        return a.kind.localeCompare(b.kind) || a.subkey.localeCompare(b.subkey);
      })
    : null;

  const total = sorted?.reduce((acc, r) => acc + r.count, 0) ?? 0;

  return (
    <div className="transforms-modal stats-modal">
      <h3 className="lightbox-title">Event-type stats</h3>
      <p className="transforms-intro">
        Counts every event the monitor has ingested, broken down by kind and (where useful) a second
        axis — tool name, error flag, model, record_type. From the persistent{' '}
        <code>event_stats</code> table; resets only if you drop the DB.
      </p>
      {error && <p className="stats-error">Failed to load: {error}</p>}
      {!sorted && !error && <p className="transforms-intro">Loading…</p>}
      {sorted && (
        <>
          <p className="transforms-intro stats-total">
            {sorted.length} unique (kind, subkey) pairs · {total.toLocaleString()} events total
          </p>
          <table className="stats-table">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="stats-th-button"
                    onClick={() => setSortKey('kind')}
                  >
                    kind {sortKey === 'kind' ? '↓' : ''}
                  </button>
                </th>
                <th>subkey</th>
                <th>
                  <button
                    type="button"
                    className="stats-th-button"
                    onClick={() => setSortKey('count')}
                  >
                    count {sortKey === 'count' ? '↓' : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="stats-th-button"
                    onClick={() => setSortKey('last_seen')}
                  >
                    last seen {sortKey === 'last_seen' ? '↓' : ''}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={`${r.kind}/${r.subkey}`}>
                  <td>{r.kind}</td>
                  <td className="stats-subkey">{r.subkey || <span className="muted">—</span>}</td>
                  <td className="stats-count">{r.count.toLocaleString()}</td>
                  <td className="stats-last-seen">{formatLastSeen(r.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function formatLastSeen(ts: number): string {
  if (!ts) return '—';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
