/**
 * Static manifest mapping every transform key to its TypeScript source,
 * loaded at build time via Vite's `?raw` import suffix. The drift-guard
 * test in `./sources.test.ts` enforces 1:1 with `VIEW_TRANSFORMS`.
 *
 * Adding a new transform: one import line here, one entry in the object.
 */

import askUserQuestionSrc from '../../transforms/builtIn/askUserQuestion.ts?raw';
import assistantTextBubbleSrc from '../../transforms/builtIn/assistantTextBubble.ts?raw';
import attachSkillPreludeSrc from '../../transforms/builtIn/attachSkillPrelude.ts?raw';
import clearMarkerSrc from '../../transforms/builtIn/clearMarker.ts?raw';
import coalesceBetweenChatsSrc from '../../transforms/builtIn/coalesceBetweenChats.ts?raw';
import coalesceFileOpsSrc from '../../transforms/builtIn/coalesceFileOps.ts?raw';
import defaultEventItemSrc from '../../transforms/builtIn/defaultEventItem.ts?raw';
import insertDayDividersSrc from '../../transforms/builtIn/insertDayDividers.ts?raw';
import mergeToolResultSrc from '../../transforms/builtIn/mergeToolResult.ts?raw';
import scanChecklistSrc from '../../transforms/builtIn/scanChecklist.ts?raw';
import stripBhTitleMarkerSrc from '../../transforms/builtIn/stripBhTitleMarker.ts?raw';
import suppressInterruptMarkerSrc from '../../transforms/builtIn/suppressInterruptMarker.ts?raw';
import tagBtwUserTextSrc from '../../transforms/builtIn/tagBtwUserText.ts?raw';
import taskSubagentsSrc from '../../transforms/builtIn/taskSubagents.ts?raw';
import todoWriteToChecklistSrc from '../../transforms/builtIn/todoWriteToChecklist.ts?raw';
import toolUseToCapsuleSrc from '../../transforms/builtIn/toolUseToCapsule.ts?raw';
import trackPendingSrc from '../../transforms/builtIn/trackPending.ts?raw';
import userTextBubbleSrc from '../../transforms/builtIn/userTextBubble.ts?raw';

/** Keyed by `transform.key`. Built-in transform keys use the
 * `built-in.<kebab-name>` convention. */
export const TRANSFORM_SOURCE: Record<string, string> = {
  'built-in.track-pending': trackPendingSrc,
  'built-in.scan-checklist': scanChecklistSrc,
  'built-in.task-subagents': taskSubagentsSrc,
  'built-in.strip-bh-title-marker': stripBhTitleMarkerSrc,
  'built-in.merge-tool-result': mergeToolResultSrc,
  'built-in.ask-user-question': askUserQuestionSrc,
  'built-in.todo-write-to-checklist': todoWriteToChecklistSrc,
  'built-in.tool-use-to-capsule': toolUseToCapsuleSrc,
  'built-in.suppress-interrupt-marker': suppressInterruptMarkerSrc,
  'built-in.clear-marker': clearMarkerSrc,
  'built-in.attach-skill-prelude': attachSkillPreludeSrc,
  'built-in.tag-btw-user-text': tagBtwUserTextSrc,
  'built-in.user-text-bubble': userTextBubbleSrc,
  'built-in.assistant-text-bubble': assistantTextBubbleSrc,
  'built-in.default-event-item': defaultEventItemSrc,
  'built-in.coalesce-file-ops': coalesceFileOpsSrc,
  'built-in.coalesce-between-chats': coalesceBetweenChatsSrc,
  'built-in.insert-day-dividers': insertDayDividersSrc,
};
