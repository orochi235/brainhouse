import { describe, expect, it } from 'vitest';
import { reconstructFile } from './fileSnapshot.ts';
import type { ToolItem } from './pipeline-types.ts';

let uid = 0;
function op(name: string, input: Record<string, unknown>, result?: string): ToolItem {
  uid += 1;
  return {
    type: 'tool',
    anchorUuid: `u${uid}`,
    use: { tool_use_id: `t${uid}`, name, input },
    result:
      result !== undefined ? { tool_use_id: `t${uid}`, content: result, is_error: false } : null,
    ack: null,
    ts: '2026-05-24T00:00:00Z',
  };
}

/** Build a `cat -n` style Read result starting at the given line number. */
function catN(start: number, lines: string[]): string {
  return lines.map((l, i) => `${String(start + i).padStart(6, ' ')}\t${l}`).join('\n');
}

describe('reconstructFile', () => {
  it('Edit after Read uses absolute line numbers from the cat -n result', () => {
    const ops = [
      op('Read', { file_path: '/x' }, catN(1, ['alpha', 'beta', 'gamma', 'delta'])),
      op('Edit', { file_path: '/x', old_string: 'beta\ngamma', new_string: 'BETA\nGAMMA' }),
    ];
    const r = reconstructFile(ops);
    expect(r[0]).toMatchObject({ kind: 'read' });
    if (r[1]?.kind !== 'edit') throw new Error('expected edit');
    const h = r[1].hunks[0]!;
    expect(h.lineMode).toBe('absolute');
    expect(h.oldStart).toBe(2);
    expect(h.newStart).toBe(2);
    expect(h.contextBefore).toEqual(['alpha']);
    expect(h.contextAfter).toEqual(['delta']);
  });

  it('Read with an offset preserves the absolute start line', () => {
    const ops = [
      op('Read', { file_path: '/x', offset: 100 }, catN(100, ['line100', 'line101', 'line102'])),
      op('Edit', { file_path: '/x', old_string: 'line101', new_string: 'CHANGED' }),
    ];
    const r = reconstructFile(ops);
    if (r[1]?.kind !== 'edit') throw new Error('expected edit');
    expect(r[1].hunks[0]!.oldStart).toBe(101);
  });

  it('sequential MultiEdit edits each operate on the running snapshot', () => {
    const ops = [
      op('Read', { file_path: '/x' }, catN(1, ['a', 'b', 'c', 'd', 'e'])),
      op('MultiEdit', {
        file_path: '/x',
        edits: [
          { old_string: 'b', new_string: 'B1\nB2' }, // grows by 1 line
          { old_string: 'd', new_string: 'D' }, // now at line 5 due to growth
        ],
      }),
    ];
    const r = reconstructFile(ops);
    if (r[1]?.kind !== 'edit') throw new Error('expected edit');
    expect(r[1].hunks).toHaveLength(2);
    expect(r[1].hunks[0]!.oldStart).toBe(2);
    expect(r[1].hunks[1]!.oldStart).toBe(5); // shifted by the previous edit
  });

  it('Edit without a preceding Read falls back to relative numbering', () => {
    const ops = [op('Edit', { file_path: '/x', old_string: 'foo', new_string: 'bar' })];
    const r = reconstructFile(ops);
    if (r[0]?.kind !== 'edit') throw new Error('expected edit');
    expect(r[0].hunks[0]!.lineMode).toBe('relative');
    expect(r[0].hunks[0]!.oldStart).toBe(1);
  });

  it('Write following a Read yields a true diff against the prior snapshot', () => {
    const ops = [
      op('Read', { file_path: '/x' }, catN(1, ['old1', 'old2'])),
      op('Write', { file_path: '/x', content: 'new1\nnew2' }),
    ];
    const r = reconstructFile(ops);
    if (r[1]?.kind !== 'write') throw new Error('expected write');
    expect(r[1].isFullReplace).toBe(true);
    expect(r[1].hunks[0]!.oldText).toBe('old1\nold2');
    expect(r[1].hunks[0]!.newText).toBe('new1\nnew2');
  });

  it('Write without prior content is an all-add (relative mode)', () => {
    const ops = [op('Write', { file_path: '/x', content: 'fresh' })];
    const r = reconstructFile(ops);
    if (r[0]?.kind !== 'write') throw new Error('expected write');
    expect(r[0].isFullReplace).toBe(false);
    expect(r[0].hunks[0]!.oldText).toBe('');
    expect(r[0].hunks[0]!.newText).toBe('fresh');
  });
});
