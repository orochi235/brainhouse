import { describe, expect, it } from 'vitest';
import { outline } from './outline.ts';

describe('outline()', () => {
  it('captures exported function declarations', () => {
    const src = `export function run(event, items, ctx) {\n  return false;\n}\n`;
    expect(outline(src)).toEqual([
      { line: 1, label: 'function run(event, items, ctx)', kind: 'decl' },
    ]);
  });

  it('captures top-level const lambdas', () => {
    const src = `const foo = () => 1;\nexport const bar = (x: number) => x;\n`;
    expect(outline(src)).toEqual([
      { line: 1, label: 'const foo', kind: 'decl' },
      { line: 2, label: 'const bar', kind: 'decl' },
    ]);
  });

  it('captures top-level if / switch / case branches inside a run body', () => {
    const src = [
      'export function run(e) {',
      '  if (e.kind === "tool_use") {',
      '    doA();',
      '  } else if (e.kind === "tool_result") {',
      '    doB();',
      '  } else {',
      '    doC();',
      '  }',
      '  switch (e.kind) {',
      '    case "x":',
      '      return 1;',
      '    case "y":',
      '      return 2;',
      '  }',
      '}',
    ].join('\n');
    const got = outline(src);
    const labels = got.map((o) => o.label);
    expect(labels).toContain('function run(e)');
    expect(labels).toContain('if (e.kind === "tool_use")');
    expect(labels).toContain('else if (e.kind === "tool_result")');
    expect(labels).toContain('else');
    expect(labels).toContain('switch (e.kind)');
  });

  it('ignores deeply nested if/switch', () => {
    const src = [
      'function run(e) {',
      '  if (x) {',
      '    if (y) {', // nested — should NOT appear
      '      doDeep();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const labels = outline(src).map((o) => o.label);
    expect(labels).toContain('if (x)');
    expect(labels).not.toContain('if (y)');
  });
});
