/**
 * Top-level layout shell. Mounts the windease providers and a single
 * `Container` rooted at the layout root. The container fills the
 * viewport; everything beneath is positioned by the strip strategy's
 * pixel rects, with a draggable seam between every pair of panes.
 *
 * Sizing is declarative — see `store.ts`. The topbar and the top widget
 * ask to be sized by their content and the sidebar caps its own width,
 * so nothing here measures or writes a size.
 */
import { gridStrategy, stripStrategy } from 'windease';
import { Container, Provider, StrategyRegistryProvider } from 'windease/react';
import { layoutChrome, type Slots, SlotsProvider } from './chrome.tsx';
import { layoutStore, ROOT_ID } from './store.ts';

const strategies = {
  strip: stripStrategy,
  grid: gridStrategy,
};

export interface LayoutProps {
  slots: Slots;
}

export function Layout({ slots }: LayoutProps) {
  return (
    <Provider store={layoutStore}>
      <StrategyRegistryProvider strategies={strategies}>
        <SlotsProvider value={slots}>
          <Container
            parentId={ROOT_ID}
            chrome={layoutChrome}
            affordances
            className="layout-root"
          />
        </SlotsProvider>
      </StrategyRegistryProvider>
    </Provider>
  );
}
