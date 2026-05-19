import type { Event } from '@server/parser.ts';
import type { Delta, PanelDto } from '@server/session.ts';
import { useEffect, useReducer } from 'react';
import { trpc } from './trpc.ts';

/**
 * State + reducer that tracks all panels and their events on the client.
 *
 * The server sends one `{kind: 'snapshot'}` on subscribe (full hydrate) and
 * then a stream of `{kind: 'delta', delta}` messages. Both are applied
 * through the same reducer so the snapshot path goes through the same code
 * as live updates.
 */

export interface PanelState extends PanelDto {
  events: Event[];
}

export interface DeltaState {
  /** Connection liveness — drives the header status badge. */
  status: 'connecting' | 'live' | 'offline';
  panels: Map<string, PanelState>;
}

type Action =
  | { type: 'conn'; status: DeltaState['status'] }
  | { type: 'snapshot'; panels: Array<PanelDto & { events: Event[] }> }
  | { type: 'delta'; delta: Delta };

const initialState: DeltaState = {
  status: 'connecting',
  panels: new Map(),
};

function reducer(state: DeltaState, action: Action): DeltaState {
  switch (action.type) {
    case 'conn':
      return { ...state, status: action.status };
    case 'snapshot': {
      const panels = new Map<string, PanelState>();
      for (const p of action.panels) panels.set(p.id, { ...p, events: p.events });
      return { ...state, panels };
    }
    case 'delta': {
      const panels = new Map(state.panels);
      const d = action.delta;
      if (d.op === 'panel_upsert') {
        const existing = panels.get(d.panel.id);
        panels.set(d.panel.id, { ...d.panel, events: existing?.events ?? [] });
      } else if (d.op === 'event_append') {
        const existing = panels.get(d.panel_id);
        if (existing) {
          panels.set(d.panel_id, { ...existing, events: [...existing.events, d.event] });
        }
      } else if (d.op === 'panel_status') {
        const existing = panels.get(d.panel_id);
        if (existing) {
          panels.set(d.panel_id, {
            ...existing,
            status: d.status,
            status_changed_at: Date.now() / 1000,
          });
        }
      } else if (d.op === 'panel_remove') {
        panels.delete(d.panel_id);
      }
      return { ...state, panels };
    }
  }
}

/** Subscribe to the server's delta stream; expose normalized state + dispatch. */
export function useDeltaStream(): DeltaState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    dispatch({ type: 'conn', status: 'connecting' });
    const sub = trpc.deltas.subscribe(undefined, {
      onStarted() {
        dispatch({ type: 'conn', status: 'live' });
      },
      onData(msg) {
        if (msg.kind === 'snapshot') {
          // Server sent us {events: unknown[]}; on the wire it's full Events.
          dispatch({
            type: 'snapshot',
            panels: msg.panels as Array<PanelDto & { events: Event[] }>,
          });
        } else {
          // tRPC's inferred Delta loses some narrowing precision around the
          // payload union; runtime shape matches Delta exactly.
          dispatch({ type: 'delta', delta: msg.delta as unknown as Delta });
        }
      },
      onError() {
        dispatch({ type: 'conn', status: 'offline' });
      },
      onStopped() {
        dispatch({ type: 'conn', status: 'offline' });
      },
    });
    return () => sub.unsubscribe();
  }, []);

  return state;
}
