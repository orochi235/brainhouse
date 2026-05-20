/**
 * Contact sheet: every tool/CLI icon brainhouse ships, rendered at
 * uniform size with its name underneath. Useful for design review,
 * sanity-checking new icons against the existing set, and as a "what
 * does brainhouse recognize" reference for anyone wondering whether
 * adding a new tool name would get an icon for free.
 */

import { iconForTool } from '../lib/tools.ts';

/** Names brainhouse renders as glyphs (emoji-shaped) from TOOL_ICONS.
 * Pass through iconForTool with empty input → the CLI branch is skipped
 * and the TOOL_ICONS lookup wins. */
const TOOL_NAMES = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskCreate',
  'TaskUpdate',
] as const;

/** CLI commands brainhouse renders as SVG logos from CLI_ICONS. To pull
 * the SVG, we go through iconForTool('Bash', { command: '<cli>' }) —
 * the same path the live capsule uses. */
const CLI_NAMES = [
  'gh',
  'git',
  'curl',
  'wget',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'pip',
  'uv',
  'pytest',
  'make',
  'docker',
  'kubectl',
  'node',
  'deno',
  'bun',
  'cargo',
  'rustc',
  'go',
  'brew',
  'jq',
  'vim',
  'nvim',
] as const;

function IconCell({ name, label }: { name: string; label: string }) {
  const icon = iconForTool(name, name === 'Bash' ? { command: label } : {});
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.6rem',
        background: 'var(--code-bg)',
        border: '1px solid var(--panel-border)',
        borderRadius: 6,
        minWidth: 80,
        fontSize: '0.7rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--muted)',
      }}
    >
      <span
        className="tool-icon"
        style={{ fontSize: '1.4rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {icon.kind === 'svg' ? (
          <span
            className="svg-glyph"
            style={{ width: '1.4em', height: '1.4em', color: 'var(--fg)' }}
            aria-hidden="true"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
            dangerouslySetInnerHTML={{ __html: icon.svg }}
          />
        ) : (
          <span style={{ color: 'var(--fg)' }}>{icon.text}</span>
        )}
      </span>
      <span>{label}</span>
    </div>
  );
}

function Section({
  title,
  items,
  asCli,
}: {
  title: string;
  items: readonly string[];
  /** When true, each item is rendered via the Bash + command lookup
   * path (CLI SVGs); when false, via the tool-name glyph lookup. */
  asCli?: boolean;
}) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2
        style={{
          fontSize: '0.85rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          marginBottom: '0.6rem',
        }}
      >
        {title} <span style={{ opacity: 0.5 }}>({items.length})</span>
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '0.5rem' }}>
        {items.map((name) => (
          <IconCell key={name} name={asCli ? 'Bash' : name} label={name} />
        ))}
      </div>
    </section>
  );
}

export const AllIcons = () => (
  <div style={{ maxWidth: 900 }}>
    <h1 style={{ fontSize: '1.2rem', marginBottom: '0.3rem' }}>Icon contact sheet</h1>
    <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.2rem' }}>
      Every tool name + CLI command brainhouse recognizes. Tool names render as glyphs;
      CLI commands render as SVG logos via the Bash code-path. Adding a new entry to
      `TOOL_ICONS` / `CLI_ICONS` in <code>client/src/lib/tools.ts</code> shows up here.
    </p>
    <Section title="Tool names" items={TOOL_NAMES} />
    <Section title="CLI commands" items={CLI_NAMES} asCli />
  </div>
);

export const ToolNamesOnly = () => (
  <div style={{ maxWidth: 900 }}>
    <Section title="Tool names" items={TOOL_NAMES} />
  </div>
);

export const CLICommandsOnly = () => (
  <div style={{ maxWidth: 900 }}>
    <Section title="CLI commands" items={CLI_NAMES} asCli />
  </div>
);
