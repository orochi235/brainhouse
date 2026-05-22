/**
 * Zoomed-in view of an op-strip (the compact one-liner that wraps
 * everything between two chat bubbles). Offers two view modes:
 *
 *   - conversation (default): renders sub-items chronologically as they
 *     happened — same as the panel view.
 *   - file: regroups file-changes by path. A directory tree on the left
 *     picks which file's hunks render on the right. Single-chain
 *     directories are collapsed so dense paths don't waste vertical
 *     space. Non-file ops collapse into a summary strip above the split.
 *
 * View mode and the selected file are session-local (reset when the
 * lightbox closes).
 */
import { useMemo, useState } from 'react';
import { LinkifyText } from '../lib/filenameLinksContext.tsx';
import type { FileChangeItem, OpStripItem, ToolItem, ViewItem } from '../lib/pipeline.ts';
import { ViewItemList } from './EventList.tsx';
import { OpView, summarizeFileChange } from './fileOpView.tsx';
import { ToolChip, ToolChips } from './ToolChips.tsx';

type ViewMode = 'conversation' | 'file';

export function OpStripLightbox({
  item,
  startedAt,
  title,
}: {
  item: OpStripItem;
  startedAt?: number;
  title: string;
}) {
  const [mode, setMode] = useState<ViewMode>('conversation');
  return (
    <div className="op-strip-lightbox">
      <div className="lightbox-title-row">
        <h3 className="lightbox-title">{title}</h3>
        <ToolChips>
          <ToolChip
            aria-pressed={mode === 'conversation'}
            onClick={() => setMode('conversation')}
            title="Show sub-items in the order they happened"
          >
            Conversation
          </ToolChip>
          <ToolChip
            aria-pressed={mode === 'file'}
            onClick={() => setMode('file')}
            title="Browse file changes via a directory tree"
          >
            File
          </ToolChip>
        </ToolChips>
      </div>
      {mode === 'conversation' ? (
        <ViewItemList items={item.items} startedAt={startedAt} />
      ) : (
        <FileView items={item.items} />
      )}
    </div>
  );
}

function FileView({ items }: { items: ViewItem[] }) {
  const { files, nonFile } = useMemo(() => groupByFile(items), [items]);
  const tree = useMemo(() => buildTree(files.map((f) => f.path)), [files]);
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const selectedFile = files.find((f) => f.path === selected) ?? null;

  if (files.length === 0) {
    return (
      <div className="op-strip-file-view">
        {nonFile.length > 0 && <NonFileSummary items={nonFile} />}
        <p className="op-strip-empty">No file changes in this batch.</p>
      </div>
    );
  }

  return (
    <div className="op-strip-file-view">
      {nonFile.length > 0 && <NonFileSummary items={nonFile} />}
      <div className="op-strip-file-split">
        <aside className="op-strip-file-tree" aria-label="affected files">
          <TreeView node={tree} selected={selected} onSelect={setSelected} depth={0} />
        </aside>
        <div className="op-strip-file-pane">
          {selectedFile ? (
            <FileSection file={selectedFile} />
          ) : (
            <p className="op-strip-empty">Select a file from the tree.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function FileSection({ file }: { file: FileChangeItem }) {
  return (
    <section className="op-strip-file-section">
      <h4 className="op-strip-file-path">
        <LinkifyText text={file.path} />
      </h4>
      <p className="file-change-subtitle">
        {file.ops.length} operation{file.ops.length === 1 ? '' : 's'} ·{' '}
        {summarizeFileChange(file)}
      </p>
      <div className="file-change-hunks">
        {file.ops.map((op, i) => (
          <OpView key={`${op.anchorUuid}-${i}`} op={op} />
        ))}
      </div>
    </section>
  );
}

function NonFileSummary({ items }: { items: ViewItem[] }) {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const label = labelFor(it);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name}`)
    .join(' · ');
  return <p className="op-strip-nonfile-summary">Also: {summary}</p>;
}

function labelFor(item: ViewItem): string {
  if (item.type === 'tool') return (item as ToolItem).use?.name ?? 'tool';
  if (item.type === 'bubble') return item.role === 'user' ? 'user msg' : 'assistant msg';
  return item.type;
}

/** Group file-change items by path, leaving everything else in `nonFile`.
 * Multiple FileChangeItems for the same path (rare but possible across
 * non-adjacent ops) merge into one section. */
export function groupByFile(items: ViewItem[]): {
  files: FileChangeItem[];
  nonFile: ViewItem[];
} {
  const byPath = new Map<string, FileChangeItem>();
  const nonFile: ViewItem[] = [];
  for (const item of items) {
    if (item.type === 'file-change') {
      const existing = byPath.get(item.path);
      if (existing) {
        existing.ops = [...existing.ops, ...item.ops];
      } else {
        byPath.set(item.path, { ...item, ops: [...item.ops] });
      }
    } else {
      nonFile.push(item);
    }
  }
  return { files: [...byPath.values()], nonFile };
}

// ---- file tree ----

export interface TreeNode {
  /** Display name. For collapsed chains this is `a/b/c`. */
  name: string;
  /** Set on leaves: the full original path. */
  path?: string;
  children: TreeNode[];
}

/** Build a nested tree from a list of file paths, then collapse any
 * non-leaf chains with a single non-leaf child (`src` → `lib` → `foo.ts`
 * renders as `src/lib` containing `foo.ts`). */
export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', children: [] };
  for (const p of paths) {
    const segs = p.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLeaf = i === segs.length - 1;
      let child = cur.children.find((c) => c.name === seg && !c.path === !isLeaf);
      if (!child) {
        child = { name: seg, children: [] };
        if (isLeaf) child.path = p;
        cur.children.push(child);
      }
      cur = child;
    }
  }
  return collapseChains(root);
}

function collapseChains(node: TreeNode): TreeNode {
  const collapsedChildren = node.children.map(collapseChains);
  if (!node.path && collapsedChildren.length === 1 && !collapsedChildren[0].path && node.name) {
    const only = collapsedChildren[0];
    return { name: `${node.name}/${only.name}`, children: only.children };
  }
  return { ...node, children: collapsedChildren };
}

function TreeView({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  // Sort: directories first, then files; alphabetical within each.
  const sorted = [...node.children].sort((a, b) => {
    const aDir = !a.path;
    const bDir = !b.path;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className="op-strip-tree" style={depth === 0 ? undefined : { paddingLeft: '0.85rem' }}>
      {sorted.map((child) =>
        child.path ? (
          <li key={child.path}>
            <button
              type="button"
              className="op-strip-tree-file"
              aria-pressed={selected === child.path}
              onClick={() => onSelect(child.path as string)}
              title={child.path}
            >
              {child.name}
            </button>
          </li>
        ) : (
          <li key={`d:${child.name}`}>
            <div className="op-strip-tree-dir">{child.name}/</div>
            <TreeView
              node={child}
              selected={selected}
              onSelect={onSelect}
              depth={depth + 1}
            />
          </li>
        ),
      )}
    </ul>
  );
}
