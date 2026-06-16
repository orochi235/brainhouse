/**
 * Per-tool icons and smart summary labels for tool capsules.
 *
 * Mirrors brainhouse/static/app.js TOOL_ICONS / CLI_ICONS / summarizeTool /
 * parseBashCommandHead. Kept as a pure-function module so it stays
 * easy-to-test and easy-to-extend.
 *
 * CLI logo SVGs in ../assets/icons/ are sourced from Simple Icons
 * (https://simpleicons.org/), licensed CC0-1.0. The jq icon is a
 * hand-rolled `{}` glyph (no Simple Icons entry exists). The skull (used
 * for kill/pkill/killall) comes from Lucide (https://lucide.dev/), MIT.
 */

import awsIcon from '../assets/icons/aws.svg?raw';
import azIcon from '../assets/icons/az.svg?raw';
import brewIcon from '../assets/icons/brew.svg?raw';
import bunIcon from '../assets/icons/bun.svg?raw';
import cargoIcon from '../assets/icons/cargo.svg?raw';
import cloudflareIcon from '../assets/icons/cloudflare.svg?raw';
import curlIcon from '../assets/icons/curl.svg?raw';
import denoIcon from '../assets/icons/deno.svg?raw';
import dockerIcon from '../assets/icons/docker.svg?raw';
import gcloudIcon from '../assets/icons/gcloud.svg?raw';
import ghIcon from '../assets/icons/gh.svg?raw';
import gitIcon from '../assets/icons/git.svg?raw';
import glabIcon from '../assets/icons/glab.svg?raw';
import goIcon from '../assets/icons/go.svg?raw';
import helmIcon from '../assets/icons/helm.svg?raw';
import jqIcon from '../assets/icons/jq.svg?raw';
import kubectlIcon from '../assets/icons/kubectl.svg?raw';
import makeIcon from '../assets/icons/make.svg?raw';
import netlifyIcon from '../assets/icons/netlify.svg?raw';
import ngrokIcon from '../assets/icons/ngrok.svg?raw';
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
import skullIcon from '../assets/icons/skull.svg?raw';
import supabaseIcon from '../assets/icons/supabase.svg?raw';
import tailscaleIcon from '../assets/icons/tailscale.svg?raw';
import terraformIcon from '../assets/icons/terraform.svg?raw';
import uvIcon from '../assets/icons/uv.svg?raw';
import vercelIcon from '../assets/icons/vercel.svg?raw';
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
  // version control
  gh: ghIcon,
  git: gitIcon,
  glab: glabIcon,
  // http
  curl: curlIcon,
  wget: wgetIcon,
  // node ecosystem
  npm: npmIcon,
  npx: npxIcon,
  pnpm: pnpmIcon,
  yarn: yarnIcon,
  node: nodeIcon,
  deno: denoIcon,
  bun: bunIcon,
  // python ecosystem
  python: pythonIcon,
  python3: python3Icon,
  pip: pipIcon,
  uv: uvIcon,
  pytest: pytestIcon,
  // build / package
  make: makeIcon,
  brew: brewIcon,
  cargo: cargoIcon,
  rustc: rustcIcon,
  go: goIcon,
  // containers / orchestration
  docker: dockerIcon,
  kubectl: kubectlIcon,
  helm: helmIcon,
  // cloud + infra
  aws: awsIcon,
  gcloud: gcloudIcon,
  az: azIcon,
  terraform: terraformIcon,
  cloudflare: cloudflareIcon,
  tailscale: tailscaleIcon,
  ngrok: ngrokIcon,
  // edge / deploy
  vercel: vercelIcon,
  netlify: netlifyIcon,
  // backend platforms
  supabase: supabaseIcon,
  // tools
  jq: jqIcon,
  vim: vimIcon,
  nvim: nvimIcon,
  // destructive ops — kill/pkill/killall surface a skull so they're
  // visually unmistakable in a long Bash run.
  kill: skullIcon,
  pkill: skullIcon,
  killall: skullIcon,
};

const BASH_SKIP = new Set(['sudo', 'time', 'command', 'exec', 'nice', 'env']);

