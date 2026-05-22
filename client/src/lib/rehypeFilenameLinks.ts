/**
 * Rehype plugin: walk the hast tree and replace path-shaped substrings in
 * text nodes with `<a class="filename-link">` elements that deeplink into
 * the user's configured editor.
 *
 * Skipped under `<pre>` so fenced code blocks stay verbatim. Inline `<code>`
 * is *not* in the skip set — agents constantly write `` `src/foo.ts:42` ``
 * in prose, and we want those clickable. Inline-code rendering preserves
 * the monospace style; the anchor sits inside it.
 *
 * The plugin doesn't import `unist-util-visit` (transitive but not declared)
 * — a small manual recursive walker handles the tree.
 */

import type { Element, ElementContent, Root, Text } from 'hast';
import { buildEditorUrl, resolveAbsolute, segmentFilenameLinks } from './filenameLinks.ts';

export interface RehypeFilenameLinksOptions {
  cwd: string | null;
  template: string;
}

const SKIP_TAGS = new Set(['pre', 'a', 'script', 'style']);

export function rehypeFilenameLinks(options: RehypeFilenameLinksOptions) {
  const { cwd, template } = options;

  function transformTextNode(node: Text): ElementContent[] | null {
    const segs = segmentFilenameLinks(node.value);
    if (segs.length === 1 && segs[0].kind === 'text') return null;
    const out: ElementContent[] = [];
    for (const s of segs) {
      if (s.kind === 'text') {
        if (s.value) out.push({ type: 'text', value: s.value });
        continue;
      }
      const abs = resolveAbsolute(s.match.path, cwd);
      const href = buildEditorUrl(template, abs, s.match.line, s.match.col);
      if (!href) {
        out.push({ type: 'text', value: s.match.raw });
        continue;
      }
      out.push({
        type: 'element',
        tagName: 'a',
        properties: {
          href,
          className: ['filename-link'],
          title: `open ${abs}${s.match.line ? `:${s.match.line}` : ''} in editor`,
        },
        children: [{ type: 'text', value: s.match.raw }],
      } satisfies Element);
    }
    return out;
  }

  function walk(parent: { children: ElementContent[] }, inSkip: boolean): void {
    const newChildren: ElementContent[] = [];
    for (const child of parent.children) {
      if (child.type === 'text' && !inSkip) {
        const replaced = transformTextNode(child);
        if (replaced) {
          newChildren.push(...replaced);
          continue;
        }
        newChildren.push(child);
        continue;
      }
      if (child.type === 'element') {
        const childIsSkip =
          inSkip || (typeof child.tagName === 'string' && SKIP_TAGS.has(child.tagName));
        walk(child, childIsSkip);
      }
      newChildren.push(child);
    }
    parent.children = newChildren;
  }

  return (tree: Root) => {
    walk(tree, false);
  };
}
