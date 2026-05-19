/**
 * Zoomed-in view of a coalesced file-change. Each op renders chronologically:
 *   - Read:      tiny "read N lines" note
 *   - Edit:      a unified-diff style hunk (old_string above, new_string below)
 *   - MultiEdit: each sub-edit as its own hunk
 *   - Write:     the new file content as one big "all replaced" hunk
 */

import type { FileChangeItem } from '../lib/pipeline.ts';

export function FileChangeLightbox({ item }: { item: FileChangeItem }) {
  return (
    <div className="file-change-lightbox">
      <h3 className="lightbox-title">{item.path}</h3>
      <p className="file-change-subtitle">
        {item.ops.length} operations · {summarize(item)}
      </p>
      <div className="file-change-hunks">
        {item.ops.map((op, i) => (
          <OpView key={`${op.anchorUuid}-${i}`} op={op} />
        ))}
      </div>
    </div>
  );
}

function OpView({ op }: { op: FileChangeItem['ops'][number] }) {
  const use = op.use;
  if (!use) return null;
  const name = use.name;
  const input = (use.input ?? {}) as Record<string, unknown>;
  if (name === 'Read') {
    const lines = lineCount(op.result?.content);
    return (
      <section className="file-change-hunk file-change-hunk-read">
        <header>Read{lines !== null ? ` · ${lines} lines` : ''}</header>
      </section>
    );
  }
  if (name === 'Edit') {
    return (
      <section className="file-change-hunk">
        <header>Edit</header>
        <Diff
          before={typeof input.old_string === 'string' ? input.old_string : ''}
          after={typeof input.new_string === 'string' ? input.new_string : ''}
        />
      </section>
    );
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return (
      <section className="file-change-hunk">
        <header>MultiEdit · {edits.length} edits</header>
        {edits.map((edit, i) => {
          if (!edit || typeof edit !== 'object') return null;
          const e = edit as Record<string, unknown>;
          return (
            <Diff
              key={i}
              before={typeof e.old_string === 'string' ? e.old_string : ''}
              after={typeof e.new_string === 'string' ? e.new_string : ''}
            />
          );
        })}
      </section>
    );
  }
  if (name === 'Write') {
    return (
      <section className="file-change-hunk">
        <header>Write · entire file</header>
        <Diff before="" after={typeof input.content === 'string' ? input.content : ''} />
      </section>
    );
  }
  return (
    <section className="file-change-hunk">
      <header>{name}</header>
      <pre className="file-change-raw">{JSON.stringify(input, null, 2)}</pre>
    </section>
  );
}

/** Naive unified-diff renderer: shows the before block as `-` lines, then
 * the after block as `+` lines. Good-enough for the common Edit case where
 * old_string and new_string are localized; a real LCS-based diff can come
 * later. */
function Diff({ before, after }: { before: string; after: string }) {
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');
  return (
    <pre className="file-change-diff">
      {beforeLines.map((l, i) => (
        <div key={`b${i}`} className="diff-del">
          <span className="diff-marker">-</span>
          {l}
        </div>
      ))}
      {afterLines.map((l, i) => (
        <div key={`a${i}`} className="diff-add">
          <span className="diff-marker">+</span>
          {l}
        </div>
      ))}
    </pre>
  );
}

function summarize(item: FileChangeItem): string {
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

function lineCount(content: unknown): number | null {
  if (typeof content !== 'string') return null;
  if (!content) return 0;
  return content.split('\n').filter(Boolean).length;
}
