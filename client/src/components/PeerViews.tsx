/**
 * How another Claude Code session shows up inside this one's transcript: its
 * name as a chip in its own project color (a link to its panel when that
 * session is known), and the one-line idle-watch notices.
 */

import type { PanelTheme } from '@server/session.ts';
import classNames from 'classnames';
import type { CSSProperties } from 'react';
import { type PeerRef, usePeer } from '../lib/peers.tsx';
import type { PeerNoticeItem } from '../lib/pipeline-types.ts';
import { CapsuleRow } from './CapsuleRow.tsx';
import './PeerViews.css';

/** CSS vars that tint an element in a peer's project color. */
export function peerVars(theme: PanelTheme | null | undefined): CSSProperties | undefined {
  if (!theme) return undefined;
  return { '--peer-bg': theme.background, '--peer-fg': theme.foreground } as CSSProperties;
}

export function usePeerLook(ref: PeerRef | null) {
  const peer = usePeer(ref);
  return { peer, style: peerVars(peer?.theme), themed: !!peer?.theme };
}

/** The sender's project as a pill in its own `.hued` colors, then its session
 * name; a button that opens its panel when it resolves to one. */
export function PeerName({
  label,
  peer,
  className,
}: {
  label: string;
  peer: ReturnType<typeof usePeer>;
  className?: string;
}) {
  const cls = classNames('peer-name', className);
  const open = peer?.open;
  const content = (
    <>
      {peer?.project ? (
        <span className={classNames('peer-project', peer.theme && 'is-themed')}>{peer.project}</span>
      ) : null}
      <span className="peer-session">{label}</span>
    </>
  );
  if (!open) return <span className={cls}>{content}</span>;
  return (
    <button
      type="button"
      className={classNames(cls, 'is-link')}
      title={`Go to ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      {content}
    </button>
  );
}

export function PeerNotice({ item, startedAt }: { item: PeerNoticeItem; startedAt?: number }) {
  const { peer, style } = usePeerLook(item.peer);
  const label = item.peer.name ?? (item.peer.pid ? `pid ${item.peer.pid}` : 'another session');
  return (
    <CapsuleRow
      kind="peer-notice"
      ts={item.event.ts}
      startedAt={startedAt}
      anchorUuid={item.event.uuid}
    >
      <div className="peer-notice" style={style}>
        <PeerName label={label} peer={peer} /> <span className="peer-notice-text">{item.text}</span>
        {item.detail ? <span className="peer-notice-detail"> — {item.detail}</span> : null}
      </div>
    </CapsuleRow>
  );
}
