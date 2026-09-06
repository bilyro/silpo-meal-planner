// HTML formatting helpers for Telegram messages (menu, item table, cart summary).

import type { SessionState } from '../agent/session.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Renders the proposed menu from session state (spec §9.6), NOT from the model's prose. Verified
 * necessary against a live run: the model called propose_menu and then replied only "Підтверди,
 * будь ласка, це меню" — the menu itself lived in tool data and would never have reached the user.
 * Rendering from state also upholds spec §11's rule that user-visible content comes from tool
 * data rather than free text the model could hallucinate.
 */
export function formatMenu(menu: NonNullable<SessionState['menu']>): string {
  const lines = [`🍽 <b>Меню на ${menu.length} ${menu.length === 1 ? 'день' : 'дні'}</b>`];
  for (const day of menu) {
    lines.push('');
    lines.push(`<b>День ${day.day}</b> — ${escapeHtml(day.dish)}`);
    for (const ing of day.ingredients) {
      lines.push(`• ${escapeHtml(ing.name)} — ${escapeHtml(ing.qty)}`);
    }
  }
  return lines.join('\n');
}
