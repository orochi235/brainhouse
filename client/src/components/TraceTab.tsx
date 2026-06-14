/**
 * Trace tab — Spec 3 of the transforms-inspector rebuild.
 *
 * Renders the most recent `PanelTrace` for `panelId`. On mount it
 * flips `setTracing(panelId, true)` so the next pipeline pass writes
 * a trace into the store; on unmount it flips back so the steady-state
 * runner cost goes back to zero.
 *
 * Self-contained today. When Spec 2's tabbed inspector lands, the
 * outer modal owns the tab framework and this file becomes the body
 * of Tab C without further changes; the toggle column on Tab B will
 * `useTransformToggles` directly.
 */

import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { VIEW_TRANSFORMS } from '../transforms/registry.ts';
import type { TraceRecord } from '../transforms/selectors/types.ts';
import { serializeDebugSnapshot, serializeDebugSnapshotJson } from '../transforms/snapshot.ts';
import { usePanelTrace, useTraceStore } from '../transforms/traceContext.tsx';
import { useTransformToggles } from '../transforms/useTransformToggles.ts';

interface TraceTabProps {
  panelId: string;
  events: Event[];
  /** Final view items after stage 2 — the same array the panel just
   * rendered. We pass it through so the "Resulting view items"
   * section can resolve `record.finalItemIndices` against it. */
  items: ViewItem[];
}

type StatusFilter = 'consumed' | 'errored' | 'noop' | 'not-matched';

interface RowStatus {
  kind: 'consumed' | 'noop' | 'errored' | 'unmatched';
  touchedBy: { key: string; consumed: boolean }[];
}

const STATUS_FILTERS: StatusFilter[] = ['consumed', 'errored', 'noop', 'not-matched'];

const STATUS_TOKEN: Record<RowStatus['kind'], StatusFilter> = {
  consumed: 'consumed',
  errored: 'errored',
  noop: 'noop',
  unmatched: 'not-matched',
};

function rowStatus(record: TraceRecord | undefined): RowStatus {
  if (!record) return { kind: 'unmatched', touchedBy: [] };
  const touched = record.perStage.filter((s) => s.ran);
  const errored = touched.some((s) => s.error);
  const consumed = touched.find((s) => s.consumed);
  const touchedBy = touched.map((s) => ({ key: s.transformKey, consumed: s.consumed }));
  if (errored) return { kind: 'errored', touchedBy };
  if (consumed) return { kind: 'consumed', touchedBy };
  if (touched.length > 0) return { kind: 'noop', touchedBy };
  return { kind: 'unmatched', touchedBy };
}

function previewText(event: Event): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload === 'object') {
    const candidate = payload.text ?? payload.content ?? payload.command;
    if (typeof candidate === 'string') return candidate.slice(0, 60);
  }
  try {
    return JSON.stringify(payload).slice(0, 60);
  } catch {
    return '';
  }
}

