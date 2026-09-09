import Fastify from 'fastify';
import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import * as repo from '../db/repo.js';
import { completeAuthorization } from '../mcp/SilpoMcpClient.js';
import { escapeHtml } from '../bot/format.js';

interface AuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

export function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  // Liveness: "the process is up". Deliberately touches nothing else — this is what the platform
  // health check watches, and making it depend on Postgres would turn a brief database blip into a
  // restart loop that also takes down /auth/callback.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: "the process can actually serve". Separate endpoint precisely so a failing database
  // is visible (to us, and in the demo) without being fatal.
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      logger.error({ err }, 'Readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  app.get<{ Querystring: AuthCallbackQuery }>('/auth/callback', async (req, reply) => {
    const { code, state, error } = req.query;

    if (error) {
      // Escaped: `error` is an unauthenticated query parameter reflected straight into the page,
      // so interpolating it raw is a reflected XSS on an origin that also serves the OAuth
      // callback. Anyone can hand a user a crafted /auth/callback?error=… link.
      return reply.type('text/html').send(`<h1>Помилка авторизації Сільпо: ${escapeHtml(error)}</h1>`);
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

    // Deliberately not final yet: whoever ran /start in Telegram could have forwarded this exact
    // authorize link to someone else, who is the one actually looking at this page right now (see
    // the `confirmed` column doc in schema.ts). Nothing in the app will treat this account as
    // linked — getTokens() filters on confirmed=true — until this code is typed back into the
    // Telegram chat that started the flow, which the person looking at this page cannot do unless
    // they have access to that chat.
    const confirmCode = String(randomInt(100000, 1000000));
    await repo.markUnconfirmed(pending.userId, confirmCode);

    return reply.type('text/html').send(
      `<h1>Майже готово!</h1><p>Повертайтесь у Telegram-чат, де ви написали /start, і надішліть боту цей код, щоб підтвердити підключення:</p><p style="font-size:2em;font-weight:bold;letter-spacing:0.1em">${escapeHtml(confirmCode)}</p><p>Якщо ви не запускали підключення в Telegram самостійно — не надсилайте цей код нікому.</p>`,
    );
  });

  return app;
}
