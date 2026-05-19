import type { Event } from '@server/parser.ts';
import { useMemo } from 'react';
import { formatClockTime } from '../lib/format.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import { type BubblePart, preprocessEvents, type ViewItem } from '../lib/pipeline.ts';
import { Markdown } from './Markdown.tsx';
import { ToolCapsule } from './ToolCapsule.tsx';

export function EventList({ events }: { events: Event[] }) {
  const { items } = useMemo(() => preprocessEvents(events), [events]);
  return (
    <ul className="events">
      {items.map((item) => (
        <Item key={itemKey(item)} item={item} />
      ))}
    </ul>
  );
}

function itemKey(item: ViewItem): string {
  if (item.type === 'tool') return `tool:${item.anchorUuid}`;
  return `${item.type}:${item.event.uuid}`;
}

function Item({ item }: { item: ViewItem }) {
  if (item.type === 'bubble') return <Bubble item={item} />;
  if (item.type === 'tool') return <ToolCapsule item={item} />;
  if (item.type === 'thinking') return <ThinkingEvent event={item.event} />;
  if (item.type === 'system') return <SystemEvent event={item.event} />;
  return <MetaEvent event={item.event} />;
}

function Bubble({ item }: { item: Extract<ViewItem, { type: 'bubble' }> }) {
  return (
    <li className={`event event-${item.role}_text`}>
      <div className="bubble">
        {item.parts.map((part, i) => (
          <BubblePartView
            key={`${item.event.uuid}-${i}`}
            part={part}
            escape={item.role === 'user'}
          />
        ))}
      </div>
      <span className="event-time">{formatClockTime(item.event.ts)}</span>
    </li>
  );
}

function BubblePartView({ part, escape }: { part: BubblePart; escape: boolean }) {
  if (part.kind === 'sawtooth') return <div className="interrupt-sawtooth" />;
  return <Markdown text={part.text} escape={escape} />;
}

function ThinkingEvent({ event }: { event: Event }) {
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
      <span className="event-time">{formatClockTime(event.ts)}</span>
      <div className="event-body">{event.payload.text}</div>
    </li>
  );
}

function SystemEvent({ event }: { event: Event }) {
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
      <span className="event-time">{formatClockTime(event.ts)}</span>
      <div className="event-body">{text}</div>
    </li>
  );
}

function MetaEvent({ event }: { event: Event }) {
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
      <span className="event-time">{formatClockTime(event.ts)}</span>
    </li>
  );
}
