/**
 * Collapse consecutive Read/Edit/Write/MultiEdit ops on the same file into
 * a single `file-change` row. The lightbox on that row shows the
 * cumulative diff.
 *
 * A run is broken by:
 *   - a `bubble` item (chat resets the file context)
 *   - a tool whose file_path differs from the run's current path
 *   - a non-file tool (Bash, Grep, …)
 *   - a tool with no `result` yet (pending state stays visible)
 *
 * Singletons pass through as plain tool items.
 */

import {
  FILE_TOOLS,
  type ToolItem,
  type ViewItem,
} from '../../lib/pipeline-types.ts';
import type { Stage2Transform } from '../types.ts';

export const coalesceFileOps: Stage2Transform = {
  kind: 'view',
  stage: 2,
  key: 'built-in.coalesce-file-ops',
  name: 'coalesceFileOps',
  description:
    'Successive Read/Edit/Write/MultiEdit ops on the same file collapse into a single `file-change` row whose lightbox shows the cumulative diff.',
  run(items) {
    const out: ViewItem[] = [];
    let run: ToolItem[] = [];
    let runPath: string | null = null;

    const flush = () => {
      if (run.length === 0) return;
      if (run.length === 1 || runPath === null) {
        out.push(...run);
      } else {
        const first = run[0];
        const last = run[run.length - 1];
        if (first && last) {
          out.push({
            type: 'file-change',
            anchorUuid: first.anchorUuid,
            path: runPath,
            ops: run.slice(),
            ts: last.ts,
          });
        }
      }
      run = [];
      runPath = null;
    };

    for (const item of items) {
      if (item.type === 'tool') {
        const path = filePathOf(item);
        const canRun = path !== null && item.use !== null && item.result !== null;
        if (canRun && (runPath === null || runPath === path)) {
          run.push(item);
          runPath = path;
          continue;
        }
        flush();
        if (canRun) {
          run.push(item);
          runPath = path;
          continue;
        }
        out.push(item);
        continue;
      }
      if (item.type === 'bubble') {
        flush();
        out.push(item);
        continue;
      }
      out.push(item);
    }
    flush();
    return out;
  },
};

function filePathOf(item: ToolItem): string | null {
  if (!item.use || !FILE_TOOLS.has(item.use.name)) return null;
  const input = item.use.input as { file_path?: unknown };
  if (typeof input?.file_path !== 'string' || !input.file_path) return null;
  return input.file_path;
}
