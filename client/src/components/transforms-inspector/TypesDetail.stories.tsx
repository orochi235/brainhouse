import { SelectorStoreProvider, type StoredSelectorDef } from '../../transforms/selectors/store.tsx';
import type { Stage1Transform, ViewTransform } from '../../transforms/types.ts';
import { TypesDetail } from './TypesDetail.tsx';

const FRAME: React.CSSProperties = { width: 720, padding: '1rem', background: '#0f172a' };

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={FRAME}>{children}</div>
    </SelectorStoreProvider>
  );
}

const WITH_SAMPLE: StoredSelectorDef = {
  origin: 'builtin',
  key: 'tool-use.todowrite',
  name: 'TodoWrite tool_use',
  description: 'A tool_use event whose tool name is exactly "TodoWrite".',
  selector: 'event[kind=tool_use] > tool_use[name=TodoWrite]',
  samplePayload: {
    kind: 'tool_use',
    payload: { name: 'TodoWrite', input: { todos: [] } },
  },
};

const WITHOUT_SAMPLE: StoredSelectorDef = {
  origin: 'builtin',
  key: 'assistant-text.bh-title',
  name: 'Assistant <bh-title> marker',
  description: 'An assistant_text event with a trailing <bh-title>…</bh-title> marker.',
  selector: 'event[kind=assistant_text] > text[contains=<bh-title]',
};

const fakeTransform = (i: number): Stage1Transform => ({
  kind: 'view',
  stage: 1,
  key: `fake.transform-${i}`,
  name: `fake transform ${i}`,
  description: '',
  run: () => false,
});

const FAKE_TRANSFORMS: ViewTransform[] = [0, 1, 2, 3].map(fakeTransform);

export const WithSample = () =>
  frame(<TypesDetail def={WITH_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
export const WithoutSample = () =>
  frame(<TypesDetail def={WITHOUT_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
export const ManyRelatedTransforms = () =>
  frame(
    <TypesDetail def={WITH_SAMPLE} usedBy={FAKE_TRANSFORMS} onJumpToTransform={() => {}} />,
  );
export const NoRelatedTransforms = () =>
  frame(<TypesDetail def={WITH_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
