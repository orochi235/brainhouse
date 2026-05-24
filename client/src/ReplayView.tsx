/**
 * Read-only replay view for a single JSONL transcript. Renders one
 * PanelCard with `readOnly` set so the trash + dev affordances are
 * suppressed; everything else (lightbox, scroll memory, popovers)
 * works normally because PanelCard is unchanged.
 *
 * Entered via `?replay=<abs path>` (server reads the file, allowlist
 * gated) or via global file-drop (client reads contents, ships them
 * to the inline endpoint that runs the same parser).
 */

import type { Event } from '@server/parser.ts';
import type { PanelDto } from '@server/session.ts';
import { useEffect, useState } from 'react';
import { PanelCard } from './components/PanelCard.tsx';
import { LightboxProvider } from './lib/lightbox.tsx';
import { trpc } from './trpc.ts';
import type { PanelState } from './useDeltaStream.ts';

export interface ReplaySource {
  /** Server-side load from an allowlisted absolute path. */
  kind: 'path';
  path: string;
}

export interface ReplayInlineSource {
  /** Client-supplied contents (drag-and-drop). */
  kind: 'inline';
  label: string;
  contents: string;
}

type Source = ReplaySource | ReplayInlineSource;

interface LoadedPayload {
  panel: PanelDto;
  events: Event[];
  parseErrors: Array<{ lineNo: number; raw: string; error: string }>;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: LoadedPayload };

export function ReplayView({ source }: { source: Source }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const promise =
      source.kind === 'path'
        ? trpc.debug.replayJsonl.query({ path: source.path })
        : trpc.debug.replayJsonlInline.query({
            contents: source.contents,
            label: source.label,
          });
    promise
      .then((payload) => {
        // tRPC re-derives a structural type from the server's `Event` union
        // and marks `tool_use.payload.input` as optional (because `unknown`
        // includes `undefined`). The actual values always carry `input`,
        // so we cast back to the named `Event[]` at this boundary.
        if (!cancelled)
          setState({ kind: 'ready', payload: payload as unknown as LoadedPayload });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (state.kind === 'loading') {
    return (
      <div className="replay-shell">
        <ReplayHeader label={sourceLabel(source)} />
        <div className="replay-status">Loading…</div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="replay-shell">
        <ReplayHeader label={sourceLabel(source)} />
        <div className="replay-status replay-error">{state.message}</div>
        <div className="replay-status replay-hint">
          Drop another .jsonl file anywhere on the page to try a different one, or visit{' '}
          <code>/?replay=&lt;absolute path&gt;</code>.
        </div>
      </div>
    );
  }

  const panel: PanelState = { ...state.payload.panel, events: state.payload.events };
  const parseErrors = state.payload.parseErrors;

  return (
    <LightboxProvider>
      <div className="replay-shell">
        <ReplayHeader
          label={sourceLabel(source)}
          counts={
            <>
              {state.payload.events.length} events
              {parseErrors.length > 0 && ` · ${parseErrors.length} parse errors`}
            </>
          }
        />
        <div className="replay-grid">
          <PanelCard panel={panel} readOnly />
        </div>
        {parseErrors.length > 0 && (
          <details className="replay-parse-errors">
            <summary>{parseErrors.length} parse errors</summary>
            <ul>
              {parseErrors.slice(0, 50).map((e) => (
                <li key={e.lineNo}>
                  <code>L{e.lineNo}</code> {e.error}: <code>{e.raw}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </LightboxProvider>
  );
}

function ReplayHeader({ label, counts }: { label: string; counts?: React.ReactNode }) {
  return (
    <header className="replay-header">
      <span className="replay-tag">REPLAY</span>
      <code className="replay-source">{label}</code>
      {counts && <span className="replay-counts">{counts}</span>}
      <button
        type="button"
        className="replay-exit"
        onClick={() => {
          window.location.search = '';
        }}
      >
        exit replay
      </button>
    </header>
  );
}

function sourceLabel(source: Source): string {
  return source.kind === 'path' ? source.path : source.label;
}
