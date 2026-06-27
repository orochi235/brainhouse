import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDirByInode } from './findRenamed.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'brainhouse-rename-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findDirByInode', () => {
  it('locates a directory renamed in place by its inode', async () => {
    const oldPath = path.join(root, 'old-name');
    await mkdir(oldPath);
    const { dev, ino } = await stat(oldPath);
    const newPath = path.join(root, 'new-name');
    await rename(oldPath, newPath);

    expect(await findDirByInode(root, dev, ino)).toBe(newPath);
  });

  it('returns null when no entry matches (real delete)', async () => {
    const p = path.join(root, 'gone');
    await mkdir(p);
    const { dev, ino } = await stat(p);
    await rm(p, { recursive: true });

    expect(await findDirByInode(root, dev, ino)).toBeNull();
  });

  it('returns null when the parent directory does not exist', async () => {
    expect(await findDirByInode(path.join(root, 'nope'), 1, 2)).toBeNull();
  });

  it('ignores non-directory entries with a matching inode', async () => {
    // A file can never be a renamed session cwd; match only directories.
    const f = path.join(root, 'a-file');
    await writeFile(f, 'x');
    const { dev, ino } = await stat(f);

    expect(await findDirByInode(root, dev, ino)).toBeNull();
  });
});
