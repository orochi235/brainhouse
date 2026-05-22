import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import trashIcon from '../assets/icons/trash.svg?raw';
import { formatIdle, formatIdleCoarse, formatTokens } from '../lib/format.ts';
import { cacheHealth, inputEquivalentTokens } from '../lib/tokenCost.ts';
import { HoverPopover } from './HoverPopover.tsx';
import { ContextSizeTooltip, SessionTimeTooltip } from './PanelHeaderTooltips.tsx';
import { TokenTooltip } from './TokenTooltip.tsx';
import { renderInlineCode } from '../lib/inlineCode.tsx';
import { useLightbox } from '../lib/lightbox.tsx';
import { type ChecklistItem, preprocessEvents } from '../lib/pipeline.ts';
import { projectLabel } from '../lib/project.ts';
import { loadScrollPosition, saveScrollPosition } from '../lib/scrollMemory.ts';
import { usePrefs } from '../lib/usePrefs.ts';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { EventList } from './EventList.tsx';
import { ToolChip, ToolChips } from './ToolChips.tsx';

/** How long after the user's last click in a panel we treat them as actively
 * reading it. Inside this window auto-scroll respects manual scroll
 * position; outside it, updates always snap to the bottom. */
const ACTIVE_WINDOW_MS = 30_000;

interface Props {
  panel: PanelState;
  /** True when this panel is nested inside another panel's subagent tray. */
  nested?: boolean;
  /** Close this panel's window. The underlying session is untouched — the
   * panel will pop back into view as soon as new activity arrives. */
  onHide?: () => void;
  /** Restore from the tray back to the grid. Provided only by tray renderers;
   * its presence suppresses the `×` button (a panel already in the tray
   * doesn't need a close affordance, but does need an unmini). */
  onRestore?: () => void;
  /** Pinned panels stay in the grid + don't dim regardless of status/age. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** True when a subagent has been pulled out of its parent's nested tray. */
  brokenOut?: boolean;
  /** Toggle whether a subagent renders nested under its parent or as a
   * standalone top-level panel. Only meaningful for subagent panels. */
  onToggleBrokenOut?: () => void;
  /** Account label to badge in the header. Parent typically passes
   * `panel.account_label` when more than one account is configured;
   * undefined/null suppresses the badge. */
  account?: string | null;
  /** Hex color tied to the account. When set, stamps `--account-color`
   * on the panel so the badge + a subtle border tint pick it up. */
  accountColor?: string;
}

/**
 * One panel — header + (optional) pinned checklist + scrolling event body.
 *
 * The thinking indicator, waiting glow, and idle counter are all derived
 * from a useMemo over panel.events, plus a 1Hz tick for the time displays.
 */
