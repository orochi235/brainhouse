import { SelectorStoreProvider } from '../transforms/selectors/store.tsx';
import { TransformsModal } from './TransformsModal.tsx';

export const Default = () => (
  <SelectorStoreProvider>
    <div style={{ width: 960, padding: '1rem', background: '#0f172a' }}>
      <TransformsModal />
    </div>
  </SelectorStoreProvider>
);
