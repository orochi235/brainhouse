import os from 'node:os';
import path from 'node:path';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { TranscriptMonitor } from './monitor.js';
import { appRouter } from './trpc.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8765);

function defaultRoots(): string[] {
  const home = os.homedir();
  return [path.join(home, '.claude', 'projects'), path.join(home, '.claude-pw', 'projects')];
}

async function main() {
  const roots = process.env.BRAINHOUSE_ROOTS?.split(':') ?? defaultRoots();
  const monitor = new TranscriptMonitor({ roots });
  await monitor.start();

  const app = Fastify({ logger: { transport: { target: 'pino-pretty' } } });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ monitor }),
    },
  });

  app.get('/health', async () => ({ ok: true }));

  app.addHook('onClose', async () => {
    await monitor.stop();
  });

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`brainhouse listening at http://${HOST}:${PORT}`);
  for (const r of roots) app.log.info(`  watch: ${r}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
