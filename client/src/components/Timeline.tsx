/**
 * Event-timeline view. Plots every event (or every coalesced view-item)
 * along a horizontal time axis. Each kind gets its own lane and color;
 * hover surfaces a tooltip, click drills into a detail pane, drag on
 * the axis brushes a range, wheel zooms around the cursor.
 *
 * Self-contained: parent owns the container size (a lightbox, an inline
 * panel slot, eventually a top-level page). We size off ResizeObserver
 * so dropping `<Timeline>` into any sized box just works. No d3 — the
 * scale is a linear ts→x map (literally two divisions), and brush /
 * zoom are native pointer + wheel handlers.
 *
 * Data flow: parent passes `events: Event[]`. We derive view-items via
 * `preprocessEvents` once and toggle between them as the user picks a
 * granularity. Everything else is pure layout from there.
 */

import type { Event } from '@server/parser.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewItemList } from './EventList.tsx';
import { ToolChip, ToolChips } from './ToolChips.tsx';
import { formatClockTime } from '../lib/format.ts';
import { type ViewItem, preprocessEvents } from '../lib/pipeline.ts';

type Granularity = 'events' | 'items';

interface Mark {
  /** Unique id per mark — uuid for events, anchorUuid for items, or a
   * fallback. Used for hover/select state. */
  id: string;
  /** Lane key — drives both color and y-position. */
  lane: string;
  /** Display label for the tooltip. */
  label: string;
  /** Wall-clock ms since epoch. */
  t: number;
}

interface MarkSourceEvent {
  kind: 'event';
  event: Event;
}
interface MarkSourceItem {
  kind: 'item';
  item: ViewItem;
}
type MarkSource = MarkSourceEvent | MarkSourceItem;

/** Lane palette — keep in sync with `.timeline-lane[data-lane]` in CSS.
 * Ordering here drives the vertical lane stack (top to bottom). */
const EVENT_LANES: { key: Event['kind']; label: string }[] = [
  { key: 'user_text', label: 'user' },
  { key: 'assistant_text', label: 'assistant' },
  { key: 'thinking', label: 'thinking' },
  { key: 'tool_use', label: 'tool use' },
  { key: 'tool_result', label: 'tool result' },
  { key: 'resource_usage', label: 'tokens' },
  { key: 'system', label: 'system' },
  { key: 'meta', label: 'meta' },
];

const ITEM_LANES: { key: ViewItem['type']; label: string }[] = [
  { key: 'bubble', label: 'bubble' },
  { key: 'thinking', label: 'thinking' },
  { key: 'tool', label: 'tool' },
  { key: 'file-change', label: 'file change' },
  { key: 'op-strip', label: 'op strip' },
  { key: 'cleared', label: 'cleared' },
  { key: 'interrupt-divider', label: 'interrupt' },
  { key: 'day-divider', label: 'day' },
  { key: 'system', label: 'system' },
  { key: 'meta', label: 'meta' },
];

export interface TimelineProps {
  events: Event[];
  startedAt?: number;
  /** When provided, the parent has already done the pipeline pass — use
   * its view-items rather than re-running. Cheap optimization for the
   * lightbox tab inside OpStripLightbox. */
  precomputedItems?: ViewItem[];
}

