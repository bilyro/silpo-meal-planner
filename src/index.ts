import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './web/server.js';
import { createBot } from './bot/bot.js';

/** Grace period for a clean shutdown before the process is killed regardless (spec §8 Phase 7). */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  // Before anything binds a port: a container that starts serving against an un-migrated database
  // fails later, per request, in ways that look like application bugs. Failing here is louder and
  // leaves the previous deploy running on platforms that health-check before switching over.
  await runMigrations();

  const bot = createBot();

  const server = buildServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Web server listening');

  bot
    .start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'Bot started (long polling)'),
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Bot failed to start (check TELEGRAM_BOT_TOKEN); web server stays up');
    });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A platform that sees no exit sends a second signal; re-entering would race two bot.stop()s.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down...');

    // bot.stop() waits for the in-flight long poll and any running handler, which can be an entire
    // agent turn. Bounded, or a redeploy stalls until the platform SIGKILLs us mid-write.
    const timer = setTimeout(() => {
      logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out; exiting anyway');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    // Each step is guarded separately, not wrapped in one try: a single shared catch means the
    // first failure skips everything after it. Observed for real — bot.stop() calls getUpdates one
    // last time, so a 401 or a network blip during a redeploy would throw and silently leave the
    // port bound and the pg pool undrained, with only the kill timer to clean up.
    for (const [what, close] of [
      ['telegram bot', () => bot.stop()],
      ['web server', () => server.close()],
      ['database pool', () => pool.end()],
    ] as const) {
      try {
        await close();
      } catch (err) {
        logger.error({ err, what }, 'Error during shutdown; continuing with the remaining steps');
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error on startup');
  process.exit(1);
});
