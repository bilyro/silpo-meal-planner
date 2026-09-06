import { Bot, type Context, type InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runAgentTurn } from '../agent/runAgentTurn.js';
import { ensureCartContext } from '../agent/cartContext.js';
import { applyResolution, finishWithCheckout } from '../agent/localTools.js';
import { resolveIngredients } from '../agent/resolveIngredients.js';
import { loadSession, saveSession } from '../agent/session.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import * as repo from '../db/repo.js';
import { registerCommands } from './commands.js';
import { cartActionsKeyboard, confirmMenuKeyboard } from './keyboards.js';
import { escapeHtml, formatResolvedItems, formatMenu, formatUah, stripHtml } from './format.js';

/**
 * Sends an HTML-formatted reply, falling back to tag-stripped plain text if Telegram rejects it.
 *
 * Telegram's HTML mode accepts only a small tag set (b, i, u, s, code, pre, a, blockquote,
 * tg-spoiler) and rejects the WHOLE message otherwise — observed with claude-haiku-4-5 emitting
 * <ul>/<li>. Without this fallback the send throws, grammY's global catch only logs, and the user
 * is left staring at nothing. Shared by every handler that echoes model or product text.
 */
async function replyHtml(ctx: Context, body: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.reply(body, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    logger.warn({ err, chatId: ctx.chat?.id }, 'HTML reply rejected; retrying as plain text');
    await ctx.reply(stripHtml(body), { reply_markup: keyboard });
  }
}

/** Telegram stops showing "typing" after ~5s, so refresh it while a long tool chain runs. */
function keepTyping(ctx: Context): () => void {
  void ctx.replyWithChatAction('typing').catch(() => {});
  const timer = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(timer);
}

