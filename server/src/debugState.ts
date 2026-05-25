/**
 * Debug-only inspection of the running monitor's model state, independent
 * of any client-side filtering. Used by the `/debug` tile to surface
 * discrepancies between what's on disk, what's in the SessionStore, and
 * what the watcher's offset table thinks it has tailed.
 *
 * Not part of the normal client/server contract — schema is free to
 * change. Do not consume from production UI.
 */

import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptMonitor } from './monitor.js';
import { classifyPath } from './watcher.js';

export interface DiskSessionRow {
  root: string;
  session_id: string;
  parent_jsonl_path: string | null;
  parent_jsonl_size: number | null;
  parent_jsonl_mtime: number | null;
  subagent_file_count: number;
}

export interface DebugState {
  now: number;
  panels: ReturnType<TranscriptMonitor['store']['debugDump']>;
  panelsByParent: Record<string, number>;
  reconciliation: {
    rows: Array<
      DiskSessionRow & {
        panel_status: string | null;
        panel_title: string | null;
        project: string | null;
        subagent_panel_count: number;
        subagent_gap: number;
      }
    >;
    rootCounts: Array<{ root: string; sessions: number; subagentFiles: number }>;
  };
  offsets: Array<{ file_path: string; byte_offset: number; file_size: number | null }>;
  subscribers: number;
  watcher: { roots: string[] };
}

/** Walk one root looking for parent jsonl files and their subagent dirs.
 * Mirrors what the watcher classifies, but reports counts instead of
 * tailing content. */
async function inspectRoot(root: string): Promise<{
  sessions: Map<string, DiskSessionRow>;
  subagentFiles: number;
}> {
  const sessions = new Map<string, DiskSessionRow>();
  let subagentFiles = 0;
  if (!existsSync(root)) return { sessions, subagentFiles };
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = classifyPath(full);
      if (!info) continue;
      let mtime: number | null = null;
      let size: number | null = null;
      try {
        const st = statSync(full);
        mtime = st.mtimeMs / 1000;
        size = st.size;
      } catch {
        // ignore
      }
      let row = sessions.get(info.session_id);
      if (!row) {
        row = {
          root,
          session_id: info.session_id,
          parent_jsonl_path: null,
          parent_jsonl_size: null,
          parent_jsonl_mtime: null,
          subagent_file_count: 0,
        };
        sessions.set(info.session_id, row);
      }
      if (info.agent_id === null && !info.is_meta) {
        row.parent_jsonl_path = full;
        row.parent_jsonl_size = size;
        row.parent_jsonl_mtime = mtime;
      } else if (info.agent_id !== null && !info.is_meta) {
        row.subagent_file_count += 1;
        subagentFiles += 1;
      }
    }
  };
  await visit(root);
  return { sessions, subagentFiles };
}

/** Best-effort project label. Prefer the panel's actual cwd (last
 * segment); fall back to the encoded-cwd directory the jsonl lives
 * under (with leading `-` and `--` heuristically un-encoded). */
function deriveProject(cwd: string | null, jsonlPath: string | null): string | null {
  if (cwd) {
    const segs = cwd.replace(/\/+$/, '').split('/');
    const last = segs[segs.length - 1];
    if (last) return last;
  }
  if (jsonlPath) {
    const encoded = path.basename(path.dirname(jsonlPath));
    // Claude Code encodes `/` and `.` both to `-`, so we can't perfectly
    // round-trip. Just show the trailing segment after the last `--`,
    // which is usually the actual project name for worktree paths.
    const parts = encoded.split('--');
    const tail = parts[parts.length - 1] ?? encoded;
    return tail || encoded;
  }
  return null;
}

export async function collectDebugState(monitor: TranscriptMonitor): Promise<DebugState> {
  const panels = monitor.store.debugDump();

  const panelById = new Map(panels.map((p) => [p.id, p]));
  const subagentsByParent = new Map<string, number>();
  for (const p of panels) {
    if (p.kind !== 'subagent' || !p.parent_panel_id) continue;
    subagentsByParent.set(p.parent_panel_id, (subagentsByParent.get(p.parent_panel_id) ?? 0) + 1);
  }

  const panelsByParent: Record<string, number> = {};
  for (const [k, v] of subagentsByParent) panelsByParent[k] = v;

  const roots = monitor.watcher.roots;
  const reconciliationRows: DebugState['reconciliation']['rows'] = [];
  const rootCounts: DebugState['reconciliation']['rootCounts'] = [];
  for (const root of roots) {
    const { sessions, subagentFiles } = await inspectRoot(root);
    rootCounts.push({ root, sessions: sessions.size, subagentFiles });
    for (const row of sessions.values()) {
      const subPanelCount = subagentsByParent.get(row.session_id) ?? 0;
      const panel = panelById.get(row.session_id);
      reconciliationRows.push({
        ...row,
        panel_status: panel?.status ?? null,
        panel_title: panel?.title ?? null,
        project: deriveProject(panel?.cwd ?? null, row.parent_jsonl_path),
        subagent_panel_count: subPanelCount,
        subagent_gap: row.subagent_file_count - subPanelCount,
      });
    }
  }
  // Sort: biggest gaps first, then by parent mtime descending.
  reconciliationRows.sort((a, b) => {
    if (b.subagent_gap !== a.subagent_gap) return b.subagent_gap - a.subagent_gap;
    return (b.parent_jsonl_mtime ?? 0) - (a.parent_jsonl_mtime ?? 0);
  });

  const offsetRows: DebugState['offsets'] = [];
  const store = monitor.persistStore;
  if (store) {
    for (const [filePath, byteOffset] of store.allBootstrapOffsets()) {
      let fileSize: number | null = null;
      try {
        fileSize = statSync(filePath).size;
      } catch {
        // file gone — leave null
      }
      offsetRows.push({ file_path: filePath, byte_offset: byteOffset, file_size: fileSize });
    }
  }

  return {
    now: Date.now() / 1000,
    panels,
    panelsByParent,
    reconciliation: { rows: reconciliationRows, rootCounts },
    offsets: offsetRows,
    subscribers: monitor.emitter.listenerCount('delta'),
    watcher: { roots },
  };
}
