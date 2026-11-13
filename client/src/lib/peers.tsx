/**
 * Resolves the sender of a cross-session message (`emilia-93`, or a pid from
 * its `uds:/tmp/cc-socks/<pid>.sock` address) to that session's panel, so the
 * message can wear the sender's project color and jump to it.
 *
 * The server stamps `peer` from Claude Code's session registry. For a sender
 * brainhouse never saw registered (it exited before a restart), a derived
 * name's stem (`emilia` from `emilia-93`) still finds the project's color,
 * though not a specific panel to open.
 */

import type { PanelTheme } from '@server/session.ts';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { PanelState } from '../useDeltaStream.ts';

export interface PeerRef {
  name: string | null;
  pid: number | null;
}

export interface PeerMatch {
  /** Null when only the project matched, not a particular session. */
  panelId: string | null;
  theme: PanelTheme | null;
}

interface PeerDirectory {
  resolve(ref: PeerRef): PeerMatch | null;
  open(panelId: string): void;
}

const Ctx = createContext<PeerDirectory | null>(null);

export function PeerProvider({
  panels,
  open,
  children,
}: {
  panels: Map<string, PanelState>;
  open: (panelId: string) => void;
  children: ReactNode;
}) {
  const value = useMemo<PeerDirectory>(
    () => ({ resolve: (ref) => resolvePeer(panels.values(), ref), open }),
    [panels, open],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePeer(ref: PeerRef | null): (PeerMatch & { open: (() => void) | null }) | null {
  const dir = useContext(Ctx);
  if (!dir || !ref) return null;
  const match = dir.resolve(ref);
  if (!match) return null;
  const { panelId } = match;
  return { ...match, open: panelId ? () => dir.open(panelId) : null };
}

export function resolvePeer(panels: Iterable<PanelState>, ref: PeerRef): PeerMatch | null {
  let exact: PanelState | null = null;
  let project: PanelState | null = null;
  const stem = ref.name?.replace(/-\d+$/, '') ?? null;
  for (const p of panels) {
    if (p.kind !== 'parent') continue;
    const hit =
      (ref.pid !== null && p.peer?.pid === ref.pid) ||
      (ref.name !== null && p.peer?.name === ref.name);
    if (hit && (!exact || p.last_event_at > exact.last_event_at)) exact = p;
    if (stem && p.theme && repoLeaf(p) === stem) {
      if (!project || p.last_event_at > project.last_event_at) project = p;
    }
  }
  if (exact) return { panelId: exact.id, theme: exact.theme ?? project?.theme ?? null };
  if (project) return { panelId: null, theme: project.theme };
  return null;
}

function repoLeaf(p: PanelState): string | null {
  const dir = p.repo_root ?? p.cwd;
  return dir?.split('/').filter(Boolean).pop() ?? null;
}

/** Pid behind a `uds:/tmp/cc-socks/<pid>.sock` address, or null. */
export function pidFromAddress(addr: string | null | undefined): number | null {
  const m = addr?.match(/\/(\d+)\.sock$/);
  return m?.[1] ? Number(m[1]) : null;
}
