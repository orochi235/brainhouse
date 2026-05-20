import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
      result !== undefined
        ? { tool_use_id: `t${uid}`, content: result, is_error: false }
        : null,
    ack: null,
    ts: '2026-05-19T00:00:00Z',
  };
}

function fileChange(path: string, ops: ToolItem[]): FileChangeItem {
  return {
    type: 'file-change',
    anchorUuid: ops[0]?.anchorUuid ?? 'u',
    path,
    ops,
    ts: '2026-05-19T00:00:00Z',
  };
}

describe('<FileChangeLightbox>', () => {
  it('renders the file path as the title', () => {
    render(
      <FileChangeLightbox item={fileChange('/tmp/x.ts', [op('Read', {}, 'line1\nline2')])} />,
    );
    expect(screen.getByText('/tmp/x.ts')).toBeInTheDocument();
  });

  it('summarizes op counts', () => {
    render(
      <FileChangeLightbox
        item={fileChange('/x', [
          op('Read', {}, 'a'),
          op('Edit', { old_string: 'a', new_string: 'b' }),
          op('Edit', { old_string: 'b', new_string: 'c' }),
        ])}
      />,
    );
    expect(screen.getByText(/3 operations/)).toBeInTheDocument();
    expect(screen.getByText(/2 Edit/)).toBeInTheDocument();
  });

  it('renders Edit hunks as +/- diff lines', () => {
    const { container } = render(
      <FileChangeLightbox
        item={fileChange('/x', [op('Edit', { old_string: 'old', new_string: 'new' })])}
      />,
    );
    expect(container.querySelector('.diff-del')).toHaveTextContent('old');
    expect(container.querySelector('.diff-add')).toHaveTextContent('new');
  });

  it('Write op renders as add-only diff against an empty before', () => {
    const { container } = render(
      <FileChangeLightbox
        item={fileChange('/x', [op('Write', { content: 'whole new file' })])}
      />,
    );
    expect(container.querySelector('.diff-del')).toBeNull();
    expect(container.querySelector('.diff-add')).toHaveTextContent('whole new file');
  });

  it('Read op shows the line count when content is a string', () => {
    render(
      <FileChangeLightbox
        item={fileChange('/x', [op('Read', {}, 'one\ntwo\nthree')])}
      />,
    );
    expect(screen.getByText(/3 lines/)).toBeInTheDocument();
  });

  it('MultiEdit renders one diff per sub-edit', () => {
    const { container } = render(
      <FileChangeLightbox
        item={fileChange('/x', [
          op('MultiEdit', {
            edits: [
              { old_string: 'a', new_string: 'A' },
              { old_string: 'b', new_string: 'B' },
            ],
          }),
        ])}
      />,
    );
    // Two diffs → two `.diff-del` + two `.diff-add` (one per sub-edit).
    expect(container.querySelectorAll('.diff-del').length).toBe(2);
    expect(container.querySelectorAll('.diff-add').length).toBe(2);
  });
});
