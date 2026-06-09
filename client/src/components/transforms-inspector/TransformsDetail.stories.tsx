import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TransformsDetail } from './TransformsDetail.tsx';

const FRAME: React.CSSProperties = { width: 720, padding: '1rem', background: '#0f172a' };

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={FRAME}>{children}</div>
    </SelectorStoreProvider>
  );
}

const stage1 = VIEW_TRANSFORMS.find((t) => t.stage === 1) ?? null;
const stage2 = VIEW_TRANSFORMS.find((t) => t.stage === 2) ?? null;

export const Stage1WithMatches = () => {
  const withMatches = stage1
    ? { ...stage1, matches: ['tool-use.bash', 'tool-use.todowrite'] as string[] }
    : null;
  return frame(<TransformsDetail transform={withMatches} onJumpToType={() => {}} />);
};

export const Stage2NoMatches = () =>
  frame(<TransformsDetail transform={stage2} onJumpToType={() => {}} />);

export const LongSource = () => {
  const long =
    VIEW_TRANSFORMS.find((t) => t.key === 'built-in.todo-write-to-checklist') ?? stage1;
  return frame(<TransformsDetail transform={long} onJumpToType={() => {}} />);
};
