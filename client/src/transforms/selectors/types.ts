/**
 * Shared seam for the transforms-inspector work (Specs 1/2/3 at
 * `docs/superpowers/specs/2026-06-08-transforms-*-design.md`).
 *
 * Spec 1 owns: Selector, SelectorNode, SelectorDef, the parser/compiler/
 * registry behind them, and the runner changes that consume `matches`
 * on a transform.
 * Spec 2 reads: SelectorDef.
 * Spec 3 owns: TraceRecord, runtime instrumentation, the inspector
 * Trace tab.
 *
 * This file ships ahead of those implementations so all three can build
 * against an identical seam.
 */

import type { Event } from '@server/parser.ts';
import type { TransformError } from '../types.ts';

/**
 * Selector AST node. Discriminated by `type`. Each variant's payload
 * is owned by Spec 1's parser; consumers should treat the AST as
 * opaque except when rendering a structural view of a selector.
 */
export interface SelectorNode {
  type: 'kind' | 'attr-eq' | 'attr-present' | 'matches' | 'child' | 'has' | 'group';
  [key: string]: unknown;
}

/** A compiled selector: the source string, parsed AST, and a closure
 * that tests an event against it. Returned from the registry's
 * resolveSelector(); transforms never construct these directly. */
export interface Selector {
  source: string;
  ast: SelectorNode;
  match: (e: Event) => boolean;
}

/** A named, registered selector — the public catalog entry. */
export interface SelectorDef {
  key: string;
  name: string;
  description: string;
  selector: string;
  /** Optional fixture event used by the inspector catalog UI to show
   * what an event matching this selector looks like. Not used at
   * runtime. */
  samplePayload?: unknown;
}

/** One trace record per Event per pipeline pass when the runner is
 * given a `trace` accumulator. `perStage` entries are in stage-1
 * registration order. `finalItemIndices` is left empty by Spec 1 and
 * filled by Spec 3's post-stage-2 attribution pass. */
export interface TraceRecord {
  eventUuid: string;
  perStage: Array<{
    transformKey: string;
    /** Which named selector matched, if any. `undefined` when the
     * transform has no `matches` declared (runs on every event). */
    selectorKey?: string;
    matched: boolean;
    ran: boolean;
    consumed: boolean;
    /** Heuristic — see Spec 3's "Mutation detection" section for
     * limitations. */
    mutatedItems: boolean;
    error?: TransformError;
  }>;
  finalItemIndices: number[];
}
