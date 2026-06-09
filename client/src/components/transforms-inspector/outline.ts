/**
 * Regex-based structural outliner for read-only transform source. Two
 * levels of recognition:
 *
 *   1. Top-level declarations — `(export )?(function|const)\s+name…`.
 *   2. Top-level branches inside a `run` body — lines that start with
 *      exactly two-space indent (`^\s{2}`) and begin with `if (`,
 *      `else if (`, `else`, `switch (`, or `case …:`.
 *
 * Anything more deeply nested is ignored on purpose — this is a navigation
 * aid, not an AST.
 */

export interface OutlineEntry {
  line: number; // 1-based
  label: string;
  kind: 'decl' | 'branch';
}

const DECL_RE = /^(?:export\s+)?(function\s+\w+\s*\([^)]*\)|const\s+\w+)/;
const BRANCH_RE =
  /^ {2}(?:\}\s*)?(if\s*\([^)]*\)|else\s+if\s*\([^)]*\)|else|switch\s*\([^)]*\)|case\s+[^:]+:)/;

export function outline(src: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const declMatch = raw.match(DECL_RE);
    if (declMatch) {
      out.push({ line: i + 1, label: declMatch[1] ?? raw.trim(), kind: 'decl' });
      continue;
    }
    const branchMatch = raw.match(BRANCH_RE);
    if (branchMatch) {
      out.push({ line: i + 1, label: branchMatch[1] ?? raw.trim(), kind: 'branch' });
    }
  }
  return out;
}