export function Timeline({ events, startedAt, precomputedItems }: TimelineProps) {
  // When the host has only view-items (e.g. an op-strip), default to the
  // matching granularity so the chart isn't empty on first render.
  const [granularity, setGranularity] = useState<Granularity>(
    events.length === 0 && precomputedItems && precomputedItems.length > 0 ? 'items' : 'events',
  );
  const items = useMemo<ViewItem[]>(() => {
    if (precomputedItems) return precomputedItems;
    return preprocessEvents(events).items;
  }, [events, precomputedItems]);

  const marks = useMemo(
    () => (granularity === 'events' ? eventMarks(events) : itemMarks(items)),
    [granularity, events, items],
  );
  const sources = useMemo(
    () => (granularity === 'events' ? eventSources(events) : itemSources(items)),
    [granularity, events, items],
  );

  const dataRange = useMemo<[number, number]>(() => {
    if (marks.length === 0) {
      const now = Date.now();
      return [now - 60_000, now];
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of marks) {
      if (m.t < lo) lo = m.t;
      if (m.t > hi) hi = m.t;
    }
    if (lo === hi) {
      // Single point: pad ±30s so it doesn't collapse to zero width.
      return [lo - 30_000, hi + 30_000];
    }
    return [lo, hi];
  }, [marks]);

  const [view, setView] = useState<[number, number]>(dataRange);
  // Re-anchor the view when the data range shifts (granularity flip or
  // new events arriving), but only when the user hasn't custom-zoomed.
  // We treat "view === previous dataRange" as the untouched state.
  const prevRangeRef = useRef(dataRange);
  useEffect(() => {
    const [pLo, pHi] = prevRangeRef.current;
    const untouched = view[0] === pLo && view[1] === pHi;
    prevRangeRef.current = dataRange;
    if (untouched) setView(dataRange);
  }, [dataRange, view]);

  const [selectionRange, setSelectionRange] = useState<[number, number] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const lanes = granularity === 'events' ? EVENT_LANES : ITEM_LANES;
  const lanesPresent = useMemo(() => {
    const seen = new Set(marks.map((m) => m.lane));
    return lanes.filter((l) => seen.has(l.key));
  }, [marks, lanes]);

  const resetView = useCallback(() => {
    setView(dataRange);
    setSelectionRange(null);
  }, [dataRange]);

  const selectedSource = useMemo(() => {
    if (!selectedId) return null;
    return sources.get(selectedId) ?? null;
  }, [selectedId, sources]);

  const inSelection = useMemo<ViewItem[] | null>(() => {
    if (!selectionRange) return null;
    const [lo, hi] = selectionRange;
    return items.filter((it) => {
      const t = itemTime(it);
      return t !== null && t >= lo && t <= hi;
    });
  }, [items, selectionRange]);

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <ToolChips>
          <ToolChip
            aria-pressed={granularity === 'events'}
            onClick={() => setGranularity('events')}
            title="Show every parsed event"
          >
            Events
          </ToolChip>
          <ToolChip
            aria-pressed={granularity === 'items'}
            onClick={() => setGranularity('items')}
            title="Show coalesced view-items (matches the conversation view)"
          >
            Items
          </ToolChip>
        </ToolChips>
        <span className="timeline-range">
          {formatClockTime(new Date(view[0]).toISOString())} —{' '}
          {formatClockTime(new Date(view[1]).toISOString())}
          <span className="timeline-range-aux"> · {marks.length} total</span>
        </span>
        <ToolChips>
          <ToolChip onClick={() => zoomBy(view, setView, dataRange, 0.5)} title="Zoom out">
            −
          </ToolChip>
          <ToolChip onClick={() => zoomBy(view, setView, dataRange, 2)} title="Zoom in">
            +
          </ToolChip>
          <ToolChip onClick={resetView} title="Reset zoom + clear brush">
            ⟲
          </ToolChip>
        </ToolChips>
      </div>
      <TimelineChart
        marks={marks}
        lanes={lanesPresent}
        view={view}
        setView={setView}
        dataRange={dataRange}
        selectionRange={selectionRange}
        setSelectionRange={setSelectionRange}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        hoveredId={hoveredId}
        setHoveredId={setHoveredId}
      />
      <div className="timeline-detail">
        {selectedSource ? (
          <DetailPane source={selectedSource} startedAt={startedAt} />
        ) : selectionRange && inSelection ? (
          <RangePane items={inSelection} startedAt={startedAt} range={selectionRange} />
        ) : (
          <p className="timeline-empty">
            Hover a mark to see its summary. Click to drill in. Drag the chart background to
            brush a range. Scroll-wheel zooms.
          </p>
        )}
      </div>
    </div>
  );
}

