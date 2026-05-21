/**
 * Cross-session "flows" aggregator — builds a sankey-friendly graph of
 * what event types tend to follow what across every session in the
 * `events_index` window.
 *
 * Layout: chronological columns. We bucket events by ordinal position in
 * their parent session (1st event, 2nd, …). Events past column 19 collapse
 * into a single per-type `tail` node so the graph remains a finite DAG
 * (d3-sankey requires acyclic input).
 *
 * Node taxonomy (fine-grained):
 *   - event kinds as themselves: user_text, assistant_text, thinking, system, meta
 *   - each tool by name: tool_use:Read, tool_use:Bash, tool_use:mcp__foo, …
 *   - each tool_result keyed by the tool it answered: tool_result:Read, …
 *   - Task subagent spawns as: subagent:<agentType> (derived from the
 *     Task tool's `subagent_type` input, captured into the event_index
 *     row's `summary` JSON at ingest time).
 *
 * Link weight: count of sessions where event at position K (type X) was
 * directly followed by event at position K+1 (type Y), summed across
 * every session in the time window.
 */

import type { EventIndexRow, Store } from './store.js';

export const MAX_COLUMN = 19; // 20 columns total: 0..19 + a final "tail" bucket
export const TAIL_COLUMN = MAX_COLUMN + 1;

export interface FlowNode {
  id: string;
  label: string;
  /** Column index 0..TAIL_COLUMN. Tail nodes share TAIL_COLUMN. */
  column: number;
  kind: 'event_kind' | 'tool_use' | 'tool_result' | 'subagent';
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
}

export interface FlowsGraph {
  nodes: FlowNode[];
  links: FlowLink[];
}

/** Parse the `summary` field's optional JSON blob written at ingest time
 * by eventToIndexRow. Returns an empty object on any failure. */
function readMeta(summary: string | null): {
  tool_use_id?: string;
  subagent_type?: string;
} {
  if (!summary) return {};
  try {
    const v = JSON.parse(summary) as Record<string, unknown>;
    const out: { tool_use_id?: string; subagent_type?: string } = {};
    if (typeof v.tool_use_id === 'string') out.tool_use_id = v.tool_use_id;
    if (typeof v.subagent_type === 'string') out.subagent_type = v.subagent_type;
    return out;
  } catch {
    return {};
  }
}

/**
 * Map a single events_index row to its node label per the taxonomy above.
 * `toolUseIdToName` is a per-session lookup populated as the caller walks
 * events in order — when we hit a tool_result, we resolve which tool it
 * came back from. Returns null when the row can't be classified (e.g.
 * tool_use with no name).
 */
export function deriveType(
  row: EventIndexRow,
  toolUseIdToName: Map<string, string>,
): { label: string; kind: FlowNode['kind'] } | null {
  const meta = readMeta(row.summary);
  if (row.kind === 'tool_use') {
    if (!row.tool_name) return null;
    if (row.tool_name === 'Task' && meta.subagent_type) {
      return { label: `subagent:${meta.subagent_type}`, kind: 'subagent' };
    }
    // Side-effect: remember this tool_use_id → name mapping so a later
    // tool_result in the same session can resolve back to it.
    if (meta.tool_use_id) toolUseIdToName.set(meta.tool_use_id, row.tool_name);
    return { label: `tool_use:${row.tool_name}`, kind: 'tool_use' };
  }
  if (row.kind === 'tool_result') {
    let name: string | undefined;
    if (meta.tool_use_id) name = toolUseIdToName.get(meta.tool_use_id);
    return { label: `tool_result:${name ?? '?'}`, kind: 'tool_result' };
  }
  return { label: row.kind, kind: 'event_kind' };
}

/** Fold a position past MAX_COLUMN into the shared tail column. */
function bucketColumn(position: number): number {
  return position > MAX_COLUMN ? TAIL_COLUMN : position;
}

function nodeId(label: string, column: number): string {
  return `${column}::${label}`;
}

/**
 * Walk every row newer than `sinceTs` grouped by panel, classify each
 * into a (column, label) node, and count consecutive (K,X) → (K+1,Y)
 * transitions across all sessions.
 */
export function aggregateFlows(store: Store, days = 30): FlowsGraph {
  const now = Date.now() / 1000;
  const sinceTs = now - days * 86_400;
  const rows = store.eventsSince(sinceTs);
  return aggregateRows(rows);
}

/** Pure aggregation step — exposed for unit testing without a live db. */
export function aggregateRows(rows: EventIndexRow[]): FlowsGraph {
  // Group rows by panel_id while preserving the SELECT's ordering (panel
  // first, ts second). A plain Map keyed by panel_id keeps insertion order
  // which is fine here — we only need each session's events in ts order.
  const byPanel = new Map<string, EventIndexRow[]>();
  for (const r of rows) {
    const arr = byPanel.get(r.panel_id);
    if (arr) arr.push(r);
    else byPanel.set(r.panel_id, [r]);
  }

  const nodes = new Map<string, FlowNode>();
  const linkCounts = new Map<string, { source: string; target: string; value: number }>();

  for (const events of byPanel.values()) {
    const toolUseIdToName = new Map<string, string>();
    let prev: { id: string; column: number } | null = null;
    let position = 0;
    for (const row of events) {
      const t = deriveType(row, toolUseIdToName);
      if (!t) {
        position++;
        continue;
      }
      const column = bucketColumn(position);
      const id = nodeId(t.label, column);
      if (!nodes.has(id)) {
        nodes.set(id, { id, label: t.label, column, kind: t.kind });
      }
      if (prev) {
        // Skip self-loops: rare but possible at the tail column where many
        // events land in the same bucket. Sankey can't draw them.
        if (prev.id !== id) {
          const lk = `${prev.id}${id}`;
          const cur = linkCounts.get(lk);
          if (cur) cur.value += 1;
          else linkCounts.set(lk, { source: prev.id, target: id, value: 1 });
        }
      }
      prev = { id, column };
      position++;
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    links: Array.from(linkCounts.values()),
  };
}
