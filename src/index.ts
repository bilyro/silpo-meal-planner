import { config } from './config.js';
import { logger } from './logger.js';
import { buildServer } from './web/server.js';
import { createBot } from './bot/bot.js';

async function main() {
  const server = buildServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Web server listening');

  const bot = createBot();
  bot
    .start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'Bot started (long polling)'),
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Bot failed to start (check TELEGRAM_BOT_TOKEN); web server stays up');
    });

  const shutdown = async () => {
    logger.info('Shutting down...');
    await bot.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error on startup');
  process.exit(1);
});
