/**
 * Locate a directory that was renamed in place, by its inode.
 *
 * A POSIX rename preserves a directory's `(dev, ino)`; a delete-then-recreate
 * does not. So when a session's working directory disappears, we can find where
 * it went — for the common `mv old new` within the same parent — by scanning the
 * parent for the directory carrying the same inode. Used by the monitor's theme
 * poll to follow a renamed session cwd (see the rename-follow spec).
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Scan `parentDir` for a *directory* child whose `(dev, ino)` matches, returning
 * its absolute path, or `null` if none matches (a real delete, or a move out of
 * this parent). Returns `null` rather than throwing when `parentDir` itself is
 * gone. Only directories are considered — a file can never be a session cwd.
 */
export async function findDirByInode(
  parentDir: string,
  dev: number,
  ino: number,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(parentDir, name);
    try {
      const st = await stat(candidate);
      if (st.isDirectory() && st.dev === dev && st.ino === ino) return candidate;
    } catch {
      // Raced entry (vanished between readdir and stat) — skip it.
    }
  }
  return null;
}
