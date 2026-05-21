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
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_EVENTS = /** @type {const} */ ([
  ['Stop', 'stop'],
  ['SubagentStop', 'subagent_stop'],
  ['Notification', 'notification'],
  ['SessionEnd', 'session_end'],
]);
const MARKER = 'brainhouse';

function dispatcherPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'hooks', 'dispatcher.mjs');
}

function targetSettingsPaths() {
  const claudeDir = path.join(os.homedir(), '.claude');
  return existsSync(claudeDir) ? [path.join(claudeDir, 'settings.json')] : [];
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
    const filtered = entries.filter((e) => e?.[MARKER] !== true);
    if (filtered.length === 0) delete hooks[event];
    else hooks[event] = filtered;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

function addBrainhouse(settings, dispatcher) {
  const hooks = settings.hooks ?? (settings.hooks = {});
  const cmd = `node ${JSON.stringify(dispatcher).slice(1, -1)}`;
  for (const [event, kind] of HOOK_EVENTS) {
    const entries = hooks[event] ?? (hooks[event] = []);
    // Drop any previous brainhouse entry for this event first.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.[MARKER] === true) entries.splice(i, 1);
    }
    entries.push({
      [MARKER]: true,
      matcher: '.*',
      hooks: [{ type: 'command', command: `${cmd} ${kind}` }],
    });
  }
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
      : addBrainhouse(stripBrainhouse(structuredClone(before)), dispatcher);
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
      'will emit Stop / SubagentStop / Notification / SessionEnd events to the sidecar.',
    );
  }
}
