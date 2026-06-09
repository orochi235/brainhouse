import { describe, expect, it } from 'vitest';
import { F } from './__fixtures__/events.ts';
import { compile } from './compile.ts';
import { parse } from './parse.ts';

const sel = (s: string) => compile(parse(s));

describe('compile', () => {
  it('matches bare kind=event for any event', () => {
    expect(sel('event')(F.userText)).toBe(true);
    expect(sel('event')(F.toolUseBash)).toBe(true);
  });

  it('attr-eq on kind', () => {
    const m = sel('event[kind=tool_use]');
    expect(m(F.toolUseBash)).toBe(true);
    expect(m(F.userText)).toBe(false);
  });

  it('attr-eq chained: kind + name', () => {
    const m = sel('event[kind=tool_use][name=Task]');
    expect(m(F.toolUseTask)).toBe(true);
    expect(m(F.toolUseBash)).toBe(false);
    expect(m(F.userText)).toBe(false);
  });

  it('attr-eq quoted value', () => {
    const m = sel('event[kind="tool_use"][name="TodoWrite"]');
    expect(m(F.toolUseTodoWrite)).toBe(true);
    expect(m(F.toolUseBash)).toBe(false);
  });

  it(':matches against text body', () => {
    const m = sel('event[kind=assistant_text]:matches(/bh-title:/)');
    expect(m(F.asstWithBhTitle)).toBe(true);
    expect(m(F.asstPlain)).toBe(false);
  });

  it(':matches with alternation against user_text bash blocks', () => {
    const m = sel('event[kind=user_text]:matches(/<bash-(input|stdout|stderr)>/)');
    expect(m(F.userBash)).toBe(true);
    expect(m(F.userText)).toBe(false);
  });

  it('comma OR groups', () => {
    const m = sel('event[kind=user_text], event[kind=tool_result]');
    expect(m(F.userText)).toBe(true);
    expect(m(F.toolResult)).toBe(true);
    expect(m(F.asstPlain)).toBe(false);
  });

  it('three-way OR group (pending.bump shape)', () => {
    const m = sel('event[kind=user_text], event[kind=tool_result], event[kind=assistant_text]');
    expect(m(F.userText)).toBe(true);
    expect(m(F.asstPlain)).toBe(true);
    expect(m(F.toolResult)).toBe(true);
    expect(m(F.metaEvent)).toBe(false);
  });

  it('tag attribute (set membership)', () => {
    const m = sel('event[kind=user_text][tag=meta]');
    expect(m(F.userMeta)).toBe(true);
    expect(m(F.userText)).toBe(false);
  });

  it('tag attribute tolerates missing event.tags', () => {
    const m = sel('event[tag=meta]');
    expect(m(F.userTextNoTags)).toBe(false);
  });

  it('attr-present (tag key present at all)', () => {
    const m = sel('event[tag]');
    expect(m(F.userText)).toBe(true); // tags is [] (present array)
    expect(m(F.userTextNoTags)).toBe(false);
  });

  it(':has descends into tags', () => {
    // tag-as-child surface — kept for grammar completeness; matches if any
    // tag has name=meta.
    const m = sel('event:has(tag[name=meta])');
    expect(m(F.userMeta)).toBe(true);
    expect(m(F.userText)).toBe(false);
  });

  it('child combinator: event > tag matches by tag.name attr', () => {
    const m = sel('event[kind=user_text] > tag[name=meta]');
    expect(m(F.userMeta)).toBe(true);
    expect(m(F.userText)).toBe(false);
  });

  it('meta.any', () => {
    const m = sel('event[kind=meta]');
    expect(m(F.metaEvent)).toBe(true);
    expect(m(F.systemEvent)).toBe(false);
  });

  it('thinking.any', () => {
    expect(sel('event[kind=thinking]')(F.thinkingEvent)).toBe(true);
    expect(sel('event[kind=thinking]')(F.systemEvent)).toBe(false);
  });

  it('system.any', () => {
    expect(sel('event[kind=system]')(F.systemEvent)).toBe(true);
    expect(sel('event[kind=system]')(F.metaEvent)).toBe(false);
  });
});
