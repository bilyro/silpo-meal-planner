import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { logger } from '../logger.js';
import * as repo from '../db/repo.js';
import { completeAuthorization } from '../mcp/SilpoMcpClient.js';
import { sendWelcomeMessage } from '../bot/welcome.js';

interface AuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

export function buildServer(bot: Bot) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get<{ Querystring: AuthCallbackQuery }>('/auth/callback', async (req, reply) => {
    const { code, state, error } = req.query;

    if (error) {
      return reply.type('text/html').send(`<h1>Помилка авторизації Сільпо: ${error}</h1>`);
    }
    if (!code) {
      return reply.code(400).type('text/html').send('<h1>Відсутній code.</h1>');
    }

    // Silpo does not reliably echo `state` back (verified empirically) — use it when present,
    // otherwise fall back to the most recent pending link attempt (see SilpoAuthProvider doc).
    const pending = state ? await repo.getPendingAuth(state) : await repo.getMostRecentPendingAuth();
    if (!pending) {
      return reply
        .code(400)
        .type('text/html')
        .send('<h1>Посилання застаріле або вже використане. Напишіть /start у Telegram ще раз.</h1>');
    }

    try {
      await completeAuthorization(pending.userId, code, pending.codeVerifier);
    } catch (err) {
      logger.error({ err, userId: pending.userId }, 'OAuth code exchange failed');
      return reply.code(500).type('text/html').send('<h1>Не вдалося завершити підʼєднання до Сільпо.</h1>');
    }
    await repo.deletePendingAuth(pending.state);

    const user = await repo.getUserById(pending.userId);
    if (user) {
      void sendWelcomeMessage(bot, user.telegramChatId, user.id).catch((err) =>
        logger.error({ err, userId: user.id }, 'Failed to send post-link welcome message'),
      );
    }

    return reply.type('text/html').send('<h1>Готово! Повертайтесь у Telegram.</h1>');
  });

  return app;
}
