import { describe, expect, it } from 'vitest';
import {
  iconForTool,
  parseBashCommandHead,
  parseMcpToolName,
  salientBashCommand,
  shortenPath,
  stringifyToolValue,
  summarizeTool,
} from './tools.ts';

describe('parseMcpToolName', () => {
  it('splits server and tool on the last __, de-underscored', () => {
    expect(parseMcpToolName('mcp__claude_ai_Google_Calendar__create_event')).toEqual({
      server: 'Google Calendar',
      tool: 'create event',
    });
    expect(parseMcpToolName('mcp__claude_ai_Atlassian__getJiraIssue')).toEqual({
      server: 'Atlassian',
      tool: 'getJiraIssue',
    });
  });

  it('collapses plugin servers that repeat the plugin name', () => {
    expect(parseMcpToolName('mcp__plugin_playwright_playwright__browser_navigate')).toEqual({
      server: 'playwright',
      tool: 'browser navigate',
    });
    expect(parseMcpToolName('mcp__plugin_figma_figma__get_screenshot')).toEqual({
      server: 'figma',
      tool: 'get screenshot',
    });
  });

  it('returns null for non-MCP names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__nounderscoretool')).toBeNull();
  });
});

describe('parseBashCommandHead', () => {
  it('returns the first real token', () => {
    expect(parseBashCommandHead('ls -la')).toBe('ls');
    expect(parseBashCommandHead('git status')).toBe('git');
  });

  it('skips env assignments and wrappers', () => {
    expect(parseBashCommandHead('FOO=bar baz qux')).toBe('baz');
    expect(parseBashCommandHead('sudo apt-get install vim')).toBe('apt-get');
    expect(parseBashCommandHead('time npm test')).toBe('npm');
  });

  it('strips leading ./ or /', () => {
    expect(parseBashCommandHead('./script.sh')).toBe('script.sh');
    expect(parseBashCommandHead('/usr/bin/env node')).toBe('usr/bin/env');
  });

  it('returns empty for empty/whitespace', () => {
    expect(parseBashCommandHead('')).toBe('');
    expect(parseBashCommandHead('   ')).toBe('');
  });
});

describe('salientBashCommand', () => {
  it('passes a plain command through untouched (args kept)', () => {
    expect(salientBashCommand('ls -la')).toBe('ls -la');
    expect(salientBashCommand('git status')).toBe('git status');
  });

  it('drops a leading cd setup segment', () => {
    expect(salientBashCommand('cd repo && npm test')).toBe('npm test');
    expect(salientBashCommand('cd /some/path && git status')).toBe('git status');
  });

  it('strips leading env assignments within a segment', () => {
    expect(salientBashCommand('FOO=bar npm run build')).toBe('npm run build');
    expect(salientBashCommand('cd repo && FOO=1 BAR=2 npm test')).toBe('npm test');
  });

  it('keeps wrappers like sudo in the visible text', () => {
    expect(salientBashCommand('sudo systemctl restart nginx')).toBe('sudo systemctl restart nginx');
  });

  it('drops leading variable-declaration segments', () => {
    expect(salientBashCommand('export FOO=bar && npm run build')).toBe('npm run build');
    expect(salientBashCommand('export PATH=$PATH:/opt/bin && deploy.sh')).toBe('deploy.sh');
    expect(salientBashCommand('export A=1; export B=2; npm test')).toBe('npm test');
    expect(salientBashCommand('declare -x X=1 && run')).toBe('run');
  });

  it('does not drop a command merely prefixed by an export-like word', () => {
    expect(salientBashCommand('exportify --all')).toBe('exportify --all');
  });

  it('joins multiple real segments with their operators', () => {
    expect(salientBashCommand('git add -A && git commit -m "x"')).toBe(
      'git add -A && git commit -m "x"',
    );
    expect(salientBashCommand('npm run a; npm run b')).toBe('npm run a; npm run b');
    expect(salientBashCommand('test -f x || echo missing')).toBe('test -f x || echo missing');
  });

  it('keeps a pipeline intact (does not split on |)', () => {
    expect(salientBashCommand('cat x | grep y')).toBe('cat x | grep y');
    expect(salientBashCommand('cd d && cat x | grep y')).toBe('cat x | grep y');
  });

  it('does not split on operators inside quotes', () => {
    expect(salientBashCommand('git commit -m "fix && cleanup"')).toBe(
      'git commit -m "fix && cleanup"',
    );
    expect(salientBashCommand("echo 'a; b; c'")).toBe("echo 'a; b; c'");
  });

  it('falls back to the first line when every segment is setup', () => {
    expect(salientBashCommand('cd a && cd b')).toBe('cd a && cd b');
  });

  it('treats newlines as statement separators (skips leading setup lines)', () => {
    expect(salientBashCommand('cd /x\nnpm test')).toBe('npm test');
    expect(salientBashCommand('M=~/cache/foo\ncd "$M"\nFOO=1 bash run.sh')).toBe('bash run.sh');
  });

  it('joins line continuations into one logical command', () => {
    expect(salientBashCommand('FOO=1 \\\n  npm test')).toBe('npm test');
  });

  it('strips a quoted env value containing spaces', () => {
    expect(salientBashCommand('TITLE="feat: redesign login" npm run build')).toBe('npm run build');
  });

  it('handles a real multi-line env-prefixed launch command', () => {
    const cmd = [
      'M=~/.cache/pr-review/foo',
      'cd "$M"',
      'PORT=7264 PREVIEW_ENV=dev SCREENER_PR_TITLE="feat: [PW-1620] redesign login" \\',
      'SCREENER_PR_URL="https://example.com/pull/197" \\',
      'bash .claude/preview.sh 2>&1',
    ].join('\n');
    expect(salientBashCommand(cmd)).toBe('bash .claude/preview.sh 2>&1');
  });

  it('returns empty for empty/whitespace', () => {
    expect(salientBashCommand('')).toBe('');
    expect(salientBashCommand('   ')).toBe('');
  });
});

