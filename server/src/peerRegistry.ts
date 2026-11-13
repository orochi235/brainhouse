/**
 * Reads Claude Code's live-session registry: one `<config-root>/sessions/<pid>.json`
 * per running session, carrying the name other sessions address it by
 * (`emilia-93`) and the pid behind its messaging socket. Lets the client
 * attribute a cross-session message, which names its sender only that way,
 * to the sender's panel.
 *
 * A file disappears when its session exits, so callers keep what they have
 * already seen rather than clearing it.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PeerIdentity {
  /** The name SendMessage and idle notices use for this session. */
  name: string;
  /** OS pid; also the stem of its `uds:/tmp/cc-socks/<pid>.sock` address. */
  pid: number;
}

/** sessionId → identity, across every watched root. Unreadable or malformed
 * files are skipped. */
export async function readPeerRegistry(roots: string[]): Promise<Map<string, PeerIdentity>> {
  const out = new Map<string, PeerIdentity>();
  for (const root of roots) {
    // Watched roots are usually a config dir's `projects/`; the registry is its sibling.
    const configDir = path.basename(root) === 'projects' ? path.dirname(root) : root;
    const dir = path.join(configDir, 'sessions');
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Record<
          string,
          unknown
        >;
        const { sessionId, name, pid } = rec;
        if (typeof sessionId === 'string' && typeof name === 'string' && typeof pid === 'number') {
          out.set(sessionId, { name, pid });
        }
      } catch {
        // Mid-write or removed between readdir and read.
      }
    }
  }
  return out;
}
