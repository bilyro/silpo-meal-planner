import { InlineKeyboard } from 'grammy';

export const confirmMenuKeyboard = new InlineKeyboard()
  .text('✅ Так', 'menu_confirm')
  .text('✏️ Змінити', 'menu_edit');

export const cartActionsKeyboard = new InlineKeyboard()
  .text('🛒 Зібрати кошик', 'cart_build')
  .row()
  .text('💸 Дешевше', 'cart_cheaper')
  .text('✏️ Прибрати позицію', 'cart_remove_item');

export const clearCartKeyboard = new InlineKeyboard()
  .text('🗑 Так, очистити', 'clear_confirm')
  .text('Скасувати', 'clear_cancel');
