/**
 * Debug modal listing every synthetic scenario defined in the server's
 * `scenarios.ts`. Each row shows what feature the scenario exercises and
 * what should visually happen — so it also doubles as a manual-QA
 * checklist. Clicking "spawn" runs the fixture through the same
 * `monitor.ingest()` path as a real Claude session.
 */

import { useEffect, useState } from 'react';
import { trpc } from '../trpc.ts';

interface Scenario {
  key: string;
  name: string;
  description: string;
  expect: string;
}

export function ScenariosModal() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.debug.scenarios.list
      .query()
      .then((rows) => {
        if (!cancelled) setScenarios(rows as Scenario[]);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const spawn = async (key: string) => {
    setBusy(key);
    setError(null);
    try {
      await trpc.debug.scenarios.spawn.mutate({ key });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Synthetic scenarios</h3>
      <p className="transforms-intro">
        Named fixtures that exercise specific UI/lifecycle paths. Same event-ingest path as a real
        Claude session — these just synthesize the events. Each row says what you should expect to
        see if the implementation is correct.
      </p>
      {error && <p className="prefs-error">{error}</p>}
      <ol className="transforms-list">
        {scenarios.map((s) => (
          <li className="transforms-item" key={s.key}>
            <div className="transforms-row">
              <span className="transforms-name">{s.name}</span>
              <button
                type="button"
                className="debug-spawn"
                onClick={() => spawn(s.key)}
                disabled={busy === s.key}
              >
                {busy === s.key ? 'spawning…' : 'spawn'}
              </button>
            </div>
            <div className="transforms-source">{s.description}</div>
            <p className="transforms-blurb">
              <strong>expect:</strong> {s.expect}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
