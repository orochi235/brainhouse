/**
 * Cross-session "flows" sankey. Reads `trpc.flows.aggregate` (events_index,
 * windowed to the last N days), renders an SVG sankey with d3-sankey.
 *
 * Layout matches the server-side aggregation: chronological columns
 * (1st event of a session, 2nd, …), capped at 20 with a shared tail
 * column. Link weight = number of sessions where a given (column,type)
 * was directly followed by the next (column,type).
 *
 * Colors come from a small palette keyed by node `kind` so the sankey
 * reads in both light and dark themes (uses CSS color-mix against
 * --panel-bg for muted variants).
 */

import { sankey, sankeyLinkHorizontal, type SankeyGraph } from 'd3-sankey';
import { useEffect, useMemo, useState } from 'react';
import { trpc } from '../trpc.ts';

interface FlowNode {
  id: string;
  label: string;
  column: number;
  kind: 'event_kind' | 'tool_use' | 'tool_result' | 'subagent';
}
interface FlowLink {
  source: string;
  target: string;
  value: number;
}
interface FlowsGraph {
  nodes: FlowNode[];
  links: FlowLink[];
}

// d3-sankey mutates its input nodes/links with positions + indices, so we
// keep an internal type with the bookkeeping fields filled in. The
// `index` field is what d3 substitutes into `link.source`/`link.target`
// after .sankey() runs.
type SankeyNode = FlowNode & {
  index?: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  value?: number;
};
type SankeyLink = {
  source: SankeyNode | number | string;
  target: SankeyNode | number | string;
  value: number;
  width?: number;
  y0?: number;
  y1?: number;
};

const KIND_COLORS: Record<FlowNode['kind'], string> = {
  event_kind: 'var(--flow-event-kind, #6b8afd)',
  tool_use: 'var(--flow-tool-use, #4ec9a4)',
  tool_result: 'var(--flow-tool-result, #b48af0)',
  subagent: 'var(--flow-subagent, #f0a14e)',
};

const WIDTH = 1100;
const HEIGHT = 620;
const MARGIN = { top: 16, right: 180, bottom: 16, left: 16 };

interface HoverState {
  link: { source: string; target: string; value: number };
  x: number;
  y: number;
}

