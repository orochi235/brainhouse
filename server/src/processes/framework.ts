import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FrameworkHit = { framework: string; package_path: string | null };

/** Patterns are tried in order; first match wins. node_modules path
 * patterns come first because they also yield a package_path we can
 * use for version detection. Bare-name patterns afterward catch
 * tools invoked via pnpm exec / volta shim / global install where
 * the binary path doesn't include a node_modules segment. */
const PATTERNS: Array<{ framework: string; re: RegExp; pkgGroup?: number }> = [
  // node_modules-path matches (yield package_path for version detection).
  { framework: 'vite',                re: /(\S*\/node_modules\/vite)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'next',                re: /(\S*\/node_modules\/next)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'astro',               re: /(\S*\/node_modules\/astro)(\/|\s|$)/,            pkgGroup: 1 },
  { framework: 'nuxt',                re: /(\S*\/node_modules\/nuxt)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'remix',               re: /(\S*\/node_modules\/@remix-run\/dev)(\/|\s|$)/,  pkgGroup: 1 },
  { framework: 'webpack-dev-server',  re: /(\S*\/node_modules\/webpack-dev-server)(\/|\s|$)/, pkgGroup: 1 },
  { framework: 'vitest',              re: /(\S*\/node_modules\/vitest)(\/|\s|$)/,           pkgGroup: 1 },
  { framework: 'jest',                re: /(\S*\/node_modules\/jest)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'storybook',           re: /(\S*\/node_modules\/@storybook\/[^/]+)(\/|\s|$)/, pkgGroup: 1 },
  { framework: 'gatsby',              re: /(\S*\/node_modules\/gatsby)(\/|\s|$)/,           pkgGroup: 1 },
  { framework: 'expo',                re: /(\S*\/node_modules\/expo)(\/|\s|$)/,             pkgGroup: 1 },
  { framework: 'tauri',               re: /(\S*\/node_modules\/@tauri-apps\/cli)(\/|\s|$)/, pkgGroup: 1 },
  { framework: 'turbo',               re: /(\S*\/node_modules\/turbo)(\/|\s|$)/,            pkgGroup: 1 },
  { framework: 'nx',                  re: /(\S*\/node_modules\/nx)(\/|\s|$)/,               pkgGroup: 1 },
  // Bare-name matches — catch tools invoked directly without a
  // node_modules path in argv. Word boundaries: must start at start /
  // whitespace / path separator, must end at whitespace / path
  // separator / end. The trailing `/` lets us also catch cases like
  // `node_modules/react-native/cli.js` even when there's no dedicated
  // node_modules-path pattern. `vite-fan` doesn't match because `-`
  // isn't in the trailing alternation.
  { framework: 'vite',                re: /(?:^|\s|\/)vite(?:\s|\/|$)/ },
  { framework: 'vitest',              re: /(?:^|\s|\/)vitest(?:\s|\/|$)/ },
  { framework: 'jest',                re: /(?:^|\s|\/)jest(?:\s|\/|$)/ },
  { framework: 'storybook',           re: /(?:^|\s|\/)storybook(?:\s|\/|$)/ },
  { framework: 'gatsby',              re: /(?:^|\s|\/)gatsby(?:\s|\/|$)/ },
  { framework: 'expo',                re: /(?:^|\s|\/)expo(?:\s|\/|$)/ },
  { framework: 'react-native',        re: /(?:^|\s|\/)react-native(?:\s|\/|$)/ },
  { framework: 'turbo',               re: /(?:^|\s|\/)turbo(?:\s|\/|$)/ },
  { framework: 'nx',                  re: /(?:^|\s|\/)nx(?:\s|\/|$)/ },
  { framework: 'hugo',                re: /(?:^|\s|\/)hugo(?:\s|\/|$)/ },
  { framework: 'jekyll',              re: /(?:^|\s|\/)jekyll(?:\s|\/|$)/ },
  { framework: 'electron',            re: /\/Electron(?:\.app|\s|$)/ },
  { framework: 'tsc',                 re: /(?:^|\s|\/)tsc(?:\s|$)/ },
  { framework: 'jupyter',             re: /(?:^|\s|\/)jupyter(?:-\w+)?(?:\s|$)/ },
  // App-style matches (no node_modules path, distinctive arg shape).
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
