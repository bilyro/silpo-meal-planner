import { InlineKeyboard, type Bot } from 'grammy';
import * as repo from '../db/repo.js';
import { logger } from '../logger.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { loadSession } from '../agent/session.js';
import { clearCartKeyboard } from './keyboards.js';

interface GetShoppingCartByIdResult {
  success: boolean;
  cart: Record<string, unknown>;
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
}

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
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    const state = await loadSession(user.id);

    if (!state.cartContext) {
      await ctx.reply('У вас ще немає кошика. Попросіть мене спланувати меню, і я його створю.');
      return;
    }

    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();
      const cart = await mcp.callTool<GetShoppingCartByIdResult>('silpo_get_shopping_cart_by_id', {
        shoppingCartId: state.cartContext.cartId,
      });
      const lines = [
        `🧾 Кошик: філія ${state.cartContext.branchId}, доставка ${state.cartContext.deliveryType}.`,
      ];
      if (state.cartContext.timeslot) {
        lines.push(`Слот: ${state.cartContext.timeslot.start} — ${state.cartContext.timeslot.end}.`);
      }
      const checkoutLink = cart.checkoutWebLink ?? cart.checkoutMobileLink;
      if (checkoutLink) lines.push(`Оформлення: ${checkoutLink}`);
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply('Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.');
        return;
      }
      logger.error({ err, userId: user.id }, 'Failed to fetch cart');
      await ctx.reply('Не вдалося отримати кошик. Спробуйте ще раз пізніше.');
    } finally {
      await mcp.close();
    }
  });

  bot.command('clear', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    const state = await loadSession(user.id);

    if (!state.cartContext) {
      await ctx.reply('Кошика ще немає — нічого очищати.');
      return;
    }

    await ctx.reply('Очистити кошик? Цю дію не можна скасувати.', { reply_markup: clearCartKeyboard });
  });

  bot.command('logout', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    await repo.deleteTokens(user.id);
    // Drop the conversation too: whoever links this chat next must not inherit the previous
    // account's history, which can name their family, restrictions and addresses.
    await repo.deleteMessages(user.id);
    await ctx.reply('Відʼєднано. Напишіть /start, щоб підʼєднати акаунт знову.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Команди:\n/start — підʼєднати акаунт\n/plan — спланувати меню\n/cart — переглянути кошик\n/clear — очистити кошик\n/logout — відʼєднати акаунт',
    );
  });
}
