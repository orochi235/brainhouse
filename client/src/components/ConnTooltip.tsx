/**
 * Hover content for the top-bar connection pill. Explains what each
 * status value actually means — the pill itself is small and the words
 * "live" / "connecting" / "offline" are ambiguous out of context (live
 * panel? live session? a live event stream?).
 */

type ConnStatus = 'connecting' | 'live' | 'offline';

const COPY: Record<ConnStatus, { title: string; body: string; detail?: string }> = {
  live: {
    title: 'tRPC delta stream is connected',
    body:
      'Brainhouse is subscribed to the server and receiving deltas as soon as JSONL files change on disk. Panels update in real time.',
    detail:
      'This is *connection* liveness, not session liveness — a panel with the green "live" dot means an active Claude Code session; this badge means the browser ↔ server stream itself is up.',
  },
  connecting: {
    title: 'Establishing the delta stream',
    body:
      'Browser is opening a tRPC subscription to the server. Should flip to "live" within a few hundred milliseconds; if it sticks here, the server may not be running on the expected port.',
  },
  offline: {
    title: 'Delta stream disconnected',
    body:
      'The tRPC subscription dropped or never came up. Panels you can see are still rendered, but no new activity will appear until the connection comes back. Reload the page or restart the server.',
  },
};

export function ConnTooltip({ status }: { status: ConnStatus }) {
  const c = COPY[status];
  return (
    <div className={`conn-tooltip conn-tooltip-${status}`}>
      <div className="conn-tooltip-title">{c.title}</div>
      <p className="conn-tooltip-body">{c.body}</p>
      {c.detail && <p className="conn-tooltip-detail">{c.detail}</p>}
    </div>
  );
}
