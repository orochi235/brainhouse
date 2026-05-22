import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilenameLinksProvider } from '../lib/filenameLinksContext.tsx';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { FileChangeItem, OpStripItem, ToolItem } from '../lib/pipeline.ts';
import { buildTree, groupByFile, OpStripLightbox } from './OpStripLightbox.tsx';

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

function strip(items: OpStripItem['items']): OpStripItem {
  return { type: 'op-strip', anchorUuid: 'op', items, ts: '2026-05-19T00:00:00Z' };
}

function renderLb(item: OpStripItem) {
  return render(
    <LightboxProvider>
      <FilenameLinksProvider cwd={null} template="">
        <OpStripLightbox item={item} title="3 operations" />
      </FilenameLinksProvider>
    </LightboxProvider>,
  );
}

describe('groupByFile', () => {
  it('separates file-change items from everything else', () => {
    const a = fileChange('/a.ts', [op('Edit', { old_string: 'x', new_string: 'y' })]);
    const bash = op('Bash', { command: 'ls' }, 'out');
    const { files, nonFile } = groupByFile([a, bash]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/a.ts');
    expect(nonFile).toHaveLength(1);
    expect(nonFile[0]).toBe(bash);
  });

  it('merges multiple file-change items for the same path', () => {
    const a1 = fileChange('/a.ts', [op('Edit', { old_string: 'x', new_string: 'y' })]);
    const a2 = fileChange('/a.ts', [op('Edit', { old_string: 'y', new_string: 'z' })]);
    const { files } = groupByFile([a1, a2]);
    expect(files).toHaveLength(1);
    expect(files[0].ops).toHaveLength(2);
  });
});

describe('buildTree', () => {
  it('collapses single-child directory chains', () => {
    const tree = buildTree(['/Users/x/src/a.ts', '/Users/x/src/b.ts']);
    // The whole /Users/x/src prefix collapses into one node.
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].name).toBe('Users/x/src');
    expect(tree.children[0].children.map((c) => c.name).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('branches where paths diverge', () => {
    const tree = buildTree(['/a/x.ts', '/b/y.ts']);
    const names = tree.children.map((c) => c.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('<OpStripLightbox>', () => {
  it('defaults to conversation view', () => {
    renderLb(strip([fileChange('/a.ts', [op('Edit', { old_string: 'x', new_string: 'y' })])]));
    expect(screen.getByRole('button', { name: /conversation/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('toggling to file view shows the tree, a default selection, and the non-file summary', () => {
    renderLb(
      strip([
        fileChange('/src/a.ts', [op('Edit', { old_string: 'x', new_string: 'y' })]),
        fileChange('/src/b.ts', [op('Write', { content: 'hello' })]),
        op('Bash', { command: 'ls' }, 'out'),
        op('Grep', { pattern: 'foo' }, 'match'),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /^file$/i }));
    // Both files appear in the tree as buttons.
    expect(screen.getByRole('button', { name: 'a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'b.ts' })).toBeInTheDocument();
    // First file is auto-selected.
    expect(screen.getByRole('button', { name: 'a.ts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/Also:.*Bash/)).toBeInTheDocument();
    expect(screen.getByText(/Also:.*Grep/)).toBeInTheDocument();
  });

  it('clicking a file in the tree switches the right pane', () => {
    renderLb(
      strip([
        fileChange('/src/a.ts', [op('Edit', { old_string: 'aa', new_string: 'AA' })]),
        fileChange('/src/b.ts', [op('Write', { content: 'BB' })]),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /^file$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
    expect(screen.getByRole('button', { name: 'b.ts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Right pane now reflects b.ts (Write op header).
    expect(screen.getByText(/Write · entire file/)).toBeInTheDocument();
  });

  it('file view with no file ops shows empty message', () => {
    renderLb(strip([op('Bash', { command: 'ls' }, 'out')]));
    fireEvent.click(screen.getByRole('button', { name: /^file$/i }));
    expect(screen.getByText(/No file changes/i)).toBeInTheDocument();
  });
});
