import { describe, expect, it } from 'vitest';
import { resolveAnthropicApiKey } from './secrets.js';

describe('resolveAnthropicApiKey', () => {
  it('env var wins without touching the keychain', async () => {
    let execCalled = false;
    const result = await resolveAnthropicApiKey({
      env: 'sk-from-env',
      exec: async () => {
        execCalled = true;
        return { stdout: 'sk-from-keychain\n' };
      },
      platform: 'darwin',
    });
    expect(result).toEqual({ key: 'sk-from-env', source: 'env' });
    expect(execCalled).toBe(false);
  });

  it('falls back to the keychain when env is unset', async () => {
    const result = await resolveAnthropicApiKey({
      env: null,
      exec: async (cmd, args) => {
        expect(cmd).toBe('security');
        expect(args).toContain('brainhouse-anthropic');
        return { stdout: 'sk-from-keychain\n' };
      },
      platform: 'darwin',
    });
    expect(result).toEqual({ key: 'sk-from-keychain', source: 'keychain' });
  });

  it('returns null when the keychain item is missing (security errors)', async () => {
    const result = await resolveAnthropicApiKey({
      env: null,
      exec: async () => {
        throw new Error('The specified item could not be found in the keychain.');
      },
      platform: 'darwin',
    });
    expect(result).toEqual({ key: null, source: null });
  });

  it('never shells out off-darwin', async () => {
    let execCalled = false;
    const result = await resolveAnthropicApiKey({
      env: null,
      exec: async () => {
        execCalled = true;
        return { stdout: 'x' };
      },
      platform: 'linux',
    });
    expect(result).toEqual({ key: null, source: null });
    expect(execCalled).toBe(false);
  });

  it('treats an empty keychain payload as missing', async () => {
    const result = await resolveAnthropicApiKey({
      env: null,
      exec: async () => ({ stdout: '\n' }),
      platform: 'darwin',
    });
    expect(result).toEqual({ key: null, source: null });
  });
});