export function TraceTab({ panelId, events, items }: TraceTabProps) {
  const store = useTraceStore();
  const trace = usePanelTrace(panelId);
  const toggles = useTransformToggles(panelId);
  const [filterText, setFilterText] = useState('');
  const [transformFilter, setTransformFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<StatusFilter>>(new Set());
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [copyPill, setCopyPill] = useState<string | null>(null);
  const pillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracing on while mounted, off on unmount.
  useEffect(() => {
    store.setTracing(panelId, true);
    return () => {
      store.setTracing(panelId, false);
    };
  }, [store, panelId]);

  const recordByUuid = useMemo(() => {
    const m = new Map<string, TraceRecord>();
    if (trace) for (const r of trace.perEvent) m.set(r.eventUuid, r);
    return m;
  }, [trace]);

  const visibleEvents = useMemo(() => {
    const lowered = filterText.toLowerCase();
    return events
      .map((event, idx) => ({ event, idx }))
      .filter(({ event }) => {
        if (lowered) {
          const hay = `${event.kind} ${previewText(event)}`.toLowerCase();
          if (!hay.includes(lowered)) return false;
        }
        const rec = recordByUuid.get(event.uuid);
        const status = rowStatus(rec);
        if (transformFilter.size > 0) {
          const touchedKeys = new Set(status.touchedBy.map((t) => t.key));
          let any = false;
          for (const k of transformFilter) if (touchedKeys.has(k)) any = true;
          if (!any) return false;
        }
        if (statusFilter.size > 0 && !statusFilter.has(STATUS_TOKEN[status.kind])) {
          return false;
        }
        return true;
      });
  }, [events, filterText, transformFilter, statusFilter, recordByUuid]);

  const selectedEvent = useMemo(() => {
    if (!selectedUuid) return null;
    return events.find((e) => e.uuid === selectedUuid) ?? null;
  }, [events, selectedUuid]);
  const selectedRecord = selectedUuid ? recordByUuid.get(selectedUuid) : undefined;
  const selectedIndex = selectedEvent ? events.indexOf(selectedEvent) : -1;

  const toggleTransformFilter = (key: string) => {
    setTransformFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleStatusFilter = (s: StatusFilter) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const showCopiedPill = (label: string) => {
    setCopyPill(label);
    if (pillTimerRef.current) clearTimeout(pillTimerRef.current);
    pillTimerRef.current = setTimeout(() => setCopyPill(null), 1500);
  };

  const copySnapshot = (asJson: boolean) => {
    if (!selectedEvent || !selectedRecord || !trace) return;
    const input = {
      panelId,
      event: selectedEvent,
      eventIndex: selectedIndex,
      eventTotal: events.length,
      capturedAt: new Date(),
      record: selectedRecord,
      stage2: trace.stage2,
      items,
      toggles: toggles.all,
    };
    const text = asJson ? serializeDebugSnapshotJson(input) : serializeDebugSnapshot(input);
    void navigator.clipboard.writeText(text);
    showCopiedPill(asJson ? 'copied JSON' : 'copied Markdown');
  };

  // Stage-2 transforms run once per pass, not per event, so they never
  // appear in a row's touchedBy — offering them as row filters would
  // only ever produce an empty list.
  const transformKeys = useMemo(
    () => VIEW_TRANSFORMS.filter((t) => t.stage === 1).map((t) => t.key),
    [],
  );

  const filterCounts = useMemo(() => {
    const status: Record<StatusFilter, number> = {
      consumed: 0,
      errored: 0,
      noop: 0,
      'not-matched': 0,
    };
    const byTransform = new Map<string, number>();
    for (const event of events) {
      const st = rowStatus(recordByUuid.get(event.uuid));
      status[STATUS_TOKEN[st.kind]] += 1;
      for (const t of st.touchedBy) {
        byTransform.set(t.key, (byTransform.get(t.key) ?? 0) + 1);
      }
    }
    return { status, byTransform };
  }, [events, recordByUuid]);

  return (
    <div className="trace-tab">
      <div className="trace-filter-bar">
        <input
          type="text"
          className="trace-filter-text"
          placeholder="filter by preview…"
          value={filterText}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setFilterText(e.target.value)}
        />
        <div className="trace-filter-status">
          {STATUS_FILTERS.map((s) => (
            <label key={s} className="trace-filter-chip">
              <input
                type="checkbox"
                checked={statusFilter.has(s)}
                onChange={() => toggleStatusFilter(s)}
              />
              <span>{s}</span>
              <span className="trace-filter-count">{filterCounts.status[s]}</span>
            </label>
          ))}
        </div>
        <details className="trace-filter-transforms">
          <summary>transforms ({transformFilter.size || 'all'})</summary>
          <div className="trace-filter-transforms-list">
            {transformKeys.map((k) => (
              <label key={k} className="trace-filter-chip">
                <input
                  type="checkbox"
                  checked={transformFilter.has(k)}
                  onChange={() => toggleTransformFilter(k)}
                />
                <span>{k}</span>
                <span className="trace-filter-count">{filterCounts.byTransform.get(k) ?? 0}</span>
              </label>
            ))}
          </div>
        </details>
        {(filterText || transformFilter.size > 0 || statusFilter.size > 0) && (
          <button
            type="button"
            className="trace-filter-clear"
            onClick={() => {
              setFilterText('');
              setTransformFilter(new Set());
              setStatusFilter(new Set());
            }}
          >
            clear filters
          </button>
        )}
      </div>

      <div className="trace-panes">
        <ul className="trace-event-list">
          {visibleEvents.length === 0 && (
            <li className="trace-empty">
              {events.length === 0
                ? 'Nothing to trace yet — this panel has no events.'
                : 'No events match the active filters.'}
            </li>
          )}
          {visibleEvents.map(({ event, idx }) => {
            const status = rowStatus(recordByUuid.get(event.uuid));
            return (
              <li
                key={event.uuid}
                className={classNames(
                  'trace-row',
                  selectedUuid === event.uuid && 'is-selected',
                  status.kind === 'errored' && 'is-errored',
                  status.kind === 'consumed' && 'is-consumed',
                  status.kind === 'noop' && 'is-noop',
                  status.kind === 'unmatched' && 'is-unmatched',
                )}
                onClick={() => setSelectedUuid(event.uuid)}
              >
                <span className="trace-row-index">{idx}</span>
                <span className="trace-row-kind">{event.kind}</span>
                <span className="trace-row-preview">{previewText(event)}</span>
                <span className="trace-row-touched">
                  {status.touchedBy.map((t) => (
                    <span
                      key={t.key}
                      className={classNames('trace-touched-chip', !t.consumed && 'is-dim')}
                    >
                      {t.key}
                    </span>
                  ))}
                </span>
                <span
                  className={classNames('trace-status-dot', `is-${status.kind}`)}
                  aria-label={`status: ${status.kind}`}
                />
              </li>
            );
          })}
        </ul>

        <div className="trace-detail-pane">
          {!selectedEvent && (
            <p className="trace-detail-empty">Select an event to see its per-stage trace.</p>
          )}
          {selectedEvent && (
            <DetailPane
              event={selectedEvent}
              eventIndex={selectedIndex}
              record={selectedRecord}
              stage2={trace?.stage2 ?? []}
              items={items}
              toggles={toggles.all}
              onCopyMarkdown={() => copySnapshot(false)}
              onCopyJson={() => copySnapshot(true)}
              copyPill={copyPill}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailPaneProps {
  event: Event;
  eventIndex: number;
  record: TraceRecord | undefined;
  stage2: {
    transformKey: string;
    ran: boolean;
    mutatedItems: boolean;
    beforeLen: number;
    afterLen: number;
    error?: { message: string };
  }[];
  items: ViewItem[];
  toggles: Record<string, boolean>;
  onCopyMarkdown: () => void;
  onCopyJson: () => void;
  copyPill: string | null;
}

function DetailPane({
  event,
  eventIndex,
  record,
  stage2,
  items,
  toggles,
  onCopyMarkdown,
  onCopyJson,
  copyPill,
}: DetailPaneProps) {
  const finalItems = record
    ? record.finalItemIndices.map((i) => items[i]).filter((it): it is ViewItem => it !== undefined)
    : [];
  return (
    <div className="trace-detail">
      <header className="trace-detail-header">
        <button
          type="button"
          className="trace-uuid-copy"
          title="copy uuid"
          onClick={() => {
            void navigator.clipboard.writeText(event.uuid);
          }}
        >
          {event.uuid}
        </button>
        <span className="trace-detail-kind">{event.kind}</span>
        <span className="trace-detail-ts">{event.ts}</span>
        <span className="trace-detail-index">#{eventIndex}</span>
      </header>
      <details className="trace-detail-section">
        <summary>Raw event</summary>
        <pre className="trace-json">{JSON.stringify(event, null, 2)}</pre>
      </details>
      <section className="trace-detail-section">
        <h4>Stage 1</h4>
        <table className="trace-stage-table">
          <thead>
            <tr>
              <th>transform</th>
              <th>matched</th>
              <th>ran</th>
              <th>consumed</th>
              <th>mutated</th>
              <th>error</th>
            </tr>
          </thead>
          <tbody>
            {record?.perStage.map((s) => {
              const disabled = toggles[s.transformKey] === false;
              return (
                <tr
                  key={s.transformKey}
                  className={classNames(disabled && 'trace-row-disabled', s.error && 'is-errored')}
                >
                  <td>
                    {s.transformKey}
                    {disabled && <span className="trace-disabled-label"> (disabled)</span>}
                  </td>
                  <td>{s.matched ? '✓' : ''}</td>
                  <td>{s.ran ? '✓' : ''}</td>
                  <td>{s.consumed ? '✓' : ''}</td>
                  <td>{s.mutatedItems ? '✓' : ''}</td>
                  <td>{s.error ? s.error.message : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="trace-detail-section">
        <h4>Stage 2</h4>
        <table className="trace-stage-table">
          <thead>
            <tr>
              <th>transform</th>
              <th>mutated</th>
              <th>beforeLen → afterLen</th>
              <th>error</th>
            </tr>
          </thead>
          <tbody>
            {stage2.map((s) => (
              <tr key={s.transformKey} className={classNames(s.error && 'is-errored')}>
                <td>{s.transformKey}</td>
                <td>{s.mutatedItems ? '✓' : ''}</td>
                <td>{`${s.beforeLen} → ${s.afterLen}`}</td>
                <td>{s.error?.message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="trace-detail-section">
        <h4>Resulting view items ({finalItems.length})</h4>
        <pre className="trace-json">{JSON.stringify(finalItems, null, 2)}</pre>
      </section>
      <div className="trace-detail-actions">
        <button type="button" className="trace-snapshot-btn" onClick={onCopyMarkdown}>
          Copy debug snapshot
        </button>
        <button type="button" className="trace-snapshot-btn" onClick={onCopyJson}>
          Copy as JSON
        </button>
        {copyPill && <span className="snapshot-copied">{copyPill}</span>}
      </div>
    </div>
  );
}
