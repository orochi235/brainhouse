/**
 * Selector grammar parser. Handwritten tokenizer + recursive-descent
 * parser per `docs/superpowers/specs/2026-06-08-transforms-1-selector-engine-design.md`.
 *
 *   selector := group ( ',' group )*
 *   group    := simple ( '>' simple )*
 *   simple   := IDENT? filter*
 *   filter   := '[' IDENT ('=' (STRING|IDENT))? ']'
 *            |  ':matches(' regex ')'
 *            |  ':has(' selector ')'
 *   regex    := '/' body '/' flags?
 *
 * Produces the internal `SelNode` AST consumed by `compile.ts`. The
 * shape is structurally compatible with `SelectorNode` from `./types.ts`.
 */

/** Internal AST. Each node has a discriminant `type` and shape per variant. */
export type SelNode =
  | { type: 'group'; groups: SelNode[] }
  | { type: 'child'; parent: SelNode; child: SelNode }
  | { type: 'kind'; ident: string }
  | { type: 'attr-eq'; name: string; value: string }
  | { type: 'attr-present'; name: string }
  | { type: 'matches'; re: RegExp }
  | { type: 'has'; inner: SelNode }
  | { type: 'and'; nodes: SelNode[] };

interface Cursor {
  src: string;
  i: number;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentCont(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}

function skipWs(cur: Cursor): void {
  while (cur.i < cur.src.length && /\s/.test(cur.src[cur.i] ?? '')) cur.i += 1;
}

function peek(cur: Cursor): string {
  return cur.src[cur.i] ?? '';
}

function eat(cur: Cursor, ch: string): boolean {
  skipWs(cur);
  if (cur.src[cur.i] === ch) {
    cur.i += 1;
    return true;
  }
  return false;
}

function expect(cur: Cursor, ch: string, what: string): void {
  skipWs(cur);
  if (cur.src[cur.i] !== ch) {
    throw new Error(
      `selector parse error at offset ${cur.i}: expected ${what} (${JSON.stringify(ch)}) in ${JSON.stringify(cur.src)}`,
    );
  }
  cur.i += 1;
}

function readIdent(cur: Cursor): string | null {
  skipWs(cur);
  const start = cur.i;
  if (!isIdentStart(peek(cur))) return null;
  cur.i += 1;
  while (cur.i < cur.src.length && isIdentCont(cur.src[cur.i] ?? '')) cur.i += 1;
  return cur.src.slice(start, cur.i);
}

function readString(cur: Cursor): string {
  // assumes peek === ' or "
  const quote = cur.src[cur.i];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`selector parse error at offset ${cur.i}: expected string`);
  }
  cur.i += 1;
  let out = '';
  while (cur.i < cur.src.length) {
    const c = cur.src[cur.i] ?? '';
    if (c === '\\') {
      const next = cur.src[cur.i + 1] ?? '';
      out += next;
      cur.i += 2;
      continue;
    }
    if (c === quote) {
      cur.i += 1;
      return out;
    }
    out += c;
    cur.i += 1;
  }
  throw new Error(`selector parse error: unterminated string in ${JSON.stringify(cur.src)}`);
}

function readRegex(cur: Cursor): RegExp {
  // peek === '/'
  if (cur.src[cur.i] !== '/') {
    throw new Error(`selector parse error at offset ${cur.i}: expected regex starting with /`);
  }
  cur.i += 1;
  let body = '';
  let inClass = false;
  while (cur.i < cur.src.length) {
    const c = cur.src[cur.i] ?? '';
    if (c === '\\') {
      body += c + (cur.src[cur.i + 1] ?? '');
      cur.i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (c === '/' && !inClass) {
      cur.i += 1;
      let flags = '';
      while (cur.i < cur.src.length && /[gimsuy]/.test(cur.src[cur.i] ?? '')) {
        flags += cur.src[cur.i];
        cur.i += 1;
      }
      try {
        return new RegExp(body, flags);
      } catch (err) {
        throw new Error(`selector parse error: invalid regex /${body}/${flags}: ${(err as Error).message}`);
      }
    }
    body += c;
    cur.i += 1;
  }
  throw new Error(`selector parse error: unterminated regex in ${JSON.stringify(cur.src)}`);
}

function readValue(cur: Cursor): string {
  skipWs(cur);
  const c = peek(cur);
  if (c === '"' || c === "'") return readString(cur);
  const ident = readIdent(cur);
  if (ident === null) {
    throw new Error(`selector parse error at offset ${cur.i}: expected attribute value`);
  }
  return ident;
}

function parseFilter(cur: Cursor): SelNode | null {
  skipWs(cur);
  const c = peek(cur);
  if (c === '[') {
    cur.i += 1;
    skipWs(cur);
    const name = readIdent(cur);
    if (!name) {
      throw new Error(`selector parse error at offset ${cur.i}: expected attribute name after [`);
    }
    skipWs(cur);
    if (peek(cur) === '=') {
      cur.i += 1;
      const value = readValue(cur);
      skipWs(cur);
      expect(cur, ']', "closing ']'");
      return { type: 'attr-eq', name, value };
    }
    expect(cur, ']', "closing ']'");
    return { type: 'attr-present', name };
  }
  if (c === ':') {
    cur.i += 1;
    const name = readIdent(cur);
    if (name === 'matches') {
      expect(cur, '(', "'(' after :matches");
      skipWs(cur);
      const re = readRegex(cur);
      skipWs(cur);
      expect(cur, ')', "')' after :matches body");
      return { type: 'matches', re };
    }
    if (name === 'has') {
      expect(cur, '(', "'(' after :has");
      const inner = parseSelector(cur);
      skipWs(cur);
      expect(cur, ')', "')' after :has body");
      return { type: 'has', inner };
    }
    throw new Error(`selector parse error: unknown pseudo :${name}`);
  }
  return null;
}

function parseSimple(cur: Cursor): SelNode {
  skipWs(cur);
  const parts: SelNode[] = [];
  const ident = readIdent(cur);
  if (ident !== null) parts.push({ type: 'kind', ident });
  while (true) {
    const f = parseFilter(cur);
    if (!f) break;
    parts.push(f);
  }
  if (parts.length === 0) {
    throw new Error(`selector parse error at offset ${cur.i}: expected a simple selector`);
  }
  if (parts.length === 1) return parts[0] as SelNode;
  return { type: 'and', nodes: parts };
}

function parseGroup(cur: Cursor): SelNode {
  let node = parseSimple(cur);
  while (true) {
    skipWs(cur);
    const c = peek(cur);
    if (c === '>') {
      cur.i += 1;
      const child = parseSimple(cur);
      node = { type: 'child', parent: node, child };
      continue;
    }
    // Disallow bare-space combinator + reject anything else as a stray token.
    if (c === ',' || c === ')' || c === '') break;
    throw new Error(`selector parse error at offset ${cur.i}: unexpected ${JSON.stringify(c)}`);
  }
  return node;
}

function parseSelector(cur: Cursor): SelNode {
  const groups: SelNode[] = [parseGroup(cur)];
  while (true) {
    skipWs(cur);
    if (peek(cur) !== ',') break;
    cur.i += 1;
    groups.push(parseGroup(cur));
  }
  if (groups.length === 1) return groups[0] as SelNode;
  return { type: 'group', groups };
}

export function parse(source: string): SelNode {
  const cur: Cursor = { src: source, i: 0 };
  const node = parseSelector(cur);
  skipWs(cur);
  if (cur.i !== source.length) {
    throw new Error(
      `selector parse error: trailing content at offset ${cur.i} in ${JSON.stringify(source)}`,
    );
  }
  return node;
}
