import { InlineKeyboard } from 'grammy';

export const connectSilpoKeyboard = new InlineKeyboard().text('🔐 Під’єднати Сільпо', 'connect_silpo');

export const confirmMenuKeyboard = new InlineKeyboard()
  .text('✅ Так', 'menu_confirm')
  .text('✏️ Змінити', 'menu_edit');

export const cartActionsKeyboard = new InlineKeyboard()
  .text('🛒 Зібрати кошик', 'cart_build')
  .row()
  .text('💸 Дешевше', 'cart_cheaper')
  .text('✏️ Прибрати позицію', 'cart_remove_item');
