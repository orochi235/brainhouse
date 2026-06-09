import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectorStoreProvider, useSelectors, type SelectorStore } from './store.tsx';

function harness(cb: (store: SelectorStore) => void) {
  function Probe() {
    const store = useSelectors();
    cb(store);
    return null;
  }
  return render(
    <SelectorStoreProvider>
      <Probe />
    </SelectorStoreProvider>,
  );
}

describe('SelectorStore', () => {
  it('exposes built-ins from MOCK_SELECTORS with origin=builtin', () => {
    let snap: SelectorStore | null = null;
    harness((s) => {
      snap = s;
    });
    expect(snap!.all.length).toBeGreaterThan(0);
    for (const s of snap!.all) expect(s.origin).toBe('builtin');
  });

  it('rejects user keys without the `user.` prefix', () => {
    let s: SelectorStore | null = null;
    harness((store) => {
      s = store;
    });
    expect(() =>
      s!.addUser({ key: 'nope', name: 'x', description: '', selector: '' }),
    ).toThrow(/user\./);
  });

  it('rejects collisions with built-in keys', () => {
    let s: SelectorStore | null = null;
    harness((store) => {
      s = store;
    });
    expect(() =>
      s!.addUser({
        key: 'tool-use.todowrite',
        name: 'x',
        description: '',
        selector: '',
      }),
    ).toThrow(/user\./);
  });

  it('survives remove-then-re-add', () => {
    let last: SelectorStore | null = null;
    function Probe() {
      const s = useSelectors();
      last = s;
      return null;
    }
    render(
      <SelectorStoreProvider>
        <Probe />
      </SelectorStoreProvider>,
    );
    act(() => {
      last!.addUser({ key: 'user.foo', name: 'foo', description: '', selector: '' });
    });
    expect(last!.byKey.get('user.foo')?.origin).toBe('user');
    act(() => {
      last!.removeUser('user.foo');
    });
    expect(last!.byKey.get('user.foo')).toBeUndefined();
    act(() => {
      last!.addUser({ key: 'user.foo', name: 'foo', description: '', selector: '' });
    });
    expect(last!.byKey.get('user.foo')?.origin).toBe('user');
  });
});
