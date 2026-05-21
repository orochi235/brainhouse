import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkOnboarding, hasRecentSubagents, hooksInstalled } from './onboarding.js';

describe('onboarding detection', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'brainhouse-onboarding-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('hooksInstalled', () => {
    test('false when events dir is missing', () => {
      expect(hooksInstalled(path.join(tmp, 'nope'))).toBe(false);
    });

    test('false when events dir is empty', () => {
      const dir = path.join(tmp, 'events');
      mkdirSync(dir, { recursive: true });
      expect(hooksInstalled(dir)).toBe(false);
    });

    test('false when events dir contains only non-jsonl files', () => {
      const dir = path.join(tmp, 'events');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'README.txt'), 'hi');
      expect(hooksInstalled(dir)).toBe(false);
    });

    test('true when events dir contains at least one .jsonl', () => {
      const dir = path.join(tmp, 'events');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'abc.jsonl'), '{}\n');
      expect(hooksInstalled(dir)).toBe(true);
    });
  });

  describe('hasRecentSubagents', () => {
    test('false when no roots exist', () => {
      expect(hasRecentSubagents([path.join(tmp, 'missing')])).toBe(false);
    });

    test('false when projects have no subagents dirs', () => {
      const root = path.join(tmp, 'projects');
      mkdirSync(path.join(root, '-proj-a', 'sess1'), { recursive: true });
      expect(hasRecentSubagents([root])).toBe(false);
    });

    test('false when a subagents dir is older than the cutoff', () => {
      const root = path.join(tmp, 'projects');
      const subagents = path.join(root, '-proj-a', 'sess1', 'subagents');
      mkdirSync(subagents, { recursive: true });
      // Make both the dir and a child jsonl ancient.
      const ancient = new Date('2000-01-01T00:00:00Z');
      const child = path.join(subagents, 'agent-old.jsonl');
      writeFileSync(child, '{}\n');
      utimesSync(child, ancient, ancient);
      utimesSync(subagents, ancient, ancient);
      expect(hasRecentSubagents([root])).toBe(false);
    });

    test('true when a subagents dir has a recently-modified child', () => {
      const root = path.join(tmp, 'projects');
      const subagents = path.join(root, '-proj-a', 'sess1', 'subagents');
      mkdirSync(subagents, { recursive: true });
      writeFileSync(path.join(subagents, 'agent-fresh.jsonl'), '{}\n');
      expect(hasRecentSubagents([root])).toBe(true);
    });

    test('true when the subagents dir itself has a recent mtime', () => {
      const root = path.join(tmp, 'projects');
      const subagents = path.join(root, '-proj-a', 'sess1', 'subagents');
      mkdirSync(subagents, { recursive: true });
      // No children — directory mtime is the only signal.
      expect(hasRecentSubagents([root])).toBe(true);
    });
  });

  describe('checkOnboarding', () => {
    test('shouldWarn when hooks missing but recent subagents present', () => {
      const root = path.join(tmp, 'projects');
      const subagents = path.join(root, '-p', 's', 'subagents');
      mkdirSync(subagents, { recursive: true });
      writeFileSync(path.join(subagents, 'agent-x.jsonl'), '{}\n');
      const result = checkOnboarding([root], path.join(tmp, 'events-missing'));
      expect(result).toEqual({ hooks: false, recentSubagents: true, shouldWarn: true });
    });

    test('does not warn when hooks are installed, even with subagents', () => {
      const root = path.join(tmp, 'projects');
      const subagents = path.join(root, '-p', 's', 'subagents');
      mkdirSync(subagents, { recursive: true });
      writeFileSync(path.join(subagents, 'agent-x.jsonl'), '{}\n');
      const events = path.join(tmp, 'events');
      mkdirSync(events, { recursive: true });
      writeFileSync(path.join(events, 'sess.jsonl'), '{}\n');
      const result = checkOnboarding([root], events);
      expect(result.hooks).toBe(true);
      expect(result.shouldWarn).toBe(false);
    });

    test('does not warn when neither hooks nor subagents are present', () => {
      const root = path.join(tmp, 'projects');
      mkdirSync(root, { recursive: true });
      const result = checkOnboarding([root], path.join(tmp, 'events-missing'));
      expect(result.shouldWarn).toBe(false);
    });
  });
});
