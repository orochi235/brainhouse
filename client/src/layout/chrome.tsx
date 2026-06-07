/**
 * Chrome map for the top-level layout store.
 *
 * - `group` (workarea): renders its own `Container` so the workarea's
 *   binarySplit runs against the rect its parent gave it. Recurses
 *   indefinitely if more groups land later.
 * - `panel` (top/main/sidebar slots): renders a slot wrapper whose body
 *   is whatever React subtree App.tsx supplied for `node.meta.slot`.
 * - `zone`: unused at runtime (only ROOT is a zone, and it's mounted via
 *   the top-level Container in Layout.tsx), but a handler is
 *   required by ChromeMap.
 */
import type { ChromeMap } from 'windease/react';
import { Container } from 'windease/react';
import { createContext, type ReactNode, useContext } from 'react';

export type SlotName = 'top' | 'main' | 'sidebar';

export type Slots = Partial<Record<SlotName, ReactNode>>;

const SlotsContext = createContext<Slots>({});

export const SlotsProvider = SlotsContext.Provider;

export function useSlot(name: SlotName): ReactNode {
  return useContext(SlotsContext)[name] ?? null;
}

export const layoutChrome: ChromeMap = {
  zone: ({ children }) => <>{children}</>,
  group: ({ node }) => (
    <Container
      parentId={node.id}
      chrome={layoutChrome}
      affordances
      className="layout-group"
    />
  ),
  panel: ({ node }) => {
    const slot = (node.meta as { slot?: SlotName } | undefined)?.slot;
    return (
      <div className={`layout-slot layout-slot-${slot ?? 'unknown'}`}>
        {slot ? <SlotRenderer slot={slot} /> : null}
      </div>
    );
  },
};

function SlotRenderer({ slot }: { slot: SlotName }) {
  return <>{useSlot(slot)}</>;
}
