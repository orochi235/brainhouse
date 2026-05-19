import type { Event } from '@server/parser.ts';
import { useMemo } from 'react';
import { formatClockTime, formatElapsed } from '../lib/format.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import {
  type BubblePart,
  type FileChangeItem,
  type OpStripItem,
  preprocessEvents,
  type ViewItem,
} from '../lib/pipeline.ts';
import { iconForTool, parseBashCommandHead, shortenPath, type ToolIcon } from '../lib/tools.ts';
import { FileChangeLightbox } from './FileChangeLightbox.tsx';
import { Markdown } from './Markdown.tsx';
import { ToolCapsule } from './ToolCapsule.tsx';

interface EventListProps {
  events: Event[];
  startedAt?: number;
  onBubbleClick?: (event: Event) => void;
}

export function EventList({ events, startedAt, onBubbleClick }: EventListProps) {
  const { items } = useMemo(() => preprocessEvents(events), [events]);
  return <ViewItemList items={items} startedAt={startedAt} onBubbleClick={onBubbleClick} />;
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
  return (
    <ul className="events">
      {items.map((item) => (
        <Item key={itemKey(item)} item={item} startedAt={startedAt} onBubbleClick={onBubbleClick} />
      ))}
    </ul>
  );
}

function itemKey(item: ViewItem): string {
  if (item.type === 'tool') return `tool:${item.anchorUuid}`;
  if (item.type === 'file-change') return `file:${item.anchorUuid}`;
  if (item.type === 'op-strip') return `strip:${item.anchorUuid}`;
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
  if (item.type === 'op-strip') return <OpStripRow item={item} startedAt={startedAt} />;
  if (item.type === 'thinking') return <ThinkingEvent event={item.event} startedAt={startedAt} />;
  if (item.type === 'system') return <SystemEvent event={item.event} startedAt={startedAt} />;
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
  return (
    <li className={`event event-${item.role}_text`} onClick={() => onBubbleClick?.(item.event)}>
      <div className="bubble">
        {item.parts.map((part, i) => (
          <BubblePartView
            key={`${item.event.uuid}-${i}`}
            part={part}
            escape={item.role === 'user'}
          />
        ))}
      </div>
      <EventTime ts={item.event.ts} startedAt={startedAt} />
    </li>
  );
}

/**
 * Compact one-line summary of all Read/Edit/Write ops on one file in a row.
 * Click → lightbox with each op's diff stacked chronologically.
 */
function FileChangeRow({ item, startedAt }: { item: FileChangeItem; startedAt?: number }) {
  const lightbox = useLightbox();
  const counts = item.ops.reduce<Record<string, number>>((acc, op) => {
    const n = op.use?.name ?? '?';
    acc[n] = (acc[n] ?? 0) + 1;
    return acc;
  }, {});
  // Order: Read, Edit, MultiEdit, Write — most-stateful last.
  const order = ['Read', 'Edit', 'MultiEdit', 'Write'];
  const summary = order
    .filter((n) => counts[n])
    .map((n) => `${counts[n]} ${n.toLowerCase()}${counts[n] === 1 ? '' : 's'}`)
    .join(' · ');
  return (
    <li
      className="event event-file-change"
      onClick={() => lightbox.open(<FileChangeLightbox item={item} />)}
    >
      <span className="file-change-icon" aria-hidden="true">
        ✎
      </span>
      <span className="file-change-path" title={item.path}>
        {shortenPath(item.path)}
      </span>
      <span className="file-change-summary">{summary}</span>
      <EventTime ts={item.ts} startedAt={startedAt} />
    </li>
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
  const { icons, summary, total } = summarizeOpStrip(item.items);
  return (
    <li
      className="event event-op-strip"
      onClick={() =>
        lightbox.open(
          <div className="op-strip-lightbox">
            <h3 className="lightbox-title">
              {total} operation{total === 1 ? '' : 's'}: {summary}
            </h3>
            <ViewItemList items={item.items} startedAt={startedAt} />
          </div>,
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
    return <img className="op-strip-mini-icon" src={icon.src} alt="" aria-hidden="true" />;
  return <span className="op-strip-mini-icon">{icon.text}</span>;
}

function BubblePartView({ part, escape }: { part: BubblePart; escape: boolean }) {
  if (part.kind === 'sawtooth') return <div className="interrupt-sawtooth" />;
  return <Markdown text={part.text} escape={escape} />;
}

function ThinkingEvent({ event, startedAt }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'thinking') return null;
  return (
    <li
      className="event event-thinking"
      onClick={() =>
        lightbox.open(<pre className="lightbox-text-content">{event.payload.text}</pre>, {
          variant: 'text',
        })
      }
    >
      <span className="event-kind">thinking</span>
      <EventTime ts={event.ts} startedAt={startedAt} />
      <div className="event-body">
        <Markdown text={event.payload.text} />
      </div>
    </li>
  );
}

function SystemEvent({ event, startedAt }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'system') return null;
  const text = event.payload.content ?? `(${event.payload.subtype ?? 'system'})`;
  return (
    <li
      className="event event-system"
      onClick={() =>
        lightbox.open(<pre className="lightbox-text-content">{text}</pre>, { variant: 'text' })
      }
    >
      <span className="event-kind">system</span>
      <EventTime ts={event.ts} startedAt={startedAt} />
      <div className="event-body">
        <Markdown text={text} />
      </div>
    </li>
  );
}

function MetaEvent({ event, startedAt }: { event: Event; startedAt?: number }) {
  const lightbox = useLightbox();
  if (event.kind !== 'meta') return null;
  const label = event.payload.record_type ?? event.payload.block_type ?? 'meta';
  return (
    <li
      className="event event-meta"
      onClick={() =>
        lightbox.open(
          <pre className="lightbox-text-content">{JSON.stringify(event.payload, null, 2)}</pre>,
          { variant: 'text' },
        )
      }
    >
      <span className="event-kind">meta · {label}</span>
      <EventTime ts={event.ts} startedAt={startedAt} />
    </li>
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
