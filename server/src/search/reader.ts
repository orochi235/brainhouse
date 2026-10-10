/**
 * Where a transcript's bytes come from: the live file, or a buffer holding a
 * copy that icehouse stored before Claude Code deleted the original.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** A line can be a multi-megabyte image paste; never read more than this
 * looking for one newline. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface Chunk {
  /** Complete lines; null when there is none yet. */
  buf: Buffer | null;
  /** The read reached the end, so nothing after `buf` is ready. */
  sawEnd: boolean;
}

export interface Source {
  size: number;
  mtimeMs: number;
  /** Bytes from `offset` through the last newline, about `maxBytes` of them,
   * more only when one line is longer. */
  read(offset: number, maxBytes: number): Chunk;
}

type ReadAt = (offset: number, want: number) => Buffer;

/** `final` says the bytes will never grow, so a last line with no newline is
 * complete rather than still being written. */
function completeLines(
  readAt: ReadAt,
  offset: number,
  size: number,
  maxBytes: number,
  final: boolean,
): Chunk {
  if (size <= offset) return { buf: null, sawEnd: true };
  let want = Math.min(size - offset, maxBytes);
  for (;;) {
    const buf = readAt(offset, want);
    const nl = buf.lastIndexOf(0x0a);
    const sawEnd = offset + buf.length >= size;
    if (sawEnd && final) return { buf, sawEnd };
    if (nl !== -1) return { buf: buf.subarray(0, nl + 1), sawEnd };
    // A line longer than MAX_LINE_BYTES is skipped rather than wedging the file.
    if (want >= MAX_LINE_BYTES) return { buf, sawEnd };
    if (sawEnd) return { buf: null, sawEnd };
    want = Math.min(size - offset, want * 4, MAX_LINE_BYTES);
  }
}

/** The file at `p`, or null when it is gone. */
export function liveSource(p: string): Source | null {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(p);
  } catch {
    return null;
  }
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    read(offset, maxBytes) {
      if (st.size <= offset) return { buf: null, sawEnd: true };
      const fd = openSync(p, 'r');
      try {
        const readAt: ReadAt = (at, want) => {
          const buf = Buffer.alloc(want);
          return buf.subarray(0, readSync(fd, buf, 0, want, at));
        };
        return completeLines(readAt, offset, st.size, maxBytes, false);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** A whole transcript already in memory, which will never grow. */
export function bufferSource(data: Buffer, mtimeMs: number): Source {
  return {
    size: data.length,
    mtimeMs,
    read: (offset, maxBytes) =>
      completeLines(
        (at, want) => data.subarray(at, at + want),
        offset,
        data.length,
        maxBytes,
        true,
      ),
  };
}
