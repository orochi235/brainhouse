/**
 * Named selector catalog. One entry per distinct guard observed across
 * the built-in view transforms. Transforms reference these by key in
 * their `matches: string[]` field; the runner resolves each key to a
 * compiled `Selector` (memoized) on first use.
 *
 * `samplePayload` is purely catalog UI fodder for Spec 2 — not used at
 * runtime — but `registry.test.ts` asserts every entry matches its own
 * sample so a stale catalog is loud.
 */

import { F } from './__fixtures__/events.ts';
import { compile } from './compile.ts';
import { parse } from './parse.ts';
import type { Selector, SelectorDef, SelectorNode } from './types.ts';

export const SELECTOR_REGISTRY: SelectorDef[] = [
  {
    key: 'tool-use.any',
    name: 'any tool_use',
    description: 'Any tool_use event.',
    selector: 'event[kind=tool_use]',
    samplePayload: F.toolUseBash,
  },
  {
    key: 'tool-use.todo-write',
    name: 'TodoWrite tool_use',
    description: 'TodoWrite — the legacy flat-list todo tool.',
    selector: 'event[kind=tool_use][name=TodoWrite]',
    samplePayload: F.toolUseTodoWrite,
  },
  {
    key: 'tool-use.task-create',
    name: 'TaskCreate tool_use',
    description: 'TaskCreate — the per-task append shape of the modern todo tool.',
    selector: 'event[kind=tool_use][name=TaskCreate]',
    samplePayload: F.toolUseTaskCreate,
  },
  {
    key: 'tool-use.task-update',
    name: 'TaskUpdate tool_use',
    description: 'TaskUpdate — patches a single task by id.',
    selector: 'event[kind=tool_use][name=TaskUpdate]',
    samplePayload: F.toolUseTaskUpdate,
  },
  {
    key: 'tool-use.task',
    name: 'Task tool_use',
    description: 'The subagent-spawning Task tool.',
    selector: 'event[kind=tool_use][name=Task]',
    samplePayload: F.toolUseTask,
  },
  {
    key: 'tool-use.ask-user-question',
    name: 'AskUserQuestion tool_use',
    description: 'AskUserQuestion — surfaces options to the human mid-turn.',
    selector: 'event[kind=tool_use][name=AskUserQuestion]',
    samplePayload: F.toolUseAskUserQuestion,
  },
  {
    key: 'tool-result.any',
    name: 'any tool_result',
    description: 'Any tool_result event.',
    selector: 'event[kind=tool_result]',
    samplePayload: F.toolResult,
  },
  {
    key: 'assistant-text.any',
    name: 'any assistant_text',
    description: 'Any assistant_text event.',
    selector: 'event[kind=assistant_text]',
    samplePayload: F.asstPlain,
  },
  {
    key: 'assistant-text.bh-title',
    name: 'assistant_text with bh-title marker',
    description:
      'Legacy auto-title marker — assistant_text whose body contains the `bh-title:` side-channel comment.',
    selector: 'event[kind=assistant_text]:matches(/bh-title:/)',
    samplePayload: F.asstWithBhTitle,
  },
  {
    key: 'user-text.any',
    name: 'any user_text',
    description: 'Any user_text event.',
    selector: 'event[kind=user_text]',
    samplePayload: F.userText,
  },
  {
    key: 'user-text.bash',
    name: 'user_text with bash-* tags',
    description:
      'user_text containing one or more <bash-input>/<bash-stdout>/<bash-stderr> blocks — Claude Code shell-out output.',
    selector: 'event[kind=user_text]:matches(/<bash-(input|stdout|stderr)>/)',
    samplePayload: F.userBash,
  },
  {
    key: 'user-text.meta',
    name: 'user_text tagged meta',
    description: 'Synthetic meta user_text (e.g. SKILL.md preludes).',
    selector: 'event[kind=user_text][tag=meta]',
    samplePayload: F.userMeta,
  },
  {
    key: 'user-text.artifact',
    name: 'user_text tagged artifact',
    description:
      'Slash-command artifact user_text (local-command-caveat / local-command-stdout wrappers).',
    selector: 'event[kind=user_text][tag=artifact]',
    samplePayload: F.userArtifact,
  },
  {
    key: 'meta.any',
    name: 'any meta',
    description: 'Any meta record (queue-operation, attachment, etc.).',
    selector: 'event[kind=meta]',
    samplePayload: F.metaEvent,
  },
  {
    key: 'thinking.any',
    name: 'any thinking',
    description: 'Any thinking event.',
    selector: 'event[kind=thinking]',
    samplePayload: F.thinkingEvent,
  },
  {
    key: 'system.any',
    name: 'any system',
    description: 'Any system event.',
    selector: 'event[kind=system]',
    samplePayload: F.systemEvent,
  },
  {
    key: 'dialogue.any',
    name: 'any dialogue text',
    description: 'user_text or assistant_text — the conversation bubbles.',
    selector: 'event[kind=user_text], event[kind=assistant_text]',
    samplePayload: F.userText,
  },
  {
    key: 'pending.bump',
    name: 'pending-indicator bump',
    description:
      'Events that shift the pending-indicator: user_text / tool_result set pending=true, assistant_text clears it.',
    selector: 'event[kind=user_text], event[kind=tool_result], event[kind=assistant_text]',
    samplePayload: F.userText,
  },
];

const byKey: Map<string, SelectorDef> = new Map(SELECTOR_REGISTRY.map((d) => [d.key, d]));
const compiled: Map<string, Selector> = new Map();

/**
 * Lookup + memoized compile. Throws on unknown key — transforms that
 * reference a typo'd selector fail loudly on first use instead of
 * silently no-op'ing.
 */
export function resolveSelector(key: string): Selector {
  const hit = compiled.get(key);
  if (hit) return hit;
  const def = byKey.get(key);
  if (!def) {
    throw new Error(
      `unknown selector key ${JSON.stringify(key)} — declared in a transform's matches[] but missing from SELECTOR_REGISTRY`,
    );
  }
  const ast = parse(def.selector);
  const match = compile(ast);
  const sel: Selector = {
    source: def.selector,
    // The internal SelNode is structurally a SelectorNode (discriminated
    // by `type`); cast through unknown to satisfy the public seam.
    ast: ast as unknown as SelectorNode,
    match,
  };
  compiled.set(key, sel);
  return sel;
}
