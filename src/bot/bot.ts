import { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runAgentTurn } from '../agent/runAgentTurn.js';
import * as repo from '../db/repo.js';
import { registerCommands } from './commands.js';
import { confirmMenuKeyboard } from './keyboards.js';

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
      const { text, stage } = await runAgentTurn(user.id, ctx.message.text);
      await ctx.reply(text, {
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

  bot.catch((err) => {
    logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Unhandled bot error');
  });

  return bot;
}
