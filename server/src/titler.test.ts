/**
 * Unit tests for the out-of-band auto-titler. The Anthropic client is
 * stubbed; eligibility + debounce + single-flight + failure-mode logic
 * is driven by deterministic fake timers and a manual `now()` clock.
 */
import { describe, expect, it } from 'vitest';
import type { Event } from './parser.js';
import type { Panel } from './session.js';
import {
  extractTurns,
  sanitizeProposal,
  shouldFire,
  Titler,
  type TitlerAnthropicClient,
  type TitlerCreateParams,
  type TitlerCreateResponse,
} from './titler.js';

function ev(kind: Event['kind'], text: string, uuid = `u-${Math.random()}`): Event {
  return {
    session_id: 'S',
    agent_id: null,
    uuid,
    parent_uuid: null,
    ts: 't',
    cwd: null,
    kind,
    tags:
      kind === 'user_text' || kind === 'assistant_text'
        ? ['dialogue']
        : kind === 'meta'
          ? ['meta']
          : ['system'],
    payload: { text },
  } as Event;
}

function makePanel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'panel-abc12345',
    kind: 'parent',
    parent_panel_id: null,
    title: 'panel-ab', // placeholder = id.slice(0,8)
    agent_type: null,
    task_description: null,
    account_label: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    ended_provenance: null,
    manually_renamed: false,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
    hook_overhead_tokens: 0,
    clear_title_suppression: null,
    status: 'live',
    started_at: 0,
    last_event_at: 0,
    status_changed_at: 0,
    cwd: null,
    repo_root: null,
    theme: null,
    events: [],
    ...overrides,
  };
}

class FakeTimers {
  private nextId = 1;
  private readonly pending = new Map<number, { fire: number; fn: () => void }>();
  t = 1_000_000;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.pending.set(id, { fire: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown) => {
    this.pending.delete(h as number);
  };
  /** Advance the clock by `dt` ms, firing every timer whose fire time
   * crosses the new now. */
  advance(dt: number) {
    this.t += dt;
    let drained = false;
    while (!drained) {
      drained = true;
      for (const [id, entry] of [...this.pending]) {
        if (entry.fire <= this.t) {
          this.pending.delete(id);
          entry.fn();
          drained = false;
        }
      }
    }
  }
  pendingCount() {
    return this.pending.size;
  }
}

interface FakeClient extends TitlerAnthropicClient {
  calls: TitlerCreateParams[];
  /** Resolve / reject deferreds in arrival order. */
  next(): { resolve: (text: string) => void; reject: (err: unknown) => void };
}

function makeFakeClient(): FakeClient {
  const calls: TitlerCreateParams[] = [];
  const pending: Array<{
    resolve: (r: TitlerCreateResponse) => void;
    reject: (err: unknown) => void;
  }> = [];
  const waiters: Array<(d: (typeof pending)[number]) => void> = [];
  const client: FakeClient = {
    calls,
    messages: {
      create(params) {
        calls.push(params);
        return new Promise<TitlerCreateResponse>((resolve, reject) => {
          const slot = { resolve, reject };
          pending.push(slot);
          const w = waiters.shift();
          if (w) w(slot);
        });
      },
    },
    next() {
      const slot = pending.shift();
      if (!slot) throw new Error('no pending call');
      return {
        resolve: (text: string) =>
          slot.resolve({ content: [{ type: 'text', text }] }),
        reject: (err) => slot.reject(err),
      };
    },
  };
  return client;
}

const APPLIED: Array<{ panelId: string; title: string }> = [];

function freshApplied() {
  APPLIED.length = 0;
}

function build(opts: {
  panels: Map<string, Panel>;
  client?: TitlerAnthropicClient;
  enabled?: boolean;
  apiKey?: string | null;
  timers: FakeTimers;
}) {
  freshApplied();
  return new Titler({
    getPanel: (id) => opts.panels.get(id),
    isAutoTitleEnabled: () => opts.enabled ?? true,
    applyAutoTitle: (id, title) => {
      APPLIED.push({ panelId: id, title });
    },
    clientFactory: opts.client ? () => opts.client! : undefined,
    apiKey: opts.apiKey === undefined ? 'sk-test' : opts.apiKey,
    now: opts.timers.now,
    setTimer: opts.timers.setTimer,
    clearTimer: opts.timers.clearTimer,
    logger: () => {},
  });
}

describe('sanitizeProposal', () => {
  it('strips quotes and trailing punctuation', () => {
    expect(sanitizeProposal('"Wire auto-titling hook."')).toBe('Wire auto-titling hook');
  });
  it('returns null for KEEP', () => {
    expect(sanitizeProposal('KEEP')).toBeNull();
    expect(sanitizeProposal('keep')).toBeNull();
  });
  it('caps to 14 words', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
    const result = sanitizeProposal(long);
    expect(result?.split(' ').length).toBe(14);
  });
  it('drops empty / whitespace input', () => {
    expect(sanitizeProposal('')).toBeNull();
    expect(sanitizeProposal('   \n\n')).toBeNull();
  });
});

