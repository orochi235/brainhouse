/**
 * AST → closure. Tree-walks once at compile time, returns a pure function
 * `(event: Event) => boolean`. RegExp objects in the AST are reused.
 *
 * Evaluation contexts:
 *   - event   : attributes are { kind, uuid } plus payload keys; the
 *               special attribute `tag` reads `event.tags` (Array<string>)
 *               with `=` semantics meaning "value ∈ tags". Other attribute
 *               reads pull from `event.payload[name]` and stringify.
 *               `:matches(/r/)` runs against the canonical text body
 *               (text events: payload.text; tool_use: JSON of input;
 *               tool_result: stringified content).
 *   - tag     : a pseudo-node per element of `event.tags`. Has attribute
 *               `name` equal to the tag string.
 *   - content : a pseudo-node per element of `payload.content` (for
 *               tool_use / tool_result). Has attribute `type` plus any
 *               other top-level key in the content object.
 *
 * `:has(s)` is true if any descendant satisfies `s`. The `>` combinator
 * descends one level using the rules above.
 */

import type { Event } from '@server/parser.ts';
import type { SelNode } from './parse.ts';

type CtxKind = 'event' | 'tag' | 'content';

interface Node {
  kind: CtxKind;
  /** The underlying object. For `event` this is the Event itself; for
   * `tag` it's an object `{ name }`; for `content` it's the raw content
   * block. */
  ref: { name?: string } | Event | Record<string, unknown>;
  /** The Event this node belongs to. Used for :matches and for attribute
   * fallback. */
  event: Event;
}

function eventCtx(e: Event): Node {
  return { kind: 'event', ref: e, event: e };
}

/** Returns the canonical text body of an event for :matches. */
function bodyText(e: Event): string {
  switch (e.kind) {
    case 'user_text':
    case 'assistant_text':
    case 'thinking':
      return e.payload.text ?? '';
    case 'tool_use':
      try {
        return JSON.stringify((e.payload as { input?: unknown }).input ?? '');
      } catch {
        return '';
      }
    case 'tool_result': {
      const c = (e.payload as { content?: unknown }).content;
      return typeof c === 'string' ? c : (() => {
        try {
          return JSON.stringify(c ?? '');
        } catch {
          return '';
        }
      })();
    }
    default:
      return '';
  }
}

function attrEq(node: Node, name: string, value: string): boolean {
  if (node.kind === 'tag') {
    if (name === 'name') return (node.ref as { name?: string }).name === value;
    return false;
  }
  if (node.kind === 'event') {
    const e = node.ref as Event;
    if (name === 'kind') return e.kind === value;
    if (name === 'uuid') return e.uuid === value;
    if (name === 'tag') return Array.isArray(e.tags) && e.tags.includes(value as never);
    const payload = (e as { payload?: Record<string, unknown> }).payload;
    if (!payload) return false;
    const v = payload[name];
    if (v === undefined || v === null) return false;
    return String(v) === value;
  }
  // content node
  const obj = node.ref as Record<string, unknown>;
  const v = obj[name];
  if (v === undefined || v === null) return false;
  return String(v) === value;
}

function attrPresent(node: Node, name: string): boolean {
  if (node.kind === 'tag') return name === 'name' && typeof (node.ref as { name?: string }).name === 'string';
  if (node.kind === 'event') {
    const e = node.ref as Event;
    if (name === 'kind' || name === 'uuid') return true;
    if (name === 'tag') return Array.isArray(e.tags);
    const payload = (e as { payload?: Record<string, unknown> }).payload;
    return !!payload && payload[name] !== undefined;
  }
  const obj = node.ref as Record<string, unknown>;
  return obj[name] !== undefined;
}

function kindMatches(node: Node, ident: string): boolean {
  return node.kind === ident;
}

/** Yields each direct child node per the descent rules. */
function* children(node: Node): IterableIterator<Node> {
  if (node.kind === 'event') {
    const e = node.ref as Event;
    if (Array.isArray(e.tags)) {
      for (const t of e.tags) {
        yield { kind: 'tag', ref: { name: t }, event: e };
      }
    }
    if (e.kind === 'tool_use' || e.kind === 'tool_result') {
      const payload = e.payload as { content?: unknown };
      const content = payload.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object') {
            yield { kind: 'content', ref: c as Record<string, unknown>, event: e };
          }
        }
      }
    }
  }
  // tag and content nodes have no children in v1
}

/** Walks all descendants (depth-first), including the node itself. */
function* descendants(node: Node): IterableIterator<Node> {
  yield node;
  for (const c of children(node)) yield* descendants(c);
}

function evalNode(ast: SelNode, node: Node): boolean {
  switch (ast.type) {
    case 'kind':
      return kindMatches(node, ast.ident);
    case 'attr-eq':
      return attrEq(node, ast.name, ast.value);
    case 'attr-present':
      return attrPresent(node, ast.name);
    case 'matches':
      return ast.re.test(bodyText(node.event));
    case 'and':
      for (const n of ast.nodes) if (!evalNode(n, node)) return false;
      return true;
    case 'group':
      for (const g of ast.groups) if (evalNode(g, node)) return true;
      return false;
    case 'has': {
      // ':has' descends into strict descendants (not the node itself).
      for (const c of children(node)) {
        for (const d of descendants(c)) {
          if (evalNode(ast.inner, d)) return true;
        }
      }
      return false;
    }
    case 'child': {
      if (!evalNode(ast.parent, node)) return false;
      for (const c of children(node)) {
        if (evalNode(ast.child, c)) return true;
      }
      return false;
    }
  }
}

export function compile(ast: SelNode): (e: Event) => boolean {
  return (e: Event) => evalNode(ast, eventCtx(e));
}
