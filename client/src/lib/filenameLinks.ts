/**
 * Detect file paths inside arbitrary text and produce editor-deeplink URLs.
 *
 * Used by tool capsules, file-change rows, the lightbox, and (via a rehype
 * plugin) markdown bubbles to turn things like `src/foo.ts:42` or
 * `/Users/me/src/foo.ts` into clickable links that open in the user's
 * configured editor.
 *
 * Match rule: a path token must either contain at least one `.` in its last
 * segment (an extension) or have a `:line` suffix — otherwise common prose
 * like `to/the` or `and/or` would linkify.
 */

export interface FilenameMatch {
  /** The exact substring that matched, before any cwd resolution. */
  raw: string;
  /** The path as written (relative or absolute). */
  path: string;
  /** 1-based line number if the match included `:N`. */
  line?: number;
  /** 1-based column if the match included `:N:M`. */
  col?: number;
  /** Index into the original string where `raw` starts. */
  start: number;
  /** Index into the original string where `raw` ends (exclusive). */
  end: number;
}

export type FilenameSegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; match: FilenameMatch };

/**
 * Editor URL template presets. The template is a string with `{path}`,
 * `{line}`, and `{col}` placeholders. `{path}` is the resolved absolute path
 * (URL-encoded). `{line}` and `{col}` are integers; if a placeholder is
 * present but the match didn't capture that field, it falls back to `1`.
 */
export interface EditorPreset {
  id: string;
  label: string;
  template: string;
}

export const EDITOR_PRESETS: EditorPreset[] = [
  { id: 'cursor', label: 'Cursor', template: 'cursor://file/{path}:{line}' },
  { id: 'vscode', label: 'VS Code', template: 'vscode://file/{path}:{line}:{col}' },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    template: 'vscode-insiders://file/{path}:{line}:{col}',
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    template: 'webstorm://open?file={path}&line={line}&column={col}',
  },
  {
    id: 'intellij',
    label: 'IntelliJ',
    template: 'idea://open?file={path}&line={line}&column={col}',
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    template: 'pycharm://open?file={path}&line={line}&column={col}',
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    template: 'subl://open?url=file://{path}&line={line}&column={col}',
  },
  {
    id: 'textmate',
    label: 'TextMate',
    template: 'txmt://open?url=file://{path}&line={line}&column={col}',
  },
  { id: 'zed', label: 'Zed', template: 'zed://file/{path}:{line}:{col}' },
];

export const DEFAULT_EDITOR_TEMPLATE = EDITOR_PRESETS[0]!.template;

/** Match an EDITOR_PRESETS entry by template string; returns its id, or
 * `'custom'` if no preset matches the template verbatim. */
export function editorPresetIdForTemplate(template: string): string {
  const hit = EDITOR_PRESETS.find((p) => p.template === template);
  return hit ? hit.id : 'custom';
}

/**
 * Resolve a path against a cwd. Absolute paths pass through. `~/` is
 * expanded against `home` if given, otherwise inferred from the cwd
 * (`/Users/<n>/...` → `/Users/<n>`, `/home/<n>/...` → `/home/<n>`) —
 * editor deeplink handlers like `cursor://file/~/foo` do *not* expand
 * `~` themselves, so we must do it client-side. Relative paths are
 * joined onto cwd if cwd is set, otherwise returned unchanged.
 */
export function resolveAbsolute(
  raw: string,
  cwd: string | null | undefined,
  home?: string | null,
): string {
  if (raw.startsWith('/')) return raw;
  if (raw.startsWith('~/')) {
    const h = home ?? inferHomeFromCwd(cwd);
    return h ? `${h.replace(/\/$/, '')}/${raw.slice(2)}` : raw;
  }
  if (!cwd) return raw;
  const trimmed = raw.replace(/^\.\//, '');
  return `${cwd.replace(/\/$/, '')}/${trimmed}`;
}

/** Best-effort home dir from a cwd. Matches `/Users/<n>` (macOS) and
 * `/home/<n>` (Linux). Returns null otherwise. */
export function inferHomeFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const m = cwd.match(/^(\/(?:Users|home)\/[^/]+)(?:\/|$)/);
  return m && m[1] ? m[1] : null;
}

