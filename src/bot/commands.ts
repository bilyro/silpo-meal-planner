import type { Bot } from 'grammy';
import { connectSilpoKeyboard } from './keyboards.js';

export function registerCommands(bot: Bot) {
  bot.command('start', async (ctx) => {
    // Phase 2 will check for an existing token and skip straight to the profile summary.
    await ctx.reply(
      'Привіт! Я «Сільпо Шеф» — агент для планування меню та збирання кошика в Сільпо.\n\n' +
        'Щоб почати, під’єднайте свій акаунт Сільпо:',
      { reply_markup: connectSilpoKeyboard },
    );
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
    await ctx.reply('Відʼєднання акаунта буде доступне у Фазі 2.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Команди:\n/start — підʼєднати акаунт\n/plan — спланувати меню\n/cart — переглянути кошик\n/clear — очистити кошик\n/logout — відʼєднати акаунт',
    );
  });
}
