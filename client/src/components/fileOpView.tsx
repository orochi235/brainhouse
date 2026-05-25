/**
 * Renderers for a single file-op (Read/Edit/MultiEdit/Write) as a real
 * split-pane diff with absolute line numbers when available. Shared
 * between `FileChangeLightbox` (single-file zoomed view) and
 * `OpStripLightbox` (multi-file view-mode toggle).
 *
 * Absolute line numbering, snapshot replay, and ±3 lines of surrounding
 * context all live in `lib/fileSnapshot.ts`. Diff rendering itself lives
 * in `<DiffTable>`. This module is purely the per-op header + dispatch.
 */

import type { OpRender } from '../lib/fileSnapshot.ts';
import type { FileChangeItem } from '../lib/pipeline.ts';
import { DiffTable } from './DiffTable.tsx';

export function OpView({ op, render }: { op: FileChangeItem['ops'][number]; render: OpRender }) {
  const name = op.use?.name ?? '?';

  if (render.kind === 'read') {
    return (
      <section className="file-change-hunk file-change-hunk-read">
        <header>Read{render.lines !== null ? ` · ${render.lines} lines` : ''}</header>
      </section>
    );
  }

  if (render.kind === 'edit') {
    const subCount =
      name === 'MultiEdit'
        ? Array.isArray((op.use?.input as { edits?: unknown[] } | undefined)?.edits)
          ? ((op.use?.input as { edits?: unknown[] }).edits as unknown[]).length
          : render.hunks.length
        : 0;
    const label = name === 'MultiEdit' ? `MultiEdit · ${subCount} edits` : 'Edit';
    return (
      <section className="file-change-hunk">
        <header>{label}</header>
        {render.hunks.map((h, i) => (
          <DiffTable key={i} hunk={h} />
        ))}
      </section>
    );
  }

  if (render.kind === 'write') {
    const label = render.isFullReplace ? 'Write · diff vs prior content' : 'Write · entire file';
    return (
      <section className="file-change-hunk">
        <header>{label}</header>
        {render.hunks.map((h, i) => (
          <DiffTable key={i} hunk={h} />
        ))}
      </section>
    );
  }

  // Unknown tool — fall back to a raw input dump.
  const input = (op.use?.input ?? {}) as Record<string, unknown>;
  return (
    <section className="file-change-hunk">
      <header>{name}</header>
      <pre className="file-change-raw">{JSON.stringify(input, null, 2)}</pre>
    </section>
  );
}

export function lineCount(content: unknown): number | null {
  if (typeof content !== 'string') return null;
  if (!content) return 0;
  return content.split('\n').filter(Boolean).length;
}

export function summarizeFileChange(item: FileChangeItem): string {
  const counts: Record<string, number> = {};
  for (const op of item.ops) {
    const n = op.use?.name ?? '?';
    counts[n] = (counts[n] ?? 0) + 1;
  }
  return ['Read', 'Edit', 'MultiEdit', 'Write']
    .filter((n) => counts[n])
    .map((n) => `${counts[n]} ${n}`)
    .join(', ');
}
