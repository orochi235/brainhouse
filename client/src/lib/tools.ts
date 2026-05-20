/**
 * Per-tool icons and smart summary labels for tool capsules.
 *
 * Mirrors pensieve/static/app.js TOOL_ICONS / CLI_ICONS / summarizeTool /
 * parseBashCommandHead. Kept as a pure-function module so it stays
 * easy-to-test and easy-to-extend.
 *
 * CLI logo SVGs in ../assets/icons/ are sourced from Simple Icons
 * (https://simpleicons.org/), licensed CC0-1.0. The jq icon is a
 * hand-rolled `{}` glyph (no Simple Icons entry exists).
 */

import brewIcon from '../assets/icons/brew.svg?raw';
import bunIcon from '../assets/icons/bun.svg?raw';
import cargoIcon from '../assets/icons/cargo.svg?raw';
import curlIcon from '../assets/icons/curl.svg?raw';
import denoIcon from '../assets/icons/deno.svg?raw';
import dockerIcon from '../assets/icons/docker.svg?raw';
import ghIcon from '../assets/icons/gh.svg?raw';
import gitIcon from '../assets/icons/git.svg?raw';
import goIcon from '../assets/icons/go.svg?raw';
import jqIcon from '../assets/icons/jq.svg?raw';
import kubectlIcon from '../assets/icons/kubectl.svg?raw';
import makeIcon from '../assets/icons/make.svg?raw';
import nodeIcon from '../assets/icons/node.svg?raw';
import npmIcon from '../assets/icons/npm.svg?raw';
import npxIcon from '../assets/icons/npx.svg?raw';
import nvimIcon from '../assets/icons/nvim.svg?raw';
import pipIcon from '../assets/icons/pip.svg?raw';
import pnpmIcon from '../assets/icons/pnpm.svg?raw';
import pytestIcon from '../assets/icons/pytest.svg?raw';
import pythonIcon from '../assets/icons/python.svg?raw';
import python3Icon from '../assets/icons/python3.svg?raw';
import rustcIcon from '../assets/icons/rustc.svg?raw';
import uvIcon from '../assets/icons/uv.svg?raw';
import vimIcon from '../assets/icons/vim.svg?raw';
import wgetIcon from '../assets/icons/wget.svg?raw';
import yarnIcon from '../assets/icons/yarn.svg?raw';

interface ToolUseInput {
  command?: string;
  file_path?: string;
  pattern?: string;
  path?: string;
  url?: string;
  query?: string;
  subagent_type?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ToolUsePayload {
  tool_use_id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
}

export type ToolIcon = { kind: 'svg'; svg: string } | { kind: 'glyph'; text: string };

export const TOOL_ICONS: Record<string, string> = {
  Bash: '▶',
  Read: '📄',
  Edit: '✎',
  Write: '✏',
  Glob: '🗂',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '◈',
  TaskCreate: '✓',
  TaskUpdate: '✓',
};

export const CLI_ICONS: Record<string, string> = {
  gh: ghIcon,
  git: gitIcon,
  curl: curlIcon,
  wget: wgetIcon,
  npm: npmIcon,
  npx: npxIcon,
  pnpm: pnpmIcon,
  yarn: yarnIcon,
  python: pythonIcon,
  python3: python3Icon,
  pip: pipIcon,
  uv: uvIcon,
  pytest: pytestIcon,
  make: makeIcon,
  docker: dockerIcon,
  kubectl: kubectlIcon,
  node: nodeIcon,
  deno: denoIcon,
  bun: bunIcon,
  cargo: cargoIcon,
  rustc: rustcIcon,
  go: goIcon,
  brew: brewIcon,
  jq: jqIcon,
  vim: vimIcon,
  nvim: nvimIcon,
};

const BASH_SKIP = new Set(['sudo', 'time', 'command', 'exec', 'nice', 'env']);

export function parseBashCommandHead(cmd: string): string {
  if (!cmd) return '';
  const tokens = cmd.trim().split(/\s+/);
  for (const t of tokens) {
    if (!t) continue;
    if (t.includes('=') && !t.startsWith('-')) continue;
    if (BASH_SKIP.has(t)) continue;
    if (t.startsWith('-')) continue;
    return t.replace(/^\.?\/?/, '');
  }
  return '';
}

export function iconForTool(name: string, input: unknown): ToolIcon {
  if (name === 'Bash' && input && typeof input === 'object') {
    const cmd = (input as ToolUseInput).command;
    if (typeof cmd === 'string') {
      const head = parseBashCommandHead(cmd);
      if (head && CLI_ICONS[head]) return { kind: 'svg', svg: CLI_ICONS[head] };
    }
  }
  return { kind: 'glyph', text: TOOL_ICONS[name] ?? '⚙' };
}

export function shortenPath(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `.../${parts.slice(-2).join('/')}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function summarizeTool(
  use: { name?: string; input?: unknown },
  result: ToolResultPayload | null,
): string {
  const name = use.name ?? 'tool';
  const input = (use.input ?? {}) as ToolUseInput;
  let label: string;
  if (name === 'Bash') {
    const cmd = (input.command ?? '').split('\n')[0] ?? '';
    label = cmd ? truncate(cmd, 70) : 'bash';
  } else if (name === 'Read' || name === 'Edit' || name === 'Write') {
    label = `${name} ${shortenPath(input.file_path)}`;
  } else if (name === 'Grep') {
    label = `Grep ${JSON.stringify(input.pattern ?? '')}`;
    if (input.path) label += ` in ${shortenPath(input.path)}`;
  } else if (name === 'Glob') {
    label = `Glob ${input.pattern ?? ''}`;
  } else if (name === 'WebFetch' || name === 'WebSearch') {
    label = `${name}: ${truncate(input.url ?? input.query ?? '', 50)}`;
  } else if (name === 'Task') {
    const t = input.subagent_type ?? 'agent';
    const d = input.description ?? '';
    label = `Task: ${t}${d ? ` — ${truncate(d, 50)}` : ''}`;
  } else {
    const firstVal = Object.values(input)[0];
    label = name + (firstVal !== undefined ? `: ${truncate(String(firstVal), 50)}` : '');
  }
  if (!result) return label;
  if (result.is_error) return `${label}  · error`;
  const text =
    typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  const lines = text ? text.split('\n').filter(Boolean).length : 0;
  let suffix: string;
  if (!text) suffix = 'done';
  else if (name === 'Read' && lines > 0) suffix = `${lines} lines`;
  else if ((name === 'Grep' || name === 'Glob') && lines > 0) suffix = `${lines} matches`;
  else if (lines > 1) suffix = `${lines} lines`;
  else suffix = `${text.length} chars`;
  return `${label}  · ${suffix}`;
}

export function stringifyToolValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
