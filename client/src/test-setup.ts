/**
 * Vitest setup — runs once before any test file.
 *
 * - registers jest-dom DOM matchers
 * - shims `localStorage` because happy-dom 20 exposes the property but leaves
 *   the value undefined unless the host opts in via a special config; a
 *   plain Map-backed shim is simpler than wrestling with the env.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Auto-cleanup between tests so leftover DOM from a previous render doesn't
// match queries in the next test. (React Testing Library does this
// automatically under Jest; under vitest we wire it up here.)
afterEach(() => {
  cleanup();
});


class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof window !== 'undefined' && !window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    writable: false,
  });
}
if (typeof globalThis.localStorage === 'undefined' && typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
    writable: false,
  });
}
