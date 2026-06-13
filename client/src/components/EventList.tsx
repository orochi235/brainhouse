import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { useMemo } from 'react';
import { buildEditorUrl, DEFAULT_EDITOR_TEMPLATE, resolveAbsolute } from '../lib/filenameLinks.ts';
import { FilenameLinksProvider, useFilenameLinks } from '../lib/filenameLinksContext.tsx';
import { diffStats, reconstructFile } from '../lib/fileSnapshot.ts';
import { formatClockTime, formatElapsed } from '../lib/format.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import {
  type BubblePart,
  type FileChangeItem,
  type OpStripItem,
  preprocessEvents,
  type ViewItem,
} from '../lib/pipeline.ts';
import { iconForTool, parseBashCommandHead, prettyJson, shortenPath, type ToolIcon } from '../lib/tools.ts';
import { usePrefs } from '../lib/usePrefs.tsx';
import { CapsuleRow } from './CapsuleRow.tsx';
import { FileChangeLightbox } from './FileChangeLightbox.tsx';
import { Markdown } from './Markdown.tsx';
import { OpStripLightbox } from './OpStripLightbox.tsx';
import { SvgGlyph } from './SvgGlyph.tsx';
import { TerminalCard } from './TerminalCard.tsx';
import { ThoughtBubble } from './ThoughtBubble.tsx';
import { ToolCapsule } from './ToolCapsule.tsx';

interface EventListProps {
  events: Event[];
  startedAt?: number;
  /** Panel cwd — used to resolve relative paths into absolute editor deeplinks. */
  cwd?: string | null;
  onBubbleClick?: (event: Event) => void;
}

export function EventList({ events, startedAt, cwd, onBubbleClick }: EventListProps) {
  const { items } = useMemo(
    () => preprocessEvents(events, { view: 'conversation' }),
    [events],
  );
  const { prefs } = usePrefs();
  const template = prefs.editor?.urlTemplate ?? DEFAULT_EDITOR_TEMPLATE;
  return (
    <FilenameLinksProvider cwd={cwd ?? null} template={template}>
      <ViewItemList items={items} startedAt={startedAt} onBubbleClick={onBubbleClick} />
    </FilenameLinksProvider>
  );
}

/** Render an already-preprocessed list of view items. Used both by EventList
 * and by the op-strip lightbox to render the strip's sub-items. */
export function ViewItemList({
  items,
  startedAt,
  onBubbleClick,
}: {
  items: ViewItem[];
  startedAt?: number;
  onBubbleClick?: (event: Event) => void;
}) {
  // Tally each natural key as we go; collisions get suffixed with #2,
  // #3, etc. so React never sees a duplicate. The transform pipeline
  // can legitimately produce two op-strips that share an anchor (a
  // coalesce pass that wraps another coalesce's output), so we treat
  // intra-list collisions as a routine ordering signal rather than a
  // bug to track down deep in the transforms.
  const seen = new Map<string, number>();
  return (
    <ul className="events">
      {items.map((item) => {
        const base = itemKey(item);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const key = n === 1 ? base : `${base}#${n}`;
        return <Item key={key} item={item} startedAt={startedAt} onBubbleClick={onBubbleClick} />;
      })}
    </ul>
  );
}

function itemKey(item: ViewItem): string {
  if (item.type === 'tool') return `tool:${item.anchorUuid}`;
  if (item.type === 'file-change') return `file:${item.anchorUuid}`;
  if (item.type === 'terminal') return `term:${item.anchorUuid}`;
  if (item.type === 'op-strip') return `strip:${item.anchorUuid}`;
  if (item.type === 'interrupt-divider') return `int:${item.anchorUuid}`;
  if (item.type === 'day-divider') return `day:${item.date}:${item.anchorUuid}`;
  return `${item.type}:${item.event.uuid}`;
}

function Item({
  item,
  startedAt,
  onBubbleClick,
}: {
  item: ViewItem;
  startedAt?: number;
  onBubbleClick?: (event: Event) => void;
}) {
  if (item.type === 'bubble')
    return <Bubble item={item} startedAt={startedAt} onBubbleClick={onBubbleClick} />;
  if (item.type === 'tool') return <ToolCapsule item={item} startedAt={startedAt} />;
  if (item.type === 'file-change') return <FileChangeRow item={item} startedAt={startedAt} />;
  if (item.type === 'terminal') return <TerminalCard item={item} startedAt={startedAt} />;
  if (item.type === 'op-strip') return <OpStripRow item={item} startedAt={startedAt} />;
  if (item.type === 'thinking') return <ThinkingEvent event={item.event} startedAt={startedAt} />;
  if (item.type === 'system') return <SystemEvent event={item.event} startedAt={startedAt} />;
  if (item.type === 'cleared')
    return (
      <li className="event event-cleared">
        <div className="session-ended" aria-label="prior session cleared">
          <span>prior session cleared</span>
        </div>
      </li>
    );
  if (item.type === 'interrupt-divider')
    return (
      <li className="event event-interrupt-divider" aria-label="user interrupted">
        <span className="interrupt-divider-rule" aria-hidden="true" />
        <span className="interrupt-divider-label">user interrupted</span>
        <span className="interrupt-divider-rule" aria-hidden="true" />
      </li>
    );
  if (item.type === 'day-divider')
    return (
      <li className="event event-day-divider">
        <div className="session-ended" aria-label={`new day — ${item.label}`}>
          <span>{item.label}</span>
        </div>
      </li>
    );
  return <MetaEvent event={item.event} startedAt={startedAt} />;
}