/** Build an editor deeplink. Returns null if the template is empty. */
export function buildEditorUrl(
  template: string,
  abs: string,
  line?: number,
  col?: number,
): string | null {
  if (!template) return null;
  return template
    .replaceAll('{path}', encodeURI(abs))
    .replaceAll('{line}', String(line ?? 1))
    .replaceAll('{col}', String(col ?? 1));
}

// Characters allowed inside a single path segment. Liberal — most real
// filenames stay inside this set.
const SEG = 'A-Za-z0-9._+\\-@';
// A path: absolute (/a/b/c) OR home-relative (~/a/b) OR plain relative
// (a/b/c or ./a/b/c). Must contain at least one `/`. Trailing slash allowed
// on dir-like references.
const PATH_BODY = `(?:\\/(?:[${SEG}]+\\/)*[${SEG}]+|~\\/(?:[${SEG}]+\\/)*[${SEG}]+|\\.?\\/?(?:[${SEG}]+\\/)+[${SEG}]+)`;
const LINE_COL = `(?::(\\d+)(?::(\\d+))?)?`;

// Lookbehind: don't start a match inside an identifier, after `://` (URL),
// or in the middle of a longer path (preceding `/`). Lookahead: don't end
// inside a longer token.
const PATH_RE = new RegExp(
  `(?<![A-Za-z0-9:/_~@.+-])(${PATH_BODY})${LINE_COL}(?![A-Za-z0-9_+@-])`,
  'g',
);

/**
 * Find every plausible filename reference in `text`. Returns matches in
 * order, non-overlapping. Bare-folder relative paths (no extension, no
 * `:line`) are rejected to keep prose from linkifying.
 */
export function findFilenameMatches(text: string): FilenameMatch[] {
  if (!text) return [];
  const out: FilenameMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic exec loop.
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = m[0];
    const path = m[1] ?? raw;
    const line = m[2] ? Number(m[2]) : undefined;
    const col = m[3] ? Number(m[3]) : undefined;
    // Quality gate: require an extension on the last segment OR a :line
    // suffix. Absolute paths get the same gate — `/usr/bin/env` does not
    // linkify but `/var/log/foo.log` does. Trailing-slash paths fail the
    // gate; that's fine.
    const last = path.split('/').filter(Boolean).pop() ?? '';
    if (line === undefined && !last.includes('.')) continue;
    // Reject path that ends in punctuation we likely caught from prose:
    // trailing `.` in a sentence ending like "see foo.ts." — strip and
    // re-evaluate.
    let trimmedRaw = raw;
    let trimmedPath = path;
    while (trimmedPath.endsWith('.') && !trimmedPath.endsWith('..')) {
      trimmedPath = trimmedPath.slice(0, -1);
      trimmedRaw = trimmedRaw.slice(0, -1);
    }
    if (!trimmedPath) continue;
    out.push({
      raw: trimmedRaw,
      path: trimmedPath,
      line,
      col,
      start: m.index,
      end: m.index + trimmedRaw.length,
    });
  }
  return out;
}

/** Split `text` into alternating text + link segments. */
export function segmentFilenameLinks(text: string): FilenameSegment[] {
  const matches = findFilenameMatches(text);
  if (matches.length === 0) return [{ kind: 'text', value: text }];
  const segs: FilenameSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segs.push({ kind: 'text', value: text.slice(cursor, m.start) });
    segs.push({ kind: 'link', match: m });
    cursor = m.end;
  }
  if (cursor < text.length) segs.push({ kind: 'text', value: text.slice(cursor) });
  return segs;
}
