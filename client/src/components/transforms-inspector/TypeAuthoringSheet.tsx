/**
 * Point-and-build (pick an event from the panel, infer a selector) or
 * write a raw selector. v1 has no event-stream wiring — see Spec 2 modal
 * shell; events default to []. Save is rejected unless the key is
 * `user.`-prefixed and unique.
 */

import { useMemo, useState } from 'react';
import type { Event } from '@server/parser.ts';
import { compileSelector, type SelectorDef } from '../../transforms/selectors/index.ts';
import { infer } from './inference.ts';

type Path = 'pick' | 'paste' | 'raw';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function TypeAuthoringSheet({
  recentEvents = [],
  onCancel,
  onSave,
}: {
  recentEvents?: Event[];
  onCancel: () => void;
  onSave: (def: SelectorDef) => void;
}) {
  const [path, setPath] = useState<Path>('pick');
  const [selectedEventUuid, setSelectedEventUuid] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState('');
  const [selectorSrc, setSelectorSrc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sampleEvent: Event | null = useMemo(() => {
    if (path === 'paste') {
      if (!pasted.trim()) return null;
      try {
        return JSON.parse(pasted) as Event;
      } catch {
        return null;
      }
    }
    if (path === 'pick' && selectedEventUuid) {
      return recentEvents.find((e) => e.uuid === selectedEventUuid) ?? null;
    }
    return null;
  }, [path, pasted, selectedEventUuid, recentEvents]);

  const inferredSrc = useMemo(() => {
    if (path === 'raw' || !sampleEvent) return '';
    return infer(sampleEvent);
  }, [sampleEvent, path]);

  // Default the editable selector source to the inferred one when the user
  // hasn't typed anything yet.
  const effectiveSelectorSrc = selectorSrc || inferredSrc;

  // Compile + match-check.
  const matchInfo = useMemo<'yes' | 'no' | '—' | 'err'>(() => {
    if (!effectiveSelectorSrc) return '—';
    if (!sampleEvent) return '—';
    try {
      const compiled = compileSelector(effectiveSelectorSrc);
      return compiled.match(sampleEvent) ? 'yes' : 'no';
    } catch {
      return 'err';
    }
  }, [effectiveSelectorSrc, sampleEvent]);

  const effectiveKey = key || (name ? `user.${slugify(name)}` : '');

  const handleSave = () => {
    setError(null);
    if (!name.trim()) {
      setError('name is required');
      return;
    }
    if (!effectiveKey.startsWith('user.')) {
      setError('key must start with "user."');
      return;
    }
    if (!effectiveSelectorSrc.trim()) {
      setError('selector source is required');
      return;
    }
    try {
      onSave({
        key: effectiveKey,
        name,
        description,
        selector: effectiveSelectorSrc,
        samplePayload: sampleEvent ?? undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="inspector-detail inspector-sheet">
      <header className="inspector-detail-header">
        <h4>Add type</h4>
        <button type="button" className="inspector-sheet-cancel" onClick={onCancel}>
          Cancel
        </button>
      </header>
      <nav className="inspector-sheet-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={path === 'pick'}
          className={path === 'pick' ? 'is-active' : ''}
          onClick={() => setPath('pick')}
        >
          Pick an event
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={path === 'paste'}
          className={path === 'paste' ? 'is-active' : ''}
          onClick={() => setPath('paste')}
        >
          Paste JSON
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={path === 'raw'}
          className={path === 'raw' ? 'is-active' : ''}
          onClick={() => setPath('raw')}
        >
          Write selector
        </button>
      </nav>

      {path === 'pick' && (
        <section className="inspector-sheet-source">
          {recentEvents.length === 0 ? (
            <p className="inspector-muted">
              (no events in the current panel — paste JSON or write a raw selector)
            </p>
          ) : (
            <select
              className="inspector-event-picker"
              value={selectedEventUuid ?? ''}
              onChange={(e) => setSelectedEventUuid(e.target.value || null)}
            >
              <option value="">— select an event —</option>
              {recentEvents.slice(0, 200).map((ev) => (
                <option key={ev.uuid} value={ev.uuid}>
                  {ev.kind} · {ev.uuid.slice(0, 6)}
                </option>
              ))}
            </select>
          )}
        </section>
      )}

      {path === 'paste' && (
        <section className="inspector-sheet-source">
          <textarea
            className="inspector-paste-area"
            placeholder='{"kind":"tool_use","payload":{"name":"Bash",...}}'
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </section>
      )}

      {(path === 'pick' || path === 'paste') && sampleEvent && (
        <section className="inspector-detail-section">
          <h5>Event</h5>
          <pre className="inspector-sample">{JSON.stringify(sampleEvent, null, 2)}</pre>
        </section>
      )}

      <section className="inspector-detail-section">
        <h5>Selector source</h5>
        <input
          type="text"
          className="inspector-field"
          placeholder={path === 'raw' ? 'event[kind=…] > …' : inferredSrc || 'event[kind=…]'}
          value={selectorSrc}
          onChange={(e) => setSelectorSrc(e.target.value)}
        />
        <p className="inspector-match-info">
          Matches sample? <strong>{matchInfo}</strong>
        </p>
      </section>

      <section className="inspector-detail-section inspector-sheet-meta">
        <label>
          <span>Name</span>
          <input
            type="text"
            className="inspector-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Key</span>
          <input
            type="text"
            className="inspector-field"
            placeholder={effectiveKey || 'user.…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            type="text"
            className="inspector-field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </section>

      {error && <p className="inspector-error">{error}</p>}

      <footer className="inspector-sheet-footer">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="inspector-primary" onClick={handleSave}>
          Save
        </button>
      </footer>
    </div>
  );
}