function Bubble({
  item,
  startedAt,
  onBubbleClick,
}: {
  item: Extract<ViewItem, { type: 'bubble' }>;
  startedAt?: number;
  onBubbleClick?: (event: Event) => void;
}) {
  // Thought bubbles are exclusively for the agent's *thinking* events
  // (the model's internal monologue). User-attributed thought bubbles
  // were a category error: the user doesn't "have thoughts" the UI is
  // privy to — they have typed messages. Synthetic `is_meta` user_texts
  // (Skill preludes, hook-injected context) are still text the user
  // didn't author, but they're not *thoughts*. Their visual treatment
  // is TBD; for now they fall through to the default user bubble.
  return (
    <CapsuleRow
      kind={`${item.role}_text`}
      ts={item.event.ts}
      startedAt={startedAt}
      className={classNames(item.canceled && 'canceled', item.btw && 'is-btw')}
      onClick={() => onBubbleClick?.(item.event)}
    >
      <div className={classNames('bubble', item.btw && 'is-btw')}>
        {item.parts.map((part, i) => (
          <BubblePartView
            key={`${item.event.uuid}-${i}`}
            part={part}
            escape={item.role === 'user'}
          />
        ))}
      </div>
    </CapsuleRow>
  );
}

/**
 * Compact one-line summary of all Read/Edit/Write ops on one file in a row.
 * Click → lightbox with each op's diff stacked chronologically.
 */
function FileChangeRow({ item, startedAt }: { item: FileChangeItem; startedAt?: number }) {
  const lightbox = useLightbox();
  const links = useFilenameLinks();
  const counts = item.ops.reduce<Record<string, number>>((acc, op) => {
    const n = op.use?.name ?? '?';
    acc[n] = (acc[n] ?? 0) + 1;
    return acc;
  }, {});
  // Order: Read, Edit, MultiEdit, Write — most-stateful last.
  const order = ['Read', 'Edit', 'MultiEdit', 'Write'];
  const opSummary = order
    .filter((n) => counts[n])
    .map((n) => `${counts[n]} ${n.toLowerCase()}${counts[n] === 1 ? '' : 's'}`)
    .join(' · ');
  const stats = useMemo(() => diffStats(reconstructFile(item.ops)), [item.ops]);
  const summary =
    stats.adds === 0 && stats.dels === 0
      ? opSummary
      : `${opSummary} · +${stats.adds} −${stats.dels}`;
  return (
    <CapsuleRow
      kind="file-change"
      ts={item.ts}
      startedAt={startedAt}
      onClick={() =>
        lightbox.open(
          <FilenameLinksProvider cwd={links.cwd} template={links.template}>
            <FileChangeLightbox item={item} />
          </FilenameLinksProvider>,
        )
      }
    >
      <span className="file-change-icon" aria-hidden="true">
        ✎
      </span>
      <FileChangePath path={item.path} />
      <span className="file-change-summary">{summary}</span>
    </CapsuleRow>
  );
}

/**
 * Compact one-liner that wraps everything between two chat bubbles. Items
 * are grouped by kind (Bash subcommands → npm/ls/cat; tool name otherwise;
 * file-change is its own bucket); one icon per group, one count per group.
 * Click → lightbox shows the full sequence in its original order.
 */
function OpStripRow({ item, startedAt }: { item: OpStripItem; startedAt?: number }) {
  const lightbox = useLightbox();
  const links = useFilenameLinks();
  const { icons, summary, total } = summarizeOpStrip(item.items);
  return (
    <li
      className="event event-op-strip"
      onClick={() =>
        lightbox.open(
          <FilenameLinksProvider cwd={links.cwd} template={links.template}>
            <OpStripLightbox
              item={item}
              startedAt={startedAt}
              title={`${total} operation${total === 1 ? '' : 's'}: ${summary}`}
            />
          </FilenameLinksProvider>,
        )
      }
    >
      <span className="op-strip-content">
        <span className="op-strip-icons" aria-hidden="true">
          {icons.map((g) => (
            <GroupIcon key={g.key} icon={g.icon} />
          ))}
        </span>
        <span className="op-strip-count">{summary}</span>
      </span>
      <EventTime ts={item.ts} startedAt={startedAt} />
    </li>
  );
}