export function PanelCard({
  panel,
  nested,
  onHide,
  onRestore,
  pinned,
  onTogglePin,
  brokenOut,
  onToggleBrokenOut,
  account,
  accountColor,
}: Props) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const lightbox = useLightbox();
  const articleRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Inner wrapper around the body's children, sized by content. We observe
   * this with ResizeObserver to catch height changes that don't go through
   * the `events.length` effect — async markdown/hljs rendering, tool-result
   * merges that grow a capsule, status-transition banners, etc. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastStatusRef = useRef(panel.status);
  const [collapsed, setCollapsed] = useState(false);
  const prevProgressRef = useRef<number | null>(null);
  // True until the user scrolls away from the bottom. Re-armed when they
  // scroll back. While true, new events keep the view pinned at the bottom.
  const stickToBottomRef = useRef(true);
  // Wall-clock of the user's most recent click inside this panel. While
  // `Date.now() - lastClickAtRef.current < ACTIVE_WINDOW_MS`, auto-scroll
  // defers to the user's manual scroll position; outside that window the
  // panel always snaps to the bottom on update.
  const lastClickAtRef = useRef(0);
  /** Throttle for sessionStorage writes during fast scrolls — at most one
   * save per animation frame. Cleared after each flush. */
  const scrollSaveRafRef = useRef<number | null>(null);

  // On mount and whenever the panel id changes (e.g. focused view, restore
  // from the tray, fullscreen open), jump straight to the bottom — UNLESS
  // sessionStorage has a recent (<60s) saved scroll position for this
  // panel, which means we're mid-refresh and want to restore the view.
  // useLayoutEffect runs after DOM mutations but before paint so the user
  // never sees a flash of the wrong position. The rAF re-snap covers
  // children whose final size lands a frame later (code highlighting,
  // async images).
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel.id drives the reset; refs are intentionally not deps.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const saved = loadScrollPosition(panel.id);
    if (saved !== null) {
      el.scrollTop = saved;
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      // Children that grow a frame later (code highlight, images) — re-apply
      // the saved offset once they settle so we don't jitter to the top.
      const raf = requestAnimationFrame(() => {
        el.scrollTop = saved;
      });
      return () => cancelAnimationFrame(raf);
    }
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    const raf = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [panel.id]);

  // Snap-on-content-resize: a ResizeObserver on the body's content wrapper
  // catches *any* size change — events landing, tool-result merges, async
  // markdown / hljs render, status banners, image loads — and applies the
  // same active-reader gating. This subsumes the old `events.length` effect.
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) return;
    const snap = () => {
      // If the browser window isn't focused, the user can't possibly be
      // actively reading — snap unconditionally.
      const browserFocused = document.hasFocus();
      const recentlyActive =
        browserFocused && Date.now() - lastClickAtRef.current < ACTIVE_WINDOW_MS;
      const frozen = false; // freeze-panel concept not yet supported
      if (!recentlyActive && !frozen) {
        body.scrollTop = body.scrollHeight;
        stickToBottomRef.current = true;
        return;
      }
      if (stickToBottomRef.current) body.scrollTop = body.scrollHeight;
    };
    const ro = new ResizeObserver(snap);
    ro.observe(content);
    // When the window loses focus or the tab is hidden, snap immediately.
    // Otherwise a panel that grew while focused-and-recently-clicked stays
    // mid-scroll forever from the user's perspective.
    const onBlur = () => {
      body.scrollTop = body.scrollHeight;
      stickToBottomRef.current = true;
    };
    const onVisibility = () => {
      if (document.hidden) onBlur();
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ro.disconnect();
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Completion sweep: fire briefly on live → done transitions.
  useEffect(() => {
    if (lastStatusRef.current === 'live' && panel.status === 'done' && articleRef.current) {
      const el = articleRef.current;
      el.classList.add('completing');
      const t = setTimeout(() => el.classList.remove('completing'), 800);
      return () => clearTimeout(t);
    }
    lastStatusRef.current = panel.status;
  }, [panel.status]);

  const { items, checklist, pending } = useMemo(
    () => preprocessEvents(panel.events),
    [panel.events],
  );
  const waiting = pending && panel.status === 'live';
  const progressPct = checklist ? progressPercent(checklist) : null;

  // Subagent at 100% progress: play a collapse animation, then unmount.
  // Parent panels are never auto-collapsed; their lifecycle stays
  // server-driven (idle → done → mini → removed).
  useEffect(() => {
    const prev = prevProgressRef.current;
    prevProgressRef.current = progressPct;
    if (panel.kind !== 'subagent') return;
    if (progressPct !== 100 || prev === 100) return;
    const article = articleRef.current;
    if (!article) return;
    article.classList.add('progress-completing');
    const t = setTimeout(() => setCollapsed(true), 950);
    return () => clearTimeout(t);
  }, [progressPct, panel.kind]);

  if (collapsed) return null;

  const onBubbleClick = (event: Event) => {
    // Open the full turn that contains this bubble. If for some reason we
    // can't resolve a turn (e.g. event.uuid not found in events), fall back
    // to showing the single message — clicking should never appear to do
    // nothing.
    const turn = computeTurn(panel.events, event.uuid);
    const eventsToShow = turn.length > 0 ? turn : [event];
    lightbox.open(<TurnLightbox panel={panel} events={eventsToShow} />, {
      theme: panel.theme,
    });
  };

  const style: CSSProperties = {};
  const styleVars = style as Record<string, string>;
  if (progressPct !== null) styleVars['--progress'] = `${progressPct}%`;
  if (accountColor) styleVars['--account-color'] = accountColor;
  if (panel.theme) {
    styleVars['--panel-theme-bg'] = panel.theme.background;
    styleVars['--panel-theme-fg'] = panel.theme.foreground;
  }

  return (
    <div className="panel-wrap" style={style}>
      {/* Halo sibling — sits behind the panel so its box-shadow pulse can
       * escape the panel's overflow:hidden. Animates `opacity` only
       * (composited / GPU) instead of `box-shadow` keyframes (paint /
       * CPU). Visibility + color are driven by the panel's classes
       * via :has() selectors in app.css. */}
      <div className="panel-halo" aria-hidden="true" />
      <article
        ref={articleRef}
        className={classNames(
          'panel',
          `panel-${panel.kind}`,
          `status-${panel.status}`,
          waiting && 'waiting',
          panel.awaiting_input && 'awaiting-input',
          progressPct !== null && 'has-progress',
          panel.theme && 'has-theme',
          nested && 'nested',
          pinned && 'pinned',
          panel.removing && 'removing',
          panel.ended && 'ended',
        )}
        data-panel-id={panel.id}
        onMouseDownCapture={() => {
          lastClickAtRef.current = Date.now();
        }}
      >
        <PanelHeader
          panel={panel}
          now={now}
          onHide={onHide}
          onRestore={onRestore}
          pinned={pinned}
          onTogglePin={onTogglePin}
          account={account}
          waiting={waiting}
          waitingSince={waiting ? lastUserActivity(items, now) : null}
        />
        {panel.status !== 'mini' && (
          <PanelToolPalette
            panel={panel}
            onHide={onHide}
            brokenOut={!!brokenOut}
            onToggleBrokenOut={onToggleBrokenOut}
          />
        )}
        {checklist && <ChecklistPin items={checklist} />}
        <div
          className="panel-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 32px slack so a near-bottom scroll still counts as "at bottom".
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
            // Persist position for refresh-recovery (sessionStorage, 60s TTL).
            // Debounced via the same requestAnimationFrame the browser is
            // already firing for scroll, so we don't write storage on every
            // wheel tick.
            if (scrollSaveRafRef.current === null) {
              scrollSaveRafRef.current = requestAnimationFrame(() => {
                scrollSaveRafRef.current = null;
                if (bodyRef.current) saveScrollPosition(panel.id, bodyRef.current.scrollTop);
              });
            }
          }}
        >
          <div className="panel-body-content" ref={contentRef}>
            <EventList
              events={panel.events}
              startedAt={panel.started_at}
              cwd={panel.cwd}
              onBubbleClick={onBubbleClick}
            />
            {waiting && <ThinkingIndicator started={lastUserActivity(items, now)} now={now} />}
            {panel.status !== 'live' &&
              (() => {
                const cleared = panel.ended_provenance === 'hook_session_start_supersede';
                const label = cleared ? 'session cleared' : 'session ended';
                return (
                  <div className="session-ended" aria-label={label}>
                    <span>{label}</span>
                  </div>
                );
              })()}
          </div>
        </div>
      </article>
      <AutoTitleToast panel={panel} />
    </div>
  );
}

