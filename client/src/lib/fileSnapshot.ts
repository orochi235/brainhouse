/**
 * Per-file content reconstruction for `<FileChangeLightbox>` / `<OpStripLightbox>`.
 *
 * Given a `FileChangeItem.ops` (an ordered list of Read/Edit/MultiEdit/Write
 * tool calls for a single path), walks the ops and replays them on a
 * running snapshot. Output is a parallel array of `OpRender` records: each
 * carries the hunks needed to render the op as a real split-pane diff with
 * absolute line numbers when possible.
 *
 * Absolute line numbers come from Claude Code's `Read` tool result, which
 * is `cat -n` formatted ("     N\tcontent"). When no preceding Read is
 * available (or `old_string` can't be located), we fall back to
 * `lineMode: 'relative'` and number 1..N within the fragment.
 *
 * Snapshots are kept on each op so a future "whole-file" view can render
 * the full file with the op's hunk highlighted in place.
 */

import { diffLines } from 'diff';
import type { ToolItem } from './pipeline-types.ts';

const CONTEXT_LINES = 3;

export interface DiffHunk {
  /** Text removed. Empty for additions-only writes. */
  oldText: string;
  /** Text inserted. Empty for deletions-only (rare in practice). */
  newText: string;
  /** Line number where `oldText` begins on the OLD side (1-based). */
  oldStart: number;
  /** Line number where `newText` begins on the NEW side (1-based). */
  newStart: number;
  /** 'absolute' = real file positions; 'relative' = 1..N within fragment. */
  lineMode: 'absolute' | 'relative';
  /** Up to `CONTEXT_LINES` unchanged lines preceding `oldText`. Only set in absolute mode. */
  contextBefore: string[];
  /** Up to `CONTEXT_LINES` unchanged lines following `oldText`. Only set in absolute mode. */
  contextAfter: string[];
}

export type OpRender =
  | { kind: 'read'; lines: number | null }
  | { kind: 'edit'; hunks: DiffHunk[] }
  | { kind: 'write'; hunks: DiffHunk[]; isFullReplace: boolean }
  | { kind: 'unknown'; name: string };

export function reconstructFile(ops: ToolItem[]): OpRender[] {
  // Snapshot: sparse map of lineNumber → content. Contiguous from `baseLine`
  // when populated by a Read; cleared and rebuilt on Edit/MultiEdit/Write.
  const snapshot: { baseLine: number; lines: string[] } = { baseLine: 1, lines: [] };

  return ops.map((op): OpRender => {
    const use = op.use;
    if (!use) return { kind: 'unknown', name: '?' };
    const name = use.name;
    const input = (use.input ?? {}) as Record<string, unknown>;

    if (name === 'Read') {
      const content = op.result?.content;
      if (typeof content === 'string') applyReadToSnapshot(snapshot, content);
      return { kind: 'read', lines: typeof content === 'string' ? countLines(content) : null };
    }

    if (name === 'Edit') {
      const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
      const newStr = typeof input.new_string === 'string' ? input.new_string : '';
      const hunk = applyEditToSnapshot(snapshot, oldStr, newStr);
      return { kind: 'edit', hunks: [hunk] };
    }

    if (name === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      // Capture pre-text + base line so we can compute a single merged diff
      // across all sub-edits after they're applied.
      const hadSnapshot = snapshotIsContiguous(snapshot);
      const preText = hadSnapshot ? snapshotText(snapshot) : '';
      const preBase = snapshot.baseLine;
      const fallbackHunks: DiffHunk[] = [];
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue;
        const r = e as Record<string, unknown>;
        const oldStr = typeof r.old_string === 'string' ? r.old_string : '';
        const newStr = typeof r.new_string === 'string' ? r.new_string : '';
        fallbackHunks.push(applyEditToSnapshot(snapshot, oldStr, newStr));
      }
      // If we had no usable snapshot, the per-edit hunks (in relative mode)
      // are the best we can do.
      if (!hadSnapshot) return { kind: 'edit', hunks: fallbackHunks };
      const postText = snapshotText(snapshot);
      const merged = splitDiffIntoHunks(preText, postText, preBase, preBase);
      // If the merger produced nothing (e.g. all edits failed to locate),
      // fall back to per-edit hunks.
      return { kind: 'edit', hunks: merged.length > 0 ? merged : fallbackHunks };
    }

    if (name === 'Write') {
      const content = typeof input.content === 'string' ? input.content : '';
      const priorText = snapshotIsContiguous(snapshot) ? snapshotText(snapshot) : '';
      const isFullReplace = priorText !== '';
      // Rebuild snapshot from the new content.
      snapshot.baseLine = 1;
      snapshot.lines = content === '' ? [] : content.split('\n');
      const hunk: DiffHunk = {
        oldText: priorText,
        newText: content,
        oldStart: 1,
        newStart: 1,
        lineMode: isFullReplace ? 'absolute' : 'relative',
        contextBefore: [],
        contextAfter: [],
      };
      return { kind: 'write', hunks: [hunk], isFullReplace };
    }

    return { kind: 'unknown', name };
  });
}

