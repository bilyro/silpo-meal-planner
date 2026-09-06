import { InlineKeyboard, type Bot } from 'grammy';
import * as repo from '../db/repo.js';
import { logger } from '../logger.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';

export function registerCommands(bot: Bot) {
  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    const tokens = await repo.getTokens(user.id);
    if (tokens) {
      await ctx.reply('Ви вже підʼєднані до Сільпо. Напишіть, що спланувати, або /plan.');
      return;
    }

    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();
      // Tokens existed but getTokens() missed them (shouldn't happen) — treat as linked.
      await ctx.reply('Ви вже підʼєднані до Сільпо. Напишіть, що спланувати, або /plan.');
    } catch (err) {
      if (!(err instanceof NeedsAuthError)) {
        logger.error({ err, userId: user.id }, 'Failed to start Silpo authorization');
        await ctx.reply('Не вдалося розпочати підʼєднання. Спробуйте ще раз пізніше.');
        return;
      }
      const keyboard = new InlineKeyboard().url('🔐 Підʼєднати Сільпо', err.authorizationUrl.toString());
      await ctx.reply(
        'Привіт! Я «Сільпо Шеф» — агент для планування меню та збирання кошика в Сільпо.\n\n' +
          'Щоб почати, підʼєднайте свій акаунт Сільпо:',
        { reply_markup: keyboard },
      );
    } finally {
      await mcp.close();
    }
  });

  bot.command('plan', async (ctx) => {
    await ctx.reply('Опишіть, що спланувати, напр.: «Сплануй вечері на 3 дні, без свинини, до 1200 грн».');
  });

  bot.command('cart', async (ctx) => {
    await ctx.reply('Перегляд кошика буде доступний у Фазі 4.');
  });

  bot.command('clear', async (ctx) => {
    await ctx.reply('Очищення кошика буде доступне у Фазі 4.');
  });

  bot.command('logout', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    await repo.deleteTokens(user.id);
    await ctx.reply('Відʼєднано. Напишіть /start, щоб підʼєднати акаунт знову.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Команди:\n/start — підʼєднати акаунт\n/plan — спланувати меню\n/cart — переглянути кошик\n/clear — очистити кошик\n/logout — відʼєднати акаунт',
    );
  });
}