function TurnLightbox({ panel, events }: { panel: PanelState; events: Event[] }) {
  return (
    <>
      <h3 className="lightbox-title">{renderInlineCode(panel.title)}</h3>
      <EventList events={events} startedAt={panel.started_at} cwd={panel.cwd} />
    </>
  );
}

function computeTurn(events: Event[], anchorUuid: string): Event[] {
  const anchorIdx = events.findIndex((e) => e.uuid === anchorUuid);
  if (anchorIdx === -1) return [];
  let start = 0;
  for (let i = anchorIdx; i >= 0; i--) {
    if (events[i]?.kind === 'user_text') {
      start = i;
      break;
    }
  }
  let end = events.length;
  for (let i = start + 1; i < events.length; i++) {
    if (events[i]?.kind === 'user_text') {
      end = i;
      break;
    }
  }
  return events.slice(start, end);
}

function PanelHeader({
  panel,
  now,
  onHide,
  onRestore,
  pinned,
  onTogglePin,
  account,
  waiting,
  waitingSince,
}: {
  panel: PanelState;
  now: number;
  onHide?: () => void;
  onRestore?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  account?: string | null;
  waiting?: boolean;
  waitingSince?: number | null;
}) {
  const lightbox = useLightbox();
  const isLive = panel.status === 'live';
  let idleLabel: string;
  if (isLive) {
    idleLabel = formatIdle(Math.max(0, now - panel.last_event_at));
  } else {
    // done + mini: `+5m` style — status icon already communicates which
    // lifecycle state we're in, so the label is just the elapsed delta.
    idleLabel = `+${formatIdleCoarse(Math.max(0, now - panel.status_changed_at))}`;
  }
  const showWaitingBadge = !!waiting && waitingSince != null;
  const waitingLabel = showWaitingBadge ? formatIdle(Math.max(0, now - waitingSince)) : '';

  // Spin the status icon when pinned changes: clockwise on pin, counter-
  // clockwise on unpin. A one-shot class drives the keyframe animation
  // and clears itself after it ends so the resting shape (.pinned or not)
  // takes over cleanly.
  const [spinDir, setSpinDir] = useState<'cw' | 'ccw' | null>(null);
  const prevPinnedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const prev = prevPinnedRef.current;
    prevPinnedRef.current = pinned;
    if (prev === undefined) return; // first render — no transition
    if (prev === pinned) return;
    setSpinDir(pinned ? 'cw' : 'ccw');
    const t = setTimeout(() => setSpinDir(null), 550);
    return () => clearTimeout(t);
  }, [pinned]);
  // Headline is input-equivalent (each bucket × its billing coefficient)
  // rather than a naive sum — cache_read dominates the raw total at 0.1×
  // actual cost, so an unweighted sum overstates effective usage by ~5×.
  const totalTokens = inputEquivalentTokens(panel.tokens);

  return (
    <header
      className="panel-header"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        if (panel.status !== 'live') {
          // Open the whole panel in a lightbox so done/mini panels can still be inspected.
          lightbox.open(<PanelLightboxContent panel={panel} />, { theme: panel.theme });
        }
      }}
    >
      {onRestore || onTogglePin ? (
        <button
          type="button"
          className={classNames(
            'panel-status-slot',
            'panel-status-slot-button',
            pinned && 'pinned',
          )}
          title={
            onRestore
              ? `Restore to the grid · ${statusIconTitle(panel.status, !!waiting, !!pinned)}`
              : pinned
                ? `Unpin · ${statusIconTitle(panel.status, !!waiting, true)}`
                : `Pin · ${statusIconTitle(panel.status, !!waiting, false)}`
          }
          aria-pressed={onRestore ? undefined : !!pinned}
          onClick={(e) => {
            e.stopPropagation();
            if (onRestore) onRestore();
            else onTogglePin?.();
          }}
        >
          {panel.ended ? (
            <CheckGlyph />
          ) : (
            <span
              className={classNames(
                'panel-status-icon',
                spinDir === 'cw' && 'panel-status-icon-spin-cw',
                spinDir === 'ccw' && 'panel-status-icon-spin-ccw',
              )}
              aria-hidden="true"
            />
          )}
        </button>
      ) : (
        <span
          className="panel-status-slot"
          title={statusIconTitle(panel.status, !!waiting, !!pinned)}
        >
          {panel.ended ? <CheckGlyph /> : <span className="panel-status-icon" aria-hidden="true" />}
        </span>
      )}
      <span className="panel-titles">
        <span className={classNames('panel-title', useTitleFlash(panel.autoTitledAt) && 'flash')}>
          {renderInlineCode(panel.title)}
        </span>
        <span className="panel-subtitle-row">
          {panel.kind === 'subagent' && panel.agent_type ? (
            <span className="panel-subtitle">{panel.agent_type}</span>
          ) : panel.cwd ? (
            <span className="panel-subtitle panel-subtitle-cwd">{projectLabel(panel.cwd)}</span>
          ) : null}
          {account && (
            <span className="panel-account" title={`account: ${account}`}>
              {account}
            </span>
          )}
          {panel.status === 'mini' && !showWaitingBadge && (
            <span className="panel-idle-inline">{idleLabel}</span>
          )}
        </span>
      </span>
      <span className="panel-meta">
        <span className="panel-meta-row panel-meta-row-top">
          {showWaitingBadge ? (
            <span
              className="panel-waiting-badge"
              title="awaiting response from the model"
              aria-live="polite"
            >
              <span className="panel-waiting-spinner" aria-hidden="true" />
              <span className="panel-waiting-elapsed">{waitingLabel}</span>
            </span>
          ) : (
            panel.status !== 'mini' && <span className="panel-idle">{idleLabel}</span>
          )}
          <HeaderActions panel={panel} onHide={onHide} onRestore={onRestore} />
        </span>
        {panel.status !== 'mini' && !onRestore && (
          <span className="panel-meta-row panel-meta-row-bottom">
            <HoverPopover
              className="panel-session-time"
              content={
                <SessionTimeTooltip startedAt={panel.started_at} isLive={isLive} />
              }
            >
              <span aria-label="total session time">
                {formatIdleCoarse(
                  Math.max(0, (isLive ? now : panel.last_event_at) - panel.started_at),
                )}
              </span>
            </HoverPopover>
            {totalTokens > 0 && (
              <HoverPopover
                className={classNames('panel-tokens', `cache-${cacheHealth(panel.tokens)}`)}
                content={<TokenTooltip tokens={panel.tokens} />}
              >
                <span aria-label="token usage">{formatTokens(totalTokens)}</span>
              </HoverPopover>
            )}
            {panel.context_size > 0 && (
              <HoverPopover
                className="panel-context"
                content={<ContextSizeTooltip contextSize={panel.context_size} />}
              >
                <span aria-label="context window size">{formatTokens(panel.context_size)}</span>
              </HoverPopover>
            )}
          </span>
        )}
      </span>
    </header>
  );
}

