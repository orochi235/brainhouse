import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateIfLarge } from './log-rotation.mjs';

let dir;
let log;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bh-rotate-'));
  log = path.join(dir, 'stdout.log');
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('rotateIfLarge', () => {
  it('leaves a file under the limit alone', async () => {
    await fsp.writeFile(log, 'x'.repeat(100));
    expect(await rotateIfLarge(log, 1000)).toBe(0);
    expect((await fsp.stat(log)).size).toBe(100);
    await expect(fsp.stat(`${log}.1`)).rejects.toThrow();
  });

  it('is a no-op when the file does not exist', async () => {
    expect(await rotateIfLarge(path.join(dir, 'absent.log'), 10)).toBe(0);
  });

  it('copies to .1 and empties the original when over the limit', async () => {
    await fsp.writeFile(log, 'y'.repeat(500));
    expect(await rotateIfLarge(log, 100)).toBe(500);
    expect((await fsp.stat(log)).size).toBe(0);
    expect(await fsp.readFile(`${log}.1`, 'utf8')).toBe('y'.repeat(500));
  });

  it('overwrites a previous generation rather than stacking', async () => {
    await fsp.writeFile(`${log}.1`, 'older');
    await fsp.writeFile(log, 'z'.repeat(500));
    await rotateIfLarge(log, 100);
    expect(await fsp.readFile(`${log}.1`, 'utf8')).toBe('z'.repeat(500));
  });

  // The load-bearing one: launchd holds StandardOutPath open O_APPEND for the
  // life of the job. Rotation must keep that fd writing into the same file.
  it('keeps an already-open append fd writing after truncation', async () => {
    const fh = await fsp.open(log, 'a');
    try {
      await fh.write('a'.repeat(500));
      await rotateIfLarge(log, 100);
      await fh.write('after');
      expect(await fsp.readFile(log, 'utf8')).toBe('after');
      expect(await fsp.readFile(`${log}.1`, 'utf8')).toBe('a'.repeat(500));
    } finally {
      await fh.close();
    }
  });
});
