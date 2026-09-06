// HTML formatting helpers for Telegram messages (menu, item table, cart summary).

import type { SessionState } from '../agent/session.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Last-resort de-formatting for a message Telegram rejected in HTML mode: drops every tag and
 * decodes the entities `escapeHtml` produces, so the text still reaches the user unformatted.
 */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Ukrainian plural for «день»: 1 день · 2–4 дні · 5–20 днів (and the same pattern per hundred). */
export function pluralDays(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'днів';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дні';
  return 'днів';
}

/**
 * Renders the proposed menu from session state (spec §9.6), NOT from the model's prose — spec §11
 * requires user-visible content to come from tool data, and a live run showed the model sometimes
 * stores the menu via propose_menu without restating it at all.
 *
 * Groups by `day` because one day can hold several meals: a «обід і вечеря» request produces two
 * entries both with day=1, which naively counted reads as "Меню на 2 дні".
 */
export function formatMenu(menu: NonNullable<SessionState['menu']>): string {
  const byDay = new Map<number, typeof menu>();
  for (const entry of menu) {
    const bucket = byDay.get(entry.day);
    if (bucket) bucket.push(entry);
    else byDay.set(entry.day, [entry]);
  }

  const dayNumbers = [...byDay.keys()].sort((a, b) => a - b);
  const lines = [`🍽 <b>Меню на ${dayNumbers.length} ${pluralDays(dayNumbers.length)}</b>`];

  for (const dayNumber of dayNumbers) {
    lines.push('');
    lines.push(`<b>День ${dayNumber}</b>`);
    for (const meal of byDay.get(dayNumber) ?? []) {
      lines.push(`<i>${escapeHtml(meal.dish)}</i>`);
      for (const ing of meal.ingredients) {
        lines.push(`• ${escapeHtml(ing.name)} — ${escapeHtml(ing.qty)}`);
      }
    }
  }
  return lines.join('\n');
}
