/**
 * Saved plans and «Повтори минулий план» (spec §8 Phase 6 item 2).
 *
 * ## Why a replay re-resolves products instead of re-adding the stored ones
 *
 * A stored plan carries both the MENU (days → dishes → ingredients) and the RESOLVED ITEMS
 * (`productId`, `companyId`, `unitPrice`, `isPromo`) captured the moment the cart was built.
 * Only the menu is replayed; the products are re-resolved from scratch through
 * `resolveIngredients`. Four reasons, in descending order of how badly the alternative fails:
 *
 * 1. **Stale lines poison the whole cart, not just themselves.** Silpo validates the cart as a
 *    unit: one line above `product.offer.stock.max` yields a `level:'error'` validation and the
 *    checkout link is withheld for the ENTIRE cart (docs/phase5-findings.md §4). Re-adding
 *    week-old quantities is the single most likely way to produce a cart that cannot be checked
 *    out, and the user gets no per-line explanation of which item did it.
 * 2. **Availability is branch- and slot-scoped, and the replay has a different one.** A replay
 *    days later goes through a fresh `ensure_cart_context`: possibly another branch, certainly
 *    another timeslot. A `productId` that was in stock at branch A in Tuesday's 10:00 slot is not
 *    a promise about branch B on Sunday. `resolveIngredients` already handles this properly —
 *    availability filtering plus a `silpo_get_replacements` fallback per missing ingredient.
 * 3. **Stale prices are the same class of error as invented ones.** Spec §11 forbids the bot
 *    stating prices it did not read from a tool. Rendering `unitPrice` captured three weeks ago as
 *    if it were today's price breaks that guarantee just as surely as a hallucinated number, and
 *    silently — it looks entirely plausible.
 * 4. **Promo share is a scored success metric.** Replaying frozen products locks in whichever
 *    promotions ran back then; re-resolving picks up today's, which is the behaviour the metric
 *    is meant to reward.
 *
 * The stored `resolvedItems` are therefore never restored into `SessionState.resolvedItems` (the
 * field `cart_build` writes straight into the real cart). They survive only as a read-only record
 * of what the plan cost last time, which is worth showing the user — «минулого разу вийшло 845 грн»
 * — and is what `formatPlanSummary` renders.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { escapeHtml, formatUah, pluralDays, pluralUa } from '../bot/format.js';
import * as repo from '../db/repo.js';
import { saveSession, type SessionState } from './session.js';

type Menu = NonNullable<SessionState['menu']>;
type ResolvedItems = NonNullable<SessionState['resolvedItems']>;
type Totals = NonNullable<SessionState['totals']>;

export interface StoredPlan {
  id: number;
  createdAt: Date;
  menu: Menu;
  resolvedItems?: ResolvedItems;
  totals?: Totals;
}

export type LoadPlanResult = { ok: true; plan: StoredPlan } | { ok: false; message: string };

/** Shown when the user asks to repeat but has never completed a plan. Not an error condition. */
const NO_PLANS_MESSAGE =
  'У вас ще немає збережених планів. Складіть меню і зберіть кошик — тоді я запамʼятаю цей план ' +
  'і зможу його повторити.';

/** Shown when a row exists but predates the current SessionState shape (see parseMenu). */
const UNREADABLE_PLAN_MESSAGE =
  'Не вдалося прочитати збережений план — схоже, він застарілого формату. Напишіть, що спланувати, ' +
  'і я складу нове меню.';

// ── Defensive parsing ───────────────────────────────────────────────────────────────────────────
// A `plans` row is JSON written by an older build of this bot; nothing in the DB enforces today's
// shape. Same posture as session.ts's `looksLikeSessionState`, but filtering rather than a plain
// boolean guard: a plan with one malformed day is still worth replaying without it, whereas letting
// it through would crash `formatMenu`, which walks `meal.ingredients[].name` unconditionally.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMenu(value: unknown): Menu | undefined {
  if (!Array.isArray(value)) return undefined;
  const menu: Menu = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.day !== 'number' || typeof raw.dish !== 'string') continue;
    const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : [])
      .filter(isRecord)
      .filter((i): i is { name: string; qty: unknown } => typeof i.name === 'string')
      .map((i) => ({ name: i.name, qty: typeof i.qty === 'string' ? i.qty : '' }));
    menu.push({ day: raw.day, dish: raw.dish, ingredients });
  }
  return menu.length > 0 ? menu : undefined;
}

