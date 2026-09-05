import { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerCommands } from './commands.js';

export function createBot() {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  registerCommands(bot);

  bot.callbackQuery('connect_silpo', async (ctx) => {
    // Phase 2: kick off the OAuth authorization-code + PKCE flow.
    await ctx.answerCallbackQuery();
    await ctx.reply('Підʼєднання акаунта буде реалізовано у Фазі 2.');
  });

  bot.on('message:text', async (ctx) => {
    // Phase 3 will route free text through runAgentTurn().
    await ctx.reply('Ще не вмію відповідати на довільні повідомлення — це зʼявиться у Фазі 3.');
  });

  bot.catch((err) => {
    logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Unhandled bot error');
  });

  return bot;
}