export function FlowsModal() {
  const [graph, setGraph] = useState<FlowsGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setError(null);
    trpc.flows.aggregate
      .query({ days })
      .then((data) => {
        if (!cancelled) setGraph(data as FlowsGraph);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const laidOut = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    // d3-sankey wants integer source/target indices. Build a copy keyed
    // by id, then convert string ids → indices for the layout pass.
    const idToIdx = new Map<string, number>();
    const nodes: SankeyNode[] = graph.nodes.map((n, i) => {
      idToIdx.set(n.id, i);
      return { ...n };
    });
    const links: SankeyLink[] = [];
    for (const l of graph.links) {
      const s = idToIdx.get(l.source);
      const t = idToIdx.get(l.target);
      if (s === undefined || t === undefined) continue;
      links.push({ source: s, target: t, value: l.value });
    }

    const innerW = WIDTH - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    try {
      const layout = sankey<SankeyNode, SankeyLink>()
        .nodeId((d) => String((d as SankeyNode).index ?? ''))
        .nodeWidth(12)
        .nodePadding(8)
        .extent([
          [0, 0],
          [innerW, innerH],
        ]);
      // d3-sankey expects nodes/links shaped as SankeyGraph.
      const result = layout({ nodes, links } as unknown as SankeyGraph<SankeyNode, SankeyLink>);
      return result;
    } catch (e) {
      // d3-sankey throws on cycles. With our column-bucketing approach the
      // graph is acyclic by construction, but degenerate inputs (one
      // column total) can still trip it; fall back to "no graph" rather
      // than crash the modal.
      console.warn('sankey layout failed', e);
      return null;
    }
  }, [graph]);

  const totalSessions = useMemo(() => {
    if (!graph) return 0;
    // The 0-column nodes' summed value is roughly the number of sessions
    // contributing to the graph (each session emits one event at column 0).
    // d3 fills .value during layout; this read happens after laidOut runs.
    if (!laidOut) return 0;
    return laidOut.nodes
      .filter((n) => n.column === 0)
      .reduce((acc, n) => acc + (n.value ?? 0), 0);
  }, [graph, laidOut]);

  return (
    <div className="transforms-modal flows-modal">
      <h3 className="lightbox-title">Session flow</h3>
      <p className="transforms-intro">
        What event types follow what, across every session in the last{' '}
        <select
          className="flows-days"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>1 day</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
        . Columns are ordinal position in a session (1st event, 2nd, …); link
        weight is how often (col K, X) was directly followed by (col K+1, Y).
      </p>
      {error && <p className="stats-error">Failed to load: {error}</p>}
      {!graph && !error && <p className="transforms-intro">Loading…</p>}
      {graph && graph.nodes.length === 0 && (
        <p className="transforms-intro">
          No events in the last {days} day{days === 1 ? '' : 's'}. Run a few sessions and try
          again.
        </p>
      )}
      {laidOut && (
        <>
          <p className="transforms-intro stats-total">
            {laidOut.nodes.length} nodes · {laidOut.links.length} transitions ·{' '}
            ~{totalSessions} sessions
          </p>
          <FlowsSvg laidOut={laidOut} onHover={setHover} />
          {hover && (
            <div
              className="flows-tooltip"
              style={{ left: hover.x + 12, top: hover.y + 12 }}
            >
              <strong>{labelOf(hover.link.source)}</strong>
              <span className="flows-tooltip-arrow"> → </span>
              <strong>{labelOf(hover.link.target)}</strong>
              <span className="flows-tooltip-count"> · {hover.link.value}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function labelOf(nodeId: string): string {
  const sep = nodeId.indexOf('::');
  return sep === -1 ? nodeId : nodeId.slice(sep + 2);
}

function FlowsSvg({
  laidOut,
  onHover,
}: {
  laidOut: SankeyGraph<SankeyNode, SankeyLink>;
  onHover: (h: HoverState | null) => void;
}) {
  const linkPath = sankeyLinkHorizontal<SankeyNode, SankeyLink>();
  return (
    <svg
      className="flows-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ width: '100%', height: '70vh' }}
      role="img"
      aria-label="Session flow sankey"
    >
      <title>Session flow — cross-session event sequence</title>
      <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
        <g className="flows-links" fill="none">
          {laidOut.links.map((l, i) => {
            const src = l.source as SankeyNode;
            const tgt = l.target as SankeyNode;
            return (
              <path
                key={`l-${src.id}-${tgt.id}-${i}`}
                d={linkPath(l) ?? ''}
                stroke={KIND_COLORS[src.kind]}
                strokeOpacity={0.25}
                strokeWidth={Math.max(1, l.width ?? 1)}
                onMouseEnter={(e) =>
                  onHover({
                    link: { source: src.id, target: tgt.id, value: l.value },
                    x: e.clientX,
                    y: e.clientY,
                  })
                }
                onMouseMove={(e) =>
                  onHover({
                    link: { source: src.id, target: tgt.id, value: l.value },
                    x: e.clientX,
                    y: e.clientY,
                  })
                }
                onMouseLeave={() => onHover(null)}
                onFocus={() => {
                  /* no-op; required for a11y if we add keyboard later */
                }}
              >
                <title>
                  {labelOf(src.id)} → {labelOf(tgt.id)} · {l.value}
                </title>
              </path>
            );
          })}
        </g>
        <g className="flows-nodes">
          {laidOut.nodes.map((n) => {
            const x0 = n.x0 ?? 0;
            const x1 = n.x1 ?? 0;
            const y0 = n.y0 ?? 0;
            const y1 = n.y1 ?? 0;
            const innerW = WIDTH - MARGIN.left - MARGIN.right;
            const labelLeft = x0 > innerW / 2;
            return (
              <g key={n.id}>
                <rect
                  x={x0}
                  y={y0}
                  width={Math.max(1, x1 - x0)}
                  height={Math.max(1, y1 - y0)}
                  fill={KIND_COLORS[n.kind]}
                  opacity={0.85}
                >
                  <title>
                    {n.label} (col {n.column}) · {n.value ?? 0}
                  </title>
                </rect>
                <text
                  x={labelLeft ? x0 - 6 : x1 + 6}
                  y={(y0 + y1) / 2}
                  dy="0.35em"
                  textAnchor={labelLeft ? 'end' : 'start'}
                  className="flows-node-label"
                  fontSize={10}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}
