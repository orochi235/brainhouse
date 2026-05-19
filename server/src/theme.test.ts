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

  it('caches results across calls', async () => {
    await writeHued('background=#222222\n');
    const first = await readPanelTheme(dir);
    // Overwrite to a value that would parse differently; cached should win.
    await writeHued('background=#eeeeee\n');
    const second = await readPanelTheme(dir);
    expect(second).toEqual(first);
  });

  it('clearPanelThemeCache forces re-read', async () => {
    await writeHued('background=#222222\n');
    await readPanelTheme(dir);
    await writeHued('background=#664422\n');
    clearPanelThemeCache();
    const theme = await readPanelTheme(dir);
    expect(theme?.background).toBe('#664422');
  });
});
