import { Bot, type Context, type InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runAgentTurn } from '../agent/runAgentTurn.js';
import { ensureCartContext } from '../agent/cartContext.js';
import { applyResolution, finishWithCheckout } from '../agent/localTools.js';
import { applyPromoCode, fetchLoyalty, fetchOffers, firstApplicableCode, formatLoyaltyBlock } from '../agent/loyalty.js';
import { hardRestrictions } from '../agent/memory.js';
import { loadLastPlanIntoState, savePlanFromState } from '../agent/plans.js';
import { resolveIngredients } from '../agent/resolveIngredients.js';
import { loadSession, saveSession } from '../agent/session.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import * as repo from '../db/repo.js';
import { registerCommands } from './commands.js';
import { cartActionsKeyboard, confirmMenuKeyboard, promoKeyboard } from './keyboards.js';
import { relinkReply } from './messages.js';
import { escapeHtml, formatResolvedItems, formatMenu, formatUah, stripHtml, stripLinks } from './format.js';
import { sendWelcomeMessage } from './welcome.js';

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

/**
 * Backstop so no update can fail silently (spec §8 Phase 6 item 3: never a stack trace, always a
 * short Ukrainian message with a suggested action).
 *
 * Individual handlers already catch around their own MCP calls with specific wording, and that
 * stays — it says more than this can. What this adds is coverage for everything OUTSIDE those
 * blocks: `getOrCreateUser` and `loadSession` run BEFORE the try in every callback handler, so a
 * Postgres hiccup threw straight past them into grammY's `bot.catch`, which only logs. The user
 * pressed a button and got nothing back at all.
 *
 * Registered as middleware rather than a per-handler wrapper so it covers commands, callbacks and
 * free text alike, including handlers added later that forget to catch anything.
 */