export interface McpToolName {
  server: string;
  tool: string;
}

/**
 * Parse an MCP tool name (`mcp__<server>__<tool>`) into display parts.
 * The server segment can itself contain underscores, so the tool is
 * whatever follows the LAST `__`. Known prefixes are stripped
 * (`claude_ai_` connectors, `plugin_` for plugin-bundled servers — where
 * a duplicated plugin/server word like `playwright_playwright` collapses
 * to one), and remaining underscores become spaces.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const idx = rest.lastIndexOf('__');
  if (idx <= 0) return null;
  let server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2).replace(/_/g, ' ');
  if (server.startsWith('claude_ai_')) server = server.slice('claude_ai_'.length);
  else if (server.startsWith('plugin_')) server = server.slice('plugin_'.length);
  const words = server.split('_').filter(Boolean);
  const deduped = words.filter((w, i) => w !== words[i - 1]);
  return { server: deduped.join(' '), tool };
}

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

/** Setup commands that are navigational noise — dropped from the salient
 * view of a chained command. */
const BASH_SETUP = new Set(['cd', 'pushd', 'popd']);

interface BashSegment {
  /** Operator preceding this segment: '' (first), '&&', '||', or ';'. */
  op: string;
  text: string;
}

/** Quote-aware split of one command line into sequence segments on
 * top-level `&&`, `||`, `;` — but NOT on `|` (a pipeline reads as one
 * command). Operators inside single/double quotes are ignored. This is a
 * display heuristic, not a shell parser: `$(...)`/backtick nesting isn't
 * tracked. */
function splitBashSegments(line: string): BashSegment[] {
  const segs: BashSegment[] = [];
  let buf = '';
  let op = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      segs.push({ op, text: buf });
      op = `${c}${c}`;
      buf = '';
      i += 1;
      continue;
    }
    if (c === ';') {
      segs.push({ op, text: buf });
      op = ';';
      buf = '';
      continue;
    }
    buf += c;
  }
  segs.push({ op, text: buf });
  return segs;
}

/** Strip leading env-assignments (`FOO=bar`) from a segment. Wrappers
 * (`sudo`, `time`, …) are intentionally kept so the displayed command
 * isn't misrepresented — only the icon's `parseBashCommandHead` looks
 * past them. */
function stripEnvPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (t.includes('=') && !t.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i).join(' ');
}

/**
 * The "salient" command(s) a reader cares about. Drops pure-setup
 * segments (`cd`/`pushd`/`popd`) and leading env-assignments, then
 * re-joins the survivors with their operators:
 *   `cd repo && FOO=1 npm test`        → `npm test`
 *   `git add -A && git commit -m "x"`  → `git add -A && git commit -m "x"`
 * Operates on the first line only. Falls back to the trimmed first line
 * when every segment is setup, so the result is never blank.
 */
export function salientBashCommand(cmd: string): string {
  if (!cmd) return '';
  const line = cmd.split('\n')[0] ?? '';
  const kept: BashSegment[] = [];
  for (const seg of splitBashSegments(line)) {
    const text = stripEnvPrefix(seg.text);
    if (!text) continue; // env-only segment
    const head = text.split(/\s+/)[0] ?? '';
    if (BASH_SETUP.has(head)) continue; // cd/pushd/popd
    kept.push({ op: seg.op, text });
  }
  if (kept.length === 0) return line.trim();
  let out = kept[0]?.text ?? '';
  for (let i = 1; i < kept.length; i += 1) {
    const s = kept[i];
    if (!s) continue;
    out += s.op === ';' ? `; ${s.text}` : ` ${s.op} ${s.text}`;
  }
  return out;
}

export function iconForTool(name: string, input: unknown): ToolIcon {
  if (name === 'Bash' && input && typeof input === 'object') {
    const cmd = (input as ToolUseInput).command;
    if (typeof cmd === 'string') {
      // Resolve the icon off the salient command so a leading `cd …` or
      // env-prefix doesn't mask the real CLI (`cd foo && npm test` → npm).
      const head = parseBashCommandHead(salientBashCommand(cmd));
      if (head && CLI_ICONS[head]) return { kind: 'svg', svg: CLI_ICONS[head] };
    }
  }
  if (parseMcpToolName(name)) return { kind: 'glyph', text: '🔌' };
  return { kind: 'glyph', text: TOOL_ICONS[name] ?? '⚙' };
}

