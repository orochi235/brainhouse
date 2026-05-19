import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { appRouter } from './trpc.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8765);

async function main() {
  const app = Fastify({ logger: { transport: { target: 'pino-pretty' } } });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter },
  });

  app.get('/health', async () => ({ ok: true }));

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`brainhouse server listening at http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
