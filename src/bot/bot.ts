import { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runAgentTurn } from '../agent/runAgentTurn.js';
import { loadSession, saveSession } from '../agent/session.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import * as repo from '../db/repo.js';
import { registerCommands } from './commands.js';
import { confirmMenuKeyboard } from './keyboards.js';
import { formatMenu } from './format.js';

export function createBot() {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  registerCommands(bot);

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await repo.getOrCreateUser(chatId);

    await ctx.replyWithChatAction('typing');
    const typingTimer = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, 4000);

    try {
      const { text, stage, menu } = await runAgentTurn(user.id, ctx.message.text);
      // The model reliably calls propose_menu but often does not restate the menu in its reply,
      // so render it from tool data and let the model's text serve as the follow-up prompt.
      const body = stage === 'menu_proposed' && menu?.length ? `${formatMenu(menu)}\n\n${text}` : text;
      await ctx.reply(body, {
        parse_mode: 'HTML',
        reply_markup: stage === 'menu_proposed' ? confirmMenuKeyboard : undefined,
      });
    } finally {
      clearInterval(typingTimer);
    }
  });

  bot.callbackQuery('menu_confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Збирання списку продуктів буде реалізовано у Фазі 5.');
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
