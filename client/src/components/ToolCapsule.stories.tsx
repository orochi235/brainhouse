/**
 * Ladle stories for ToolCapsule. Each story is one capsule in isolation,
 * mostly so we can sanity-check the per-tool styling rules (read-op dim,
 * Bash icon, file path shortening, canceled strikethrough, error color).
 */

import type React from 'react';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { ViewItem } from '../lib/pipeline.ts';
import { ToolCapsule } from './ToolCapsule.tsx';

type ToolItem = Extract<ViewItem, { type: 'tool' }>;

let uid = 0;
function tool(
  name: string,
  input: Record<string, unknown>,
  result?: { content: unknown; is_error?: boolean },
  overrides: Partial<ToolItem> = {},
): ToolItem {
  uid += 1;
  return {
    type: 'tool',
    anchorUuid: `u${uid}`,
    use: { tool_use_id: `t${uid}`, name, input },
    result:
      result === undefined
        ? null
        : { tool_use_id: `t${uid}`, content: result.content, is_error: result.is_error ?? false },
    ack: null,
    ts: '2026-05-20T00:00:00Z',
    ...overrides,
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 520, padding: '0.6rem', background: '#0f172a' }}>
      <LightboxProvider>
        <ul className="events" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {children}
        </ul>
      </LightboxProvider>
    </div>
  );
}

export const BashPending = () => (
  <Frame>
    <ToolCapsule item={tool('Bash', { command: 'npm test' })} />
  </Frame>
);

export const BashOk = () => (
  <Frame>
    <ToolCapsule item={tool('Bash', { command: 'echo hello' }, { content: 'hello\n' })} />
  </Frame>
);

export const BashError = () => (
  <Frame>
    <ToolCapsule
      item={tool(
        'Bash',
        { command: 'rm -rf /tmp/does-not-exist' },
        { content: 'rm: /tmp/does-not-exist: No such file or directory', is_error: true },
      )}
    />
  </Frame>
);

export const Edit = () => (
  <Frame>
    <ToolCapsule
      item={tool(
        'Edit',
        { file_path: '/Users/demo/src/foo/bar.ts', old_string: 'foo()', new_string: 'foo(x)' },
        { content: '+1 -1' },
      )}
    />
  </Frame>
);

export const Write = () => (
  <Frame>
    <ToolCapsule
      item={tool('Write', { file_path: '/tmp/new.ts' }, { content: 'wrote 42 lines' })}
    />
  </Frame>
);

export const Canceled = () => (
  <Frame>
    <ToolCapsule
      item={tool(
        'Bash',
        { command: 'npm install' },
        { content: 'cancelled by user' },
        { canceled: true },
      )}
    />
  </Frame>
);

/** Pure-lookup ops render at reduced visual weight (#3). Compare to BashOk
 * above — same capsule shell, dimmer + smaller. */
export const ReadOnly_Grep = () => (
  <Frame>
    <ToolCapsule
      item={tool('Grep', { pattern: 'TODO', path: 'src/' }, { content: '12 matches' })}
    />
  </Frame>
);

export const ReadOnly_Glob = () => (
  <Frame>
    <ToolCapsule item={tool('Glob', { pattern: '**/*.test.ts' }, { content: '7 files' })} />
  </Frame>
);

export const ReadOnly_WebFetch = () => (
  <Frame>
    <ToolCapsule
      item={tool('WebFetch', { url: 'https://example.com/api' }, { content: 'fetched 12 KB' })}
    />
  </Frame>
);

/** Errors keep full visual prominence even on read-ops — the dimming
 * rule deliberately excludes the .error state. */
export const ReadOnly_Grep_Error = () => (
  <Frame>
    <ToolCapsule
      item={tool(
        'Grep',
        { pattern: '[invalid', path: 'src/' },
        { content: 'regex parse error', is_error: true },
      )}
    />
  </Frame>
);

export const WithAck = () => (
  <Frame>
    <ToolCapsule
      item={tool(
        'Bash',
        { command: 'pytest' },
        { content: '3 passed' },
        { ack: 'All green — moving on to integration tests.' },
      )}
    />
  </Frame>
);
