import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFrameworkFromArgv, readPackageVersion } from './framework.js';

describe('detectFrameworkFromArgv', () => {
  it('vite via node_modules', () => {
    const r = detectFrameworkFromArgv(['node', '/x/proj/node_modules/vite/bin/vite.js']);
    expect(r).toMatchObject({ framework: 'vite', package_path: '/x/proj/node_modules/vite' });
  });
  it('next dev', () => {
    const r = detectFrameworkFromArgv(['node', '/x/proj/node_modules/next/dist/bin/next', 'dev']);
    expect(r?.framework).toBe('next');
  });
  it('django runserver', () => {
    const r = detectFrameworkFromArgv(['python', 'manage.py', 'runserver']);
    expect(r?.framework).toBe('django');
  });
  it('rails server', () => {
    const r = detectFrameworkFromArgv(['ruby', 'bin/rails', 'server']);
    expect(r?.framework).toBe('rails');
  });
  it('playwright via @playwright scope', () => {
    expect(detectFrameworkFromArgv(['node', '/x/node_modules/@playwright/test/cli.js'])?.framework).toBe('playwright');
    expect(detectFrameworkFromArgv(['npx', '@playwright/mcp@latest'])?.framework).toBe('playwright');
  });
  it('astro / nuxt / remix / webpack-dev-server', () => {
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/astro/astro.js'])?.framework).toBe('astro');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/nuxt/bin/nuxt.mjs'])?.framework).toBe('nuxt');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/@remix-run/dev/dist/cli.js'])?.framework).toBe('remix');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/webpack-dev-server/bin/webpack-dev-server.js'])?.framework).toBe('webpack-dev-server');
  });
  it('vitest / jest / storybook / gatsby via node_modules', () => {
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/vitest/dist/cli.js'])?.framework).toBe('vitest');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/jest/bin/jest.js'])?.framework).toBe('jest');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/@storybook/cli/bin/index.js'])?.framework).toBe('storybook');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/gatsby/dist/bin/gatsby.js'])?.framework).toBe('gatsby');
  });
  it('bare-name argv: vite / vitest / jest / hugo / jekyll / tsc', () => {
    expect(detectFrameworkFromArgv(['vite', 'dev'])?.framework).toBe('vite');
    expect(detectFrameworkFromArgv(['/opt/homebrew/bin/vite'])?.framework).toBe('vite');
    expect(detectFrameworkFromArgv(['vitest', 'run'])?.framework).toBe('vitest');
    expect(detectFrameworkFromArgv(['jest', '--watch'])?.framework).toBe('jest');
    expect(detectFrameworkFromArgv(['hugo', 'server', '-D'])?.framework).toBe('hugo');
    expect(detectFrameworkFromArgv(['jekyll', 'serve'])?.framework).toBe('jekyll');
    expect(detectFrameworkFromArgv(['tsc', '--watch'])?.framework).toBe('tsc');
  });
  it('react-native / expo / turbo / nx / jupyter', () => {
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/react-native/cli.js', 'start'])?.framework).toBe('react-native');
    expect(detectFrameworkFromArgv(['expo', 'start'])?.framework).toBe('expo');
    expect(detectFrameworkFromArgv(['turbo', 'run', 'dev'])?.framework).toBe('turbo');
    expect(detectFrameworkFromArgv(['nx', 'serve'])?.framework).toBe('nx');
    expect(detectFrameworkFromArgv(['jupyter-lab'])?.framework).toBe('jupyter');
    expect(detectFrameworkFromArgv(['jupyter', 'notebook'])?.framework).toBe('jupyter');
  });
  it('does not false-match vite inside an unrelated path', () => {
    // /Users/vite-fan/code — "vite" appears but not as a standalone token.
    // The (?:^|\s|\/) word-boundary alternative requires the match to
    // start at a path separator, and (?:\s|$) must end at end-of-arg.
    // "vite-fan" has "-" after "vite", so it should NOT match.
    expect(detectFrameworkFromArgv(['node', '/Users/vite-fan/code/server.js'])).toBeNull();
  });
});

describe('readPackageVersion', () => {
  it('reads version from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
    expect(readPackageVersion(dir)).toBe('1.2.3');
  });
  it('returns null when missing', () => {
    expect(readPackageVersion('/nonexistent-' + Date.now())).toBeNull();
  });
});
