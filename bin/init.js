/**
 * `brainhouse init` — wire the hook dispatcher into Claude Code's settings.
 *
 * Targets:
 *   ~/.claude/settings.json
 *
 * Idempotent: re-running replaces any existing brainhouse hooks rather than
 * appending duplicates. Adds a `brainhouse` marker to each hook entry so we
 * can recognize ours on uninstall without disturbing user-authored hooks.
 *
 * Flags:
 *   --uninstall    remove brainhouse hook entries
 *   --dry-run      show the diff but don't write
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_EVENTS = /** @type {const} */ ([
  ['Stop', 'stop'],
  ['SubagentStop', 'subagent_stop'],
  ['Notification', 'notification'],
  ['SessionEnd', 'session_end'],
  ['SessionStart', 'session_start'],
]);
const MARKER = 'brainhouse';

function dispatcherPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'hooks', 'dispatcher.mjs');
}

function autoTitlePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'hooks', 'auto-title.mjs');
}

function targetSettingsPaths() {
  // Pick up every Claude Code config dir at the top of $HOME — the canonical
  // `~/.claude` plus any sibling `~/.claude-*` dirs used to host multiple
  // accounts under separate `CLAUDE_CONFIG_DIR` values (e.g. `.claude-pw`,
  // `.claude-msb`). Each gets the same dispatcher + auto-title wiring.
  const home = os.homedir();
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && (e.name === '.claude' || e.name.startsWith('.claude-')))
    .map((e) => path.join(home, e.name, 'settings.json'));
  return dirs;
}

async function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = await readFile(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function stripBrainhouse(settings) {
  const hooks = settings.hooks ?? {};
  for (const [event] of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    // Truthy match covers both the legacy `brainhouse: true` form and the
    // newer role-tagged form (`brainhouse: "dispatcher" | "auto-title"`).
    const filtered = entries.filter((e) => !e?.[MARKER]);
    if (filtered.length === 0) delete hooks[event];
    else hooks[event] = filtered;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

function addBrainhouse(settings, dispatcher, autoTitle) {
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks;
  const cmd = `node ${JSON.stringify(dispatcher).slice(1, -1)}`;
  for (const [event, kind] of HOOK_EVENTS) {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push({
      [MARKER]: 'dispatcher',
      matcher: '.*',
      hooks: [{ type: 'command', command: `${cmd} ${kind}` }],
    });
  }
  // Auto-title side-channel: separate Stop entry that runs `claude -p` on
  // the user's account when `display.autoTitle` is on in prefs.json. The
  // script gates itself; install is unconditional so toggling the pref
  // takes effect without re-running init. Tagged distinctly from the
  // dispatcher entry so future strips can tell them apart.
  hooks.Stop.push({
    [MARKER]: 'auto-title',
    matcher: '.*',
    hooks: [{ type: 'command', command: `node ${JSON.stringify(autoTitle).slice(1, -1)}` }],
  });
  return settings;
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(file, json, 'utf8');
}

export async function runInit(argv) {
  const args = new Set(argv);
  const uninstall = args.has('--uninstall');
  const dryRun = args.has('--dry-run');

  const dispatcher = dispatcherPath();
  if (!existsSync(dispatcher)) {
    console.error(`brainhouse: dispatcher missing at ${dispatcher}`);
    console.error('Did you run `npm run build` and `npm link`?');
    process.exit(1);
  }
  const autoTitle = autoTitlePath();
  if (!existsSync(autoTitle)) {
    console.error(`brainhouse: auto-title hook missing at ${autoTitle}`);
    process.exit(1);
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
      : addBrainhouse(stripBrainhouse(structuredClone(before)), dispatcher, autoTitle);
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
    console.log('Hooks installed. Start brainhouse and any new Claude Code session');
    console.log(
      'will emit Stop / SubagentStop / Notification / SessionEnd / SessionStart events to the sidecar.',
    );
  }
}