/** Path span inside a file-change row. Always shows the shortened form; if
 * the user has an editor template configured, clicking opens the file in
 * their editor (stopPropagation so the row's lightbox click is suppressed). */
function FileChangePath({ path }: { path: string }) {
  const { cwd, template } = useFilenameLinks();
  const abs = resolveAbsolute(path, cwd);
  const href = buildEditorUrl(template, abs);
  const short = shortenPath(path);
  if (!href) {
    return (
      <span className="file-change-path" title={path}>
        {short}
      </span>
    );
  }
  return (
    <a
      className="file-change-path filename-link"
      href={href}
      title={`open ${abs} in editor`}
      onClick={(e) => e.stopPropagation()}
    >
      {short}
    </a>
  );
}

interface IconGroup {
  key: string;
  icon: ToolIcon;
}

interface OpStripSummary {
  icons: IconGroup[];
  summary: string;
  total: number;
}

/**
 * Build the strip's icon row + summary text. Edit ops get headline billing
 * (path + line counts), then a `;` separator, then the remaining tools
 * grouped by kind (`5 npm, 1 ls, 1 cat`). Icons are deduped: one ✎ for all
 * file-changes, plus one icon per other group, in first-occurrence order.
 */
function summarizeOpStrip(items: ViewItem[]): OpStripSummary {
  const icons: IconGroup[] = [];
  const seenIcons = new Set<string>();
  const addIcon = (key: string, icon: ToolIcon) => {
    if (seenIcons.has(key)) return;
    seenIcons.add(key);
    icons.push({ key, icon });
  };

  const fileEdits: { path: string; lines: number }[] = [];
  const otherGroups = new Map<string, { label: string; count: number }>();

  for (const it of items) {
    if (it.type === 'file-change') {
      addIcon('file-change', { kind: 'glyph', text: '✎' });
      fileEdits.push({ path: it.path, lines: editedLineCount(it) });
      continue;
    }
    if (it.type === 'tool') {
      const name = it.use?.name ?? '';
      const input = it.use?.input ?? null;
      let key: string;
      let label: string;
      if (name === 'Bash' && input && typeof input === 'object') {
        const cmd = (input as { command?: unknown }).command;
        const head = typeof cmd === 'string' ? parseBashCommandHead(cmd) : '';
        key = head ? `bash:${head}` : 'bash:_';
        label = head || 'bash';
      } else {
        key = `tool:${name}`;
        label = name || 'tool';
      }
      addIcon(key, iconForTool(name, input));
      const existing = otherGroups.get(key);
      if (existing) existing.count += 1;
      else otherGroups.set(key, { label, count: 1 });
      continue;
    }
    if (it.type === 'thinking') {
      addIcon('thinking', { kind: 'glyph', text: '✦' });
      const g = otherGroups.get('thinking') ?? { label: 'thought', count: 0 };
      g.count += 1;
      otherGroups.set('thinking', g);
      continue;
    }
    if (it.type === 'system' || it.type === 'meta') {
      addIcon('system', { kind: 'glyph', text: '⚙' });
      const g = otherGroups.get('system') ?? { label: 'system', count: 0 };
      g.count += 1;
      otherGroups.set('system', g);
    }
  }

  const editsPart =
    fileEdits.length > 0
      ? `edited ${fileEdits
          .map(
            (e) =>
              `${shortenPath(e.path)}${e.lines > 0 ? ` (${e.lines} line${e.lines === 1 ? '' : 's'})` : ''}`,
          )
          .join(', ')}`
      : '';
  const othersPart = Array.from(otherGroups.values())
    .map((g) => `${g.count} ${g.label}`)
    .join(', ');
  const summary = [editsPart, othersPart].filter(Boolean).join('; ');
  const total =
    fileEdits.length + Array.from(otherGroups.values()).reduce((n, g) => n + g.count, 0);
  return { icons, summary, total };
}

/** Sum the lines actually written / replaced across an aggregated file-change.
 * For Edit / MultiEdit we count the `new_string` lines; for Write we count
 * the full content. Reads contribute nothing. */
