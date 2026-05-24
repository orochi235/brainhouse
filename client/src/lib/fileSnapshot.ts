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
      const hunks: DiffHunk[] = [];
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue;
        const r = e as Record<string, unknown>;
        const oldStr = typeof r.old_string === 'string' ? r.old_string : '';
        const newStr = typeof r.new_string === 'string' ? r.new_string : '';
        hunks.push(applyEditToSnapshot(snapshot, oldStr, newStr));
      }
      return { kind: 'edit', hunks };
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

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').filter(Boolean).length;
}
