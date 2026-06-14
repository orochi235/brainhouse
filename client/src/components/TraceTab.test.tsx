/**
 * TraceTab filter-bar behavior:
 *  - status checkboxes cover all four row statuses (incl. noop) and
 *    narrow the event list to rows with a checked status;
 *  - the transforms dropdown lists stage-1 keys only (stage-2 records
 *    are per-pass, not per-event, so they can never match a row);
 *  - every checkbox label carries the number of rows it would match.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VIEW_TRANSFORMS } from '../transforms/registry.ts';
import { F } from '../transforms/selectors/__fixtures__/events.ts';
import type { TraceRecord } from '../transforms/selectors/types.ts';
import type { PanelTrace, TraceStore } from '../transforms/traceContext.tsx';
import { TraceProvider, useTraceStore } from '../transforms/traceContext.tsx';
import { TraceTab } from './TraceTab.tsx';

const STAGE1_KEYS = VIEW_TRANSFORMS.filter((t) => t.stage === 1).map((t) => t.key);
const STAGE2_KEYS = VIEW_TRANSFORMS.filter((t) => t.stage === 2).map((t) => t.key);
// The built-in registry always ships well more than two stage-1 transforms;
// assert so K1/K2 are `string` rather than `string | undefined`.
const K1 = STAGE1_KEYS[0]!;
const K2 = STAGE1_KEYS[1]!;

function stage(
  transformKey: string,
  flags: Partial<Pick<TraceRecord['perStage'][number], 'ran' | 'consumed' | 'error'>>,
): TraceRecord['perStage'][number] {
  return {
    transformKey,
    matched: flags.ran === true,
    ran: flags.ran === true,
    consumed: flags.consumed === true,
    mutatedItems: false,
    ...(flags.error ? { error: flags.error } : {}),
  };
}

function grabStore(): TraceStore {
  let store: TraceStore | undefined;
  function Probe() {
    store = useTraceStore();
    return null;
  }
  render(
    <TraceProvider>
      <Probe />
    </TraceProvider>,
  );
  if (!store) throw new Error('store probe failed');
  return store;
}

/** u1 consumed by K1, a1 noop-touched by K2, tu1 errored in K1,
 * u2 has no trace record at all (not-matched). */
function seed(panelId: string) {
  const events = [F.userText, F.asstPlain, F.toolUseBash, F.userMeta];
  const trace: PanelTrace = {
    perEvent: [
      {
        eventUuid: 'u1',
        perStage: [stage(K1, { ran: true, consumed: true })],
        finalItemIndices: [],
      },
      { eventUuid: 'a1', perStage: [stage(K2, { ran: true })], finalItemIndices: [] },
      {
        eventUuid: 'tu1',
        perStage: [
          stage(K1, {
            ran: true,
            error: { transformKey: K1, message: 'boom', ts: 0 },
          }),
        ],
        finalItemIndices: [],
      },
    ],
    stage2: [],
    generatedAt: 0,
  };
  grabStore().write(panelId, trace);
  return events;
}

function renderTab(panelId: string) {
  const events = seed(panelId);
  return render(
    <TraceProvider>
      <TraceTab panelId={panelId} events={events} items={[]} />
    </TraceProvider>,
  );
}

describe('<TraceTab> filter bar', () => {
  it('renders a checkbox per status, each labeled with its match count', () => {
    renderTab('trace-test-counts');
    expect(screen.getByRole('checkbox', { name: 'consumed 1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'errored 1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'noop 1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'not-matched 1' })).toBeInTheDocument();
  });

  it('noop checkbox narrows the list to noop rows', () => {
    renderTab('trace-test-noop');
    fireEvent.click(screen.getByRole('checkbox', { name: 'noop 1' }));
    const rows = document.querySelectorAll('.trace-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classList.contains('is-noop')).toBe(true);
  });

  it('lists only stage-1 transforms in the dropdown, with match counts', () => {
    renderTab('trace-test-stage1');
    for (const k of STAGE2_KEYS) {
      expect(screen.queryByRole('checkbox', { name: new RegExp(k) })).toBeNull();
    }
    expect(screen.getByRole('checkbox', { name: `${K1} 2` })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: `${K2} 1` })).toBeInTheDocument();
  });
});
