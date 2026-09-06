import { InlineKeyboard } from 'grammy';

export const confirmMenuKeyboard = new InlineKeyboard()
  .text('✅ Так', 'menu_confirm')
  .text('✏️ Змінити', 'menu_edit');

export const cartActionsKeyboard = new InlineKeyboard()
  .text('🛒 Зібрати кошик', 'cart_build')
  .row()
  .text('💸 Дешевше', 'cart_cheaper')
  .text('✏️ Прибрати позицію', 'cart_remove_item');

/**
 * Offered only when an offer actually carries an applicable code. Telegram caps `callback_data` at
 * 64 bytes; Silpo promo codes are short, but the handler still treats a truncated code as invalid
 * rather than trusting it.
 */
export const promoKeyboard = (code: string): InlineKeyboard =>
  new InlineKeyboard().text('🏷 Застосувати промокод', `apply_promo:${code}`);

export const repeatPlanKeyboard = new InlineKeyboard().text('🔁 Повторити минулий план', 'plan_repeat');

export const clearCartKeyboard = new InlineKeyboard()
  .text('🗑 Так, очистити', 'clear_confirm')
  .text('Скасувати', 'clear_cancel');