function applyReadToSnapshot(
  snapshot: { baseLine: number; lines: string[] },
  catNContent: string,
): void {
  const parsed = parseCatN(catNContent);
  if (!parsed) {
    // Couldn't parse — leave snapshot alone. Future Edits in this group will
    // fall back to relative numbering.
    return;
  }
  // Each Read replaces our knowledge with that read's contiguous range.
  // (We don't try to merge overlapping reads — typical sessions do one full
  // Read followed by Edits, and partial Reads usually precede targeted Edits.)
  snapshot.baseLine = parsed.startLine;
  snapshot.lines = parsed.lines;
}

function applyEditToSnapshot(
  snapshot: { baseLine: number; lines: string[] },
  oldStr: string,
  newStr: string,
): DiffHunk {
  const fallback = (): DiffHunk => ({
    oldText: oldStr,
    newText: newStr,
    oldStart: 1,
    newStart: 1,
    lineMode: 'relative',
    contextBefore: [],
    contextAfter: [],
  });

  if (snapshot.lines.length === 0) return fallback();
  const before = snapshot.lines.join('\n');
  const idx = before.indexOf(oldStr);
  if (idx === -1) return fallback();

  const linesBeforeMatch = before.slice(0, idx).split('\n');
  const offsetWithinFirstLine = linesBeforeMatch[linesBeforeMatch.length - 1]?.length ?? 0;
  // If the match doesn't start at a line boundary, fall back — line-level
  // diffing would be inaccurate. (cat -n style edits virtually always
  // align to a line start, but be defensive.)
  if (offsetWithinFirstLine !== 0) return fallback();
  const startLine = snapshot.baseLine + linesBeforeMatch.length - 1;
  const oldLineCount = oldStr === '' ? 0 : oldStr.split('\n').length;

  const after = before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
  const afterLines = after === '' ? [] : after.split('\n');

  // Gather context from the pre-edit snapshot lines around the match.
  const startIdx = linesBeforeMatch.length - 1; // 0-based index in snapshot.lines
  const endIdx = startIdx + oldLineCount; // exclusive
  const contextBefore = snapshot.lines.slice(Math.max(0, startIdx - CONTEXT_LINES), startIdx);
  const contextAfter = snapshot.lines.slice(endIdx, endIdx + CONTEXT_LINES);

  snapshot.lines = afterLines;
  // baseLine unchanged — the file's first known line hasn't moved.

  return {
    oldText: oldStr,
    newText: newStr,
    oldStart: startLine,
    newStart: startLine,
    lineMode: 'absolute',
    contextBefore,
    contextAfter,
  };
}

function parseCatN(content: string): { startLine: number; lines: string[] } | null {
  if (!content) return null;
  const raw = content.split('\n');
  // Strip optional trailing empty line from `split`.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const result: string[] = [];
  let startLine: number | null = null;
  for (const line of raw) {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    if (!m) {
      // Trailing system-reminder block or a non-numbered footer — stop here.
      if (startLine === null) return null;
      break;
    }
    const n = Number.parseInt(m[1] ?? '', 10);
    if (startLine === null) startLine = n;
    result.push(m[2] ?? '');
  }
  if (startLine === null) return null;
  return { startLine, lines: result };
}

function snapshotIsContiguous(snapshot: { baseLine: number; lines: string[] }): boolean {
  return snapshot.lines.length > 0;
}

function snapshotText(snapshot: { baseLine: number; lines: string[] }): string {
  return snapshot.lines.join('\n');
}

