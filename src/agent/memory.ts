/**
 * Durable memory: what the bot knows about a user across sessions, as opposed to
 * `sessions.state_json` (the plan currently being built) and `messages` (the last 12 turns).
 *
 * Three sources, deliberately kept apart because they have very different truth values:
 *
 *   1. STATED facts — allergies, diets, dislikes, preferences the user told us. Stored in
 *      `user_facts`, trustworthy, and the only source allowed to produce hard constraints.
 *   2. PLAN HISTORY — every menu ever built, from `plans`. Fact, not inference: we really did
 *      propose these dishes and resolve these products.
 *   3. WHAT IS PROBABLY AT HOME — derived from recent plans. This one is a GUESS, and the whole
 *      design of this module is arranged so it can never be stated as a fact. See below.
 *
 * Why the guess is fenced off: we learn what went into a CART, never what was bought. Checkout
 * happens on Silpo's own site behind an external link, so the bot's visibility ends at the moment
 * it hands that link over. `silpo_get_my_online_orders` would close the loop — it exists, it is
 * paginated, and it is the only honest source of purchase truth — but on a real linked account it
 * returns zero orders (this account has never completed a purchase), so its line-item shape is
 * unverified and nothing here may depend on it yet.
 *
 * Even with purchase truth we still would not know what was COOKED, or what was in the cupboard
 * beforehand. A ledger that claims «у тебе ще є 700 г рису» is therefore fiction with a number
 * attached, and the failure mode is nasty: it is confidently wrong, invisible to the user, and it
 * silently removes an ingredient from the shopping list. So recent purchases are surfaced as a
 * question for the user to answer, never as an inventory to plan against.
 */

import * as repo from '../db/repo.js';
import type { FactSource } from '../db/repo.js';

/**
 * `allergy` and `diet` FILTER products; `dislike`, `preference` and `household` only bias them.
 *
 * The split is the point of this type. An allergy demoted to a preference is a safety bug, not a
 * ranking bug — the menu would still "mostly" avoid peanuts while occasionally suggesting them.
 */
export const HARD_KINDS = ['allergy', 'diet'] as const;
export const SOFT_KINDS = ['dislike', 'preference', 'household'] as const;
export const FACT_KINDS = [...HARD_KINDS, ...SOFT_KINDS] as const;

export type FactKind = (typeof FACT_KINDS)[number];
export type { FactSource };

export interface UserFact {
  id: number;
  kind: string;
  text: string;
  source: FactSource;
}

export function isHardKind(kind: string): boolean {
  return (HARD_KINDS as readonly string[]).includes(kind);
}

