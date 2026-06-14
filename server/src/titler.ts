/**
 * Out-of-band server-side auto-titler.
 *
 * Replaces the legacy `auto-title-inline.mjs` UserPromptSubmit hook, which
 * asked the live model to emit an `<!-- bh-title: ... -->` marker on its
 * last line. The marker was invisible in markdown renderers (brainhouse's
 * UI) but rendered literally in the user's CLI session — a visible seam
 * in what's pitched as seamless instrumentation.
 *
 * Here the server itself drives title generation from transcript state it
 * already ingests: ingestion sites in `session.ts` call
 * `scheduleEvaluation(panelId, reason)`. A per-panel debounce timer
 * coalesces bursts of `user_text` / `assistant_text` calls; a `stop`
 * reason bypasses the debounce and fires immediately (after gates pass).
 * The single-flight guard prevents overlapping requests per panel.
 *
 * Outcomes route through `applyAutoTitle()` — same dedupe, same delta
 * routing, same UI flash/toast — so this module's surface area is
 * narrow: schedule + dispose. No client-side wire change.
 *
 * Eligibility mirrors the inline hook:
 *   - pref `display.autoTitle` ON
 *   - turn count >= 2 when no custom title exists
 *   - recheck every RECHECK_EVERY_N_TURNS once titled
 *
 * Inputs sent to Haiku: the first user_text + the last two substantive
 * dialogue turns + the current title (for KEEP-vs-replace). System
 * prompt carries `cache_control: ephemeral` so repeated calls land in
 * the prompt cache.
 *
 * Failure modes:
 *   - Missing ANTHROPIC_API_KEY: titler permanently disabled at
 *     startup, logged once. Public methods become no-ops.
 *   - 401 at runtime: same — disable for process lifetime.
 *   - 429 / 5xx / network: per-panel cooldown of ~2 minutes; one retry
 *     on transient errors with a 1s delay.
 *
 * Cost metering for titler calls is intentionally deferred (separate
 * bucket from `hook_overhead_tokens`).
 */

import type { Event } from './parser.js';
import type { Panel } from './session.js';

const PLACEHOLDER_TURN_THRESHOLD = 2;
const RECHECK_EVERY_N_TURNS = 20;
const TITLE_MAX_WORDS = 14;
const ASSISTANT_TEXT_FLOOR = 40;
const DEBOUNCE_MS = 30_000;
const COOLDOWN_MS_ON_FAILURE = 2 * 60_000;
const NETWORK_RETRY_DELAY_MS = 1_000;

const ARTIFACT_RE = /^<(local-command-(caveat|stdout)|command-(name|message|args))>/;

const SYSTEM_PROMPT =
  'You are brainhouse session-titler. You produce a concise session title from the' +
  ' transcript fragments below, or the literal token KEEP if the existing title is' +
  ' still a good fit.\n\nRules:\n' +
  `- Maximum ${TITLE_MAX_WORDS} words.\n` +
  '- Sentence case. No quotes. No trailing punctuation.\n' +
  '- Describe the work, not the tool ("Wire auto-titling hook", not "Helping the user with auto-titling").\n' +
  '- Reply with ONLY the title text or KEEP. No preface, no explanation, no formatting.';

export type EvaluationReason = 'user_text' | 'assistant_text' | 'stop';

/** Minimal shape of the Anthropic SDK surface the titler uses. Lets tests
 * pass in a fake without pulling the real client. */
export interface TitlerAnthropicClient {
  messages: {
    create(params: TitlerCreateParams): Promise<TitlerCreateResponse>;
  };
}

