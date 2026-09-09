// HTML formatting helpers for Telegram messages (menu, item table, cart summary).

import type { SessionState } from '../agent/session.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strips <a> tags from model-generated free text before it reaches Telegram, keeping each tag's
 * inner text but dropping the href/tag itself. The model is allowed to use Telegram's other
 * formatting tags (<b>, <i>, ...) in free-text replies, but it has no legitimate reason to ever
 * emit a link there — the one real link (checkout) is rendered by our own deterministic code from
 * tool data, never echoed from the model's prose. This closes off a link being smuggled into a
 * stranger's chat via text the model was asked to relay verbatim (e.g. an ingredient string from
 * the cross-user shared-recipe pool) rather than text the model composed itself.
 */
export function stripLinks(text: string): string {
  return text.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
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

/**
 * Ukrainian plural selection: `one` for 1/21/31…, `few` for 2–4/22–24…, `many` otherwise —
 * with the 11–14 teens taking `many` despite their final digit.
 */
export function pluralUa(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Ukrainian plural for «день»: 1 день · 2–4 дні · 5–20 днів (and the same pattern per hundred). */
export function pluralDays(n: number): string {
  return pluralUa(n, 'день', 'дні', 'днів');
}

/**
 * UAH amounts for display. Prices arrive as floats and `unitPrice × qty` on weighted goods
 * routinely lands on values like 189.49999999999997, so round to kopiykas and drop a trailing
 * `.00` — «189 грн», never «189.4999999 грн».
 */
export function formatUah(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
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

type ResolvedItems = NonNullable<SessionState['resolvedItems']>;
type Totals = NonNullable<SessionState['totals']>;

/** A line's cost. `unitPrice` is per kg/l for weighted goods and per package otherwise, and `qty`
 * is expressed in the matching unit, so the product is correct for both — see selectProduct.ts. */
export function lineTotal(item: ResolvedItems[number]): number {
  return item.unitPrice * item.qty;
}

/**
 * Telegram hard-caps a message at 4096 characters. Stop well short: the caller may append a
 * «не знайшли» line, and an over-long message is rejected outright rather than truncated, which
 * would lose the whole list.
 */
const ITEM_LIST_CHAR_BUDGET = 3400;

/**
 * Renders the resolved shopping list (spec §9.6) purely from tool data — spec §11 requires
 * user-visible product names and prices to come from `resolvedItems`, never from model prose,
 * so nothing here can be hallucinated.
 *
 * Pure and I/O-free so it can be unit-tested.
 */
export function formatResolvedItems(items: ResolvedItems, totals: Totals): string {
  const promoCount = items.filter((i) => i.isPromo).length;
  const substitutedCount = items.filter((i) => i.wasSubstituted).length;

  const header =
    `🧾 <b>Список: ${items.length} ${pluralUa(items.length, 'позиція', 'позиції', 'позицій')} — ` +
    `${formatUah(totals.sum)} грн</b>`;
  // The budget clause is omitted entirely when the user never named one — showing "(бюджет —)"
  // would imply a constraint that does not exist.
  const budgetClause =
    totals.budget === undefined
      ? ''
      : ` (бюджет ${formatUah(totals.budget)} ${totals.sum <= totals.budget ? '✅' : '⚠️'})`;

  const lines = [header + budgetClause];

  const badges: string[] = [];
  if (promoCount > 0) badges.push(`🔥 ${promoCount} ${pluralUa(promoCount, 'акційна', 'акційні', 'акційних')}`);
  if (substitutedCount > 0) {
    badges.push(`🔄 ${substitutedCount} ${pluralUa(substitutedCount, 'заміна', 'заміни', 'замін')}`);
  }
  if (badges.length > 0) lines.push(badges.join(' · '));
  lines.push('');

  let used = lines.join('\n').length;
  let shown = 0;
  for (const item of items) {
    const qtySuffix = item.qty === 1 ? '' : ` × ${formatUah(item.qty)}`;
    const itemBadges = `${item.isPromo ? ' 🔥' : ''}${item.wasSubstituted ? ' 🔄' : ''}`;
    const line = `• ${escapeHtml(item.title)}${qtySuffix} — ${formatUah(lineTotal(item))} грн${itemBadges}`;
    if (used + line.length + 1 > ITEM_LIST_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }

  const hidden = items.length - shown;
  if (hidden > 0) lines.push(`…та ще ${hidden} ${pluralUa(hidden, 'позиція', 'позиції', 'позицій')}`);

  return lines.join('\n');
}
