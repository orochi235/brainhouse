import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageCacheDir, resolveImageFile, stashEventImages } from './images.js';
import { parseLine } from './parser.js';

const PNG_BASE64 = 'iVBORw0KGgo=';
const PNG_SHA = '929e08d597feae564ce98003c4a47ff5239a5b93681d186eda3a9871e5b62644';

let dir: string;
const previous = process.env.BRAINHOUSE_IMAGE_DIR;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bh-images-'));
  process.env.BRAINHOUSE_IMAGE_DIR = dir;
});

afterAll(() => {
  if (previous === undefined) delete process.env.BRAINHOUSE_IMAGE_DIR;
  else process.env.BRAINHOUSE_IMAGE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

function pastedImageEvent(data = PNG_BASE64) {
  const events = parseLine({
    type: 'user',
    uuid: 'u1',
    sessionId: 's1',
    timestamp: 't',
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
    },
  });
  const event = events[0];
  if (event?.kind !== 'image') throw new Error('expected an image event');
  return event;
}

describe('stashEventImages', () => {
  it('writes the bytes and swaps data for a hash', () => {
    const event = pastedImageEvent();
    stashEventImages(event);
    expect(event.payload.ref.data).toBeUndefined();
    expect(event.payload.ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(imageCacheDir(), `${event.payload.ref.sha256}.png`);
    expect(readFileSync(file)).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  });

  it('hashes by content, so a repeat paste reuses the cached file', () => {
    const a = pastedImageEvent();
    const b = pastedImageEvent();
    stashEventImages(a);
    stashEventImages(b);
    expect(a.payload.ref.sha256).toBe(b.payload.ref.sha256);
  });

  it('reaches images nested in a tool_result', () => {
    const [event] = parseLine({
      type: 'user',
      uuid: 'u2',
      sessionId: 's1',
      timestamp: 't',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
              },
            ],
          },
        ],
      },
    });
    if (event?.kind !== 'tool_result') throw new Error('expected a tool_result event');
    stashEventImages(event);
    expect(JSON.stringify(event)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(event)).toContain('sha256');
  });

  it('leaves kinds that never carry images untouched', () => {
    const event = { kind: 'user_text', payload: { text: 'hi' } };
    stashEventImages(event);
    expect(event).toEqual({ kind: 'user_text', payload: { text: 'hi' } });
  });
});

describe('resolveImageFile', () => {
  it('resolves a stashed image', () => {
    const event = pastedImageEvent();
    stashEventImages(event);
    const hit = resolveImageFile(`${event.payload.ref.sha256}.png`);
    expect(hit?.mediaType).toBe('image/png');
  });

  it('returns null for a well-formed name with nothing behind it', () => {
    expect(resolveImageFile(`${'0'.repeat(64)}.png`)).toBeNull();
  });

  it.each([
    '../../../etc/passwd',
    'not-a-hash.png',
    `${'0'.repeat(64)}.exe`,
    `${'0'.repeat(63)}.png`,
    `${'0'.repeat(64)}.png/../../x`,
  ])('rejects %s', (name) => {
    expect(resolveImageFile(name)).toBeNull();
  });
});

// The hash is over the base64 text, not the decoded bytes — pinned so a
// change of hashing input is a loud test failure rather than a silent
// cache-wide miss.
it('hashes the base64 payload', () => {
  const event = pastedImageEvent();
  stashEventImages(event);
  expect(event.payload.ref.sha256).toBe(PNG_SHA);
});