export interface TitlerCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface TitlerCreateResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface TitlerOptions {
  /** Looks up the current panel for a given id; null if it's gone away. */
  getPanel: (panelId: string) => Panel | undefined;
  /** Returns true when `display.autoTitle` is enabled. Read fresh on each
   * evaluation so a runtime prefs flip takes effect on the next call. */
  isAutoTitleEnabled: () => boolean;
  /** Hand a proposal off to the session store's accept path. */
  applyAutoTitle: (panelId: string, proposed: string) => void;
  /** Test seam — when missing, the titler lazy-builds a real Anthropic
   * client from `ANTHROPIC_API_KEY`. */
  clientFactory?: (apiKey: string) => TitlerAnthropicClient;
  /** Test seam — defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string | null;
  /** Test seam — overrideable for deterministic timing. Returns ms since
   * epoch. */
  now?: () => number;
  /** Test seam — defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam — defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
  /** Optional logger; defaults to `console.warn`. Only used for the one-
   * time disabled / 401 notices. */
  logger?: (msg: string) => void;
}

interface PanelState {
  /** Pending debounce timer handle. Cleared on fire / dispose. */
  timer: unknown | null;
  /** Wall-clock ms until which the panel is in backoff (skip
   * evaluations). 0 when not in backoff. */
  cooldownUntil: number;
  /** True while a request is in-flight for this panel; second concurrent
   * evaluations are dropped (single-flight). */
  inflight: boolean;
}

/**
 * Owns per-panel debounce state and the Anthropic client.
 *
 * @internal — public surface is intentionally just `scheduleEvaluation`,
 * `dispose`, and the constructor. Callers should never reach into
 * `PanelState` directly.
 */
export class Titler {
  private readonly opts: TitlerOptions;
  private readonly states = new Map<string, PanelState>();
  private client: TitlerAnthropicClient | null = null;
  private clientInitialized = false;
  private permanentlyDisabled = false;
  private readonly apiKey: string | null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly logger: (msg: string) => void;

  constructor(opts: TitlerOptions) {
    this.opts = opts;
    this.apiKey =
      opts.apiKey !== undefined ? opts.apiKey : (process.env.ANTHROPIC_API_KEY ?? null);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? ((msg) => console.warn(msg));
    if (!this.apiKey) {
      this.permanentlyDisabled = true;
      this.logger('[titler] disabled: ANTHROPIC_API_KEY not set');
    }
  }

  /** Public entry point. Schedules an evaluation or fires immediately
   * for `stop` reasons. No-ops when permanently disabled. */
  scheduleEvaluation(panelId: string, reason: EvaluationReason): void {
    if (this.permanentlyDisabled) return;
    if (!this.opts.isAutoTitleEnabled()) return;
    const state = this.ensureState(panelId);
    if (state.cooldownUntil > this.now()) return;
    if (reason === 'stop') {
      // Strongest "turn complete" signal — bypass debounce.
      this.cancelTimer(state);
      void this.evaluate(panelId);
      return;
    }
    this.cancelTimer(state);
    state.timer = this.setTimer(() => {
      const s = this.states.get(panelId);
      if (s) s.timer = null;
      void this.evaluate(panelId);
    }, DEBOUNCE_MS);
  }

  /** Drop any pending timer for a reaped panel. Idempotent. */
  dispose(panelId: string): void {
    const state = this.states.get(panelId);
    if (!state) return;
    this.cancelTimer(state);
    this.states.delete(panelId);
  }

  /** Test seam: whether the titler will issue API calls. */
  get enabled(): boolean {
    return !this.permanentlyDisabled;
  }

  private ensureState(panelId: string): PanelState {
    let s = this.states.get(panelId);
    if (!s) {
      s = { timer: null, cooldownUntil: 0, inflight: false };
      this.states.set(panelId, s);
    }
    return s;
  }

  private cancelTimer(state: PanelState): void {
    if (state.timer !== null) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
  }

  /** Run one evaluation pass for a panel. Idempotent across concurrent
   * calls via the inflight flag (drops the second request). */
  private async evaluate(panelId: string): Promise<void> {
    if (this.permanentlyDisabled) return;
    const state = this.states.get(panelId);
    if (state && state.inflight) return;
    const panel = this.opts.getPanel(panelId);
    if (!panel) return;
    if (panel.binned_at !== null) return;
    if (!this.opts.isAutoTitleEnabled()) return;
    const turns = extractTurns(panel.events);
    if (!shouldFire(panel, turns.user.length)) return;
    const client = this.ensureClient();
    if (!client) return;

    if (state) state.inflight = true;
    try {
      const proposal = await this.requestProposal(client, panel, turns);
      if (!proposal) return;
      this.opts.applyAutoTitle(panelId, proposal);
    } catch (err) {
      this.handleError(panelId, err);
    } finally {
      const s = this.states.get(panelId);
      if (s) s.inflight = false;
    }
  }