export function createBot() {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  registerCommands(bot);

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);

    const stopTyping = keepTyping(ctx);
    try {
      const { text, stage, menu } = await runAgentTurn(user.id, ctx.message.text);
      // On a proposed menu the reply is rendered purely from tool data and the model's prose is
      // dropped: whether it restates the menu varies run to run, and appending it produced a
      // visibly duplicated menu. The system prompt also tells the model not to restate it, but
      // that is only a token-saving hint — this is what actually guarantees no duplication.
      const body =
        stage === 'menu_proposed' && menu?.length
          ? `${formatMenu(menu)}\n\nПідтверджуєте меню?`
          : text;
      await replyHtml(ctx, body, stage === 'menu_proposed' ? confirmMenuKeyboard : undefined);
    } finally {
      stopTyping();
    }
  });

  /**
   * ✅ on a proposed menu: resolve every ingredient to a real product and show the priced list.
   * Deterministic rather than model-driven (spec §6.3's rationale) — the batch search, selection
   * heuristic and totals maths are the same on every run.
   */
  bot.callbackQuery('menu_confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await repo.getOrCreateUser(String(ctx.chat?.id ?? ''));
    const state = await loadSession(user.id);

    if (!state.menu?.length) {
      await ctx.reply('Меню ще не складено. Напишіть, що спланувати.');
      return;
    }

    const stopTyping = keepTyping(ctx);
    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();

      const cartCtx = await ensureCartContext(mcp, state);
      await saveSession(user.id, state);
      if ('needsAddress' in cartCtx) {
        // The account has no saved address. Ask in plain text and stop: the user's reply goes
        // through the normal agent turn, whose ensure_cart_context tool accepts an address.
        await ctx.reply('Щоб зібрати кошик, напишіть адресу доставки текстом — напр. «Київ, вулиця Хрещатик, 1».');
        return;
      }

      const { items, misses } = await resolveIngredients(mcp, cartCtx.cartContext, state.menu, {
        ...(state.profile?.restrictions ? { restrictions: state.profile.restrictions } : {}),
      });

      if (items.length === 0) {
        await ctx.reply('На жаль, не вдалося підібрати жодного товару. Спробуйте змінити меню.');
        return;
      }

      const totals = await applyResolution(user.id, state, items);
      let body = formatResolvedItems(items, totals);
      if (misses.length > 0) {
        body += `\n\n⚠️ Не знайшли: ${misses.map((m) => escapeHtml(m)).join(', ')}`;
      }
      await replyHtml(ctx, body, cartActionsKeyboard);
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply('Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.');
        return;
      }
      logger.error({ err, userId: user.id }, 'Failed to resolve ingredients');
      await ctx.reply('Не вдалося підібрати товари. Спробуйте ще раз пізніше.');
    } finally {
      stopTyping();
      await mcp.close();
    }
  });

  /**
   * 🛒 — writes the resolved list into the real Silpo cart. This mutates real data, which spec
   * §4.6 permits only after explicit user confirmation; pressing this button IS that confirmation.
   */
  bot.callbackQuery('cart_build', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await repo.getOrCreateUser(String(ctx.chat?.id ?? ''));
    const state = await loadSession(user.id);

    if (!state.resolvedItems?.length || !state.cartContext) {
      await ctx.reply('Спочатку потрібно підібрати список товарів.');
      return;
    }

    const branchId = state.cartContext.branchId;
    const skipped: string[] = [];
    const products = [];
    for (const item of state.resolvedItems) {
      // companyId is required by the API and comes from the product search payload; an item
      // missing it cannot be added, so report it rather than failing the whole batch.
      if (!item.companyId) {
        skipped.push(item.title);
        continue;
      }
      products.push({ productId: item.productId, companyId: item.companyId, branchId, quantity: item.qty });
    }

    if (products.length === 0) {
      await ctx.reply('Жоден товар не має даних, потрібних для додавання в кошик.');
      return;
    }

    const stopTyping = keepTyping(ctx);
    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();
      // One batched call, not one per product (spec §8 Phase 5 step 5).
      await mcp.callTool('silpo_add_or_update_cart_products', {
        shoppingCartId: state.cartContext.cartId,
        products,
      });

      const summary = await finishWithCheckout(user.id, state, mcp);
      // Prefer Silpo's own total: it includes delivery, so it is what the user will actually pay.
      const total = summary.cartTotal ?? state.totals?.sum ?? 0;
      const lines = [`🛒 <b>Кошик зібрано</b> — ${products.length} поз., ${formatUah(total)} грн`];
      if (skipped.length > 0) lines.push(`⚠️ Не додано: ${skipped.map((s) => escapeHtml(s)).join(', ')}`);
      if (summary.loyalty?.isEnabled) lines.push(`💳 Бонусів доступно: ${formatUah(summary.loyalty.bonusAvailable)}`);
      const link = summary.checkoutWebLink ?? summary.checkoutMobileLink;
      if (link) {
        lines.push(`\n👉 <a href="${escapeHtml(link)}">Оформити замовлення</a>`);
      } else if (summary.blockers?.length) {
        // Say WHY there is no link. Silpo withholds it below a minimum order value, and a bare
        // "the link will appear later" leaves the user with no idea what to do about it.
        lines.push(`\n⚠️ Оформлення поки недоступне: ${escapeHtml(summary.blockers.join('; '))}.`);
        lines.push('Додайте ще позицій або попросіть мене доповнити меню.');
      } else {
        lines.push('\nПосилання на оформлення зʼявиться, коли кошик пройде перевірку в Сільпо.');
      }
      await replyHtml(ctx, lines.join('\n'));
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply('Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.');
        return;
      }
      logger.error({ err, userId: user.id }, 'Failed to build cart');
      await ctx.reply('Не вдалося зібрати кошик. Спробуйте ще раз пізніше.');
    } finally {
      stopTyping();
      await mcp.close();
    }
  });

  // 💸 / ✏️ — spec §8 Phase 5 steps 6-7. The full budget-squeeze and per-item removal flows are
  // deferred; free text already reaches the agent loop, which has the resolved list in session
  // state and conversation memory, so routing the user there is honest rather than a dead end.
  bot.callbackQuery('cart_cheaper', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Напишіть, наскільки здешевити — напр. «зроби дешевше на 200 грн».');
  });

  bot.callbackQuery('cart_remove_item', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Напишіть, яку позицію прибрати — напр. «прибери лосось».');
  });

  bot.callbackQuery('menu_edit', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Напишіть, що змінити в меню.');
  });

  bot.callbackQuery('clear_confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = String(ctx.chat?.id ?? '');
    const user = await repo.getOrCreateUser(chatId);
    const state = await loadSession(user.id);

    if (!state.cartContext) {
      await ctx.reply('Кошика вже немає.');
      return;
    }

    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();
      await mcp.callTool('silpo_clear_shopping_cart', { shoppingCartId: state.cartContext.cartId });
      state.cartContext = undefined;
      state.stage = 'idle';
      await saveSession(user.id, state);
      await ctx.reply('Кошик очищено.');
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply('Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.');
        return;
      }
      logger.error({ err, userId: user.id }, 'Failed to clear cart');
      await ctx.reply('Не вдалося очистити кошик. Спробуйте ще раз пізніше.');
    } finally {
      await mcp.close();
    }
  });

  bot.callbackQuery('clear_cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Гаразд, кошик залишається.');
  });

  bot.catch((err) => {
    logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Unhandled bot error');
  });

  return bot;
}