function parseResolvedItems(value: unknown): ResolvedItems | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ResolvedItems = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const { ingredient, productId, title, qty, unitPrice } = raw;
    if (typeof ingredient !== 'string' || typeof productId !== 'string' || typeof title !== 'string') continue;
    if (typeof qty !== 'number' || typeof unitPrice !== 'number') continue;
    items.push({
      ingredient,
      productId,
      ...(typeof raw.companyId === 'string' ? { companyId: raw.companyId } : {}),
      title,
      qty,
      unitPrice,
      isPromo: raw.isPromo === true,
      wasSubstituted: raw.wasSubstituted === true,
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    });
  }
  return items.length > 0 ? items : undefined;
}

function parseTotals(value: unknown): Totals | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.sum !== 'number') return undefined;
  return {
    sum: value.sum,
    ...(typeof value.budget === 'number' ? { budget: value.budget } : {}),
    promoShare: typeof value.promoShare === 'number' ? value.promoShare : 0,
    substitutionRate: typeof value.substitutionRate === 'number' ? value.substitutionRate : 0,
  };
}

/** Row → domain object. `undefined` when the stored menu is unusable; everything else is optional. */
export function parsePlanRow(row: {
  id: number;
  createdAt: Date;
  menuJson: unknown;
  resolvedJson: unknown;
  totalsJson: unknown;
}): StoredPlan | undefined {
  const menu = parseMenu(row.menuJson);
  if (!menu) return undefined;
  const resolvedItems = parseResolvedItems(row.resolvedJson);
  const totals = parseTotals(row.totalsJson);
  return {
    id: row.id,
    createdAt: row.createdAt,
    menu,
    ...(resolvedItems ? { resolvedItems } : {}),
    ...(totals ? { totals } : {}),
  };
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A plan counts as COMPLETE only at `stage: 'cart_built'` with a non-empty menu and a non-empty
 * resolved list — i.e. the user pressed 🛒 and the items actually reached the Silpo cart.
 *
 * Saving earlier (at `menu_proposed` or `list_resolved`) would fill the history with menus the
 * user looked at and rejected, and «повтори минулий план» would then offer back something they
 * already declined. Reaching the cart is the only unambiguous signal in the flow that the user
 * wanted this plan.
 */
export function isPlanComplete(state: SessionState): boolean {
  return state.stage === 'cart_built' && !!state.menu?.length && !!state.resolvedItems?.length;
}

/**
 * Identity of a plan for duplicate suppression. `cart_build` is an idempotent-ish button the user
 * can tap twice (or tap again after «Дешевше»), and each tap runs `finishWithCheckout`. Two rows
 * for one plan would make /plans read like the user cooked the same week twice. Menu plus the
 * product ids and quantities: an identical tap is skipped, while a genuinely re-resolved or
 * cheapened list is a different outcome and gets its own row.
 */
function planFingerprint(menu: Menu, items: ResolvedItems): string {
  return JSON.stringify([
    menu.map((d) => [d.day, d.dish, d.ingredients.map((i) => i.name)]),
    items.map((i) => [i.productId, i.qty]),
  ]);
}

/**
 * Persists the plan if `isPlanComplete`. Returns the new plan id, or `undefined` when nothing was
 * written (incomplete state, or a duplicate of the most recent plan) — callers treat both as a
 * silent no-op, since this is bookkeeping and must never interrupt the checkout message.
 */
export async function savePlanFromState(userId: number, state: SessionState): Promise<number | undefined> {
  if (!isPlanComplete(state)) return undefined;
  const menu = state.menu ?? [];
  const items = state.resolvedItems ?? [];

  const previous = await repo.getLastPlan(userId);
  if (previous) {
    const parsed = parsePlanRow(previous);
    if (parsed && planFingerprint(parsed.menu, parsed.resolvedItems ?? []) === planFingerprint(menu, items)) {
      return undefined;
    }
  }

  return repo.savePlan(userId, { menu, resolved: items, ...(state.totals ? { totals: state.totals } : {}) });
}

// ── Replaying ───────────────────────────────────────────────────────────────────────────────────

/**
 * Restores the most recent plan's MENU into the live session and rewinds the flow to
 * `menu_proposed`, so the ordinary ✅ path re-runs `resolveIngredients` against today's catalog,
 * today's branch and today's timeslot — see the file header for why the stored products are not
 * replayed. `cartContext` is deliberately left untouched: `ensureCartContext` already rebooks a
 * stale slot, and dropping it here would force a needless cart rebuild for a user replaying
 * minutes later.
 *
 * Mutates `state` in place and persists it, matching the local-tool convention.
 */
export async function loadLastPlanIntoState(userId: number, state: SessionState): Promise<LoadPlanResult> {
  const row = await repo.getLastPlan(userId);
  if (!row) return { ok: false, message: NO_PLANS_MESSAGE };

  const plan = parsePlanRow(row);
  if (!plan) return { ok: false, message: UNREADABLE_PLAN_MESSAGE };

  state.menu = plan.menu;
  // The old list is dropped rather than carried over: `cart_build` writes `resolvedItems` straight
  // into the real Silpo cart, so leaving week-old productIds there is exactly the failure mode this
  // module avoids. `totals` goes with it — totals for a list that no longer exists are misleading.
  delete state.resolvedItems;
  delete state.totals;
  state.stage = 'menu_proposed';
  await saveSession(userId, state);

  return { ok: true, plan };
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────

/** Genitive month names: Intl with a timeZone would drag in ICU assumptions for one short label. */
const MONTHS_UA = [
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

/**
 * «6 вересня» — day and month only; a year adds noise to a list that will only ever hold a few
 * weeks of plans. UTC parts, so the label does not shift with the server's timezone.
 */
export function formatPlanDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS_UA[date.getUTCMonth()] ?? ''}`.trim();
}

/**
 * One compact HTML block per plan, for a list of saved plans. Deliberately NOT the full menu:
 * `formatMenu` expands every ingredient and several of those would blow past Telegram's 4096-char
 * message cap. Render this to let the user choose, then `formatMenu(plan.menu)` once one is loaded.
 *
 * Pure — no I/O — so it is unit-testable, like the rest of bot/format.ts.
 */
export function formatPlanSummary(plan: StoredPlan): string {
  const days = new Set(plan.menu.map((m) => m.day)).size;
  const lines = [`📋 <b>Меню на ${days} ${pluralDays(days)}</b> · ${formatPlanDate(plan.createdAt)}`];

  for (const meal of plan.menu) {
    lines.push(`• День ${meal.day} — ${escapeHtml(meal.dish)}`);
  }

  // Prices are labelled as historical, never as current: they were read from Silpo on the day the
  // plan was built and a replay re-prices everything from scratch (see the file header).
  if (plan.totals) {
    const count = plan.resolvedItems?.length ?? 0;
    const parts = [`🧾 Тоді вийшло ${formatUah(plan.totals.sum)} грн`];
    if (count > 0) parts.push(`${count} ${pluralUa(count, 'позиція', 'позиції', 'позицій')}`);
    lines.push(parts.join(' · '));
  }

  return lines.join('\n');
}

// ── Agent tool ──────────────────────────────────────────────────────────────────────────────────

/**
 * Exported separately from `localTools()` so the parent can spread it into the tool map without
 * this workstream touching localTools.ts. Same contract as the local tools: `state` is mutated in
 * place and persisted here; the caller reads `state.stage` afterwards.
 *
 * Returning `{ok:false, message}` rather than throwing keeps the "no saved plans" case a friendly
 * answer: the model relays `message` verbatim instead of apologising for an error it can't explain.
 */
export function repeatLastPlanTool(userId: number, state: SessionState): Record<string, Tool> {
  return {
    repeat_last_plan: tool({
      description:
        'Повертає останній збережений план (меню) користувача і пропонує повторити його. Виклич це, ' +
        'коли користувач просить «повтори минулий план», «те саме, що минулого разу» тощо. Товари ' +
        'НЕ переносяться — ціни, акції та наявність будуть перевірені заново після підтвердження меню. ' +
        'Якщо повернулось {ok:false} — передай користувачу текст із поля message і не вигадуй меню.',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await loadLastPlanIntoState(userId, state);
        if (!result.ok) return result;
        return {
          ok: true,
          savedAt: result.plan.createdAt.toISOString(),
          menu: result.plan.menu,
          // Historical, for context only. The model is told above not to present it as current.
          previousTotalUah: result.plan.totals?.sum,
          note: 'Меню відновлено. Ціни й наявність буде перевірено заново після підтвердження.',
        };
      },
    }),
  };
}
