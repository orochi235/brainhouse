/**
 * `brainhouse init` — wire brainhouse's hooks into Claude Code's settings.
 *
 * Targets: ~/.claude/settings.json plus any sibling ~/.claude-* config dirs
 * (per-account harness homes such as .claude-pw, .claude-msb).
 *
 * Idempotent: re-running strips every brainhouse-tagged entry and re-adds
 * the current canonical set, so updates to the hook table take effect on
 * the next `brainhouse init` invocation.
 *
 * Flags:
 *   --uninstall    remove brainhouse hook entries
 *   --dry-run      show what would be written but don't write
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'brainhouse';

/** Events the brainhouse dispatcher mirrors into the sidecar JSONL. Kind
 * strings are the CLI arg passed to dispatcher.mjs. */
const DISPATCHER_EVENTS = /** @type {const} */ ([
  ['Stop', 'stop'],
  ['SubagentStop', 'subagent_stop'],
  ['Notification', 'notification'],
  ['SessionEnd', 'session_end'],
  ['SessionStart', 'session_start'],
]);

/** Canonical table of hooks brainhouse manages. Each entry produces one
 * settings.json hook registration tagged `brainhouse: "<role>"`. Add a
 * new hook by appending a row — install/uninstall iterate this list. */
export function hookRegistry(hooksDir) {
  /** @type {{ role: string, event: string, command: string, matcher?: string }[]} */
  const entries = [];
  const dispatcher = path.join(hooksDir, 'dispatcher.mjs');
  for (const [event, kind] of DISPATCHER_EVENTS) {
    entries.push({
      role: 'dispatcher',
      event,
      command: `node ${quote(dispatcher)} ${kind}`,
    });
  }
  // UserPromptSubmit hooks: piggyback small instructions onto the live
  // session's context, paying near-zero token cost instead of spawning
  // fresh `claude -p` subprocesses.
  entries.push({
    role: 'auto-title-inline',
    event: 'UserPromptSubmit',
    command: `node ${quote(path.join(hooksDir, 'auto-title-inline.mjs'))}`,
  });
  entries.push({
    role: 'context-reminder',
    event: 'UserPromptSubmit',
    command: `node ${quote(path.join(hooksDir, 'context-reminder.mjs'))}`,
  });
  entries.push({
    role: 'session-procs-reminder',
    event: 'UserPromptSubmit',
    command: `node ${quote(path.join(hooksDir, 'session-procs-reminder.mjs'))}`,
  });
  // Process-tracking hooks: snapshot running processes per session and
  // record bash command starts/ends so the UI can show long-running work.
  entries.push({
    role: 'procs-session-start',
    event: 'SessionStart',
    command: `node ${quote(path.join(hooksDir, 'session-start-procs.mjs'))}`,
  });
  entries.push({
    role: 'procs-pre-bash',
    event: 'PreToolUse',
    matcher: 'Bash',
    command: `node ${quote(path.join(hooksDir, 'pre-tool-use-bash.mjs'))}`,
  });
  entries.push({
    role: 'procs-post-bash',
    event: 'PostToolUse',
    matcher: 'Bash',
    command: `node ${quote(path.join(hooksDir, 'post-tool-use-bash.mjs'))}`,
  });
  return entries;
}

/** Wrap a path in double quotes safely (no embedded quotes/backslashes
 * expected, but escape just in case). */
function quote(p) {
  return `"${p.replace(/(["\\])/g, '\\$1')}"`;
}

function hooksDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'hooks');
}

function targetSettingsPaths() {
  const home = os.homedir();
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (e.name === '.claude' || e.name.startsWith('.claude-')))
    .map((e) => path.join(home, e.name, 'settings.json'));
}

async function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = await readFile(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/** Remove every hook entry tagged with our marker, regardless of role.
 * Truthy check covers both the legacy `brainhouse: true` form and the
 * current role-string form (`brainhouse: "dispatcher"` etc.). */
function stripBrainhouse(settings) {
  const hooks = settings.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((e) => !e?.[MARKER]);
    if (filtered.length === 0) delete hooks[event];
    else hooks[event] = filtered;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

function addBrainhouse(settings, registry) {
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks;
  for (const { role, event, command, matcher } of registry) {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push({
      [MARKER]: role,
      matcher: matcher ?? '.*',
      hooks: [{ type: 'command', command }],
    });
  }
  return settings;
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function runInit(argv) {
  const args = new Set(argv);
  const uninstall = args.has('--uninstall');
  const dryRun = args.has('--dry-run');

  const dir = hooksDir();
  const registry = hookRegistry(dir);
  // Pre-flight: every script the table references must exist.
  for (const { command } of registry) {
    const m = command.match(/^node "([^"]+)"/);
    const script = m?.[1];
    if (script && !existsSync(script)) {
      console.error(`brainhouse: hook script missing at ${script}`);
      console.error('Did you run `npm run build` and `npm link`?');
      process.exit(1);
    }
  }

  const targets = targetSettingsPaths();
  if (targets.length === 0) {
    console.error('brainhouse: no Claude config directory found at ~/.claude.');
    process.exit(1);
  }

  for (const file of targets) {
    const before = await readJson(file);
    const beforeStr = JSON.stringify(before, null, 2);
    const next = uninstall
      ? stripBrainhouse(structuredClone(before))
      : addBrainhouse(stripBrainhouse(structuredClone(before)), registry);
    const nextStr = JSON.stringify(next, null, 2);
    if (beforeStr === nextStr) {
      console.log(`= ${file} (no change)`);
      continue;
    }
    console.log(`${uninstall ? '-' : '+'} ${file}`);
    if (dryRun) {
      console.log(nextStr);
      continue;
    }
    await writeJson(file, next);
  }

  if (!uninstall && !dryRun) {
    console.log('');
    console.log('Hooks installed:');
    for (const line of formatRegistry(registry)) console.log(`  ${line}`);
    console.log('');
    console.log('New Claude Code sessions will pick up the changes immediately.');
  }
}

/** Group registry entries by role and render one line per role with the
 * events it binds to. Roles appear in registry order so the install summary
 * mirrors the canonical table source-of-truth. */
export function formatRegistry(registry) {
  const byRole = new Map();
  for (const entry of registry) {
    const existing = byRole.get(entry.role);
    const tag = entry.matcher && entry.matcher !== '.*' ? `${entry.event}(${entry.matcher})` : entry.event;
    if (existing) existing.push(tag);
    else byRole.set(entry.role, [tag]);
  }
  const width = Math.max(...[...byRole.keys()].map((r) => r.length));
  return [...byRole].map(([role, events]) => `${role.padEnd(width)}  ${events.join(', ')}`);
}
