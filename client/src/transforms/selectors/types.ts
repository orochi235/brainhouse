/**
 * Frozen shared seam between Spec 1 (selector engine), Spec 2 (inspector),
 * and Spec 3 (trace). DO NOT modify the shape of `SelectorDef`, `Selector`,
 * or `SelectorNode` exports without coordinating across all three specs.
 *
 * Spec 2 (this consumer) only reads these types — the parser/engine that
 * builds `Selector.ast` lives in Spec 1.
 */

import type { Event } from '@server/parser.ts';

/** Opaque AST node — Spec 1 owns the grammar. Spec 2 never inspects this. */
export type SelectorNode = unknown;

export interface Selector {
  source: string;
  ast: SelectorNode;
  match: (e: Event) => boolean;
}

export interface SelectorDef {
  /** Stable id, e.g. `"tool-use.todowrite"`. User-authored keys must start with `"user."`. */
  key: string;
  /** Display name, e.g. `"TodoWrite tool_use"`. */
  name: string;
  description: string;
  /** Source string the engine parses. */
  selector: string;
  samplePayload?: unknown;
}
