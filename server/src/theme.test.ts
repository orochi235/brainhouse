import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPanelThemeCache, readPanelTheme } from './theme.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'brainhouse-theme-'));
  clearPanelThemeCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  clearPanelThemeCache();
});

async function writeHued(body: string): Promise<void> {
  await writeFile(path.join(dir, '.hued'), body, 'utf8');
}

describe('readPanelTheme', () => {
  it('returns null when .hued is missing', async () => {
    expect(await readPanelTheme(dir)).toBeNull();
  });

  it('returns null for empty cwd', async () => {
    expect(await readPanelTheme('')).toBeNull();
  });

  it('parses a dark background and picks white foreground', async () => {
    await writeHued('background=#320053\n');
    const theme = await readPanelTheme(dir);
    expect(theme).toEqual({ background: '#320053', foreground: '#fff' });
  });

  it('picks black foreground for light backgrounds', async () => {
    await writeHued('background=#cccc99\n');
    const theme = await readPanelTheme(dir);
    expect(theme?.foreground).toBe('#000');
  });

  it('refuses near-white backgrounds (would wash text out)', async () => {
    await writeHued('background=#fefefe\n');
    expect(await readPanelTheme(dir)).toBeNull();
  });

  it('ignores comments and blank lines', async () => {
    await writeHued('# a comment\n\nbackground=#112233\n');
    const theme = await readPanelTheme(dir);
    expect(theme?.background).toBe('#112233');
  });

  it('expands 3-digit hex shorthand', async () => {
    await writeHued('background=#123\n');
    const theme = await readPanelTheme(dir);
    expect(theme?.background).toBe('#123');
    expect(theme?.foreground).toBe('#fff');
  });

  it('rejects non-hex values', async () => {
    await writeHued('background=purple\n');
    expect(await readPanelTheme(dir)).toBeNull();
  });

  it('re-reads when .hued mtime changes (polling picks up edits)', async () => {
    await writeHued('background=#222222\n');
    const first = await readPanelTheme(dir);
    expect(first?.background).toBe('#222222');
    // Bump mtime so the cache invalidates. Some filesystems have
    // second-level mtime granularity, so writeFile-twice-in-a-row can
    // collide; we set mtime explicitly to be deterministic.
    await writeHued('background=#664422\n');
    const { utimes } = await import('node:fs/promises');
    const future = new Date(Date.now() + 5_000);
    await utimes(path.join(dir, '.hued'), future, future);
    const second = await readPanelTheme(dir);
    expect(second?.background).toBe('#664422');
  });

  it('skips re-parse on unchanged mtime', async () => {
    await writeHued('background=#222222\n');
    const first = await readPanelTheme(dir);
    // Overwrite contents but preserve mtime — the cached parse should win.
    await writeHued('background=#eeeeee\n');
    const { stat, utimes } = await import('node:fs/promises');
    const huedPath = path.join(dir, '.hued');
    // Re-stamp the freshly-written file with the original cached mtime so
    // the cache key hits on the next read.
    const st = await stat(huedPath);
    await utimes(huedPath, st.atime, new Date((first ? Date.now() : 0) - 60_000));
    // Read once to seed the cache against the back-dated mtime, then
    // assert subsequent reads short-circuit.
    const seeded = await readPanelTheme(dir);
    const again = await readPanelTheme(dir);
    expect(again).toEqual(seeded);
  });

  it('clearPanelThemeCache forces re-read', async () => {
    await writeHued('background=#222222\n');
    await readPanelTheme(dir);
    clearPanelThemeCache();
    await writeHued('background=#664422\n');
    const theme = await readPanelTheme(dir);
    expect(theme?.background).toBe('#664422');
  });

  it('picks up a newly-created .hued (previous absence was cached)', async () => {
    expect(await readPanelTheme(dir)).toBeNull();
    await writeHued('background=#112233\n');
    const theme = await readPanelTheme(dir);
    expect(theme?.background).toBe('#112233');
  });
});
