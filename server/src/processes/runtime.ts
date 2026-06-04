export type Runtime = { runtime: string; runtime_version: string | null; runtime_source: 'path' | 'probe' | 'argv' };

const PATH_PATTERNS: Array<{ runtime: string; re: RegExp }> = [
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
};

export function detectRuntimeFromArgv(argv: string[]): Runtime | null {
  if (argv.length === 0) return null;
  const head = argv[0].split('/').pop() ?? argv[0];
  const py = head.match(/^python(\d+\.\d+)?$/);
  if (py) return { runtime: 'python', runtime_version: py[1] ?? null, runtime_source: 'argv' };
  const known = ARGV0_KNOWN[head];
  if (known) return { runtime: known, runtime_version: null, runtime_source: 'argv' };
  return null;
}
