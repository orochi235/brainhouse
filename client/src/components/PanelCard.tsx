import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import trashIcon from '../assets/icons/trash.svg?raw';
import { formatIdle, formatIdleCoarse, formatTokens } from '../lib/format.ts';
import { renderInlineCode } from '../lib/inlineCode.tsx';
import { getActiveDrag, setActiveDrag } from '../lib/activeDrag.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import { type ChecklistItem, preprocessEvents } from '../lib/pipeline.ts';
import type { SubagentSpawn } from '../lib/pipeline-types.ts';
import { projectLabel } from '../lib/project.ts';
import { deriveWorktree, worktreeColor } from '../lib/worktree.ts';
import { loadScrollPosition, saveScrollPosition } from '../lib/scrollMemory.ts';
import { cacheHealth, inputEquivalentTokens } from '../lib/tokenCost.ts';
import { usePrefs } from '../lib/usePrefs.tsx';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { BlacklistConfirm } from './BlacklistConfirm.tsx';
import { EventList } from './EventList.tsx';
import { HoverPopover, TruncationTooltip } from './HoverPopover.tsx';
import { ContextSizeTooltip, SessionTimeTooltip } from './PanelHeaderTooltips.tsx';
import { StatusLight } from './StatusLight.tsx';
import { TimelineLightbox } from './TimelineLightbox.tsx';
import { TitleBar } from './TitleBar.tsx';
import { TokenTooltip } from './TokenTooltip.tsx';
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
  /** When this panel is a broken-out subagent, the parent's display title.
   * Renders as a small breadcrumb chip near the subtitle; clicking the
   * pop-back button (`onToggleBrokenOut`) re-docks. */
  parentTitle?: string | null;
  /** Account label to badge in the header. Parent typically passes
   * `panel.account_label` when more than one account is configured;
   * undefined/null suppresses the badge. */
  account?: string | null;
  /** Hex color tied to the account. When set, stamps `--account-color`
   * on the panel so the badge + a subtle border tint pick it up. */
  accountColor?: string;
  /** Live child panels (subagents this panel spawned). Joined against
   * the parent's `Task` tool_use list to render the spawned-subagent
   * section. Empty / undefined skips the section. */
  subagents?: PanelState[];
  /** Replay / fixture mode: suppress action affordances whose tRPC
   * mutations would fail (panel id is synthetic) or have meaningless
   * semantics. Currently hides the trash buttons and the debug
   * dev-chip section in the tool palette. */
  readOnly?: boolean;
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
  parentTitle,
  account,
  accountColor,
  subagents,
  readOnly,
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

  const { items, checklist, pending, subagentSpawns } = useMemo(
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

  const worktree = deriveWorktree(panel.cwd);

  const style: CSSProperties = {
    // Per-panel view-transition name so the browser morphs the panel's
    // pre→post box (e.g. when promoted from dock to grid) instead of
    // cross-fading the entire layout. Only matters during an explicit
    // `document.startViewTransition()` — see `lib/viewTransition.ts`.
    viewTransitionName: `panel-${panel.id.replace(/[^a-zA-Z0-9-]/g, '-')}`,
  };
  const styleVars = style as Record<string, string>;
  if (progressPct !== null) styleVars['--progress'] = `${progressPct}%`;
  if (accountColor) styleVars['--account-color'] = accountColor;
  if (worktree) styleVars['--panel-worktree-color'] = worktreeColor(worktree.key);
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
          worktree && 'has-worktree',
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
          brokenOut={brokenOut}
          onToggleBrokenOut={onToggleBrokenOut}
          parentTitle={parentTitle}
          readOnly={readOnly}
        />
        {panel.status !== 'mini' && (
          <PanelToolPalette
            panel={panel}
            onHide={onHide}
            brokenOut={!!brokenOut}
            onToggleBrokenOut={onToggleBrokenOut}
            readOnly={readOnly}
          />
        )}
        {checklist && <ChecklistPin items={checklist} now={now} />}
        {subagentSpawns.length > 0 && (
          <SubagentSection
            spawns={subagentSpawns}
            childPanels={subagents ?? []}
            parentId={panel.id}
            readOnly={readOnly}
          />
        )}
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
      <TruncationTooltip text={panel.title}>
        <h3 className="lightbox-title">
          {panel.manually_renamed && (
            <span
              className="panel-title-manual-glyph"
              aria-label="title set manually via /rename"
              title="Title set manually via /rename"
            >
              ❖
            </span>
          )}
          {renderInlineCode(panel.title)}
        </h3>
      </TruncationTooltip>
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
  brokenOut,
  onToggleBrokenOut,
  parentTitle,
  readOnly,
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
  brokenOut?: boolean;
  onToggleBrokenOut?: () => void;
  parentTitle?: string | null;
  readOnly?: boolean;
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
  const worktree = deriveWorktree(panel.cwd);
  // Headline is input-equivalent (each bucket × its billing coefficient)
  // rather than a naive sum — cache_read dominates the raw total at 0.1×
  // actual cost, so an unweighted sum overstates effective usage by ~5×.
  const totalTokens = inputEquivalentTokens(panel.tokens);

  // Leading column: status light on top. Mini panels also get a × (and
  // trash for non-tray contexts) below it, separated by a rotated-T
  // border that mirrors the project-widget treatment. Live and done
  // panels keep the floating tool palette for ×, so the leading column
  // shows only the status light.
  const statusLight =
    onRestore || onTogglePin ? (
      <StatusLight
        ended={panel.ended}
        pinned={pinned}
        spinDir={spinDir}
        ariaPressed={onRestore ? undefined : !!pinned}
        title={
          onRestore
            ? `Restore to the grid · ${statusIconTitle(panel.status, !!waiting, !!pinned)}`
            : pinned
              ? `Unpin · ${statusIconTitle(panel.status, !!waiting, true)}`
              : `Pin · ${statusIconTitle(panel.status, !!waiting, false)}`
        }
        onClick={(e) => {
          e.stopPropagation();
          if (onRestore) onRestore();
          else onTogglePin?.();
        }}
      />
    ) : (
      <StatusLight
        ended={panel.ended}
        title={statusIconTitle(panel.status, !!waiting, !!pinned)}
      />
    );

  // Leading is at most 2 items so the rotated-T divider matches the
  // project-widget design. Mini panels get the × stacked below the
  // status light; trash lives in the subtitle aside (hover-revealed)
  // so it doesn't crowd this column.
  const showLeadingClose = panel.status === 'mini' && !!onHide && !onRestore;
  const leading = (
    <>
      {statusLight}
      {showLeadingClose && (
        <BlacklistableCloseButton
          label={panel.title || panel.id}
          sessionIds={[panel.id]}
          onClose={onHide!}
          className="panel-leading-close"
          title="Close this window. Shift-click to blacklist this session permanently. The session keeps running otherwise."
        />
      )}
    </>
  );

  const titleNode = (
    <TruncationTooltip text={panel.title}>
      <span className={classNames('panel-title', useTitleFlash(panel.autoTitledAt) && 'flash')}>
        {panel.manually_renamed && (
          <span
            className="panel-title-manual-glyph"
            aria-label="title set manually via /rename"
            title="Title set manually via /rename"
          >
            ❖
          </span>
        )}
        {renderInlineCode(panel.title)}
      </span>
    </TruncationTooltip>
  );

  // Title row right side: worktree chip + idle/waiting label. The
  // waiting badge (spinner + elapsed) takes over when the panel is
  // pending; otherwise the static idle counter shows.
  const titleAside = (
    <>
      {worktree && (
        <span
          className="panel-worktree-chip"
          title={`worktree: ${worktree.key}`}
          aria-label={`worktree ${worktree.name} on ${worktree.repo}`}
        >
          <span className="panel-worktree-swatch" aria-hidden="true" />
          {worktree.name}
        </span>
      )}
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
        <span className={panel.status === 'mini' ? 'panel-idle-inline' : 'panel-idle'}>
          {idleLabel}
        </span>
      )}
    </>
  );

  const subtitleNode =
    panel.kind === 'subagent' && panel.agent_type ? (
      <span className="panel-subtitle">{panel.agent_type}</span>
    ) : panel.cwd ? (
      <TruncationTooltip text={panel.cwd}>
        <span className="panel-subtitle panel-subtitle-cwd">{projectLabel(panel.cwd)}</span>
      </TruncationTooltip>
    ) : undefined;

  // Subtitle row right side: breadcrumb back to parent (if broken-out),
  // account chip, then the meta capsule trio (session-time / tokens /
  // context). Mini panels suppress the meta trio — their footprint is
  // a single row, so the bottom stats would crowd. Mini panels also
  // host the trash button here (hover-revealed), since the leading
  // column is reserved for the rotated-T status-light + × pair.
  const subtitleAside = (
    <>
      {brokenOut && parentTitle && (
        <button
          type="button"
          className="panel-parent-breadcrumb"
          title={`Re-dock into "${parentTitle}"`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleBrokenOut?.();
          }}
        >
          <span aria-hidden="true">↩</span> {parentTitle}
        </button>
      )}
      {account && (
        <span className="panel-account" title={`account: ${account}`}>
          {account}
        </span>
      )}
      {panel.status === 'mini' && !readOnly && (
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
      {panel.status !== 'mini' && !onRestore && (
        <>
          <HoverPopover
            className="panel-session-time"
            content={<SessionTimeTooltip startedAt={panel.started_at} isLive={isLive} />}
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
              content={
                <ContextSizeTooltip
                  contextSize={panel.context_size}
                  hookOverheadTokens={panel.hook_overhead_tokens}
                />
              }
            >
              <span aria-label="context window size">{formatTokens(panel.context_size)}</span>
            </HoverPopover>
          )}
        </>
      )}
    </>
  );

  return (
    <TitleBar
      className="panel-header"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        // Mini panels in the tray render as just-a-header — clicking
        // anywhere on that header should fully restore the session to
        // a full-sized window, matching what the status-icon button
        // already does. Without this, the header click opens the
        // lightbox instead, which is the right behavior for *done*
        // panels (inspect-in-place) but wrong for *mini* (the user is
        // bringing the session back).
        if (panel.status === 'mini' && onRestore) {
          onRestore();
          return;
        }
        if (panel.status !== 'live') {
          // Open the whole panel in a lightbox so done panels can still be inspected.
          lightbox.open(<PanelLightboxContent panel={panel} />, { theme: panel.theme });
        }
      }}
      leading={leading}
      title={titleNode}
      titleAside={titleAside}
      subtitle={subtitleNode}
      subtitleAside={subtitleAside}
    />
  );
}