function TimelineChart({
  marks,
  lanes,
  view,
  setView,
  dataRange,
  selectionRange,
  setSelectionRange,
  selectedId,
  setSelectedId,
  hoveredId,
  setHoveredId,
}: {
  marks: Mark[];
  lanes: { key: string; label: string }[];
  view: [number, number];
  setView: (v: [number, number]) => void;
  dataRange: [number, number];
  selectionRange: [number, number] | null;
  setSelectionRange: (r: [number, number] | null) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(120, entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const LANE_LABEL_W = 96;
  const LANE_H = 18;
  const TOP_PAD = 8;
  const BOTTOM_PAD = 32;
  const chartLeft = LANE_LABEL_W;
  const chartWidth = Math.max(40, width - chartLeft - 8);
  const chartHeight = lanes.length * LANE_H;
  const totalHeight = TOP_PAD + chartHeight + BOTTOM_PAD;

  const [vLo, vHi] = view;
  const tToX = useCallback(
    (t: number) => chartLeft + ((t - vLo) / (vHi - vLo || 1)) * chartWidth,
    [chartLeft, chartWidth, vLo, vHi],
  );
  const xToT = useCallback(
    (x: number) => vLo + ((x - chartLeft) / chartWidth) * (vHi - vLo),
    [chartLeft, chartWidth, vLo, vHi],
  );

  const laneY = useCallback(
    (key: string) => {
      const i = lanes.findIndex((l) => l.key === key);
      return i < 0 ? TOP_PAD : TOP_PAD + i * LANE_H + LANE_H / 2;
    },
    [lanes],
  );

  // ---- pointer interaction (brush + click + hover) ----
  const dragRef = useRef<{ startX: number; startT: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < chartLeft) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: x, startT: xToT(x), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = Math.max(chartLeft, Math.min(width, e.clientX - rect.left));
    const t = xToT(x);
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    if (drag.moved) {
      const lo = Math.min(drag.startT, t);
      const hi = Math.max(drag.startT, t);
      setSelectionRange([lo, hi]);
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!drag) return;
    // A non-drag click on background clears selection.
    if (!drag.moved) {
      setSelectionRange(null);
      setSelectedId(null);
    }
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < chartLeft) return;
    const pivot = xToT(x);
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const newLo = pivot - (pivot - vLo) * factor;
    const newHi = pivot + (vHi - pivot) * factor;
    setView(clampView([newLo, newHi], dataRange));
  };

  // Marks larger than the visible range are skipped.
  const visibleMarks = useMemo(
    () => marks.filter((m) => m.t >= vLo && m.t <= vHi),
    [marks, vLo, vHi],
  );

  // Build axis ticks. Aim for ~5–7 ticks across the chart.
  const ticks = useMemo(() => buildTicks(vLo, vHi, 6), [vLo, vHi]);

  return (
    <div className="timeline-chart" ref={containerRef}>
      <svg
        width={width}
        height={totalHeight}
        className="timeline-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <title>event timeline</title>
        {/* Lane labels + horizontal guides */}
        {lanes.map((l) => (
          <g key={l.key} className="timeline-lane" data-lane={l.key}>
            <text
              x={chartLeft - 8}
              y={laneY(l.key)}
              textAnchor="end"
              dominantBaseline="central"
              className="timeline-lane-label"
            >
              {l.label}
            </text>
            <line
              x1={chartLeft}
              x2={chartLeft + chartWidth}
              y1={laneY(l.key)}
              y2={laneY(l.key)}
              className="timeline-lane-rule"
            />
          </g>
        ))}

        {/* Selection band (drawn under marks) */}
        {selectionRange && (
          <rect
            x={tToX(selectionRange[0])}
            y={TOP_PAD}
            width={Math.max(1, tToX(selectionRange[1]) - tToX(selectionRange[0]))}
            height={chartHeight}
            className="timeline-selection"
          />
        )}

        {/* Marks */}
        {visibleMarks.map((m) => {
          const x = tToX(m.t);
          const y = laneY(m.lane);
          const isSel = selectedId === m.id;
          const isHov = hoveredId === m.id;
          return (
            <rect
              key={m.id}
              x={x - 3}
              y={y - 6}
              width={6}
              height={12}
              rx={1.5}
              className="timeline-mark"
              data-lane={m.lane}
              data-state={isSel ? 'selected' : isHov ? 'hovered' : undefined}
              onPointerEnter={() => setHoveredId(m.id)}
              onPointerLeave={() => setHoveredId(null)}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedId(m.id);
                setSelectionRange(null);
              }}
            >
              <title>{`${m.label} · ${formatClockTime(new Date(m.t).toISOString())}`}</title>
            </rect>
          );
        })}

        {/* X axis */}
        <g className="timeline-axis">
          <line
            x1={chartLeft}
            x2={chartLeft + chartWidth}
            y1={TOP_PAD + chartHeight + 4}
            y2={TOP_PAD + chartHeight + 4}
            className="timeline-axis-rule"
          />
          {ticks.map((t) => {
            const x = tToX(t);
            if (x < chartLeft - 1 || x > chartLeft + chartWidth + 1) return null;
            return (
              <g key={t} transform={`translate(${x}, ${TOP_PAD + chartHeight + 6})`}>
                <line y2={4} className="timeline-axis-tick" />
                <text
                  y={16}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  className="timeline-axis-label"
                >
                  {formatClockTime(new Date(t).toISOString())}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function DetailPane({ source, startedAt }: { source: MarkSource; startedAt?: number }) {
  if (source.kind === 'event') {
    const ev = source.event;
    return (
      <div className="timeline-detail-pane">
        <h4 className="timeline-detail-title">
          {ev.kind}
          <span className="timeline-detail-ts">
            {formatClockTime(ev.ts)} · {ev.uuid.slice(0, 8)}
          </span>
        </h4>
        <pre className="timeline-detail-body">{JSON.stringify(ev.payload, null, 2)}</pre>
      </div>
    );
  }
  return (
    <div className="timeline-detail-pane">
      <h4 className="timeline-detail-title">{source.item.type}</h4>
      <ViewItemList items={[source.item]} startedAt={startedAt} />
    </div>
  );
}

function RangePane({
  items,
  startedAt,
  range,
}: {
  items: ViewItem[];
  startedAt?: number;
  range: [number, number];
}) {
  return (
    <div className="timeline-detail-pane">
      <h4 className="timeline-detail-title">
        Range
        <span className="timeline-detail-ts">
          {formatClockTime(new Date(range[0]).toISOString())} —{' '}
          {formatClockTime(new Date(range[1]).toISOString())} · {items.length} items
        </span>
      </h4>
      {items.length > 0 ? (
        <ViewItemList items={items} startedAt={startedAt} />
      ) : (
        <p className="timeline-empty">No items in this range.</p>
      )}
    </div>
  );
}

// ---- helpers ----

function eventMarks(events: Event[]): Mark[] {
  const out: Mark[] = [];
  for (const e of events) {
    const t = parseTs(e.ts);
    if (t === null) continue;
    out.push({ id: e.uuid, lane: e.kind, label: e.kind, t });
  }
  return out;
}

function eventSources(events: Event[]): Map<string, MarkSource> {
  const m = new Map<string, MarkSource>();
  for (const e of events) m.set(e.uuid, { kind: 'event', event: e });
  return m;
}

function itemMarks(items: ViewItem[]): Mark[] {
  const out: Mark[] = [];
  for (const it of items) {
    const t = itemTime(it);
    if (t === null) continue;
    out.push({ id: itemId(it), lane: it.type, label: itemLabel(it), t });
  }
  return out;
}

function itemSources(items: ViewItem[]): Map<string, MarkSource> {
  const m = new Map<string, MarkSource>();
  for (const it of items) m.set(itemId(it), { kind: 'item', item: it });
  return m;
}

function itemId(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.anchorUuid;
  }
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return item.anchorUuid;
  if (item.type === 'bubble') return item.event.uuid;
  return item.event.uuid;
}

function itemLabel(item: ViewItem): string {
  if (item.type === 'tool') return `tool ${item.use?.name ?? ''}`.trim();
  if (item.type === 'file-change') return `file ${item.path}`;
  if (item.type === 'op-strip') return `op-strip (${item.items.length})`;
  if (item.type === 'bubble') return `${item.role} bubble`;
  if (item.type === 'day-divider') return `day · ${item.label}`;
  if (item.type === 'interrupt-divider') return 'interrupt';
  return item.type;
}

function itemTime(item: ViewItem): number | null {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return parseTs(item.ts);
  }
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return parseTs(item.ts);
  if (item.type === 'bubble') return parseTs(item.event.ts);
  return parseTs(item.event.ts);
}

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? null : n;
}

function zoomBy(
  view: [number, number],
  setView: (v: [number, number]) => void,
  dataRange: [number, number],
  factor: number,
): void {
  const mid = (view[0] + view[1]) / 2;
  const halfWidth = ((view[1] - view[0]) / 2) * (1 / factor);
  setView(clampView([mid - halfWidth, mid + halfWidth], dataRange));
}

/** Keep the view inside the data range (with a tiny slack so the edge
 * marks stay visible). Also enforces a minimum window so a runaway zoom
 * doesn't collapse the axis. */
function clampView(view: [number, number], data: [number, number]): [number, number] {
  const [dLo, dHi] = data;
  const slack = Math.max(1000, (dHi - dLo) * 0.02);
  let [lo, hi] = view;
  const minWindow = 500; // 0.5s — anything smaller is useless
  if (hi - lo < minWindow) {
    const mid = (lo + hi) / 2;
    lo = mid - minWindow / 2;
    hi = mid + minWindow / 2;
  }
  if (lo < dLo - slack) {
    const w = hi - lo;
    lo = dLo - slack;
    hi = lo + w;
  }
  if (hi > dHi + slack) {
    const w = hi - lo;
    hi = dHi + slack;
    lo = hi - w;
  }
  return [lo, hi];
}

/** Pick ~targetCount round-number ticks across [lo, hi]. Step snaps to
 * a 1/2/5×10^k sequence so labels read cleanly. */
function buildTicks(lo: number, hi: number, targetCount: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const rawStep = span / targetCount;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let t = first; t <= hi; t += step) out.push(t);
  return out;
}
