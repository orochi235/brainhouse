import { SourceView } from './SourceView.tsx';

const SHORT = `export const trackPending = {
  key: 'trackPending',
  run(event, items, ctx) {
    if (event.kind === 'user_text') ctx.scratch.pending = true;
  },
};
`;

const LONG = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n');

const BRANCHY = `export function run(e) {
  if (e.kind === 'tool_use') {
    if (e.payload.name === 'Bash') return false;
  } else if (e.kind === 'tool_result') {
    return false;
  } else {
    return true;
  }
  switch (e.kind) {
    case 'meta':
      return false;
    case 'system':
      return false;
  }
}
`;

const FRAME: React.CSSProperties = { width: 760, padding: '1rem', background: '#0f172a' };

export const Short = () => (
  <div style={FRAME}>
    <SourceView source={SHORT} />
  </div>
);

export const Long = () => (
  <div style={FRAME}>
    <SourceView source={LONG} />
  </div>
);

export const OutlineManyBranches = () => (
  <div style={FRAME}>
    <SourceView source={BRANCHY} />
  </div>
);
