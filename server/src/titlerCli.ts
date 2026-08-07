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
  TitlerUsage,
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

/** Parse `claude -p --output-format json` stdout into the SDK-ish
 * response shape, carrying token usage + reported cost through for
 * metering. Non-JSON stdout (older CLI, unexpected wrapper noise) falls
 * back to treating the whole output as the title text — the call still
 * works, it just goes unmetered. */
export function parseCliOutput(stdout: string): TitlerCreateResponse {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      result?: unknown;
      total_cost_usd?: unknown;
      usage?: Record<string, unknown>;
    };
    const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    let usage: TitlerUsage | undefined;
    if (parsed.usage && typeof parsed.usage === 'object') {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      usage = {
        input_tokens: num(parsed.usage.input_tokens),
        output_tokens: num(parsed.usage.output_tokens),
        cache_creation_input_tokens: num(parsed.usage.cache_creation_input_tokens),
        cache_read_input_tokens: num(parsed.usage.cache_read_input_tokens),
      };
    }
    return {
      content: [{ type: 'text', text }],
      usage,
      cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    };
  } catch {
    return { content: [{ type: 'text', text: trimmed }] };
  }
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
          [
            '-p',
            flattenParams(params),
            '--model',
            params.model,
            '--no-session-persistence',
            '--output-format',
            'json',
          ],
          {
            timeout: CLI_TIMEOUT_MS,
            // Stable cwd so the CLI's scaffold dir is one predictable,
            // never-watched-content location instead of one per caller.
            cwd: path.join(os.homedir(), '.brainhouse'),
            env,
          },
        );
        return parseCliOutput(stdout);
      },
    },
  };
}
