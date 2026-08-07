import { describe, expect, it } from 'vitest';
import type { TitlerCreateParams } from './titler.js';
import { flattenParams, makeCliTitlerClient, parseCliOutput } from './titlerCli.js';

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

describe('parseCliOutput', () => {
  it('extracts result text, usage, and cost from JSON output', () => {
    const res = parseCliOutput(
      JSON.stringify({
        type: 'result',
        result: 'A fine title\n',
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 500,
          output_tokens: 12,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 100,
        },
      }),
    );
    expect(res.content).toEqual([{ type: 'text', text: 'A fine title' }]);
    expect(res.usage).toEqual({
      input_tokens: 500,
      output_tokens: 12,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 100,
    });
    expect(res.cost_usd).toBe(0.0042);
  });

  it('falls back to raw text when stdout is not JSON', () => {
    const res = parseCliOutput('A plain title\n');
    expect(res.content).toEqual([{ type: 'text', text: 'A plain title' }]);
    expect(res.usage).toBeUndefined();
  });

  it('zero-fills missing usage fields', () => {
    const res = parseCliOutput(JSON.stringify({ result: 'T', usage: { output_tokens: 5 } }));
    expect(res.usage).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(res.cost_usd).toBeNull();
  });
});

describe('makeCliTitlerClient', () => {
  it('spawns claude -p with model + no-session-persistence + json output and returns stdout', async () => {
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
    expect(captured?.args).toContain('--output-format');
    expect(captured?.args).toContain('json');
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