describe('shouldFire', () => {
  it('requires 2 turns for first title on placeholder panel', () => {
    const p = makePanel();
    expect(shouldFire(p, 1)).toBe(false);
    expect(shouldFire(p, 2)).toBe(true);
  });
  it('rechecks every N turns once titled', () => {
    const p = makePanel({ title: 'A nice title' });
    expect(shouldFire(p, 1)).toBe(false);
    expect(shouldFire(p, 19)).toBe(false);
    expect(shouldFire(p, 20)).toBe(true);
    expect(shouldFire(p, 40)).toBe(true);
  });
  it('never fires on manually-renamed panels', () => {
    const p = makePanel({ title: 'User name', manually_renamed: true });
    expect(shouldFire(p, 20)).toBe(false);
  });
});

describe('extractTurns', () => {
  it('skips slash-command artifacts in user_text', () => {
    const events = [
      ev('user_text', '<command-name>clear</command-name>'),
      ev('user_text', 'real prompt'),
      ev('assistant_text', 'a reply'),
    ];
    const t = extractTurns(events);
    expect(t.user).toEqual(['real prompt']);
    expect(t.assistant).toEqual(['a reply']);
  });
});

describe('Titler', () => {
  it('is disabled when ANTHROPIC_API_KEY is missing', () => {
    const timers = new FakeTimers();
    const panels = new Map<string, Panel>();
    const titler = build({ panels, timers, apiKey: null });
    expect(titler.enabled).toBe(false);
    titler.scheduleEvaluation('any', 'stop');
    expect(APPLIED.length).toBe(0);
  });

  it('debounces user_text bursts into one request', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({
      events: [
        ev('user_text', 'first message'),
        ev('user_text', 'second message'),
      ],
    });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'user_text');
    titler.scheduleEvaluation(panel.id, 'user_text');
    titler.scheduleEvaluation(panel.id, 'user_text');
    // Nothing fired before the debounce window.
    timers.advance(29_000);
    expect(client.calls.length).toBe(0);
    timers.advance(2_000);
    expect(client.calls.length).toBe(1);
    client.next().resolve('Wire titler');
    await flush();
    expect(APPLIED).toEqual([{ panelId: panel.id, title: 'Wire titler' }]);
  });

  it('stop reason bypasses debounce', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({
      events: [
        ev('user_text', 'first'),
        ev('user_text', 'second'),
      ],
    });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    // No timer advance: request goes out synchronously.
    await flush();
    expect(client.calls.length).toBe(1);
    client.next().resolve('Sync stop title');
    await flush();
    expect(APPLIED[0]?.title).toBe('Sync stop title');
  });

  it('respects the autoTitle pref toggle', () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'a'), ev('user_text', 'b')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers, enabled: false });
    titler.scheduleEvaluation(panel.id, 'stop');
    expect(client.calls.length).toBe(0);
  });

  it('drops second concurrent eligible call (single-flight)', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'a'), ev('user_text', 'b')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    // First in flight, not resolved yet.
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    expect(client.calls.length).toBe(1);
    client.next().resolve('First');
    await flush();
    expect(APPLIED.length).toBe(1);
  });

  it('skips gate when only one user turn exists', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'only one')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    expect(client.calls.length).toBe(0);
  });

  it('401 disables the titler permanently', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'a'), ev('user_text', 'b')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    client.next().reject(Object.assign(new Error('unauthorized'), { status: 401 }));
    await flush();
    expect(titler.enabled).toBe(false);
    // Subsequent call no-ops.
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    expect(client.calls.length).toBe(1);
  });

  it('429 places the panel in cooldown', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'a'), ev('user_text', 'b')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    client.next().reject(Object.assign(new Error('rate limited'), { status: 429 }));
    await flush();
    // Next attempt within the cooldown window is dropped silently.
    timers.advance(60_000);
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    expect(client.calls.length).toBe(1);
    // After the cooldown window passes, calls flow again.
    timers.advance(2 * 60_000);
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    expect(client.calls.length).toBe(2);
  });

  it('dispose clears pending timers', () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const panel = makePanel({ events: [ev('user_text', 'a'), ev('user_text', 'b')] });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'user_text');
    expect(timers.pendingCount()).toBe(1);
    titler.dispose(panel.id);
    expect(timers.pendingCount()).toBe(0);
  });

  it('drops malformed KEEP echo without firing applyAutoTitle', async () => {
    const timers = new FakeTimers();
    const client = makeFakeClient();
    const events: Event[] = [];
    for (let i = 0; i < 20; i++) events.push(ev('user_text', `msg ${i}`));
    const panel = makePanel({ title: 'Wire titler', events });
    const panels = new Map([[panel.id, panel]]);
    const titler = build({ panels, client, timers });
    titler.scheduleEvaluation(panel.id, 'stop');
    await flush();
    client.next().resolve('KEEP');
    await flush();
    expect(APPLIED.length).toBe(0);
  });
});

/** Flush the Node microtask queue a few times so chained awaits settle.
 * Vitest's fake timers aren't engaged here (we drive a manual clock), so
 * `await` ladders need explicit yields to resolve. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}