/** Diff `oldText` vs `newText` and split the result into one hunk per
 * change region. Regions are separated by runs of unchanged lines longer
 * than `2 * contextLines` (so adjacent edits naturally merge). Each
 * emitted hunk's oldText/newText already include up to `contextLines`
 * lines of surrounding unchanged context — DiffTable will re-diff them
 * to render with proper alignment.
 *
 * Returns `[]` if the two texts are identical.
 */
function splitDiffIntoHunks(
  oldText: string,
  newText: string,
  oldStartLine: number,
  newStartLine: number,
  contextLines: number = CONTEXT_LINES,
): DiffHunk[] {
  if (oldText === newText) return [];
  const parts = diffLines(oldText, newText);
  type Op =
    | { t: 'eq'; line: string; oldN: number; newN: number }
    | { t: 'del'; line: string; oldN: number }
    | { t: 'add'; line: string; newN: number };
  const ops: Op[] = [];
  let oldN = oldStartLine;
  let newN = newStartLine;
  for (const p of parts) {
    const lines = splitNoTrailing(p.value);
    if (p.added) for (const l of lines) ops.push({ t: 'add', line: l, newN: newN++ });
    else if (p.removed) for (const l of lines) ops.push({ t: 'del', line: l, oldN: oldN++ });
    else for (const l of lines) ops.push({ t: 'eq', line: l, oldN: oldN++, newN: newN++ });
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === 'eq') {
      i++;
      continue;
    }
    // Walk forward, swallowing eq runs of size <= 2*contextLines.
    let j = i + 1;
    let lastChange = i;
    while (j < ops.length) {
      if (ops[j]!.t !== 'eq') {
        lastChange = j;
        j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k]!.t === 'eq') k++;
      const gap = k - j;
      if (gap > contextLines * 2 || k === ops.length) break;
      j = k;
    }
    // Region of changes is [i, lastChange+1). Add up to `contextLines`
    // of equal lines on either side.
    const regionStart = Math.max(0, i - contextLines);
    let cbCount = 0;
    let cbCursor = i;
    while (cbCursor > regionStart && ops[cbCursor - 1]!.t === 'eq' && cbCount < contextLines) {
      cbCursor--;
      cbCount++;
    }
    let caCursor = lastChange + 1;
    let caCount = 0;
    while (caCursor < ops.length && ops[caCursor]!.t === 'eq' && caCount < contextLines) {
      caCursor++;
      caCount++;
    }

    const sliceForOld: string[] = [];
    const sliceForNew: string[] = [];
    let firstOldN: number | null = null;
    let firstNewN: number | null = null;
    for (let p2 = cbCursor; p2 < caCursor; p2++) {
      const op = ops[p2]!;
      if (op.t === 'eq') {
        sliceForOld.push(op.line);
        sliceForNew.push(op.line);
        if (firstOldN === null) firstOldN = op.oldN;
        if (firstNewN === null) firstNewN = op.newN;
      } else if (op.t === 'del') {
        sliceForOld.push(op.line);
        if (firstOldN === null) firstOldN = op.oldN;
      } else {
        sliceForNew.push(op.line);
        if (firstNewN === null) firstNewN = op.newN;
      }
    }
    hunks.push({
      oldText: sliceForOld.join('\n'),
      newText: sliceForNew.join('\n'),
      oldStart: firstOldN ?? oldStartLine,
      newStart: firstNewN ?? newStartLine,
      lineMode: 'absolute',
      contextBefore: [],
      contextAfter: [],
    });

    i = caCursor;
  }
  return hunks;
}

/** Total added / removed lines across all renders of an op sequence.
 * Counts lines on the +/- sides of each hunk — for `kind: 'edit'` and
 * `kind: 'write'` (with `isFullReplace: true`) we run `diffLines` on
 * each hunk's old/new text to avoid double-counting lines that are
 * equal but inside a "change" hunk. Read ops contribute nothing. */
export function diffStats(renders: OpRender[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const r of renders) {
    if (r.kind === 'read' || r.kind === 'unknown') continue;
    for (const h of r.hunks) {
      const parts = diffLines(h.oldText, h.newText);
      for (const p of parts) {
        if (!p.added && !p.removed) continue;
        const lines = splitNoTrailing(p.value).length;
        if (p.added) adds += lines;
        else if (p.removed) dels += lines;
      }
    }
  }
  return { adds, dels };
}

function splitNoTrailing(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').filter(Boolean).length;
}
