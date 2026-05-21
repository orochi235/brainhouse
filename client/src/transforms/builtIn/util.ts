/**
 * Shared lookup helpers used by multiple built-in transforms. Kept here
 * (rather than re-exported from pipeline.ts) so the transform modules
 * don't pull the registry back through the index file.
 */

import type { BubbleItem, ToolItem, ViewItem } from '../../lib/pipeline-types.ts';

export function findToolItem(items: ViewItem[], toolUseId: string): ToolItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (
      item?.type === 'tool' &&
      ((item.use && item.use.tool_use_id === toolUseId) ||
        (item.result && item.result.tool_use_id === toolUseId))
    ) {
      return item;
    }
  }
  return null;
}

export function findLastBubble(
  items: ViewItem[],
  role: 'user' | 'assistant',
): BubbleItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === 'bubble' && item.role === role) return item;
  }
  return null;
}
