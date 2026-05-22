/**
 * The composed list of built-in view transforms. Order matters:
 *
 *   Stage 1 (per-event)
 *     - trackPending           pass-through; flips the pending flag
 *     - scanChecklist          pass-through; picks up the latest checklist
 *     - mergeToolResult        attaches tool_result to prior capsule
 *     - askUserQuestion        AskUserQuestion → assistant bubble (must beat the default tool_use handler)
 *     - toolUseToCapsule       default tool_use → tool capsule (also handles orphan upgrade)
 *     - suppressInterruptMarker drops "[Request interrupted by user]" and marks the in-flight turn canceled
 *     - clearMarker            `/clear` artifacts → "prior session cleared" divider; drops caveat/stdout noise
 *     - userTextBubble         default user_text → bubble (handles interrupted-followup sawtooth)
 *     - assistantTextBubble    default assistant_text → bubble (folds short ones onto a prior tool capsule)
 *     - defaultEventItem       thinking / system / meta → wrapper items
 *
 *   Stage 2 (over assembled list, in order)
 *     - coalesceFileOps        merge same-file Read/Edit/Write runs
 *     - coalesceBetweenChats   compress runs between bubbles into op-strips
 *
 * Stage B (user-loaded transforms) will append/override into this list by
 * `key`. For now the list is the literal source-of-truth.
 */

import { askUserQuestion } from './builtIn/askUserQuestion.ts';
import { assistantTextBubble } from './builtIn/assistantTextBubble.ts';
import { clearMarker } from './builtIn/clearMarker.ts';
import { coalesceBetweenChats } from './builtIn/coalesceBetweenChats.ts';
import { coalesceFileOps } from './builtIn/coalesceFileOps.ts';
import { defaultEventItem } from './builtIn/defaultEventItem.ts';
import { mergeToolResult } from './builtIn/mergeToolResult.ts';
import { scanChecklist } from './builtIn/scanChecklist.ts';
import { suppressInterruptMarker } from './builtIn/suppressInterruptMarker.ts';
import { toolUseToCapsule } from './builtIn/toolUseToCapsule.ts';
import { trackPending } from './builtIn/trackPending.ts';
import type { ViewTransform } from './types.ts';
import { userTextBubble } from './builtIn/userTextBubble.ts';

export const VIEW_TRANSFORMS: ViewTransform[] = [
  trackPending,
  scanChecklist,
  mergeToolResult,
  askUserQuestion,
  toolUseToCapsule,
  suppressInterruptMarker,
  clearMarker,
  userTextBubble,
  assistantTextBubble,
  defaultEventItem,
  coalesceFileOps,
  coalesceBetweenChats,
];