function HeaderActions({
  panel,
  onHide,
  onRestore,
}: {
  panel: PanelState;
  onHide?: () => void;
  onRestore?: () => void;
}) {
  // When the panel lives in the tray (onRestore provided), we swap `×` for
  // a restore affordance. A tray panel doesn't need closing — it's already
  // out of the way — but it does need an unmini.
  const inTray = !!onRestore;
  return (
    <>
      {/* Live panels host popout / fullscreen / close in the floating
       * PanelToolPalette; the header only renders these for done/mini. */}
      {panel.status === 'mini' && (
        <button
          type="button"
          className="panel-btn panel-trash"
          title="Move to trash (reversible from prefs → Trash)"
          onClick={(e) => {
            e.stopPropagation();
            trpc.remove.mutate({ panelId: panel.id });
          }}
        >
          <span
            className="svg-glyph"
            aria-hidden="true"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
            dangerouslySetInnerHTML={{ __html: trashIcon }}
          />
        </button>
      )}
      {/* Live + done panels have × in the floating palette; mini keeps it
       * in the header since the palette doesn't render there. */}
      {!inTray && panel.status === 'mini' && onHide && (
        <button
          type="button"
          className="panel-btn"
          title="Close this window. The session keeps running; this panel reappears on new activity."
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
        >
          ×
        </button>
      )}
    </>
  );
}

