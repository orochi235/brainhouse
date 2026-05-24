/**
 * Split-pane diff renderer for a single Edit/MultiEdit/Write hunk.
 *
 * Two-column table: `[old #][old line] | [new #][new line]`. Uses
 * `diffLines` from the `diff` package so unchanged lines line up across
 * both sides; consecutive deletions and additions are paired into
 * "change" rows (GitHub PR split-view style).
 *
 * When the hunk has `lineMode: 'absolute'`, up to 3 unchanged lines of
 * `contextBefore` / `contextAfter` (from the file snapshot) bracket the
 * change so the reader can see what surrounds it. In relative mode the
 * fragment renders on its own with 1..N numbering.
 */

import { diffLines } from 'diff';
import type { DiffHunk } from '../lib/fileSnapshot.ts';

type Row =
  | { kind: 'equal'; oldNum: number; newNum: number; text: string }
  | {
      kind: 'change';
      oldNum: number | null;
      oldText: string | null;
      newNum: number | null;
      newText: string | null;
    };

export function DiffTable({ hunk }: { hunk: DiffHunk }) {
  const rows = buildRows(hunk);
  return (
    <table className={`diff-table${hunk.lineMode === 'relative' ? ' diff-table-relative' : ''}`}>
      <colgroup>
        <col className="diff-gutter-col" />
        <col className="diff-line-col" />
        <col className="diff-gutter-col" />
        <col className="diff-line-col" />
      </colgroup>
      <tbody>
        {rows.map((r, i) => (
          <DiffRow key={i} row={r} />
        ))}
      </tbody>
    </table>
  );
}

function DiffRow({ row }: { row: Row }) {
  if (row.kind === 'equal') {
    return (
      <tr className="diff-row diff-row-equal">
        <td className="diff-gutter">{row.oldNum}</td>
        <td className="diff-cell">{row.text || ' '}</td>
        <td className="diff-gutter">{row.newNum}</td>
        <td className="diff-cell">{row.text || ' '}</td>
      </tr>
    );
  }
  return (
    <tr className="diff-row diff-row-change">
      <td className={`diff-gutter${row.oldText !== null ? ' diff-gutter-del' : ''}`}>
        {row.oldNum ?? ''}
      </td>
      <td className={`diff-cell${row.oldText !== null ? ' diff-cell-del' : ' diff-cell-empty'}`}>
        {row.oldText ?? ' '}
      </td>
      <td className={`diff-gutter${row.newText !== null ? ' diff-gutter-add' : ''}`}>
        {row.newNum ?? ''}
      </td>
      <td className={`diff-cell${row.newText !== null ? ' diff-cell-add' : ' diff-cell-empty'}`}>
        {row.newText ?? ' '}
      </td>
    </tr>
  );
}

function buildRows(hunk: DiffHunk): Row[] {
  // Bookend the fragment with surrounding context (absolute mode only).
  const ctxBefore = hunk.lineMode === 'absolute' ? hunk.contextBefore : [];
  const ctxAfter = hunk.lineMode === 'absolute' ? hunk.contextAfter : [];
  const oldWithCtx = joinLines([...ctxBefore, splitNoTrailing(hunk.oldText), ...ctxAfter]);
  const newWithCtx = joinLines([...ctxBefore, splitNoTrailing(hunk.newText), ...ctxAfter]);

  // Numbering starts at the first context line on each side (or at the
  // hunk start if there's no context).
  const oldBase = hunk.oldStart - ctxBefore.length;
  const newBase = hunk.newStart - ctxBefore.length;

  const parts = diffLines(oldWithCtx, newWithCtx);

  // First pass: flat list of per-line "ops" with line numbers assigned.
  type Op =
    | { t: 'eq'; line: string; oldN: number; newN: number }
    | { t: 'del'; line: string; oldN: number }
    | { t: 'add'; line: string; newN: number };
  const ops: Op[] = [];
  let oldN = oldBase;
  let newN = newBase;
  for (const part of parts) {
    const lines = splitNoTrailing(part.value);
    if (part.added) {
      for (const l of lines) ops.push({ t: 'add', line: l, newN: newN++ });
    } else if (part.removed) {
      for (const l of lines) ops.push({ t: 'del', line: l, oldN: oldN++ });
    } else {
      for (const l of lines) ops.push({ t: 'eq', line: l, oldN: oldN++, newN: newN++ });
    }
  }

  // Second pass: pair adjacent del-run with add-run into split-view rows.
  const rows: Row[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.t === 'eq') {
      rows.push({ kind: 'equal', oldNum: op.oldN, newNum: op.newN, text: op.line });
      i++;
      continue;
    }
    // Collect a maximal run of dels followed by a run of adds.
    const dels: Array<{ line: string; oldN: number }> = [];
    while (i < ops.length && ops[i]!.t === 'del') {
      const d = ops[i] as { t: 'del'; line: string; oldN: number };
      dels.push({ line: d.line, oldN: d.oldN });
      i++;
    }
    const adds: Array<{ line: string; newN: number }> = [];
    while (i < ops.length && ops[i]!.t === 'add') {
      const a = ops[i] as { t: 'add'; line: string; newN: number };
      adds.push({ line: a.line, newN: a.newN });
      i++;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({
        kind: 'change',
        oldNum: d ? d.oldN : null,
        oldText: d ? d.line : null,
        newNum: a ? a.newN : null,
        newText: a ? a.line : null,
      });
    }
  }

  return rows;
}

function splitNoTrailing(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(groups: Array<string | string[]>): string {
  const flat: string[] = [];
  for (const g of groups) {
    if (Array.isArray(g)) flat.push(...g);
    else flat.push(g);
  }
  return flat.join('\n');
}