function BlacklistableCloseButton({
  label,
  sessionIds,
  onClose,
  className = 'panel-btn',
  title = 'Close. Shift-click to blacklist this session permanently.',
}: {
  label: string;
  sessionIds: string[];
  onClose: () => void;
  className?: string;
  title?: string;
}) {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          lightbox.open(<BlacklistConfirm label={label} sessionIds={sessionIds} />);
          return;
        }
        onClose();
      }}
    >
      ×
    </button>
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
  readOnly,
}: {
  panel: PanelState;
  onHide?: () => void;
  brokenOut?: boolean;
  onToggleBrokenOut?: () => void;
  readOnly?: boolean;
}) {
  const lightbox = useLightbox();
  const { prefs } = usePrefs();
  const debug = prefs.debug?.enabled === true && !readOnly;
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
        <ToolChip
          title="Open the event timeline"
          onClick={(e) => {
            e.stopPropagation();
            lightbox.open(<TimelineLightbox panel={panel} />, { theme: panel.theme });
          }}
        >
          ⌁
        </ToolChip>
        {isSubWithParent && onToggleBrokenOut && (
          <ToolChip
            title={brokenOut ? 'Re-dock into the parent session' : 'Promote to a grid panel'}
            aria-pressed={!!brokenOut}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBrokenOut();
            }}
          >
            {brokenOut ? '⇱' : '⇲'}
          </ToolChip>
        )}
        {isParent && debug && (
          <>
            <ToolChip
              className="panel-tool-debug"
              title="Debug: wipe this session's in-memory + persisted state and rebuild it by re-reading the JSONL (cascades to subagents)"
              onClick={(e) => {
                e.stopPropagation();
                void trpc.debug.rebuildPanel.mutate({ panelId: panel.id });
              }}
            >
              ↻
            </ToolChip>
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
        {!readOnly && (
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
        )}
      </ToolChips>
    </div>
  );
}