/**
 * Floating top-right palette for live panels. Lives inside the article, not
 * the header — so it can sit visually on top of the content area where there's
 * room. Visibility is two-tier:
 *   - cursor on the panel: faint affordance (opacity ~0.3)
 *   - cursor near the corner (inside the palette's expanded hit region):
 *     full reveal
 * Hidden entirely once the cursor leaves the panel. Mini panels don't
 * get this — they keep the simple header buttons.
 */
function PanelToolPalette({
  panel,
  onHide,
  brokenOut,
  onToggleBrokenOut,
}: {
  panel: PanelState;
  onHide?: () => void;
  brokenOut?: boolean;
  onToggleBrokenOut?: () => void;
}) {
  const lightbox = useLightbox();
  const { prefs } = usePrefs();
  const debug = prefs.debug?.enabled === true;
  const isParent = panel.kind === 'parent';
  const isSubWithParent = panel.kind === 'subagent' && !!panel.parent_panel_id;
  return (
    <div className="panel-tool-palette" aria-label="panel actions">
      <ToolChips>
        <ToolChip
          title="Open in lightbox"
          onClick={(e) => {
            e.stopPropagation();
            lightbox.open(<PanelLightboxContent panel={panel} />, { theme: panel.theme });
          }}
        >
          ⛶
        </ToolChip>
        {isSubWithParent && onToggleBrokenOut && (
          <ToolChip
            title={brokenOut ? 'Dock back into the parent session' : 'Break out into its own panel'}
            aria-pressed={!!brokenOut}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBrokenOut();
            }}
          >
            {brokenOut ? '⇱' : '⇲'}
          </ToolChip>
        )}
        {isSubWithParent && (
          <ToolChip
            title="Pop out into an independent browser window"
            onClick={(e) => {
              e.stopPropagation();
              const url = `${location.pathname}?panel=${encodeURIComponent(panel.id)}`;
              window.open(
                url,
                `brainhouse-panel-${panel.id}`,
                'noopener=no,width=900,height=900',
              );
            }}
          >
            ↗
          </ToolChip>
        )}
        {isParent && debug && (
          <>
            <ToolChip
              className="panel-tool-debug"
              title="Debug: spawn a mock subagent in this session"
              onClick={(e) => {
                e.stopPropagation();
                trpc.debug.spawnSubagentIn.mutate({ sessionId: panel.id });
              }}
            >
              +sub
            </ToolChip>
            <ToolChip
              className="panel-tool-debug"
              title="Debug: spawn a counting subagent (runs to 10)"
              onClick={(e) => {
                e.stopPropagation();
                trpc.debug.spawnSubagentIn.mutate({ sessionId: panel.id, stopAt: 10 });
              }}
            >
              +count
            </ToolChip>
          </>
        )}
        {debug && (
          <ToolChip
            className="panel-tool-debug"
            title="Debug: trigger title flash + toast + inline breadcrumb at once"
            onClick={(e) => {
              e.stopPropagation();
              trpc.debug.previewAutoTitle.mutate({ panelId: panel.id });
            }}
          >
            !title
          </ToolChip>
        )}
        {debug && (
          <ToolChip
            className="panel-tool-debug"
            title={`Debug: copy session id (${panel.id}) to clipboard`}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(panel.id);
            }}
          >
            id
          </ToolChip>
        )}
        {onHide && (
          <ToolChip
            title="Send this panel to the dock. The session keeps running; this panel reappears on new activity."
            onClick={(e) => {
              e.stopPropagation();
              onHide();
            }}
          >
            ⤓
          </ToolChip>
        )}
        <ToolChip
          title="Move to trash (reversible from prefs → Trash)"
          onClick={(e) => {
            e.stopPropagation();
            trpc.remove.mutate({ panelId: panel.id });
          }}
        >
          <span
            className="svg-glyph"
            aria-hidden="true"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
            dangerouslySetInnerHTML={{ __html: trashIcon }}
          />
        </ToolChip>
      </ToolChips>
    </div>
  );
}

