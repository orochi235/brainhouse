/**
 * Claude Code injects a Skill's SKILL.md as a synthetic user-meta message
 * tied to the originating Skill tool_use (`isMeta: true`,
 * `sourceToolUseID: <skill-id>`). Left to the default `userTextBubble`
 * transform, those messages render as multi-kilobyte user bubbles.
 *
 * Instead, attach the prelude to the matching tool capsule so it lives
 * behind the lightbox click. If no matching capsule is found, fall
 * through and let the next transform handle it.
 *
 * Runs before `userTextBubble`.
 */

import type { Stage1Transform } from '../types.ts';
import { findToolItem } from './util.ts';

export const attachSkillPrelude: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.attach-skill-prelude',
  name: 'attach skill prelude to tool capsule',
  description:
    'Routes synthetic user-meta messages produced by the Skill tool onto their originating capsule instead of emitting a giant user bubble.',
  matches: ['user-text.meta'],
  run(event, items) {
    // Selector ensures user_text + meta tag.
    if (event.kind !== 'user_text') return false; // type narrowing
    const { source_tool_use_id, text } = event.payload;
    if (!source_tool_use_id) return false;
    const target = findToolItem(items, source_tool_use_id);
    if (!target || target.use?.name !== 'Skill') return false;
    target.prelude = target.prelude ? `${target.prelude}\n\n${text}` : text;
    return true;
  },
};
