import { describe, expect, it } from 'vitest';
import type { TitlerCreateParams } from './titler.js';
import { flattenParams, makeCliTitlerClient } from './titlerCli.js';

function params(): TitlerCreateParams {
  return {
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    system: [{ type: 'text', text: 'You are the titler.' }],
    messages: [{ role: 'user', content: 'Propose a title.' }],
  };
}

describe('flattenParams', () => {
  it('joins system and user content', () => {
    expect(flattenParams(params())).toBe('You are the titler.\n\nPropose a title.');
  });
});

describe('makeCliTitlerClient', () => {
  it('spawns claude -p with model + no-session-persistence and returns stdout', async () => {
    let captured: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const client = makeCliTitlerClient({
      configDir: '/tmp/fake-config',
      exec: async (cmd, args, opts) => {
        captured = { cmd, args, env: opts.env };
        return { stdout: 'A fine title\n' };
      },
    });
    const res = await client.messages.create(params());
    expect(res.content).toEqual([{ type: 'text', text: 'A fine title' }]);
    expect(captured?.cmd).toBe('claude');
    expect(captured?.args).toContain('-p');
    expect(captured?.args).toContain('--no-session-persistence');
    expect(captured?.args).toContain('claude-haiku-4-5');
    expect(captured?.env.CLAUDE_CONFIG_DIR).toBe('/tmp/fake-config');
    expect(captured?.env.PATH).toContain('.local/bin');
  });

  it('leaves CLAUDE_CONFIG_DIR alone when configDir is null', async () => {
    let env: NodeJS.ProcessEnv | null = null;
    const client = makeCliTitlerClient({
      configDir: null,
      exec: async (_cmd, _args, opts) => {
        env = opts.env;
        return { stdout: 'x' };
      },
    });
    await client.messages.create(params());
    expect(env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('propagates spawn errors (ENOENT reaches the titler)', async () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const client = makeCliTitlerClient({
      exec: async () => {
        throw err;
      },
    });
    await expect(client.messages.create(params())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