export function shortenPath(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `.../${parts.slice(-2).join('/')}`;
}

export function summarizeTool(
  use: { name?: string; input?: unknown },
  result: ToolResultPayload | null,
): string {
  const name = use.name ?? 'tool';
  const input = (use.input ?? {}) as ToolUseInput;
  let label: string;
  // Data-layer text is the full, un-truncated label. The `.tool-label`
  // CSS handles visual overflow with ellipsis, so a wide panel shows
  // more of the command/URL/description than a narrow one — instead of
  // every capsule getting cut at a fixed char count regardless of
  // available space.
  if (name === 'Bash') {
    label = salientBashCommand(input.command ?? '') || 'bash';
  } else if (name === 'Read' || name === 'Edit' || name === 'Write') {
    label = `${name} ${shortenPath(input.file_path)}`;
  } else if (name === 'Grep') {
    label = `Grep ${JSON.stringify(input.pattern ?? '')}`;
    if (input.path) label += ` in ${shortenPath(input.path)}`;
  } else if (name === 'Glob') {
    label = `Glob ${input.pattern ?? ''}`;
  } else if (name === 'WebFetch' || name === 'WebSearch') {
    label = `${name}: ${input.url ?? input.query ?? ''}`;
  } else if (name === 'Task') {
    const t = input.subagent_type ?? 'agent';
    const d = input.description ?? '';
    label = `Task: ${t}${d ? ` — ${d}` : ''}`;
  } else {
    const mcp = parseMcpToolName(name);
    const head = mcp ? `${mcp.server} · ${mcp.tool}` : name;
    const firstVal = Object.values(input)[0];
    label = head + (firstVal !== undefined ? `: ${String(firstVal)}` : '');
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
    return prettyJson(value);
  } catch {
    return String(value);
  }
}

/**
 * Pretty-print a JSON value for human display. Same as
 * `JSON.stringify(v, null, 2)` except string literals get their
 * escape sequences unfolded: `\n` becomes a real newline (with
 * continuation indent so the value still reads as a single string),
 * `\t` becomes a tab, and `\"`, `\\`, `\r` are unescaped too.
 *
 * The output is no longer parseable JSON — readability wins. Use
 * `JSON.stringify` directly when the result needs to round-trip.
 */
export function prettyJson(value: unknown, indent = 2): string {
  return serialize(value, '', ' '.repeat(indent));
}

function serialize(value: unknown, prefix: string, indent: string): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return formatString(value as string, prefix);
  if (t === 'number' || t === 'boolean') return String(value);
  if (t === 'bigint') return `${value}n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const next = prefix + indent;
    const items = value.map((v) => `${next}${serialize(v, next, indent)}`).join(',\n');
    return `[\n${items}\n${prefix}]`;
  }
  if (t === 'object') {
    const entries = Object.entries(value as object);
    if (entries.length === 0) return '{}';
    const next = prefix + indent;
    const lines = entries
      .map(([k, v]) => `${next}${JSON.stringify(k)}: ${serialize(v, next, indent)}`)
      .join(',\n');
    return `{\n${lines}\n${prefix}}`;
  }
  return JSON.stringify(value);
}

function formatString(s: string, prefix: string): string {
  // No special chars? Standard JSON quoted string.
  if (!/[\n\r\t\\"]/.test(s)) return JSON.stringify(s);
  // Unescape into a readable block. Inner lines get the prefix so the
  // continuation aligns under the opening quote's column.
  const lines = s.split(/\r?\n/);
  if (lines.length === 1) {
    // Single-line but contains tabs / quotes / backslashes — just
    // unescape those individually inside a quoted form.
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\t')}"`;
  }
  const inner = lines.map((line, i) => (i === 0 ? line : `${prefix}${line}`)).join('\n');
  return `"${inner}"`;
}
