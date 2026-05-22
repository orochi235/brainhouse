import type { Element, Root, Text } from 'hast';
import { describe, expect, it } from 'vitest';
import { rehypeFilenameLinks } from './rehypeFilenameLinks.ts';

function run(tree: Root, cwd: string | null = '/Users/me/proj'): Root {
  const transform = rehypeFilenameLinks({ cwd, template: 'cursor://file/{path}:{line}' });
  transform(tree);
  return tree;
}

function text(value: string): Text {
  return { type: 'text', value };
}

function el(tagName: string, children: (Element | Text)[]): Element {
  return { type: 'element', tagName, properties: {}, children };
}

function findAnchor(node: Element | Root): Element | null {
  if ('tagName' in node && node.tagName === 'a') return node;
  for (const child of node.children) {
    if (child.type === 'element') {
      const hit = findAnchor(child);
      if (hit) return hit;
    }
  }
  return null;
}

describe('rehypeFilenameLinks', () => {
  it('rewrites a path in a paragraph text node', () => {
    const tree: Root = { type: 'root', children: [el('p', [text('see src/foo.ts now')])] };
    run(tree);
    const a = findAnchor(tree);
    expect(a).not.toBeNull();
    expect(a?.properties?.href).toBe('cursor://file//Users/me/proj/src/foo.ts:1');
    const aText = a?.children[0] as Text;
    expect(aText.value).toBe('src/foo.ts');
  });

  it('rewrites paths inside inline <code>', () => {
    const tree: Root = { type: 'root', children: [el('p', [el('code', [text('src/foo.ts:42')])])] };
    run(tree);
    const a = findAnchor(tree);
    expect(a).not.toBeNull();
    expect(a?.properties?.href).toBe('cursor://file//Users/me/proj/src/foo.ts:42');
  });

  it('leaves paths inside <pre> alone', () => {
    const tree: Root = {
      type: 'root',
      children: [el('pre', [el('code', [text('src/foo.ts:42')])])],
    };
    run(tree);
    expect(findAnchor(tree)).toBeNull();
  });

  it('does not double-wrap existing <a>', () => {
    const tree: Root = {
      type: 'root',
      children: [el('p', [el('a', [text('src/foo.ts')])])],
    };
    run(tree);
    const outer = (tree.children[0] as Element).children[0] as Element;
    expect(outer.tagName).toBe('a');
    expect(outer.children).toHaveLength(1);
    expect((outer.children[0] as Text).value).toBe('src/foo.ts');
  });

  it('expands ~/ via cwd-inferred home', () => {
    const tree: Root = { type: 'root', children: [el('p', [text('open ~/.bashrc:5')])] };
    run(tree, '/Users/me/proj');
    const a = findAnchor(tree);
    expect(a?.properties?.href).toBe('cursor://file//Users/me/.bashrc:5');
  });
});