function editedLineCount(fc: FileChangeItem): number {
  let total = 0;
  for (const op of fc.ops) {
    const name = op.use?.name;
    const input = op.use?.input as Record<string, unknown> | null | undefined;
    if (!input) continue;
    if (name === 'Edit') {
      const s = input.new_string;
      if (typeof s === 'string') total += countLines(s);
    } else if (name === 'Write') {
      const s = input.content;
      if (typeof s === 'string') total += countLines(s);
    } else if (name === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const e of edits) {
        if (e && typeof e === 'object') {
          const s = (e as Record<string, unknown>).new_string;
          if (typeof s === 'string') total += countLines(s);
        }
      }
    }
  }
  return total;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

function GroupIcon({ icon }: { icon: ToolIcon }) {
  if (icon.kind === 'svg')
    return <SvgGlyph svg={icon.svg} className="op-strip-mini-icon svg-glyph" />;
  return <span className="op-strip-mini-icon">{icon.text}</span>;
}

function BubblePartView({ part, escape }: { part: BubblePart; escape: boolean }) {
  if (part.kind === 'sawtooth') return <div className="interrupt-sawtooth" />;
  if (part.struck) {
    return (
      <div className="bubble-text-struck">
        <Markdown text={part.text} escape={escape} />
      </div>
    );
  }
  // Split `<system-reminder>...</system-reminder>` blocks out of the
  // main flow into a collapsed `<details>` footer. Reminders are
  // hook-injected context that the user didn't author (process list,
  // task-tool nudge, autonomous-loop nags, etc.); rendering them inline
  // visually buries the user's actual prompt.
  const chunks = splitSystemReminders(part.text);
  if (chunks.reminders.length === 0) {
    return <Markdown text={part.text} escape={escape} />;
  }
  return (
    <>
      {chunks.main && <Markdown text={chunks.main} escape={escape} />}
      <details className="bubble-reminders">
        <summary>
          {chunks.reminders.length} system reminder{chunks.reminders.length === 1 ? '' : 's'}
        </summary>
        {chunks.reminders.map((r, i) => (
          <pre className="bubble-reminder" key={i}>
            {r}
          </pre>
        ))}
      </details>
    </>
  );
}

const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
function splitSystemReminders(text: string): { main: string; reminders: string[] } {
  const reminders: string[] = [];
  const main = text.replace(SYSTEM_REMINDER_RE, (_, body) => {
    reminders.push(String(body).trim());
    return '';
  });
  return { main: main.replace(/\n{3,}/g, '\n\n').trim(), reminders };
}

function ThinkingEvent({ event }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'thinking') return null;
  // TODO(tags): switch to `event.tags.has('thinking')` once tags ship.
  return (
    <ThoughtBubble
      text={event.payload.text}
      speaker="agent"
      onClick={() =>
        lightbox.open(<pre className="lightbox-text-content">{event.payload.text}</pre>, {
          variant: 'text',
        })
      }
    />
  );
}

function SystemEvent({ event, startedAt }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'system') return null;
  const text = event.payload.content ?? `(${event.payload.subtype ?? 'system'})`;
  return (
    <CapsuleRow
      kind="system"
      ts={event.ts}
      startedAt={startedAt}
      onClick={() =>
        lightbox.open(<pre className="lightbox-text-content">{text}</pre>, { variant: 'text' })
      }
    >
      <span className="event-kind">system</span>
      <div className="event-body">
        <Markdown text={text} />
      </div>
    </CapsuleRow>
  );
}

function MetaEvent({ event, startedAt }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'meta') return null;
  const label = event.payload.record_type ?? event.payload.block_type ?? 'meta';
  if (label === 'auto-title') {
    const raw = event.payload.raw as { previous?: string; current?: string } | undefined;
    return (
      <CapsuleRow kind="meta" ts={event.ts} startedAt={startedAt} className="event-meta-auto-title">
        <span className="event-kind">
          auto-titled · <em>{raw?.previous ?? '—'}</em> → <strong>{raw?.current ?? ''}</strong>
        </span>
      </CapsuleRow>
    );
  }
  return (
    <CapsuleRow
      kind="meta"
      ts={event.ts}
      startedAt={startedAt}
      onClick={() =>
        lightbox.open(
          <pre className="lightbox-text-content">{prettyJson(event.payload)}</pre>,
          { variant: 'text' },
        )
      }
    >
      <span className="event-kind">meta · {label}</span>
    </CapsuleRow>
  );
}

/** Honors the body.show-elapsed toggle when the panel's start time is known. */
export function EventTime({ ts, startedAt }: { ts: string; startedAt?: number }) {
  if (document.body.classList.contains('show-elapsed') && startedAt && ts) {
    const t = new Date(ts).getTime() / 1000;
    if (!Number.isNaN(t)) {
      return <span className="event-time">{formatElapsed(Math.max(0, t - startedAt))}</span>;
    }
  }
  return <span className="event-time">{formatClockTime(ts)}</span>;
}