  private ensureClient(): TitlerAnthropicClient | null {
    if (this.permanentlyDisabled) return null;
    if (this.clientInitialized) return this.client;
    this.clientInitialized = true;
    if (!this.apiKey) {
      this.permanentlyDisabled = true;
      return null;
    }
    if (this.opts.clientFactory) {
      try {
        this.client = this.opts.clientFactory(this.apiKey);
      } catch (err) {
        this.logger(
          `[titler] disabled: failed to construct Anthropic client (${(err as Error)?.message ?? err})`,
        );
        this.permanentlyDisabled = true;
        this.client = null;
      }
      return this.client;
    }
    // No factory + need real client. Lazy-import the SDK so test runs
    // without ANTHROPIC_API_KEY never pull it in. Returning null while
    // the dynamic import resolves means the *first* eligible call gets
    // skipped; the next one finds the client wired up. Acceptable
    // because auto-title fires on a 30s debounce cadence — a missed
    // first turn just defers the title to the next eligible event.
    if (!this.clientPromise) {
      const apiKey = this.apiKey;
      this.clientPromise = import('@anthropic-ai/sdk').then(
        (mod) => {
          const Ctor = mod.default as new (opts: { apiKey: string }) => TitlerAnthropicClient;
          this.client = new Ctor({ apiKey });
        },
        (err) => {
          this.logger(
            `[titler] disabled: failed to load @anthropic-ai/sdk (${(err as Error)?.message ?? err})`,
          );
          this.permanentlyDisabled = true;
          this.client = null;
        },
      );
    }
    return this.client;
  }

  private clientPromise: Promise<void> | null = null;

