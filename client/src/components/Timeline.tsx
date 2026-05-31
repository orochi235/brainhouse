/**
 * Event-timeline view. Plots every event (or every coalesced view-item)
 * along a vertical time axis: lanes are columns, time runs top↔bottom.
 * A horizontal mini chart at the top doubles as a range scrubber — it
 * always shows the full data range with a draggable window overlay that
 * drives the main chart's visible range.
 *
 * Self-contained: parent owns the container size (a lightbox, an inline
 * panel slot, eventually a top-level page). We size off ResizeObserver
 * so dropping `<Timeline>` into any sized box just works. No d3 — scales
 * are linear ts→px maps, and brush / zoom are native pointer + wheel
 * handlers.
 *
 * Data flow: parent passes `events: Event[]`. We derive view-items via
 * `preprocessEvents` once and toggle between them as the user picks a
 * granularity. Everything else is pure layout from there.
 */

import type { Event } from '@server/parser.ts';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewItemList } from './EventList.tsx';
import { ToolChip, ToolChips } from './ToolChips.tsx';
import { formatClockTime } from '../lib/format.ts';
import { type ViewItem, preprocessEvents } from '../lib/pipeline.ts';
import { iconForTool, summarizeTool } from '../lib/tools.ts';

type Granularity = 'events' | 'items';
/** Vertical time direction. `asc` = oldest at top (matches conversation
 * scroll); `desc` = newest at top (reverse-chron log). */
type Direction = 'asc' | 'desc';

interface Mark {
  /** Unique id per mark — uuid for events, anchorUuid for items, or a
   * fallback. Used for hover/select state. */
  id: string;
  /** Lane key — drives both color and lane column. */
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
 * Ordering here drives the lane column order (left to right). */
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
  const [direction, setDirection] = useState<Direction>('asc');

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
      // Single point: pad ±30s so it doesn't collapse to zero size.
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

