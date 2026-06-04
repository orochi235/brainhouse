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
