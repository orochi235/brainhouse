import type { Event } from '@server/parser.ts';

export function EventList({ events }: { events: Event[] }) {
  return (
    <ul className="events">
      {events.map((e) => (
        <li key={e.uuid} className={`event event-${e.kind}`}>
          <EventBody event={e} />
        </li>
      ))}
    </ul>
  );
}

function EventBody({ event }: { event: Event }) {
  if (event.kind === 'user_text' || event.kind === 'assistant_text') {
    return <div className="bubble">{event.payload.text}</div>;
  }
  if (event.kind === 'thinking') {
    return <div className="thinking">thinking · {event.payload.text}</div>;
  }
  if (event.kind === 'tool_use') {
    return (
      <div className="tool">
        ▶ {event.payload.name}
        <pre>{stringify(event.payload.input)}</pre>
      </div>
    );
  }
  if (event.kind === 'tool_result') {
    return <pre className="tool-result">{stringify(event.payload.content)}</pre>;
  }
  if (event.kind === 'system') {
    return <div className="system">{event.payload.content ?? `(${event.payload.subtype})`}</div>;
  }
  // meta
  return <div className="meta">meta · {event.payload.record_type ?? event.payload.block_type}</div>;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
