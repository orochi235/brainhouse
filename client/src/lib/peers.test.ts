import { describe, expect, it } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import { pidFromAddress, resolvePeer } from './peers.tsx';

const theme = (bg: string) => ({ background: bg, foreground: '#fff' });
function panel(over: Partial<PanelState>): PanelState {
  return {
    kind: 'parent',
    last_event_at: 0,
    repo_root: null,
    cwd: null,
    theme: null,
    peer: null,
    ...over,
  } as PanelState;
}

describe('resolvePeer', () => {
  const emilia = panel({
    id: 'e1',
    repo_root: '/src/emilia',
    theme: theme('#123'),
    peer: { name: 'emilia-93', pid: 28469 },
    last_event_at: 5,
  });
  const olderEmilia = panel({ id: 'e0', repo_root: '/src/emilia', theme: theme('#456') });

  it('finds the sending session by registry name or pid', () => {
    expect(resolvePeer([olderEmilia, emilia], { name: 'emilia-93', pid: null })).toEqual({
      panelId: 'e1',
      theme: theme('#123'),
    });
    expect(resolvePeer([emilia], { name: null, pid: 28469 })?.panelId).toBe('e1');
  });

  it('falls back to the project color, without a panel, for an unregistered name', () => {
    expect(resolvePeer([olderEmilia], { name: 'emilia-12', pid: null })).toEqual({
      panelId: null,
      theme: theme('#456'),
    });
  });

  it('returns null for a sender it knows nothing about', () => {
    expect(resolvePeer([emilia], { name: 'perch-73', pid: null })).toBeNull();
  });
});

describe('pidFromAddress', () => {
  it('reads the pid from a socket address', () => {
    expect(pidFromAddress('uds:/tmp/cc-socks/28469.sock')).toBe(28469);
    expect(pidFromAddress('...')).toBeNull();
  });
});
