import type { FileChangeItem, ToolItem } from '../lib/pipeline.ts';
import { FileChangeLightbox } from './FileChangeLightbox.tsx';

let uid = 0;
function op(name: string, input: Record<string, unknown>, result?: string): ToolItem {
  uid += 1;
  return {
    type: 'tool',
    anchorUuid: `u${uid}`,
    use: { tool_use_id: `t${uid}`, name, input },
    result:
      result !== undefined ? { tool_use_id: `t${uid}`, content: result, is_error: false } : null,
    resultTs: null,
    ack: null,
    ts: '2026-05-20T00:00:00Z',
  };
}

function fc(path: string, ops: ToolItem[]): FileChangeItem {
  return {
    type: 'file-change',
    anchorUuid: ops[0]?.anchorUuid ?? 'u',
    path,
    ops,
    ts: '2026-05-20T00:00:00Z',
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 760, padding: '1rem', background: '#0f172a' }}>{children}</div>;
}

export const ReadOnly = () => (
  <Frame>
    <FileChangeLightbox
      item={fc('/Users/demo/src/foo.ts', [
        op('Read', { file_path: '/Users/demo/src/foo.ts' }, 'line1\nline2\nline3'),
      ])}
    />
  </Frame>
);

export const SimpleEdit = () => (
  <Frame>
    <FileChangeLightbox
      item={fc('/Users/demo/src/foo.ts', [
        op('Edit', {
          file_path: '/Users/demo/src/foo.ts',
          old_string: 'export function foo() { return null }',
          new_string: 'export function foo(x: number) { return x * 2 }',
        }),
      ])}
    />
  </Frame>
);

export const MultipleEdits = () => (
  <Frame>
    <FileChangeLightbox
      item={fc('/Users/demo/src/api.ts', [
        op('Read', { file_path: '/Users/demo/src/api.ts' }, 'original contents'),
        op('Edit', {
          file_path: '/Users/demo/src/api.ts',
          old_string: 'GET /api',
          new_string: 'POST /api',
        }),
        op('Edit', { file_path: '/Users/demo/src/api.ts', old_string: '200', new_string: '201' }),
      ])}
    />
  </Frame>
);

export const Write = () => (
  <Frame>
    <FileChangeLightbox
      item={fc('/tmp/generated.ts', [
        op('Write', {
          file_path: '/tmp/generated.ts',
          content: "export const config = {\n  port: 8765,\n  host: '127.0.0.1',\n};\n",
        }),
      ])}
    />
  </Frame>
);

export const MultiEdit = () => (
  <Frame>
    <FileChangeLightbox
      item={fc('/src/handler.ts', [
        op('MultiEdit', {
          edits: [
            { old_string: 'foo', new_string: 'FOO' },
            { old_string: 'bar', new_string: 'BAR' },
            { old_string: 'baz', new_string: 'BAZ' },
          ],
        }),
      ])}
    />
  </Frame>
);
