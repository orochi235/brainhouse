import { describe, expect, it } from 'vitest';
import { parse } from './parse.ts';

describe('parse', () => {
  it('parses a bare kind selector', () => {
    expect(parse('event')).toMatchObject({ type: 'kind', ident: 'event' });
  });

  it('parses attr-eq with ident value', () => {
    expect(parse('event[kind=tool_use]')).toMatchObject({
      type: 'and',
      nodes: [
        { type: 'kind', ident: 'event' },
        { type: 'attr-eq', name: 'kind', value: 'tool_use' },
      ],
    });
  });

  it('parses attr-eq with quoted string value', () => {
    expect(parse('event[name="Task Run"]')).toMatchObject({
      type: 'and',
      nodes: [
        { type: 'kind', ident: 'event' },
        { type: 'attr-eq', name: 'name', value: 'Task Run' },
      ],
    });
  });

  it('parses attr-present (no =)', () => {
    expect(parse('event[tag]')).toMatchObject({
      type: 'and',
      nodes: [
        { type: 'kind', ident: 'event' },
        { type: 'attr-present', name: 'tag' },
      ],
    });
  });

  it('parses multiple chained filters', () => {
    expect(parse('event[kind=tool_use][name=Task]')).toMatchObject({
      type: 'and',
      nodes: [
        { type: 'kind', ident: 'event' },
        { type: 'attr-eq', name: 'kind', value: 'tool_use' },
        { type: 'attr-eq', name: 'name', value: 'Task' },
      ],
    });
  });

  it('parses :matches with body and flags', () => {
    const ast = parse('event:matches(/bh-title:/i)') as { nodes: Array<{ type: string; re?: RegExp }> };
    const m = ast.nodes.find((n) => n.type === 'matches');
    expect(m).toBeDefined();
    expect(m?.re?.source).toBe('bh-title:');
    expect(m?.re?.flags).toBe('i');
  });

  it('parses :matches with alternation', () => {
    const ast = parse('event:matches(/<bash-(input|stdout|stderr)>/)') as {
      nodes: Array<{ type: string; re?: RegExp }>;
    };
    const m = ast.nodes.find((n) => n.type === 'matches');
    expect(m?.re?.source).toBe('<bash-(input|stdout|stderr)>');
  });

  it('parses :has', () => {
    expect(parse('event:has(tag[name=meta])')).toMatchObject({
      type: 'and',
      nodes: [
        { type: 'kind', ident: 'event' },
        {
          type: 'has',
          inner: {
            type: 'and',
            nodes: [
              { type: 'kind', ident: 'tag' },
              { type: 'attr-eq', name: 'name', value: 'meta' },
            ],
          },
        },
      ],
    });
  });

  it('parses comma groups', () => {
    expect(parse('event[kind=meta], event[kind=user_text]')).toMatchObject({
      type: 'group',
      groups: [
        { type: 'and' },
        { type: 'and' },
      ],
    });
  });

  it('parses child combinator', () => {
    expect(parse('event > content[type=text]')).toMatchObject({
      type: 'child',
      parent: { type: 'kind', ident: 'event' },
      child: { type: 'and' },
    });
  });

  it('throws on unterminated string', () => {
    expect(() => parse('event[name="oops]')).toThrow(/string/i);
  });

  it('throws on unterminated regex', () => {
    expect(() => parse('event:matches(/oops)')).toThrow(/regex/i);
  });

  it('throws on missing ]', () => {
    expect(() => parse('event[kind=tool_use')).toThrow(/\]/);
  });

  it('throws on unknown combinator', () => {
    expect(() => parse('event ~ tag')).toThrow();
  });
});