function ChecklistPin({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <div className="panel-pinned">
      <div className="checklist-summary">
        progress · {done} / {items.length}
      </div>
      <ul className="checklist">
        {items.map((it, i) => (
          <li key={`${i}-${it.text}`} className={it.done ? 'done' : undefined}>
            <span className={classNames('check', it.done && 'done')}>{it.done ? '✓' : '○'}</span>
            <span className="label">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThinkingIndicator({ started, now }: { started: number; now: number }) {
  const dt = Math.max(0, now - started);
  return (
    <div className="thinking-indicator">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-timer">{formatIdle(dt)}</span>
    </div>
  );
}

function PanelLightboxContent({ panel }: { panel: PanelState }) {
  return (
    <>
      <h3 className="lightbox-title">{renderInlineCode(panel.title)}</h3>
      <EventList events={panel.events} cwd={panel.cwd} />
    </>
  );
}

/** Multi-line tooltip with the per-bucket token breakdown + model. */
/**
 * Checkmark used in the status slot when the server is sure a session has
 * ended (panel.ended === true — set by SubagentStop, Stop hooks, etc.).
 * Replaces the LED glyph; the slot still pins/unpins on click.
 */
function CheckGlyph() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="panel-status-check"
      aria-hidden="true"
    >
      <polyline points="4 12 10 18 20 6" />
    </svg>
  );
}

function statusIconTitle(
  status: 'live' | 'done' | 'mini',
  waiting: boolean,
  pinned: boolean,
): string {
  const shape = pinned ? 'pinned' : 'session';
  if (status === 'live') return `${shape} — live${waiting ? ', awaiting model' : ''}`;
  if (status === 'done') return `${shape} — done`;
  return `${shape} — mini`;
}

function progressPercent(items: ChecklistItem[]): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter((i) => i.done).length / items.length) * 100);
}