  const setClampedView = useCallback(
    (v: [number, number]) => setView(clampView(v, dataRange)),
    [dataRange],
  );

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
        <ToolChips>
          <ToolChip
            aria-pressed={direction === 'asc'}
            onClick={() => setDirection('asc')}
            title="Oldest at top, newest at bottom"
          >
            ↓ oldest→newest
          </ToolChip>
          <ToolChip
            aria-pressed={direction === 'desc'}
            onClick={() => setDirection('desc')}
            title="Newest at top, oldest at bottom"
          >
            ↑ newest→oldest
          </ToolChip>
        </ToolChips>
        <span className="timeline-range">
          {formatClockTime(new Date(view[0]).toISOString())} —{' '}
          {formatClockTime(new Date(view[1]).toISOString())}
          <span className="timeline-range-aux"> · {marks.length} total</span>
        </span>
        <ToolChips>
          <ToolChip
            onClick={() => zoomBy(view, setClampedView, 0.5)}
            title="Zoom out"
          >
            −
          </ToolChip>
          <ToolChip
            onClick={() => zoomBy(view, setClampedView, 2)}
            title="Zoom in"
          >
            +
          </ToolChip>
          <ToolChip onClick={resetView} title="Reset zoom + clear brush">
            ⟲
          </ToolChip>
        </ToolChips>
      </div>
      <ScrubberChart
        marks={marks}
        lanes={lanesPresent}
        dataRange={dataRange}
        view={view}
        setView={setClampedView}
      />
      <VerticalChart
        marks={marks}
        lanes={lanesPresent}
        sources={sources}
        view={view}
        setView={setClampedView}
        direction={direction}
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
            brush a range. Scroll-wheel zooms. Drag the window on the strip above to pan.
          </p>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Scrubber: horizontal mini chart spanning the full data range, with a
// draggable+resizable window overlay representing the main chart's view.
// ----------------------------------------------------------------------

const SCRUB_HEIGHT = 64;
const SCRUB_LANE_W_MIN = 4;
const SCRUB_LANE_W_MAX = 10;
const SCRUB_HANDLE_W = 6;

function ScrubberChart({
  marks,
  lanes,
  dataRange,
  view,
  setView,
}: {
  marks: Mark[];
  lanes: { key: string; label: string }[];
  dataRange: [number, number];
  view: [number, number];
  setView: (v: [number, number]) => void;
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

  const SIDE_PAD = 8;
  const chartLeft = SIDE_PAD;
  const chartWidth = Math.max(40, width - SIDE_PAD * 2);
  const laneH = Math.max(
    SCRUB_LANE_W_MIN,
    Math.min(SCRUB_LANE_W_MAX, Math.floor((SCRUB_HEIGHT - 12) / Math.max(1, lanes.length))),
  );
  const lanesH = laneH * lanes.length;
  const lanesTop = Math.floor((SCRUB_HEIGHT - lanesH) / 2);

  const [dLo, dHi] = dataRange;
  const tToX = useCallback(
    (t: number) => chartLeft + ((t - dLo) / (dHi - dLo || 1)) * chartWidth,
    [chartLeft, chartWidth, dLo, dHi],
  );
  const xToT = useCallback(
    (x: number) => dLo + ((x - chartLeft) / chartWidth) * (dHi - dLo),
    [chartLeft, chartWidth, dLo, dHi],
  );

  const laneY = useCallback(
    (key: string) => {
      const i = lanes.findIndex((l) => l.key === key);
      return i < 0 ? lanesTop : lanesTop + i * laneH + laneH / 2;
    },
    [lanes, lanesTop, laneH],
  );

  const winX = tToX(view[0]);
  const winW = Math.max(2, tToX(view[1]) - winX);

  // Drag modes: pan moves the window, resize-l/r drags an edge, jump
  // recentres on a click outside the window.
  type DragMode = 'pan' | 'resize-l' | 'resize-r' | 'jump';
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startView: [number, number];
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    let mode: DragMode = 'jump';
    if (x >= winX - SCRUB_HANDLE_W && x <= winX + SCRUB_HANDLE_W) mode = 'resize-l';
    else if (x >= winX + winW - SCRUB_HANDLE_W && x <= winX + winW + SCRUB_HANDLE_W)
      mode = 'resize-r';
    else if (x > winX && x < winX + winW) mode = 'pan';
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: x, startView: view };
    if (mode === 'jump') {
      // Centre the window on the click point.
      const span = view[1] - view[0];
      const t = xToT(x);
      setView([t - span / 2, t + span / 2]);
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dx = x - drag.startX;
    const dt = (dx / chartWidth) * (dHi - dLo);
    const [sLo, sHi] = drag.startView;
    if (drag.mode === 'pan' || drag.mode === 'jump') {
      setView([sLo + dt, sHi + dt]);
    } else if (drag.mode === 'resize-l') {
      setView([Math.min(sLo + dt, sHi - 500), sHi]);
    } else if (drag.mode === 'resize-r') {
      setView([sLo, Math.max(sHi + dt, sLo + 500)]);
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const cursorFor = (x: number): string => {
    if (x >= winX - SCRUB_HANDLE_W && x <= winX + SCRUB_HANDLE_W) return 'ew-resize';
    if (x >= winX + winW - SCRUB_HANDLE_W && x <= winX + winW + SCRUB_HANDLE_W) return 'ew-resize';
    if (x > winX && x < winX + winW) return 'grab';
    return 'pointer';
  };
  const [hoverCursor, setHoverCursor] = useState<string>('pointer');
  const onPointerHover = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    setHoverCursor(cursorFor(e.clientX - rect.left));
  };

  return (
    <div className="timeline-scrubber" ref={containerRef}>
      <svg
        width={width}
        height={SCRUB_HEIGHT}
        className="timeline-svg"
        style={{ cursor: hoverCursor }}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          onPointerMove(e);
          onPointerHover(e);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <title>timeline scrubber</title>
        {/* Lane rules */}
        {lanes.map((l) => (
          <line
            key={l.key}
            x1={chartLeft}
            x2={chartLeft + chartWidth}
            y1={laneY(l.key)}
            y2={laneY(l.key)}
            className="timeline-lane-rule"
          />
        ))}
        {/* Marks — small ticks in their lane row */}
        {marks.map((m) => {
          const x = tToX(m.t);
          if (x < chartLeft - 1 || x > chartLeft + chartWidth + 1) return null;
          const y = laneY(m.lane);
          return (
            <rect
              key={m.id}
              x={x - 1}
              y={y - Math.max(2, laneH / 2 - 1)}
              width={2}
              height={Math.max(4, laneH - 2)}
              className="timeline-mark timeline-scrubber-mark"
              data-lane={m.lane}
            />
          );
        })}
        {/* Window overlay */}
        <rect
          x={winX}
          y={0}
          width={winW}
          height={SCRUB_HEIGHT}
          className="timeline-scrubber-window"
          pointerEvents="none"
        />
        {/* Window edge handles (visual) */}
        <rect
          x={winX - 1}
          y={0}
          width={2}
          height={SCRUB_HEIGHT}
          className="timeline-scrubber-handle"
          pointerEvents="none"
        />
        <rect
          x={winX + winW - 1}
          y={0}
          width={2}
          height={SCRUB_HEIGHT}
          className="timeline-scrubber-handle"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

// ----------------------------------------------------------------------
// VerticalChart: lanes as columns, time on Y-axis. Direction toggles
// whether the top of the chart is the oldest or newest moment in `view`.
// ----------------------------------------------------------------------

function VerticalChart({
  marks,
  lanes,
  sources,
  view,
  setView,
  direction,
  selectionRange,
  setSelectionRange,
  selectedId,
  setSelectedId,
  hoveredId,
  setHoveredId,
}: {
  marks: Mark[];
  lanes: { key: string; label: string }[];
  sources: Map<string, MarkSource>;
  view: [number, number];
  setView: (v: [number, number]) => void;
  direction: Direction;
  selectionRange: [number, number] | null;
  setSelectionRange: (r: [number, number] | null) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 480,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: Math.max(120, entry.contentRect.width),
        height: Math.max(200, entry.contentRect.height),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const LEFT_AXIS_W = 64;
  const TOP_PAD = 24;
  const BOTTOM_PAD = 12;
  const RIGHT_PAD = 8;
  const chartTop = TOP_PAD;
  const chartHeight = Math.max(80, size.height - TOP_PAD - BOTTOM_PAD);
  const chartLeft = LEFT_AXIS_W;
  const usableW = Math.max(80, size.width - LEFT_AXIS_W - RIGHT_PAD);
  // Lane columns: divide usable width evenly, with a cap.
  const laneW = Math.min(140, Math.max(48, Math.floor(usableW / Math.max(1, lanes.length))));
  const chartWidth = laneW * lanes.length;
  const totalHeight = TOP_PAD + chartHeight + BOTTOM_PAD;

  const [vLo, vHi] = view;
  // y maps a timestamp to a Y coordinate based on direction.
  const tToY = useCallback(
    (t: number) => {
      const frac = (t - vLo) / (vHi - vLo || 1);
      const f = direction === 'asc' ? frac : 1 - frac;
      return chartTop + f * chartHeight;
    },
    [chartTop, chartHeight, vLo, vHi, direction],
  );
  const yToT = useCallback(
    (y: number) => {
      const f = (y - chartTop) / chartHeight;
      const frac = direction === 'asc' ? f : 1 - f;
      return vLo + frac * (vHi - vLo);
    },
    [chartTop, chartHeight, vLo, vHi, direction],
  );

  const laneX = useCallback(
    (key: string) => {
      const i = lanes.findIndex((l) => l.key === key);
      return i < 0 ? chartLeft : chartLeft + i * laneW + laneW / 2;
    },
    [lanes, chartLeft, laneW],
  );

  // ---- pointer interaction (brush + click + hover) ----
  const dragRef = useRef<{ startY: number; startT: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < chartTop || y > chartTop + chartHeight) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: y, startT: yToT(y), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const y = Math.max(chartTop, Math.min(chartTop + chartHeight, e.clientY - rect.top));
    const t = yToT(y);
    if (Math.abs(y - drag.startY) > 3) drag.moved = true;
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
    if (!drag.moved) {
      setSelectionRange(null);
      setSelectedId(null);
    }
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < chartTop || y > chartTop + chartHeight) return;
    const pivot = yToT(y);
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const newLo = pivot - (pivot - vLo) * factor;
    const newHi = pivot + (vHi - pivot) * factor;
    setView([newLo, newHi]);
  };

  // Marks outside the visible range are skipped.
  const visibleMarks = useMemo(
    () => marks.filter((m) => m.t >= vLo && m.t <= vHi),
    [marks, vLo, vHi],
  );

  // Per-lane Y displacement so capsules don't overlap. Approach:
  // *cluster-centered* placement. Per lane, sort marks by natural Y;
  // each mark starts as a singleton cluster centered on its natural
  // Y. Iteratively merge any two adjacent clusters whose visual spans
  // overlap, with the merged center = mean of the members' natural Ys
  // (weighting each item equally). Once no overlaps remain, lay each
  // cluster's members out symmetrically around the cluster center at
  // fixed step = capsule height + gap.
  //
  // Result: a clump of N events at roughly the same time spreads
  // evenly up *and* down from their mean natural position, rather
  // than cascading downward. Stable between frames (deterministic
  // order). Worst-case O(k²) per lane, but k (capsules per lane in
  // view) is small in practice.
  const CAP_H = 22;
  const CAP_GAP = 2;
  const placedY = useMemo(() => {
    const step = CAP_H + CAP_GAP;
    const halfStep = step / 2;
    const byLane = new Map<string, Array<{ id: string; naturalY: number }>>();
    for (const m of visibleMarks) {
      const arr = byLane.get(m.lane) ?? [];
      arr.push({ id: m.id, naturalY: tToY(m.t) });
      byLane.set(m.lane, arr);
    }
    const out = new Map<string, number>();
    type Cluster = { ids: string[]; natYs: number[]; centerY: number };
    for (const arr of byLane.values()) {
      arr.sort((a, b) => a.naturalY - b.naturalY);
      const clusters: Cluster[] = arr.map((m) => ({
        ids: [m.id],
        natYs: [m.naturalY],
        centerY: m.naturalY,
      }));
      // Merge overlapping clusters until stable. Each merge may create
      // a new overlap with the prior neighbor, so on merge we restart
      // the scan from the beginning. Bounded by total cluster count.
      let merged = true;
      while (merged) {
        merged = false;
        for (let i = 0; i < clusters.length - 1; i++) {
          const a = clusters[i];
          const b = clusters[i + 1];
          if (!a || !b) continue;
          const aBottom = a.centerY + a.ids.length * halfStep;
          const bTop = b.centerY - b.ids.length * halfStep;
          if (bTop < aBottom) {
            const natYs = [...a.natYs, ...b.natYs];
            const centerY = natYs.reduce((s, y) => s + y, 0) / natYs.length;
            clusters.splice(i, 2, {
              ids: [...a.ids, ...b.ids],
              natYs,
              centerY,
            });
            merged = true;
            break;
          }
        }
      }
      for (const c of clusters) {
        const startY = c.centerY - ((c.ids.length - 1) * step) / 2;
        c.ids.forEach((id, i) => out.set(id, startY + i * step));
      }
    }
    return out;
  }, [visibleMarks, tToY]);

  // Build Y-axis ticks. Aim for ~5–7 ticks across the chart.
  const ticks = useMemo(() => buildTicks(vLo, vHi, 6), [vLo, vHi]);

  // Selection rect in screen Y. Always draw lo↔hi (in time); convert.
  const selY0 = selectionRange ? Math.min(tToY(selectionRange[0]), tToY(selectionRange[1])) : 0;
  const selY1 = selectionRange ? Math.max(tToY(selectionRange[0]), tToY(selectionRange[1])) : 0;

  return (
    <div className="timeline-chart timeline-chart-vertical" ref={containerRef}>
      <svg
        width={size.width}
        height={totalHeight}
        className="timeline-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <title>event timeline</title>

        {/* Lane column headers + vertical guides */}
        {lanes.map((l) => (
          <g key={l.key} className="timeline-lane" data-lane={l.key}>
            <text
              x={laneX(l.key)}
              y={TOP_PAD - 8}
              textAnchor="middle"
              dominantBaseline="alphabetic"
              className="timeline-lane-label"
            >
              {l.label}
            </text>
            <line
              x1={laneX(l.key)}
              x2={laneX(l.key)}
              y1={chartTop}
              y2={chartTop + chartHeight}
              className="timeline-lane-rule"
            />
          </g>
        ))}

        {/* Selection band (drawn under marks) */}
        {selectionRange && (
          <rect
            x={chartLeft}
            y={selY0}
            width={chartWidth}
            height={Math.max(1, selY1 - selY0)}
            className="timeline-selection"
          />
        )}

        {/* Marks — rendered as HTML capsules via foreignObject so they
         * pick up the same visual language as ToolCapsule. Width is the
         * lane column width minus a small inset; height is fixed. The
         * Y comes from `placedY` (above), which has already applied
         * per-lane push-down so capsules don't overlap. */}
        {(() => {
          const capW = Math.max(40, laneW - 6);
          const capH = CAP_H;
          return visibleMarks.map((m) => {
            const x = laneX(m.lane);
            const y = placedY.get(m.id) ?? tToY(m.t);
            const isSel = selectedId === m.id;
            const isHov = hoveredId === m.id;
            const desc = describeMark(m, sources.get(m.id));
            return (
              <foreignObject
                key={m.id}
                x={x - capW / 2}
                y={y - capH / 2}
                width={capW}
                height={capH}
                className="timeline-capsule-host"
              >
                <div
                  className="timeline-capsule"
                  data-lane={m.lane}
                  data-status={desc.status ?? ''}
                  data-state={isSel ? 'selected' : isHov ? 'hovered' : ''}
                  title={`${desc.label} · ${formatClockTime(new Date(m.t).toISOString())}`}
                  onPointerEnter={() => setHoveredId(m.id)}
                  onPointerLeave={() => setHoveredId(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(m.id);
                    setSelectionRange(null);
                  }}
                >
                  <span className="timeline-capsule-icon">{desc.icon}</span>
                  <span className="timeline-capsule-label">{desc.label}</span>
                  {desc.status && (
                    <span
                      className={`timeline-capsule-status status-${desc.status}`}
                      aria-label={desc.status}
                    >
                      {desc.status === 'ok' ? '✓' : desc.status === 'error' ? '✗' : ''}
                    </span>
                  )}
                </div>
              </foreignObject>
            );
          });
        })()}

        {/* Y axis */}
        <g className="timeline-axis">
          <line
            x1={chartLeft - 4}
            x2={chartLeft - 4}
            y1={chartTop}
            y2={chartTop + chartHeight}
            className="timeline-axis-rule"
          />
          {ticks.map((t) => {
            const y = tToY(t);
            if (y < chartTop - 1 || y > chartTop + chartHeight + 1) return null;
            return (
              <g key={t} transform={`translate(${chartLeft - 6}, ${y})`}>
                <line x2={4} className="timeline-axis-tick" />
                <text
                  x={-4}
                  dominantBaseline="central"
                  textAnchor="end"
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

/** Per-mark visual descriptor for the capsule rendering. Branches on the
 * underlying source — tools reuse `iconForTool` + `summarizeTool` so they
 * match the inline `ToolCapsule`; other kinds fall back to a glyph + the
 * mark's own label. Heavy customization (per-kind icons, richer labels)
 * lands here as the timeline grows. */
function describeMark(
  m: Mark,
  src: MarkSource | undefined,
): { icon: ReactNode; label: string; status?: 'ok' | 'error' | 'pending' } {
  if (src?.kind === 'item') {
    const it = src.item;
    if (it.type === 'tool') {
      const use = it.use ?? { tool_use_id: '', name: 'output', input: {} };
      const result = it.result;
      const status = result ? (result.is_error ? 'error' : 'ok') : 'pending';
      const icon = iconForTool(use.name, use.input);
      return {
        icon:
          icon.kind === 'svg' ? (
            <span
              className="svg-glyph"
              aria-hidden="true"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
              dangerouslySetInnerHTML={{ __html: icon.svg }}
            />
          ) : (
            icon.text
          ),
        label: summarizeTool(use, result),
        status,
      };
    }
    if (it.type === 'bubble') {
      return {
        icon: it.role === 'user' ? '👤' : '🤖',
        label: it.role,
      };
    }
    if (it.type === 'thinking') return { icon: '💭', label: 'thinking' };
    if (it.type === 'file-change') return { icon: '📝', label: it.path };
    if (it.type === 'op-strip') return { icon: '⋯', label: `${it.items.length} ops` };
    if (it.type === 'day-divider') return { icon: '📅', label: it.label };
    if (it.type === 'interrupt-divider') return { icon: '⏸', label: 'interrupt' };
    if (it.type === 'cleared') return { icon: '⊘', label: 'cleared' };
    if (it.type === 'system') return { icon: '⚙', label: 'system' };
    if (it.type === 'meta') return { icon: 'ℹ', label: 'meta' };
  }
  if (src?.kind === 'event') {
    const e = src.event;
    return { icon: eventKindGlyph(e.kind), label: e.kind };
  }
  return { icon: '●', label: m.label };
}

function eventKindGlyph(kind: Event['kind']): string {
  switch (kind) {
    case 'user_text':
      return '👤';
    case 'assistant_text':
      return '🤖';
    case 'thinking':
      return '💭';
    case 'tool_use':
      return '⚙';
    case 'tool_result':
      return '↩';
    case 'resource_usage':
      return '∑';
    case 'system':
      return '⚙';
    case 'meta':
      return 'ℹ';
    default:
      return '●';
  }
}

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? null : n;
}

function zoomBy(
  view: [number, number],
  setView: (v: [number, number]) => void,
  factor: number,
): void {
  const mid = (view[0] + view[1]) / 2;
  const halfWidth = ((view[1] - view[0]) / 2) * (1 / factor);
  setView([mid - halfWidth, mid + halfWidth]);
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