const CHECKLIST_ALL_DONE_LINGER_S = 5;

function ChecklistPin({ items, now }: { items: ChecklistItem[]; now: number }) {
  const done = items.filter((i) => i.done).length;
  const pct = items.length === 0 ? 0 : (done / items.length) * 100;
  // Sort: open items first (in their original order), then completed items
  // at the bottom. Within "open" we preserve list order; within "done" we
  // sort by completedAt ascending so the most-recently-finished sits at
  // the very bottom of the list (visually closest to the next open item).
  const withIndex = items.map((it, i) => {
    const completedSeconds =
      it.completedAt && it.done ? completedAgo(it.completedAt, now) : null;
    const elapsedSeconds = computeElapsed(it, now);
    return { it, i, completedSeconds, elapsedSeconds };
  });
  const open = withIndex.filter(({ it }) => !it.done);
  const finished = withIndex
    .filter(({ it }) => it.done)
    .sort((a, b) => (a.completedSeconds ?? 0) - (b.completedSeconds ?? 0));
  const ordered = [...open, ...finished];
  // Drop the whole list once it's been fully done for a few seconds so the
  // pin stays focused on active work. We measure linger from the oldest
  // (i.e. last-completed in display order is at the bottom; oldest is at
  // the top of `finished`).
  if (open.length === 0 && finished.length > 0) {
    const lastCompletedAgo = finished[finished.length - 1]?.completedSeconds ?? null;
    if (lastCompletedAgo !== null && lastCompletedAgo >= CHECKLIST_ALL_DONE_LINGER_S) {
      return null;
    }
  }
  if (ordered.length === 0) return null;
  return (
    <div className="panel-pinned">
      <div className="checklist-summary">
        <span>
          progress · {done} / {items.length}
        </span>
      </div>
      <div
        className="checklist-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
      >
        <div className="checklist-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="checklist">
        {ordered.map(({ it, i, elapsedSeconds }) => {
          const state = it.done ? 'done' : it.inProgress ? 'in-progress' : undefined;
          const glyph = it.done ? '✓' : it.inProgress ? '◐' : '○';
          return (
            <li key={`${i}-${it.text}`} className={state}>
              <span className={classNames('check', state)}>{glyph}</span>
              <span className="label">{it.text}</span>
              {elapsedSeconds !== null && (
                <span
                  className="checklist-elapsed"
                  title={
                    it.firstSeenAt
                      ? `started ${it.firstSeenAt}${it.completedAt ? ` · done ${it.completedAt}` : ''}`
                      : undefined
                  }
                >
                  {formatIdleCoarse(elapsedSeconds)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function completedAgo(iso: string, now: number): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const dt = now - ms / 1000;
  return dt < 0 ? 0 : dt;
}

/** Per-item elapsed time. For done items: completedAt − firstSeenAt.
 * For in-progress items: now − firstSeenAt. Pending items return null
 * (no useful duration to show yet). */
function computeElapsed(it: ChecklistItem, now: number): number | null {
  if (!it.firstSeenAt) return null;
  const start = Date.parse(it.firstSeenAt);
  if (!Number.isFinite(start)) return null;
  let end: number;
  if (it.done && it.completedAt) {
    const completedMs = Date.parse(it.completedAt);
    if (!Number.isFinite(completedMs)) return null;
    end = completedMs / 1000;
  } else if (it.inProgress) {
    end = now;
  } else {
    return null;
  }
  const dt = end - start / 1000;
  return dt < 0 ? 0 : dt;
}

/**
 * Header section listing the subagents this panel has dispatched via the
 * `Task` tool. Each row joins one spawn entry to its matching child panel
 * (if it exists yet) so we can render the child's live progress next to
 * the description. Clicking a row scrolls the child panel into view and
 * pulses it briefly.
 */
function SubagentSection({
  spawns,
  childPanels,
  parentId,
  readOnly,
}: {
  spawns: SubagentSpawn[];
  childPanels: PanelState[];
  parentId: string;
  readOnly?: boolean;
}) {
  const remaining = [...childPanels];
  // Match spawns to live child panels in event order (so the first spawn
  // claims the first matching child), then reverse rows so newest is at
  // the top of the rendered list. Matching order matters; render order
  // doesn't, so this stays a pure presentation reversal.
  const rows = spawns
    .map((spawn) => {
      const matchIdx = remaining.findIndex(
        (c) =>
          c.task_description === spawn.description &&
          (spawn.agentType === null || c.agent_type === spawn.agentType),
      );
      const child = matchIdx >= 0 ? remaining.splice(matchIdx, 1)[0] : null;
      return { spawn, child };
    })
    .reverse();
  const liveCount = rows.filter(
    (r) => r.spawn.status === 'running' || (r.child && !r.child.ended),
  ).length;
  const doneCount = rows.length - liveCount;
  return (
    <div className="panel-pinned subagent-section">
      <div className="checklist-summary">
        subagents · {doneCount} / {rows.length}
        {liveCount > 0 ? ` · ${liveCount} live` : ''}
      </div>
      <ul className="subagent-list">
        {rows.map(({ spawn, child }) => (
          <SubagentRow
            key={spawn.toolUseId}
            spawn={spawn}
            child={child ?? null}
            parentId={parentId}
            readOnly={readOnly}
          />
        ))}
      </ul>
    </div>
  );
}

function SubagentRow({
  spawn,
  child,
  parentId,
  readOnly,
}: {
  spawn: SubagentSpawn;
  child: PanelState | null;
  parentId: string;
  readOnly?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const status = effectiveStatus(spawn, child);
  const glyph = status === 'done' ? '✓' : status === 'failed' ? '✗' : '◐';
  // Click → promote the subagent onto the grid. Shift-click → jump to the
  // existing panel without changing layout. We always dispatch the
  // (parentId, description, agentType) tuple alongside any known child id so
  // App.tsx can resolve the panel even when layout filtering kept it out of
  // `subagents`.
  const onClick = readOnly
    ? undefined
    : (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.shiftKey && child) {
          focusPanel(child.id);
          return;
        }
        window.dispatchEvent(
          new CustomEvent('brainhouse:promote-subagent', {
            detail: {
              id: child?.id,
              parentId,
              description: spawn.description,
              agentType: spawn.agentType,
            },
          }),
        );
      };
  const childPct = useMemo(() => childProgressPercent(child), [child]);
  // Drag-to-promote is only meaningful when we have a real child panel
  // and we're not in replay (readOnly) mode — the drop handler in
  // App.tsx fires a tRPC mutation that would fail in replay.
  const canDrag = !!child && !readOnly;
  return (
    <li
      className={classNames('subagent-row', status, child && 'has-child')}
      draggable={canDrag && armed}
      onDragStart={
        canDrag && child
          ? (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/brainhouse-panel', child.id);
              e.dataTransfer.setData('text/brainhouse-panel-source', 'nested');
              setActiveDrag({
                id: child.id,
                from: 'nested',
                parentId,
                isBrokenOut: false,
              });
              (e.currentTarget as HTMLElement).classList.add('dragging');
            }
          : undefined
      }
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).classList.remove('dragging');
        setActiveDrag(null);
        setArmed(false);
      }}
      onMouseDown={() => {
        if (canDrag) setArmed(true);
      }}
      onMouseUp={() => setArmed(false)}
    >
      <button
        type="button"
        className="subagent-row-button"
        onClick={onClick}
        disabled={!onClick}
        title={
          readOnly
            ? `view ${child?.title ?? spawn.description}`
            : `promote to the grid${child ? ' (shift-click to jump)' : ''}`
        }
      >
        <span className={classNames('check', status)}>{glyph}</span>
        <span className="label">{spawn.description}</span>
        {spawn.agentType && <span className="subagent-row-type">{spawn.agentType}</span>}
      </button>
      {childPct !== null && (
        <div
          className="subagent-row-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={childPct}
        >
          <div className="subagent-row-progress-fill" style={{ width: `${childPct}%` }} />
        </div>
      )}
    </li>
  );
}

/** Returns the child's TodoWrite/checklist completion percent (0–100), or
 * `null` when the child has no checklist. We run the full pipeline on the
 * child's events here — it's memoized per child, and the same computation
 * already runs inside the child's own PanelCard, so the cost is a duplicated
 * pass only while the parent panel is mounted. */
function childProgressPercent(child: PanelState | null): number | null {
  if (!child) return null;
  const { checklist } = preprocessEvents(child.events);
  if (!checklist || checklist.length === 0) return null;
  const done = checklist.filter((i) => i.done).length;
  return Math.round((done / checklist.length) * 100);
}

function effectiveStatus(spawn: SubagentSpawn, child: PanelState | null): SubagentSpawn['status'] {
  // Prefer the child's authoritative state when joined: a child that's
  // ended (regardless of how) supersedes a still-pending parent-side
  // tool_result. The reverse is also useful: a parent that saw a failed
  // tool_result before the child panel was hidden/trashed should still
  // show as failed.
  if (spawn.status === 'failed' || spawn.status === 'canceled') return spawn.status;
  if (child?.ended) return 'done';
  if (spawn.status === 'done') return 'done';
  return 'running';
}

function focusPanel(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('focus-pulse');
  window.setTimeout(() => el.classList.remove('focus-pulse'), 900);
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
      <TruncationTooltip text={panel.title}>
        <h3 className="lightbox-title">
          {panel.manually_renamed && (
            <span
              className="panel-title-manual-glyph"
              aria-label="title set manually via /rename"
              title="Title set manually via /rename"
            >
              ❖
            </span>
          )}
          {renderInlineCode(panel.title)}
        </h3>
      </TruncationTooltip>
      <EventList events={panel.events} cwd={panel.cwd} />
    </>
  );
}

/** Multi-line tooltip with the per-bucket token breakdown + model. */

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
