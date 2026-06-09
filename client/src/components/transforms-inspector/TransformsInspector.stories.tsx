import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TransformsInspector } from './TransformsInspector.tsx';

const FRAME: React.CSSProperties = { width: 960, padding: '1rem', background: '#0f172a' };

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={FRAME}>{children}</div>
    </SelectorStoreProvider>
  );
}

export const DefaultTypes = () => {
  window.location.hash = '#inspector/types';
  return frame(<TransformsInspector />);
};

export const TransformsTab = () => {
  window.location.hash = '#inspector/transforms';
  return frame(<TransformsInspector />);
};

export const TracePlaceholder = () => {
  window.location.hash = '#inspector/trace';
  return frame(<TransformsInspector />);
};
