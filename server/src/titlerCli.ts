/**
 * `claude -p` fallback client for the titler — rides the user's Claude
 * Code subscription auth instead of a metered API key.
 *
 * Caveats this shape exists to handle:
 *   - `--no-session-persistence` is mandatory: without it every titler
 *     call writes a real session transcript into the (watched) projects
 *     dir and brainhouse ingests its own titler as phantom panels. With
 *     the flag only an empty scaffold dir appears, which the watcher
 *     ignores (it only reacts to .jsonl files).
 *   - `configDir` must point at a *logged-in* Claude Code config dir.
 *     Under launchd the CLI default is typically unauthenticated.
 *   - The service PATH lacks `~/.local/bin` (where `claude` installs),
 *     so the spawn env appends it rather than requiring a service
 *     reinstall.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  TitlerAnthropicClient,
  TitlerCreateParams,
  TitlerCreateResponse,
} from './titler.js';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;

export interface CliTitlerOptions {
  /** CLAUDE_CONFIG_DIR for the spawned CLI; null inherits the default. */
  configDir?: string | null;
  /** Test seam. */
  exec?: (
    cmd: string,
    args: string[],
    opts: { timeout: number; cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string }>;
}

/** Flatten the SDK-shaped request into one prompt string. */
export function flattenParams(params: TitlerCreateParams): string {
  const system = params.system.map((s) => s.text).join('\n\n');
  const user = params.messages.map((m) => m.content).join('\n\n');
  return `${system}\n\n${user}`;
}

export function makeCliTitlerClient(opts: CliTitlerOptions = {}): TitlerAnthropicClient {
  const exec = opts.exec ?? execFileAsync;
  return {
    messages: {
      async create(params: TitlerCreateParams): Promise<TitlerCreateResponse> {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: `${process.env.PATH ?? ''}:${path.join(os.homedir(), '.local', 'bin')}`,
        };
        if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
        const { stdout } = await exec(
          'claude',
          ['-p', flattenParams(params), '--model', params.model, '--no-session-persistence'],
          {
            timeout: CLI_TIMEOUT_MS,
            // Stable cwd so the CLI's scaffold dir is one predictable,
            // never-watched-content location instead of one per caller.
            cwd: path.join(os.homedir(), '.brainhouse'),
            env,
          },
        );
        return { content: [{ type: 'text', text: stdout.trim() }] };
      },
    },
  };
}
