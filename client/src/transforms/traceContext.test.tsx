import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTraceStore } from './traceContext.tsx';

const trace = (generatedAt: number) => ({ perEvent: [], stage2: [], generatedAt });

function getStore() {
  // useTraceStore returns the module singleton via the default context.
  return renderHook(() => useTraceStore()).result.current;
}

describe('TraceStore prune', () => {
  beforeEach(() => {
    // Singleton persists across tests; clear it via prune-to-empty.
    getStore().prune(new Set());
  });

  it('forget drops an entry with no subscribers', () => {
    const store = getStore();
    store.write('a', trace(1));
    expect(store.get('a')).toBeDefined();
    store.forget('a');
    expect(store.get('a')).toBeUndefined();
  });

  it('prune forgets only ids absent from the live set', () => {
    const store = getStore();
    store.write('a', trace(1));
    store.write('b', trace(2));
    store.prune(new Set(['b']));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });

  it('forget keeps a still-subscribed entry wired, dropping only its trace', () => {
    const store = getStore();
    let notified = 0;
    const unsub = store.subscribe('live', () => {
      notified += 1;
    });
    store.write('live', trace(1));
    expect(store.get('live')).toBeDefined();

    store.prune(new Set()); // 'live' is absent but still has a subscriber
    expect(store.get('live')).toBeUndefined(); // heavy trace released
    // ...yet the subscription is intact: a later write still notifies.
    store.write('live', trace(2));
    expect(notified).toBeGreaterThan(0);
    expect(store.get('live')).toBeDefined();
    unsub();
  });
});
