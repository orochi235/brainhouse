/**
 * Folds `image` events into the bubble of the message they were pasted
 * into. Claude Code writes a pasted image as its own content block next to
 * the text, and leaves an `[Image #N]` token in the text where it sat; the
 * parser fans those blocks out into separate events sharing the record's
 * uuid stem. Here they come back together: the placeholder is dropped from
 * the text and an image part is appended in its place.
 *
 * An image whose record produced no bubble (image-only paste, or a shape we
 * didn't anticipate) still gets one, so the picture is never silently lost.
 */

import type { Event } from '@server/parser.ts';
import type { BubbleItem, ViewItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

export const inlineImages: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.inline-images',
  name: 'inline pasted images',
  description:
    'Attaches an image event to the bubble emitted from the same transcript record, stripping the matching `[Image #N]` placeholder from its text.',
  matches: ['image.any'],
  run(event, items) {
    if (event.kind !== 'image') return false; // type narrowing
    const { ref, paste_id: pasteId } = event.payload;
    const part = { kind: 'image', ref, pasteId } as const;

    const host = findRecordBubble(items, event);
    if (host) {
      for (const existing of host.parts) {
        if (existing.kind === 'text') existing.text = stripPlaceholder(existing.text, pasteId);
      }
      host.parts.push(part);
      return true;
    }
    items.push({ type: 'bubble', event, role: 'user', parts: [part] });
    return true;
  },
};

/** The most recent bubble emitted from the same transcript record. Event
 * uuids for fanned-out content blocks are `<record uuid>:<block index>`, and
 * a record's blocks are always contiguous, so it suffices to check the last
 * bubble in the list. */
function findRecordBubble(items: ViewItem[], event: Event): BubbleItem | null {
  const last = items[items.length - 1];
  if (last?.type !== 'bubble') return null;
  return recordUuid(last.event.uuid) === recordUuid(event.uuid) ? last : null;
}

function recordUuid(uuid: string): string {
  const colon = uuid.lastIndexOf(':');
  return colon === -1 ? uuid : uuid.slice(0, colon);
}

/** Remove `[Image #N]` (and any space it left behind) for this paste id. */
function stripPlaceholder(text: string, pasteId: number): string {
  return text.replace(new RegExp(`\\s*\\[Image #${pasteId}\\]`, 'g'), '');
}