function errorBoundary(): (ctx: Context, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply(...relinkReply(err)).catch(() => {});
        return;
      }
      logger.error({ err, chatId: ctx.chat?.id }, 'Handler failed');
      // .catch: if Telegram itself is what failed, the apology cannot be delivered either, and
      // rethrowing would just re-enter bot.catch with a less informative error.
      await ctx
        .reply('Щось пішло не так. Спробуйте ще раз за хвилину або напишіть /start.')
        .catch(() => {});
    }
  };
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

  // First, so it wraps every handler registered below.
  bot.use(errorBoundary());

  registerCommands(bot);

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);

    // A bare 6-digit message is treated as an OAuth link confirmation code (see schema.ts's
    // `confirmed` column doc) rather than routed to the agent — a real diet/planning request is
    // never exactly six digits with nothing else, so this cannot misfire on ordinary conversation.
    const confirmMatch = /^\s*(\d{6})\s*$/.exec(ctx.message.text);
    const confirmCode = confirmMatch?.[1];
    if (confirmCode) {
      const pendingLink = await repo.findUnconfirmedByCode(confirmCode);
      if (pendingLink) {
        await repo.confirmLink(pendingLink.userId);
        const linkedUser = await repo.getUserById(pendingLink.userId);
        if (linkedUser) {
          await sendWelcomeMessage(bot, linkedUser.telegramChatId, linkedUser.id);
        }
        // The chat that started /start already gets sendWelcomeMessage above; only ack separately
        // if the code was typed somewhere else (someone relaying it on the linking chat's behalf).
        if (pendingLink.userId !== user.id) {
          await ctx.reply('✅ Код прийнято — підключення підтверджено.');
        }
        return;
      }
    }

    const stopTyping = keepTyping(ctx);
    try {
      const { text, stage, menu, resolvedItems, totals } = await runAgentTurn(user.id, ctx.message.text);
      // On a proposed menu the reply is rendered purely from tool data and the model's prose is
      // dropped: whether it restates the menu varies run to run, and appending it produced a
      // visibly duplicated menu. The system prompt also tells the model not to restate it, but
      // that is only a token-saving hint — this is what actually guarantees no duplication.
      //
      // list_resolved gets the same treatment, for a reason that was live and reproducible rather
      // than theoretical: the model can drive the WHOLE pipeline itself (ensure_cart_context →
      // search → record_resolution) inside one free-text turn, end at stage='list_resolved', and
      // tell the user in its own prose to press 🛒 — while this handler, which only ever checked
      // for 'menu_proposed', rendered no keyboard at all. The button the model just told the user
      // to press then didn't exist. Confirmed against a real conversation in the messages table
      // where exactly that happened.
      let body = stripLinks(text);
      let keyboard: InlineKeyboard | undefined;
      if (stage === 'menu_proposed' && menu?.length) {
        body = `${formatMenu(menu)}\n\nПідтверджуєте меню?`;
        keyboard = confirmMenuKeyboard;
      } else if (stage === 'list_resolved' && resolvedItems?.length && totals) {
        body = formatResolvedItems(resolvedItems, totals);
        keyboard = cartActionsKeyboard;
      }
      await replyHtml(ctx, body, keyboard);
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

      // Restrictions come from BOTH sources. Silpo's own food-restrictions field is authoritative
      // when set, but on a real linked account it came back empty — nobody fills it in — so the
      // allergies and diets the user told the bot must be merged in here. This is the deterministic
      // 🛒 path, which does not go through the model at all: without this merge a stored allergy
      // would constrain the model's menu and then be ignored by the code that actually picks the
      // products.
      const restrictions = await hardRestrictions(user.id, state);
      const { items, misses } = await resolveIngredients(mcp, cartCtx.cartContext, state.menu, {
        ...(restrictions.length > 0 ? { restrictions } : {}),
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

      // Recipes only get saved on a clean run — resolveIngredients reports misses across the
      // WHOLE menu, not per dish, so "0 misses" is the only correctness bar available without
      // re-deriving which dish a miss belonged to. Deliberately after the reply, own catch each:
      // a failure to remember a recipe must not turn a cart that WAS built into an error message.
      // Writes to BOTH the personal and shared pool — same correctness bar, no separate curation.
      if (misses.length === 0) {
        for (const dish of state.menu) {
          await repo
            .saveRecipe(user.id, dish.dish, dish.ingredients)
            .catch((err) => logger.error({ err, userId: user.id, dish: dish.dish }, 'Failed to save recipe'));
          await repo
            .saveSharedRecipe(dish.dish, dish.ingredients, user.id)
            .catch((err) => logger.error({ err, userId: user.id, dish: dish.dish }, 'Failed to save shared recipe'));
        }
      }
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply(...relinkReply(err));
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
      // The one place this becomes true: finishWithCheckout() below refuses to read the cart at
      // all until this is set, so the model calling it prematurely can't narrate a stale/empty
      // cart as if it answered for a resolution nothing has actually been written for yet.
      state.cartWritten = true;

      const summary = await finishWithCheckout(user.id, state, mcp);
      // Decorative extras, fetched together. Both swallow their own errors: a loyalty lookup must
      // never turn a cart that WAS built into an error message.
      const [loyaltyInfo, offers] = await Promise.all([fetchLoyalty(mcp), fetchOffers(mcp)]);
      // Prefer Silpo's own total: it includes delivery, so it is what the user will actually pay.
      const total = summary.cartTotal ?? state.totals?.sum ?? 0;
      const lines = [`🛒 <b>Кошик зібрано</b> — ${products.length} поз., ${formatUah(total)} грн`];
      if (skipped.length > 0) lines.push(`⚠️ Не додано: ${skipped.map((s) => escapeHtml(s)).join(', ')}`);
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

      // Bonuses and coupons last, so they never push the checkout link out of sight.
      const loyaltyBlock = formatLoyaltyBlock({
        cartLoyalty: summary.loyalty ?? null,
        info: loyaltyInfo,
        offers,
      });
      if (loyaltyBlock) lines.push('', loyaltyBlock);

      const promoCode = firstApplicableCode(offers);
      await replyHtml(ctx, lines.join('\n'), promoCode ? promoKeyboard(promoCode) : undefined);

      // Bookkeeping, deliberately after the reply and with its own catch: a failure to archive the
      // plan must not reach the handler's catch and tell the user the cart failed when it did not.
      await savePlanFromState(user.id, state).catch((err) =>
        logger.error({ err, userId: user.id }, 'Failed to save plan'),
      );
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply(...relinkReply(err));
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

  /**
   * 🏷 — pushes a promo code into the real cart. Mutating, so it is gated behind an explicit tap,
   * same rule as 🛒 (spec §4.6).
   */
  bot.callbackQuery(/^apply_promo:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const code = ctx.match?.[1];
    if (!code) return;
    const user = await repo.getOrCreateUser(String(ctx.chat?.id ?? ''));
    const state = await loadSession(user.id);

    if (!state.cartContext) {
      await ctx.reply('Спочатку потрібно зібрати кошик.');
      return;
    }

    const stopTyping = keepTyping(ctx);
    const mcp = new SilpoMcpClient(user.id);
    try {
      await mcp.connect();
      const result = await applyPromoCode(mcp, state.cartContext.cartId, code);
      await replyHtml(ctx, result.message);
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        await ctx.reply(...relinkReply(err));
        return;
      }
      logger.error({ err, userId: user.id }, 'Failed to apply promo code');
      await ctx.reply('Не вдалося застосувати промокод. Спробуйте ще раз пізніше.');
    } finally {
      stopTyping();
      await mcp.close();
    }
  });

  /**
   * 🔁 — restores a previous plan's MENU and rewinds to the confirm step, so ✅ re-resolves every
   * ingredient against today's catalog. The stored products are deliberately NOT replayed; see the
   * header of agent/plans.ts for why.
   */
  bot.callbackQuery('plan_repeat', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await repo.getOrCreateUser(String(ctx.chat?.id ?? ''));
    const state = await loadSession(user.id);

    const result = await loadLastPlanIntoState(user.id, state);
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    await replyHtml(
      ctx,
      `${formatMenu(result.plan.menu)}\n\nПовторюємо це меню? Ціни та наявність перевірю заново.`,
      confirmMenuKeyboard,
    );
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
        await ctx.reply(...relinkReply(err));
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
