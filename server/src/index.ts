import { existsSync } from 'node:fs';
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

const HOST = process.env.HOST ?? '127.0.0.1';
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

  // Serve the built client when present (production / `npm start`). In dev
  // the Vite server runs on its own port and proxies /trpc back here, so
  // this block is a no-op until `npm run build` has produced dist/public.
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/trpc') || req.url.startsWith('/health')) {
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
  app.log.info(`brainhouse listening at http://${HOST}:${PORT}`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
