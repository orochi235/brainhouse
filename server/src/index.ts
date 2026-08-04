import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { TranscriptMonitor } from './monitor.js';
import { checkOnboarding, ONBOARDING_WARNING_LINES } from './onboarding.js';
import { PrefsStore } from './prefs.js';
import { ProcessTracker } from './processes/index.js';
import { runStartupDiscovery } from './processes/discovery.js';
import { resolveRoots } from './roots.js';
import { Store } from './store.js';
import { appRouter } from './trpc.js';

// Dual-stack loopback: bind to the IPv6 wildcard, which on macOS/Linux
// without `bindv6only` (the default on macOS, the usual default on Linux)
// also accepts IPv4 connections as v4-mapped addresses. This avoids the
// classic "macOS resolves `localhost` to ::1 first → IPv4-only listener
// is unreachable" gotcha for any consumer hitting `localhost`. Override
// to '127.0.0.1' (or any other interface) via HOST env when needed.
const HOST = process.env.HOST ?? '::';
const PORT = Number(process.env.PORT ?? 8765);

async function main() {
  const prefs = new PrefsStore();
  await prefs.load();
  const roots = resolveRoots(prefs.get());

  const { timings, roots: configuredRoots, storage, workspace, discovery } = prefs.get();
  const store = storage.persistEnabled ? Store.open() : null;
  const tracker = new ProcessTracker();
  const monitor = new TranscriptMonitor({
    roots,
    accounts: configuredRoots,
    idleSeconds: timings.idleSeconds,
    miniSeconds: timings.miniSeconds,
    removeAfterSeconds: timings.removeAfterSeconds,
    liveProcessGraceSeconds: timings.liveProcessGraceSeconds,
    tickIntervalMs: timings.tickIntervalMs,
    store,
    eventsIndexRetentionDays: storage.eventsIndexRetentionDays,
    autoMinimizeOnClear: workspace.autoMinimizeOnClear,
    tracker,
    isAutoTitleEnabled: () => prefs.get().display.autoTitle,
    discovery,
  });
  // Hydrate persisted panels synchronously, but DON'T start the slow
  // transcript walk / process discovery yet — those run after the HTTP
  // port is bound (below) so the dev client never races a dead socket.
  // The tRPC snapshot/deltas bootstrap already serves these hydrated
  // panels the moment a client connects.
  monitor.hydrate();

  // pino-pretty's default ANSI emission (color resets, attribute clears)
  // visibly wipes terminal background tints in some terminals — opt out
  // of all in-line colors. Timestamps + level prefixes stay readable.
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: false },
      },
    },
  });

  // Cross-origin isolation so the client's measureUserAgentSpecificMemory()
  // telemetry works (it gates on crossOriginIsolated). COEP: credentialless
  // keeps cross-origin subresources loading (without credentials) rather than
  // blocking them. Remove this hook to restore normal cross-origin loading.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'credentialless');
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ monitor, prefs, store, tracker }),
    },
  });

  app.get('/health', async () => ({ ok: true }));

  // Plain-JSON counts for the macOS menu bar helper (menubar/main.swift):
  // it polls this every few seconds and shows `awaiting_input` as the
  // badge count. Outside the tRPC tree so the Swift URLSession client
  // stays a one-line JSON fetch.
  app.get('/api/summary', async () => monitor.store.menubarSummary());

  // Plain-JSON read of processes attributed to a Claude session. Lives
  // outside the tRPC tree so brainhouse hook scripts can hit it with a
  // single `fetch()` without speaking the tRPC protocol. Used by the
  // UserPromptSubmit `session-procs-reminder` hook to inject a one-line
  // summary of live background work for the active session.
  app.get<{ Params: { sessionId: string } }>(
    '/procs/by-session/:sessionId',
    async (req) => {
      const sid = req.params.sessionId;
      const rows = tracker.snapshot().filter((r) => r.session_id === sid);
      return { session_id: sid, rows };
    },
  );

  // Debug: run the lsof sweep primitive inline and report what it sees from
  // inside the service environment (env/PATH/exit-code differences vs. a
  // shell are exactly what this exists to catch).
  app.get('/procs/sweep-probe', async () => {
    const { listListeningPorts } = await import('./processes/native.js');
    const rows = await listListeningPorts();
    return rows === null
      ? { result: 'null (lsof failed)' }
      : { result: `${rows.length} pid rows`, sample: rows.slice(0, 5) };
  });

  // Debug: force one port sweep synchronously and report the before/after
  // port-carrying row count — separates "sweep logic broken" from "sweep
  // never fires".
  app.get('/procs/sweep-now', async () => {
    const before = tracker.snapshot().filter((r) => r.ports.length > 0).length;
    await tracker.maybeSweepPorts();
    const after = tracker.snapshot().filter((r) => r.ports.length > 0).length;
    return { before, after };
  });

  // Debug read of the port sweep: every tracked row that carries ports,
  // plus counts to tell "sweep never ran" apart from "nothing qualifies".
  app.get('/procs/ports', async () => {
    const all = tracker.snapshot();
    const t = tracker as unknown as { subscribers: number; sweeping: boolean };
    return {
      subscribers: t.subscribers,
      sweeping: t.sweeping,
      total: all.length,
      with_ports: all.filter((r) => r.ports.length > 0).length,
      rows: all
        .filter((r) => r.ports.length > 0)
        .map((r) => ({ pid: r.pid, provenance: r.provenance, ports: r.ports, command: r.command.slice(0, 60) })),
    };
  });

  // Serve the built client when present (production / `npm start`). In dev
  // the Vite server runs on its own port and proxies /trpc back here, so
  // this block is a no-op until `npm run build` has produced dist/public.
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method !== 'GET' ||
        req.url.startsWith('/trpc') ||
        req.url.startsWith('/health') ||
        req.url.startsWith('/procs')
      ) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await monitor.stop();
    tracker.stop();
    store?.close();
  });

  await app.listen({ host: HOST, port: PORT });
  // `[::]` in URLs is ugly and not browser-friendly; show the friendly
  // form when we're on the dual-stack default and let HOST overrides
  // print literally.
  const displayHost = HOST === '::' ? 'localhost' : HOST;
  app.log.info(`brainhouse listening at http://${displayHost}:${PORT}`);
  for (const r of roots) app.log.info(`  watch: ${r}`);

  // Heavy bootstrap, now that the port is live: walk the transcript roots
  // and discover the process table. Both stream into already-connected
  // clients via the deltas / processes subscriptions — no refresh needed.
  // Identify the brainhouse server's own pid in the processes table BEFORE the
  // first process tick (which now runs inside startWatching, ahead of the
  // transcript walk). The framework + version stamp the self row so the
  // Network view surfaces it as `brainhouse vX.Y.Z` and the UI applies the
  // purple diamond status glyph. No synthetic account_label — brainhouse isn't
  // a Claude account, and the chip would mislead.
  tracker.registerSelf(null, 'brainhouse', readBrainhouseVersion());
  // Walk transcripts + prime process discovery. startWatching replays hook
  // events and runs the first process tick before the slow walk so quiet-but-
  // alive sessions surface as live (see its body for ordering rationale).
  await monitor.startWatching();
  tracker.start();
  await runStartupDiscovery(tracker);

  // One-shot onboarding nudge: if the user clearly uses subagents but
  // hasn't installed the hook dispatcher, completion will be guessed via
  // idle-timeout. Surface the gap loudly-but-briefly.
  try {
    const check = checkOnboarding(roots);
    if (check.shouldWarn) {
      for (const line of ONBOARDING_WARNING_LINES) app.log.warn(line);
    }
  } catch {
    // never let the nudge break startup
  }
}

/** Read the brainhouse server package version off disk. Used to stamp
 * the server's own ProcessRow so the Network view's Framework column
 * shows `brainhouse vX.Y.Z`. Falls back to null when the package.json
 * isn't where we expect (e.g. compiled output running outside the
 * source tree) — the row still gets stamped as 'brainhouse', just
 * without the version. */
function readBrainhouseVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/index.ts → ../package.json in source; dist/index.js → ../package.json in build.
    const pkgPath = path.join(here, '..', 'package.json');
    if (!existsSync(pkgPath)) return null;
    const v = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