/** Ukrainian labels for the `/memory` listing and the prompt block. */
const KIND_LABELS: Record<string, string> = {
  allergy: 'Алергія',
  diet: 'Дієта',
  dislike: 'Не любить',
  preference: 'Вподобання',
  household: 'Побут',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export interface RecalledMemory {
  facts: UserFact[];
  /** Allergy/diet texts only — safe to pass to product selection as exclusions. */
  hardConstraints: string[];
  /** Dish names from recent plans, newest first, for variety. */
  recentDishes: string[];
  /** Ingredients bought recently. A GUESS about what is at home — see the module doc. */
  recentlyBought: { ingredient: string; title: string; qty: number }[];
}

interface StoredMenuEntry {
  dish?: unknown;
}

interface StoredResolvedItem {
  ingredient?: unknown;
  title?: unknown;
  qty?: unknown;
}

/** Plans hold opaque JSON (repo house rule), so every field is re-checked on the way out. */
function readDishes(menuJson: unknown): string[] {
  if (!Array.isArray(menuJson)) return [];
  return menuJson
    .map((entry) => (entry as StoredMenuEntry)?.dish)
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
}

function readResolved(resolvedJson: unknown): RecalledMemory['recentlyBought'] {
  if (!Array.isArray(resolvedJson)) return [];
  return resolvedJson.flatMap((entry) => {
    const item = entry as StoredResolvedItem;
    if (typeof item?.ingredient !== 'string' || typeof item?.title !== 'string') return [];
    return [
      {
        ingredient: item.ingredient,
        title: item.title,
        qty: typeof item.qty === 'number' ? item.qty : 1,
      },
    ];
  });
}

/** How many past plans feed variety and the "probably at home" hint. */
const PLANS_FOR_VARIETY = 3;

export async function recallMemory(userId: number): Promise<RecalledMemory> {
  const [facts, recentPlans] = await Promise.all([
    repo.listUserFacts(userId),
    repo.listRecentPlans(userId, PLANS_FOR_VARIETY),
  ]);

  const recentDishes = recentPlans.flatMap((p) => readDishes(p.menuJson));

  // Only the newest plan feeds the at-home hint: two-week-old groceries are long gone, and a
  // longer window would make the list so broad that the user has to reject most of it.
  const newest = recentPlans[0];
  const recentlyBought = newest ? readResolved(newest.resolvedJson) : [];

  return {
    facts,
    hardConstraints: facts.filter((f) => isHardKind(f.kind)).map((f) => f.text),
    recentDishes,
    recentlyBought,
  };
}

/**
 * Renders memory for the system prompt.
 *
 * Wording matters as much as content here. Hard constraints are given as absolute prohibitions;
 * recent purchases are given with an explicit instruction to ASK, because the model's default
 * behaviour with a list of groceries is to assume they are still in the cupboard and quietly drop
 * them from the list.
 */
export function formatMemoryBlock(memory: RecalledMemory): string {
  const parts: string[] = [];

  const hard = memory.facts.filter((f) => isHardKind(f.kind));
  const soft = memory.facts.filter((f) => !isHardKind(f.kind));

  if (hard.length > 0) {
    parts.push(
      'ЖОРСТКІ обмеження (НІКОЛИ не пропонуй ці продукти та страви з ними):\n' +
        hard.map((f) => `- ${kindLabel(f.kind)}: ${f.text}`).join('\n'),
    );
  }
  if (soft.length > 0) {
    parts.push(
      'Побажання (враховуй, але це не заборона):\n' +
        soft.map((f) => `- ${kindLabel(f.kind)}: ${f.text}`).join('\n'),
    );
  }
  if (memory.recentDishes.length > 0) {
    parts.push(
      'Страви з минулих планів — НЕ повторюй їх без прохання, запропонуй щось інше:\n' +
        memory.recentDishes.map((d) => `- ${d}`).join('\n'),
    );
  }
  if (memory.recentlyBought.length > 0) {
    parts.push(
      'Куплено минулого разу. Це НЕ означає, що воно ще є вдома — ми не знаємо, чи покупку ' +
        'оплатили і чи це вже з\'їли. Якщо щось із цього потрібне для нового меню — ЗАПИТАЙ ' +
        'користувача, чи воно ще є, і не викидай зі списку покупок самостійно:\n' +
        memory.recentlyBought.map((i) => `- ${i.ingredient} (${i.title})`).join('\n'),
    );
  }

  if (parts.length === 0) return '';
  return `<memory>\n${parts.join('\n\n')}\n</memory>`;
}

/**
 * Every hard constraint that must be applied when picking products: the user's stored allergies
 * and diets, merged with whatever Silpo's own profile reports.
 *
 * Both sources are needed. Silpo's field is authoritative when populated, but a live account came
 * back with none set, so in practice the stored facts are the only ones there are. De-duplicated
 * case-insensitively so «свинина» from both sources is one exclusion, not two.
 */
export async function hardRestrictions(
  userId: number,
  state: { profile?: { restrictions?: string[] } },
): Promise<string[]> {
  const stored = await repo.listUserFacts(userId);
  const merged = [
    ...(state.profile?.restrictions ?? []),
    ...stored.filter((f) => isHardKind(f.kind)).map((f) => f.text),
  ];
  const seen = new Set<string>();
  return merged.filter((r) => {
    const key = r.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
