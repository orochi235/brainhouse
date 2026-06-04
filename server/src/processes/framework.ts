import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FrameworkHit = { framework: string; package_path: string | null };

const PATTERNS: Array<{ framework: string; re: RegExp; pkgGroup?: number }> = [
  { framework: 'vite',                re: /(\S*\/node_modules\/vite)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'next',                re: /(\S*\/node_modules\/next)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'astro',               re: /(\S*\/node_modules\/astro)(\/|\s|$)/,            pkgGroup: 1 },
  { framework: 'nuxt',                re: /(\S*\/node_modules\/nuxt)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'remix',               re: /(\S*\/node_modules\/@remix-run\/dev)(\/|\s|$)/,  pkgGroup: 1 },
  { framework: 'webpack-dev-server',  re: /(\S*\/node_modules\/webpack-dev-server)(\/|\s|$)/, pkgGroup: 1 },
  { framework: 'rails',               re: /(?:^|\/|\s)bin\/rails(\s|$)/ },
  { framework: 'django',              re: /manage\.py(\s|$)/ },
  { framework: 'flask',               re: /flask(\s|$)/ },
  // Playwright distributes everything under @playwright/* (test, mcp,
  // browser bundles). Match the scope prefix so any of them surface as
  // playwright without a per-package list.
  { framework: 'playwright',          re: /@playwr/ },
];

export function detectFrameworkFromArgv(argv: string[]): FrameworkHit | null {
  const joined = argv.join(' ');
  for (const p of PATTERNS) {
    const m = joined.match(p.re);
    if (m) return { framework: p.framework, package_path: p.pkgGroup ? (m[p.pkgGroup] ?? null) : null };
  }
  return null;
}

const versionCache = new Map<string, { mtime: number; version: string | null }>();

export function readPackageVersion(packagePath: string): string | null {
  try {
    const pj = join(packagePath, 'package.json');
    if (!existsSync(pj)) return null;
    const st = statSync(pj);
    const cached = versionCache.get(pj);
    if (cached && cached.mtime === st.mtimeMs) return cached.version;
    const v = (JSON.parse(readFileSync(pj, 'utf8')).version as string) ?? null;
    versionCache.set(pj, { mtime: st.mtimeMs, version: v });
    return v;
  } catch { return null; }
}