  private async requestProposal(
    client: TitlerAnthropicClient,
    panel: Panel,
    turns: ReturnType<typeof extractTurns>,
  ): Promise<string | null> {
    const messages = buildUserMessage(panel, turns);
    const params: TitlerCreateParams = {
      model: 'claude-haiku-4-5',
      max_tokens: 64,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: messages }],
    };
    let response: TitlerCreateResponse;
    try {
      response = await client.messages.create(params);
    } catch (err) {
      // One retry on network/timeout-flavored errors.
      if (isTransientNetworkError(err)) {
        await sleep(NETWORK_RETRY_DELAY_MS);
        response = await client.messages.create(params);
      } else {
        throw err;
      }
    }
    const text = extractResponseText(response);
    return sanitizeProposal(text);
  }

  private handleError(panelId: string, err: unknown): void {
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { statusCode?: number })?.statusCode;
    if (status === 401) {
      this.permanentlyDisabled = true;
      this.client = null;
      this.logger('[titler] disabled: 401 from Anthropic API');
      return;
    }
    if (status === 429 || (typeof status === 'number' && status >= 500)) {
      const s = this.states.get(panelId);
      if (s) s.cooldownUntil = this.now() + COOLDOWN_MS_ON_FAILURE;
      return;
    }
    // Unknown error: short cooldown so we don't tight-loop on a poison
    // panel.
    const s = this.states.get(panelId);
    if (s) s.cooldownUntil = this.now() + COOLDOWN_MS_ON_FAILURE;
  }
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') return true;
  const name = (err as { name?: string }).name;
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractResponseText(response: TitlerCreateResponse): string {
  if (!response || !Array.isArray(response.content)) return '';
  for (const block of response.content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

/** Clean up Haiku's output. Returns the title text, or null if the
 * model said KEEP / nothing usable. */
export function sanitizeProposal(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  // Strip surrounding quotes / backticks the model sometimes adds even
  // when told not to.
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Drop the first line only — if the model added prose after the
  // title we want the title itself, which is the first non-empty line.
  const firstLine = text.split('\n').find((l) => l.trim() !== '');
  if (!firstLine) return null;
  text = firstLine.trim();
  if (!text) return null;
  if (/^keep$/i.test(text)) return null;
  // Trailing punctuation cleanup.
  text = text.replace(/[.!?,;:]+$/, '').trim();
  if (!text) return null;
  // Word cap.
  const words = text.split(/\s+/);
  if (words.length > TITLE_MAX_WORDS) {
    text = words.slice(0, TITLE_MAX_WORDS).join(' ');
  }
  // Display truncation (matches applyAutoTitle's caller convention).
  if (text.length > 80) text = `${text.slice(0, 79)}…`;
  return text;
}

/** Eligibility check. Mirrors `auto-title-inline.mjs:shouldFire`. */
export function shouldFire(panel: Panel, turnCount: number): boolean {
  // Manually-renamed panels are left alone — once the user authors a
  // title, brainhouse never overwrites it.
  if (panel.manually_renamed) return false;
  // A panel whose title is still the placeholder gates on the
  // first-real-title threshold; once a custom title exists we recheck
  // periodically.
  const hasCustomTitle = panel.title && panel.title !== initialPlaceholder(panel.id);
  if (!hasCustomTitle) return turnCount >= PLACEHOLDER_TURN_THRESHOLD;
  return turnCount > 0 && turnCount % RECHECK_EVERY_N_TURNS === 0;
}

/** Mirrors `session.ts:initialTitle`'s short-id form. Duplicated here to
 * avoid a circular import — the Titler is owned by SessionStore. */
function initialPlaceholder(panelId: string): string {
  return panelId.slice(0, 8);
}

interface Turns {
  user: string[];
  assistant: string[];
}

/** Pull substantive dialogue turns from a panel's event list. Mirrors
 * the inline hook's transcript parser, minus the JSONL re-read. */
export function extractTurns(events: Event[]): Turns {
  const user: string[] = [];
  const assistant: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'user_text') {
      const text = ((ev.payload as { text?: string }).text ?? '').trim();
      if (!text) continue;
      if (ARTIFACT_RE.test(text)) continue;
      user.push(text);
    } else if (ev.kind === 'assistant_text') {
      const text = ((ev.payload as { text?: string }).text ?? '').trim();
      if (!text) continue;
      assistant.push(text);
    }
  }
  return { user, assistant };
}

/** Build the compact context envelope the model sees. */
export function buildUserMessage(panel: Panel, turns: Turns): string {
  const lines: string[] = [];
  const hasCustomTitle = panel.title && panel.title !== initialPlaceholder(panel.id);
  lines.push(
    hasCustomTitle
      ? `Current title: ${panel.title}\nDecide whether it still fits; reply KEEP if so, otherwise propose a new title.`
      : 'This session has no real title yet. Propose one.',
  );
  if (turns.user.length > 0) {
    lines.push('', 'First user message:', clip(turns.user[0] ?? '', 800));
  }
  // Last 2 substantive turns (interleaved). Walk back through the
  // combined dialogue, preserving order.
  const recent: string[] = [];
  const u = turns.user.slice(1);
  const a = turns.assistant.slice();
  while (recent.length < 4 && (u.length || a.length)) {
    if (a.length) recent.push(`Assistant: ${clip(a.pop() ?? '', 400)}`);
    if (u.length) recent.push(`User: ${clip(u.pop() ?? '', 400)}`);
  }
  if (recent.length > 0) {
    lines.push('', 'Recent direction (most recent first):', ...recent);
  }
  return lines.join('\n');
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Floor on `assistant_text` length before treating it as a substantive
 * trigger. Re-exported for tests + the session.ts call site. */
export function isSubstantiveAssistantText(text: string | undefined): boolean {
  if (!text) return false;
  return text.trim().length >= ASSISTANT_TEXT_FLOOR;
}

/** True when the text is a real user prompt (not a slash-command
 * artifact). Re-exported for the session.ts call site. */
export function isRealUserText(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return !ARTIFACT_RE.test(t);
}
