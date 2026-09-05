import Fastify from 'fastify';
import { logger } from '../logger.js';

export function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Phase 2 will implement OAuth linking here.
  app.get('/auth/start', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  app.get('/auth/callback', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  return app;
}