/**
 * Best-effort: time of the last user_text / tool_result; everything else
 * (asst text, tool_use) clears the pending state so the indicator goes away.
 */
function lastUserActivity(
  items: ReturnType<typeof preprocessEvents>['items'],
  fallback: number,
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === 'bubble' && item.role === 'user') return parseTs(item.event.ts, fallback);
    if (item.type === 'tool' && item.result) return fallback; // result.ts not stored; use fallback
  }
  return fallback;
}

function parseTs(ts: string, fallback: number): number {
  if (!ts) return fallback;
  const t = new Date(ts).getTime() / 1000;
  return Number.isNaN(t) ? fallback : t;
}

/** Returns true while a panel's title-flash window is still active. The
 * window is keyed to `autoTitledAt` (wall-clock ms) so a fresh delta
 * re-triggers even if the previous flash hadn't faded yet. */
function useTitleFlash(at?: number): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!at) return;
    setActive(true);
    const t = setTimeout(() => setActive(false), 1600);
    return () => clearTimeout(t);
  }, [at]);
  return active;
}

function AutoTitleToast({ panel }: { panel: PanelState }) {
  const [visible, setVisible] = useState(false);
  const lastSeenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!panel.autoTitledAt || panel.autoTitledAt === lastSeenRef.current) return;
    lastSeenRef.current = panel.autoTitledAt;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(t);
  }, [panel.autoTitledAt]);
  if (!visible) return null;
  const prev = panel.autoTitledPrev ?? '—';
  return (
    <div className="auto-title-toast" role="status" aria-live="polite">
      <span className="auto-title-toast-label">auto-titled</span>
      <span className="auto-title-toast-prev">{prev}</span>
      <span className="auto-title-toast-arrow" aria-hidden="true">
        →
      </span>
      <span className="auto-title-toast-new">{panel.title}</span>
    </div>
  );
}
