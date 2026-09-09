import { InlineKeyboard, type Bot } from 'grammy';
import * as repo from '../db/repo.js';
import { logger } from '../logger.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { loadSession } from '../agent/session.js';
import { formatPlanSummary, parsePlanRow } from '../agent/plans.js';
import { kindLabel } from '../agent/memory.js';
import { clearCartKeyboard, repeatPlanKeyboard } from './keyboards.js';
import { escapeHtml } from './format.js';
import { relinkReply } from './messages.js';

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
      if (!err.authorizationUrl) {
        // Only reachable if the SDK reported a 401 without minting an authorize URL; there is no
        // button to offer, and repeating "напишіть /start" to someone who just did would be absurd.
        logger.error({ userId: user.id }, 'Silpo returned 401 without an authorization URL');
        await ctx.reply('Сільпо зараз не приймає підʼєднання. Спробуйте ще раз за кілька хвилин.');
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
        await ctx.reply(...relinkReply(err));
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

  bot.command('plans', async (ctx) => {
    const user = await repo.getOrCreateUser(String(ctx.chat.id));
    const saved = (await repo.listRecentPlans(user.id, 5))
      .map(parsePlanRow)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    if (saved.length === 0) {
      await ctx.reply('У вас ще немає збережених планів. Складіть меню і зберіть кошик — тоді я його запамʼятаю.');
      return;
    }

    await ctx.reply(saved.map(formatPlanSummary).join('\n\n'), {
      parse_mode: 'HTML',
      reply_markup: repeatPlanKeyboard,
    });
  });

  /**
   * Shows everything the bot remembers. A memory the user cannot inspect is one they cannot
   * correct, and a wrong allergy silently shapes every future menu — so this is not a nicety.
   */
  /** Ingredient names only, defensively read — repo.ts moves opaque JSON, this owns the shape. */
  function ingredientNames(ingredientsJson: unknown): string {
    if (!Array.isArray(ingredientsJson)) return '';
    return ingredientsJson
      .map((i) => (typeof i === 'object' && i !== null && 'name' in i ? String((i as { name: unknown }).name) : null))
      .filter((n): n is string => n !== null)
      .join(', ');
  }

  bot.command('recipes', async (ctx) => {
    const user = await repo.getOrCreateUser(String(ctx.chat.id));
    const saved = await repo.listRecipes(user.id, 15);

    if (saved.length === 0) {
      await ctx.reply(
        'Я поки не запам\'ятав жодної страви. Складіть меню і підтвердіть кошик — і наступного ' +
          'разу, коли попросите ту саму страву, я підберу ті самі інгредієнти замість вигадувати з нуля.',
      );
      return;
    }

    const lines = saved.map(
      (r) =>
        `• <b>${escapeHtml(r.dishName)}</b> (${r.timesUsed}×): ${escapeHtml(ingredientNames(r.ingredientsJson))}`,
    );
    await ctx.reply(`📖 Страви, які я запам'ятав:\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.command('memory', async (ctx) => {
    const user = await repo.getOrCreateUser(String(ctx.chat.id));
    const facts = await repo.listUserFacts(user.id);

    if (facts.length === 0) {
      await ctx.reply(
        'Я поки нічого про вас не памʼятаю.\n\n' +
          'Напишіть, напр.: «у мене алергія на арахіс», «ми не їмо свинину», «готуємо на 4 осіб» — ' +
          'і я враховуватиму це в кожному меню.',
      );
      return;
    }

    const lines = facts.map((f) => `• <b>${escapeHtml(kindLabel(f.kind))}</b>: ${escapeHtml(f.text)}`);
    await ctx.reply(
      `🧠 Що я про вас памʼятаю:\n${lines.join('\n')}\n\n` +
        'Щоб щось прибрати — просто скажіть, напр. «забудь про алергію на арахіс». ' +
        '/forget очищає все.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('forget', async (ctx) => {
    const user = await repo.getOrCreateUser(String(ctx.chat.id));
    const count = await repo.deactivateAllUserFacts(user.id);
    await ctx.reply(
      count === 0 ? 'Мені й так нічого про вас не відомо.' : `Забув усе, що знав про вас (${count}).`,
    );
  });

  bot.command('logout', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);
    await repo.deleteTokens(user.id);
    // Drop the conversation too: whoever links this chat next must not inherit the previous
    // account's history, which can name their family, restrictions and addresses. Durable memory
    // goes with it for the same reason, and more urgently — allergies and diets are health data,
    // so this is a real erase (deleteUserFacts), not the audit-preserving soft-delete /forget uses.
    // Recipes are the same household's data too — a new linker shouldn't inherit someone else's.
    await repo.deleteMessages(user.id);
    await repo.deleteUserFacts(user.id);
    await repo.deleteRecipes(user.id);
    await ctx.reply('Відʼєднано. Напишіть /start, щоб підʼєднати акаунт знову.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Команди:\n/start — підʼєднати акаунт\n/plan — спланувати меню\n/plans — минулі плани\n/recipes — запам\'ятовані страви\n/cart — переглянути кошик\n/clear — очистити кошик\n/memory — що я про вас памʼятаю\n/forget — забути все про вас\n/logout — відʼєднати акаунт',
    );
  });
}
