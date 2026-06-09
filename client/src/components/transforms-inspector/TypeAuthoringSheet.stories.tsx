import type { Event } from '@server/parser.ts';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';

const FRAME: React.CSSProperties = { width: 720, padding: '1rem', background: '#0f172a' };

const EVENTS: Event[] = [
  {
    uuid: 'evt-1',
    parent_uuid: null,
    session_id: 's',
    ts: 0,
    kind: 'tool_use',
    payload: { tool_use_id: 't1', name: 'Bash', input: { command: 'ls' } },
  } as unknown as Event,
  {
    uuid: 'evt-2',
    parent_uuid: null,
    session_id: 's',
    ts: 1,
    kind: 'user_text',
    payload: { text: '<bash-input>pwd</bash-input>' },
  } as unknown as Event,
];

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={FRAME}>{children}</div>
    </SelectorStoreProvider>
  );
}

export const PickAnEvent = () =>
  frame(<TypeAuthoringSheet recentEvents={EVENTS} onCancel={() => {}} onSave={() => {}} />);

export const PasteJsonFlow = () =>
  frame(<TypeAuthoringSheet recentEvents={[]} onCancel={() => {}} onSave={() => {}} />);

export const RawSelectorFlow = () =>
  frame(<TypeAuthoringSheet recentEvents={[]} onCancel={() => {}} onSave={() => {}} />);

export const SaveErrorKeyCollision = () =>
  frame(
    <TypeAuthoringSheet
      recentEvents={EVENTS}
      onCancel={() => {}}
      onSave={(def) => {
        throw new Error(`key "${def.key}" collides with a built-in selector`);
      }}
    />,
  );
