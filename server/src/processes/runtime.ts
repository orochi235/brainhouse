export type Runtime = { runtime: string; runtime_version: string | null; runtime_source: 'path' | 'probe' | 'argv' };

const PATH_PATTERNS: Array<{ runtime: string; re: RegExp }> = [
  // Version managers (per-user)
  { runtime: 'node',   re: /\.nvm\/versions\/node\/v?(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.volta\/tools\/image\/node\/(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.fnm\/node-versions\/v(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.asdf\/installs\/nodejs\/(\d+\.\d+\.\d+)\// },
  { runtime: 'python', re: /\.asdf\/installs\/python\/(\d+\.\d+\.\d+)\// },
  { runtime: 'python', re: /\.pyenv\/versions\/(\d+\.\d+\.\d+)\// },
  { runtime: 'ruby',   re: /\.rbenv\/versions\/(\d+\.\d+\.\d+)\// },
  { runtime: 'ruby',   re: /\.asdf\/installs\/ruby\/(\d+\.\d+\.\d+)\// },
  { runtime: 'bun',    re: /\.bun\/install\/global\/.*?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'deno',   re: /\.deno\/bin\// },
  // Homebrew Cellar (system-wide). Both Apple Silicon (/opt/homebrew)
  // and Intel (/usr/local) layouts. The formula name may include a
  // version tag (e.g. python@3.14, node@20); the second numeric segment
  // is always the actual installed version.
  { runtime: 'node',   re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/node(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'python', re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/python(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'ruby',   re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/ruby(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'go',     re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/go(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'php',    re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/php(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'redis',  re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/redis(?:@[\d.]+)?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'postgres', re: /(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/postgresql(?:@[\d.]+)?\/(\d+\.\d+\.?\d*)\// },
];

export function detectRuntimeFromPath(exePath: string): Runtime | null {
  for (const { runtime, re } of PATH_PATTERNS) {
    const m = exePath.match(re);
    if (m) return { runtime, runtime_version: m[1] ?? null, runtime_source: 'path' };
  }
  return null;
}

const ARGV0_KNOWN: Record<string, string> = {
  node: 'node', bun: 'bun', deno: 'deno', ruby: 'ruby', php: 'php',
  go: 'go', cargo: 'cargo', java: 'java', postgres: 'postgres', redis: 'redis', mysql: 'mysql',
  // Wrappers that always shell into node: surface as node so the icon
  // and color match Bash tool capsules.
  npm: 'node', npx: 'node', yarn: 'node', pnpm: 'node',
  // Claude Code itself — the binary that wraps session processes. We
  // identify it as its own runtime so it surfaces in the panel even
  // when it has no listening port (see qualifiesForBroadcast).
  claude: 'claude',
};

export function detectRuntimeFromArgv(argv: string[]): Runtime | null {
  // Scan the first few argv tokens — system processes often prefix
  // with `exec` or environment shims; the meaningful command name may
  // not be at argv[0]. (E.g. macOS ps may show "exec @playwr npm ...".)
  for (let i = 0; i < Math.min(argv.length, 4); i++) {
    const token = argv[i];
    if (!token) continue;
    const head = token.split('/').pop() ?? token;
    const py = head.match(/^python(\d+\.\d+)?$/);
    if (py) return { runtime: 'python', runtime_version: py[1] ?? null, runtime_source: 'argv' };
    const known = ARGV0_KNOWN[head];
    if (known) return { runtime: known, runtime_version: null, runtime_source: 'argv' };
  }
  return null;
}
