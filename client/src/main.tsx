import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startMeasureReaper } from './lib/telemetry.ts';

// DEV-only: React's dev build emits a performance.measure() per render into
// the DevTools "Components ⚛" track; they accumulate unbounded (millions of
// PerformanceMeasure objects → hundreds of MB of native renderer memory) in a
// long-lived dev tab. Reap the user-timing buffer periodically. No-op in prod
// (React emits none) — see lib/telemetry.ts.
if (import.meta.env.DEV) startMeasureReaper();

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
