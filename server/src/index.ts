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

  const { timings, roots: configuredRoots, storage, workspace } = prefs.get();
  const store = storage.persistEnabled ? Store.open() : null;
  const tracker = new ProcessTracker();
  const monitor = new TranscriptMonitor({
    roots,
    accounts: configuredRoots,
    idleSeconds: timings.idleSeconds,
    miniSeconds: timings.miniSeconds,
    removeAfterSeconds: timings.removeAfterSeconds,
    tickIntervalMs: timings.tickIntervalMs,
    store,
    eventsIndexRetentionDays: storage.eventsIndexRetentionDays,
    autoMinimizeOnClear: workspace.autoMinimizeOnClear,
    tracker,
  });
  await monitor.start();
  tracker.start();
  // Synthetic "brainhouse" badge for the server's own pid + descendants.
  // Not a real Claude account — just so the dev-mode self-processes
  // (this server + vite + any tsx watch) read as something rather than
  // anonymous in the Processes panel. The framework + version are
  // stamped only on the server's own pid so the Network view's
  // Framework column identifies it as `brainhouse vX.Y.Z`.
  tracker.registerSelf('brainhouse', 'brainhouse', readBrainhouseVersion());
  await runStartupDiscovery(tracker);

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

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ monitor, prefs, store, tracker }),
    },
  });

  app.get('/health', async () => ({ ok: true }));

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
