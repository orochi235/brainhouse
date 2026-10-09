/**
 * Transcript search query language. Pure: a query string in, a structured
 * query out. Syntax is documented in
 * docs/superpowers/specs/2026-10-08-transcript-search-design.md.
 */

export type Role = 'you' | 'ai' | 'thinking' | 'tool' | 'out' | 'error';

export const ROLES: readonly Role[] = ['you', 'ai', 'thinking', 'tool', 'out', 'error'];

export interface ParsedQuery {
  /** Case-insensitive substrings, every one required. Phrases land here too:
   * a phrase is just a substring that may contain spaces. */
  terms: string[];
  regex: RegExp | null;
  projects: string[];
  accounts: string[];
  roles: Role[];
  tools: string[];
  /** Unix seconds, inclusive bounds. */
  after: number | null;
  before: number | null;
  /** Problems the user should see, e.g. an invalid regex. A query with errors
   * still runs on whatever parsed. */
  errors: string[];
}

const FILTER_KEYS = ['project', 'account', 'role', 'tool', 'after', 'before', 'is'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Split into tokens: `"quoted phrases"`, `/regex/flags`, `key:value` (value
 * may itself be quoted), or bare words. */
function tokenize(
  q: string,
): Array<{ kind: 'word' | 'phrase' | 'regex'; text: string; flags?: string }> {
  const out: Array<{ kind: 'word' | 'phrase' | 'regex'; text: string; flags?: string }> = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '"') {
      const end = q.indexOf('"', i + 1);
      const text = end === -1 ? q.slice(i + 1) : q.slice(i + 1, end);
      out.push({ kind: 'phrase', text });
      i = end === -1 ? q.length : end + 1;
      continue;
    }
    if (c === '/') {
      // Find the closing unescaped slash.
      let j = i + 1;
      let inClass = false;
      while (j < q.length) {
        const d = q[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      if (j < q.length && j > i + 1) {
        let k = j + 1;
        while (k < q.length && /[a-z]/.test(q[k] ?? '')) k++;
        out.push({ kind: 'regex', text: q.slice(i + 1, j), flags: q.slice(j + 1, k) });
        i = k;
        continue;
      }
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j] ?? '')) {
      // key:"quoted value"
      if (q[j] === ':' && q[j + 1] === '"') {
        const end = q.indexOf('"', j + 2);
        j = end === -1 ? q.length : end + 1;
        break;
      }
      j++;
    }
    out.push({ kind: 'word', text: q.slice(i, j) });
    i = j;
  }
  return out;
}

const AGE_RE = /^(\d+(?:\.\d+)?)([hdw])$/;
const UNIT_S = { h: 3600, d: 86_400, w: 604_800 } as const;

/** `7d`, `12h`, `2w` → now minus that; `2026-09-01` → local midnight. */
export function parseWhen(v: string, now: number): number | null {
  const age = AGE_RE.exec(v);
  if (age) return now - Number(age[1]) * UNIT_S[age[2] as keyof typeof UNIT_S];
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = new Date(`${v}T00:00:00`).getTime();
    return Number.isNaN(t) ? null : t / 1000;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t / 1000;
}

export function parseQuery(q: string, now: number = Date.now() / 1000): ParsedQuery {
  const pq: ParsedQuery = {
    terms: [],
    regex: null,
    projects: [],
    accounts: [],
    roles: [],
    tools: [],
    after: null,
    before: null,
    errors: [],
  };
  for (const tok of tokenize(q)) {
    if (tok.kind === 'phrase') {
      if (tok.text) pq.terms.push(tok.text);
      continue;
    }
    if (tok.kind === 'regex') {
      if (pq.regex) {
        pq.errors.push('only one /regex/ per query');
        continue;
      }
      const flags = tok.flags ? tok.flags : 'i';
      try {
        pq.regex = new RegExp(tok.text, flags.replace(/[gy]/g, ''));
      } catch (err) {
        pq.errors.push(`bad regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    const colon = tok.text.indexOf(':');
    const key = colon > 0 ? tok.text.slice(0, colon).toLowerCase() : '';
    if (!FILTER_KEYS.includes(key as FilterKey)) {
      pq.terms.push(tok.text);
      continue;
    }
    let value = tok.text.slice(colon + 1);
    if (value.startsWith('"')) value = value.slice(1, value.endsWith('"') ? -1 : undefined);
    if (!value) {
      pq.errors.push(`${key}: needs a value`);
      continue;
    }
    switch (key as FilterKey) {
      case 'project':
        pq.projects.push(value);
        break;
      case 'account':
        pq.accounts.push(value.toUpperCase());
        break;
      case 'tool':
        pq.tools.push(value);
        break;
      case 'role':
      case 'is': {
        const v = value.toLowerCase();
        const role = key === 'is' && v === 'error' ? 'error' : v;
        if (ROLES.includes(role as Role)) pq.roles.push(role as Role);
        else
          pq.errors.push(
            `unknown ${key}: ${value} (try ${key === 'is' ? 'error' : ROLES.join(', ')})`,
          );
        break;
      }
      case 'after':
      case 'before': {
        const when = parseWhen(value, now);
        if (when === null) pq.errors.push(`can't read ${key}:${value} as a date or age like 7d`);
        else if (key === 'after') pq.after = when;
        else pq.before = when;
        break;
      }
    }
  }
  return pq;
}

/**
 * Literal runs a regex match must contain, for narrowing candidates through
 * the trigram index. Conservative: gives up on a pattern with top-level
 * alternation, and drops any literal followed by a quantifier that allows
 * zero or many (the last character of `ab?` is optional, so only `a` is
 * required). Returns only runs of 3+ characters.
 */
export function requiredLiterals(source: string): string[] {
  const runs: string[] = [];
  let cur = '';
  let depth = 0;
  const flush = () => {
    if (cur.length >= 3) runs.push(cur);
    cur = '';
  };
  // Any top-level `|` means no single literal is required.
  for (let i = 0, d = 0, inClass = false; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === '|' && d === 0) return [];
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (depth > 0) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        // A group's quantifier doesn't affect the literal before the group.
      }
      continue;
    }
    if (c === '(') {
      flush();
      depth = 1;
      continue;
    }
    if (c === '[') {
      flush();
      // Skip the class.
      let j = i + 1;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '\\') {
      // Escaped punctuation is a literal; \d, \w, \s, \b etc. are not.
      if (/[^a-zA-Z0-9]/.test(next)) {
        if (isOptionalQuantifier(source[i + 2])) flush();
        else cur += next;
      } else flush();
      i++;
      continue;
    }
    if ('.^$'.includes(c)) {
      flush();
      continue;
    }
    if ('*+?{'.includes(c)) {
      // Handled by the lookahead below; a stray one just ends the run.
      flush();
      if (c === '{') while (i < source.length && source[i] !== '}') i++;
      continue;
    }
    if (isOptionalQuantifier(next)) {
      // `ab*` requires `a` only; `ab+` requires `ab`.
      if (next === '+') {
        cur += c;
        flush();
      } else flush();
      continue;
    }
    cur += c;
  }
  flush();
  return runs;
}

function isOptionalQuantifier(c: string | undefined): boolean {
  return c === '*' || c === '?' || c === '{' || c === '+';
}