describe('iconForTool', () => {
  it('maps known tools', () => {
    expect(iconForTool('Read', null)).toEqual({ kind: 'glyph', text: '📄' });
    expect(iconForTool('Grep', null)).toEqual({ kind: 'glyph', text: '🔎' });
  });

  it('Bash dispatches on CLI head', () => {
    const git = iconForTool('Bash', { command: 'git diff' });
    expect(git.kind).toBe('svg');
    const docker = iconForTool('Bash', { command: 'docker ps' });
    expect(docker.kind).toBe('svg');
  });

  it('Bash dispatches on the salient command, not a leading cd', () => {
    const npm = iconForTool('Bash', { command: 'cd repo && npm test' });
    expect(npm.kind).toBe('svg');
    const git = iconForTool('Bash', { command: 'cd /x && FOO=1 git diff' });
    expect(git.kind).toBe('svg');
  });

  it('Bash falls back to generic when CLI unknown', () => {
    expect(iconForTool('Bash', { command: 'frobnicate --x' })).toEqual({
      kind: 'glyph',
      text: '▶',
    });
  });

  it('unknown tool → default gear', () => {
    expect(iconForTool('NeverHeardOf', null)).toEqual({ kind: 'glyph', text: '⚙' });
  });
});

describe('shortenPath', () => {
  it('returns short paths as-is', () => {
    expect(shortenPath('a/b/c')).toBe('a/b/c');
    expect(shortenPath('foo')).toBe('foo');
  });

  it('truncates long paths to last two segments', () => {
    expect(shortenPath('/a/b/c/d/file.ts')).toBe('.../d/file.ts');
  });

  it('non-string → empty', () => {
    expect(shortenPath(undefined)).toBe('');
    expect(shortenPath(123)).toBe('');
  });
});

describe('summarizeTool', () => {
  it('Bash joins multi-line statements via the salient filter', () => {
    const out = summarizeTool({ name: 'Bash', input: { command: 'ls\nfoo' } }, null);
    expect(out).toBe('ls; foo');
  });

  it('Bash skips leading setup lines to the real command', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'cd /tmp\nFOO=1 ./run.sh' } },
      null,
    );
    expect(out).toBe('./run.sh');
  });

  it('Bash returns the full command — CSS handles visual overflow', () => {
    const long = 'a'.repeat(200);
    const out = summarizeTool({ name: 'Bash', input: { command: long } }, null);
    expect(out).toBe(long);
  });

  it('Bash shows the salient command for a chained command', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'cd repo && FOO=1 npm test' } },
      null,
    );
    expect(out).toBe('npm test');
  });

  it('Bash salient filter composes with the result suffix', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'cd repo && npm test' } },
      { tool_use_id: 't', content: 'boom', is_error: true },
    );
    expect(out).toBe('npm test  · error');
  });

  it('Read includes shortened path', () => {
    const out = summarizeTool({ name: 'Read', input: { file_path: '/a/b/c/d/e.ts' } }, null);
    expect(out).toBe('Read .../d/e.ts');
  });

  it('Grep quotes pattern', () => {
    const out = summarizeTool({ name: 'Grep', input: { pattern: 'foo', path: 'src/x.ts' } }, null);
    expect(out).toBe('Grep "foo" in src/x.ts');
  });

  it('result error → · error suffix', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'ls' } },
      { tool_use_id: 't', content: 'no such file', is_error: true },
    );
    expect(out).toBe('ls  · error');
  });

  it('Read result reports line count', () => {
    const out = summarizeTool(
      { name: 'Read', input: { file_path: 'x.ts' } },
      { tool_use_id: 't', content: 'a\nb\nc', is_error: false },
    );
    expect(out).toMatch(/3 lines$/);
  });

  it('empty result → done', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'ls' } },
      { tool_use_id: 't', content: '', is_error: false },
    );
    expect(out).toMatch(/· done$/);
  });

  it('unknown tool shows first input value', () => {
    const out = summarizeTool({ name: 'MysteryTool', input: { thing: 'value' } }, null);
    expect(out).toBe('MysteryTool: value');
  });

  it('MCP tools get a server · tool label', () => {
    const out = summarizeTool(
      {
        name: 'mcp__plugin_playwright_playwright__browser_navigate',
        input: { url: 'http://x/' },
      },
      null,
    );
    expect(out).toBe('playwright · browser navigate: http://x/');
  });
});

describe('iconForTool — MCP', () => {
  it('MCP tools get the plug glyph', () => {
    expect(iconForTool('mcp__plugin_figma_figma__get_screenshot', null)).toEqual({
      kind: 'glyph',
      text: '🔌',
    });
  });
});

describe('stringifyToolValue', () => {
  it('pretty-prints objects', () => {
    expect(stringifyToolValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('returns strings as-is', () => {
    expect(stringifyToolValue('hello')).toBe('hello');
  });

  it('null/undefined → empty', () => {
    expect(stringifyToolValue(null)).toBe('');
    expect(stringifyToolValue(undefined)).toBe('');
  });
});
