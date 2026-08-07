/**
 * ANTHROPIC_API_KEY resolution for the server-side titler.
 *
 * The LaunchAgent environment carries no shell profile, so the env var
 * that works in a dev terminal is absent under launchd and the titler
 * silently disabled itself in production. Fallback: a macOS login
 * Keychain item, stored once with
 *
 *   security add-generic-password -s brainhouse-anthropic -a api -w
 *
 * Env still wins when present. The first Keychain read from a fresh
 * binary may pop an ACL prompt ("node wants to access...") — answer
 * Always Allow or every service restart re-prompts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = 'brainhouse-anthropic';

export interface ResolveKeyOptions {
  /** Override for process.env.ANTHROPIC_API_KEY; null = treat as unset. */
  env?: string | null;
  /** Test seam. */
  exec?: (
    cmd: string,
    args: string[],
    opts: { timeout: number },
  ) => Promise<{ stdout: string }>;
  /** Test seam; defaults to process.platform. */
  platform?: string;
}

export async function resolveAnthropicApiKey(opts: ResolveKeyOptions = {}): Promise<{
  key: string | null;
  source: 'env' | 'keychain' | null;
}> {
  const envKey = opts.env === undefined ? (process.env.ANTHROPIC_API_KEY ?? null) : opts.env;
  if (envKey) return { key: envKey, source: 'env' };
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return { key: null, source: null };
  const exec = opts.exec ?? execFileAsync;
  try {
    const { stdout } = await exec(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
    );
    const key = stdout.trim();
    return key ? { key, source: 'keychain' } : { key: null, source: null };
  } catch {
    return { key: null, source: null };
  }
}
