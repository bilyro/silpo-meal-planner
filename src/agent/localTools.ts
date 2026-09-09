import { tool, type Tool } from 'ai';
import { z } from 'zod';
import * as repo from '../db/repo.js';
import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { ensureCartContext } from './cartContext.js';
import { FACT_KINDS, hardRestrictions, kindLabel } from './memory.js';
import { resolveIngredients } from './resolveIngredients.js';
import { matchesForRemoval } from './selectProduct.js';
import { saveSession, type SessionState } from './session.js';

const proposeMenuInput = z.object({
  days: z.number().int().positive(),
  dishes: z.array(
    z.object({
      day: z.number().int().positive(),
      dish: z.string(),
      ingredients: z.array(z.object({ name: z.string(), qty: z.string() })),
    }),
  ),
});

const extraItemsInput = z.object({
  items: z.array(
    z.object({
      name: z.string().min(1).describe('Назва товару, як її назвав користувач, напр. «чіпси» або «пиво».'),
      qty: z
        .string()
        .optional()
        .describe('Кількість, якщо користувач її назвав, напр. «2 шт» або «1 упаковка». Інакше не вказуй.'),
    }),
  ),
});

const removeItemsInput = z.object({
  items: z
    .array(z.string().min(1))
    .min(1)
    .describe('Назви позицій, як їх назвав користувач, напр. ["лосось", "чіпси"].'),
});

const resolvedItemSchema = z.object({
  ingredient: z.string(),
  productId: z.string(),
  companyId: z.string().optional(),
  title: z.string(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  isPromo: z.boolean(),
  wasSubstituted: z.boolean(),
  note: z.string().optional(),
});

type ResolvedItems = NonNullable<SessionState['resolvedItems']>;
type Totals = NonNullable<SessionState['totals']>;

/**
 * Success metrics from spec §3.4 (`promo_share`, `substitution_rate`) plus the budget check.
 * Shares are 0–1 fractions of item count. Pure, so it can be unit-tested and reused.
 *
 * `unitPrice` is per kg/l for weighted goods and per package otherwise, with `qty` in the
 * matching unit, so `unitPrice × qty` is the correct line cost for both — see selectProduct.ts.
 */
export function computeTotals(items: ResolvedItems, budget?: number): Totals {
  const sum = items.reduce((acc, i) => acc + i.unitPrice * i.qty, 0);
  const count = items.length;
  return {
    sum: Math.round(sum * 100) / 100,
    ...(budget === undefined ? {} : { budget }),
    promoShare: count === 0 ? 0 : items.filter((i) => i.isPromo).length / count,
    substitutionRate: count === 0 ? 0 : items.filter((i) => i.wasSubstituted).length / count,
  };
}

/**
 * Persists a resolution into session state. Shared by the `record_resolution` tool (when the
 * model drives resolution) and by the 🛒 button flow in bot.ts (deterministic path) so the
 * totals maths and stage transition exist in exactly one place.
 */
export async function applyResolution(
  userId: number,
  state: SessionState,
  items: ResolvedItems,
): Promise<Totals> {
  const totals = computeTotals(items, state.request?.budgetUah);
  state.resolvedItems = items;
  state.totals = totals;
  state.stage = 'list_resolved';
  // A fresh list has not been written anywhere yet — a stale `true` from an earlier resolution
  // must not let finishWithCheckout() read the (unrelated) old cart as if it answered for this one.
  state.cartWritten = false;
  await saveSession(userId, state);
  return totals;
}

export interface AddExtraItemsResult {
  added: ResolvedItems;
  misses: string[];
  totals: Totals;
}

/**
 * Adds ad-hoc items the user asked for outside the meal plan's own ingredients (spec: "додай
 * чіпси і пиво") — appended to `state.resolvedItems`, never a replacement of it.
 *
 * The model supplies ONLY names + free-text quantities, exactly the same shape `propose_menu`
 * uses for recipe ingredients. It is never asked for — and never allowed to supply — a productId
 * or price: those come solely from `resolveIngredients()` against the live catalogue, the same
 * function and the same selection heuristic the confirmed-menu path already uses (`bot.ts`'s
 * `menu_confirm` handler). This is the same "never trust the model to retype tool-sourced data"
 * rule `finishWithCheckout` and `applyResolution`'s `cartWritten` reset already enforce elsewhere:
 * the model names NEW inputs, code resolves them for real and appends the result.
 *
 * Reuses `applyResolution` for the totals/stage/`cartWritten` bookkeeping over the COMBINED list,
 * so an old resolution's numbers are never retyped by hand and a stale cart-write flag cannot
 * survive a list that has since grown.
 */
export async function addExtraItems(
  userId: number,
  state: SessionState,
  mcp: SilpoMcpClient,
  wanted: { name: string; qty?: string }[],
): Promise<AddExtraItemsResult> {
  if (!state.cartContext?.timeslot) {
    throw new Error('Cart context has no timeslot — call ensure_cart_context before adding extra items');
  }

  const restrictions = await hardRestrictions(userId, state);
  // One synthetic "dish" holding every requested name — the same shape resolveIngredients()
  // already flattens menu ingredients from, so extra items go through IDENTICAL selection code
  // instead of a second, divergent implementation.
  const syntheticMenu: SessionState['menu'] = [
    { day: 0, dish: 'додаткові товари', ingredients: wanted.map((w) => ({ name: w.name, qty: w.qty ?? '' })) },
  ];

  const { items: newItems, misses } = await resolveIngredients(mcp, state.cartContext, syntheticMenu, {
    ...(restrictions.length > 0 ? { restrictions } : {}),
    // "чіпси" and "пиво" are exactly the processed/snack forms selectProduct normally demotes in
    // favour of a raw cooking ingredient — wrong here, since the processed form IS what was asked
    // for. See SelectionOptions.skipProcessedFormPenalty in selectProduct.ts.
    skipProcessedFormPenalty: true,
  });

  // As in removeItems: nothing to add (every requested item missed resolution) means the list is
  // unchanged, so a built cart must not be marked stale for a no-op.
  if (newItems.length === 0) {
    return {
      added: newItems,
      misses,
      totals: state.totals ?? computeTotals(state.resolvedItems ?? [], state.request?.budgetUah),
    };
  }

  const combined = [...(state.resolvedItems ?? []), ...newItems];
  const totals = await applyResolution(userId, state, combined);
  return { added: newItems, misses, totals };
}

export interface RemoveItemsResult {
  removed: ResolvedItems;
  notFound: string[];
  totals: Totals;
}

/** True when `name`, as the user said it, refers to this already-resolved line. */
function itemMatchesName(item: ResolvedItems[number], name: string): boolean {
  return matchesForRemoval(name, item.ingredient) || matchesForRemoval(name, item.title);
}

/**
 * Removes items the user asked to drop ("прибери лосось") — filtered out of `state.resolvedItems`
 * by code, never by asking the model to retype everything else that should survive. That mirrors
 * `addExtraItems`'s append: the model names WHICH existing lines go, code does the filtering, so a
 * line the user meant to keep can never be silently dropped or altered by a retyped list.
 *
 * Matching uses `matchesForRemoval` (`selectProduct.ts`) against both `ingredient` (what the user
 * originally asked for) and `title` (the actual resolved product) — Ukrainian-inflection tolerant
 * like the catalogue search's own `matchesQuery`, but strict about short words: unlike search
 * results (already narrowed by Silpo), an unfiltered "match everything" fallback here would delete
 * the wrong line for any common 3-letter Ukrainian food word («сир», «рис», «мед»).
 * Each requested name removes at most ONE line (`find`, not a sweep): "прибери яловина" removing
 * every beef-named line at once — including one the user didn't mean — would be a worse mistake
 * than occasionally needing to ask again with a more specific name.
 *
 * Reuses `applyResolution` for the totals/stage/`cartWritten` bookkeeping, so removing a line
 * invalidates a stale "already written to the real cart" flag exactly like adding one does.
 */
export async function removeItems(
  userId: number,
  state: SessionState,
  names: string[],
): Promise<RemoveItemsResult> {
  let remaining = state.resolvedItems ?? [];
  const removed: ResolvedItems = [];
  const notFound: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const match = remaining.find((item) => itemMatchesName(item, name));
    if (!match) {
      notFound.push(name);
      continue;
    }
    removed.push(match);
    remaining = remaining.filter((item) => item !== match);
  }

  // Only a REAL change invalidates a built cart. Every requested name missing (a typo, an
  // already-removed item) left `remaining` identical to `state.resolvedItems` — applyResolution's
  // unconditional `cartWritten = false` would otherwise wrongly demand pressing 🛒 again for a
  // cart that was never actually touched.
  if (removed.length === 0) {
    return { removed, notFound, totals: state.totals ?? computeTotals(remaining, state.request?.budgetUah) };
  }

  const totals = await applyResolution(userId, state, remaining);
  return { removed, notFound, totals };
}

export type RecallRecipeResult =
  | { found: true; source: 'personal' | 'shared'; dishName: string; ingredients: unknown; timesUsed: number }
  | { found: false };

/**
 * Looks up a dish this user already cooked before, for the model to check before inventing an
 * ingredient list from scratch — see `saveRecipe()`/`saveSharedRecipe()` in `db/repo.ts` for
 * where these get written (bot.ts's ✅ handler, only on a clean resolution) and the `recipes`
 * table's own doc comment for why only names/quantities are stored, never a resolved product or
 * price.
 *
 * Checks this user's OWN history first — most personalized, most trusted — and only falls back
 * to the cross-user `sharedRecipes` pool if this user has never cooked the dish. `source` tells
 * the model which one it got, so the prompt can ask for more adaptation caution on a shared
 * result (a stranger's family size and preferences, not this one's).
 */
export async function recallRecipe(userId: number, dishName: string): Promise<RecallRecipeResult> {
  const personal = await repo.findRecipe(userId, dishName);
  if (personal) {
    return { found: true, source: 'personal', dishName: personal.dishName, ingredients: personal.ingredientsJson, timesUsed: personal.timesUsed };
  }
  const shared = await repo.findSharedRecipe(dishName);
  if (shared) {
    return { found: true, source: 'shared', dishName: shared.dishName, ingredients: shared.ingredientsJson, timesUsed: shared.timesUsed };
  }
  return { found: false };
}

interface CartByIdResult {
  success: boolean;
  cart: Record<string, unknown>;
  loyalty: { bonusAvailable: number; bonusTotal: number; bonusRequested: number | null; isEnabled: boolean } | null;
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
}

export interface CheckoutSummary {
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
  loyalty?: CartByIdResult['loyalty'];
  /** Silpo's own total, including delivery — larger than our products-only `totals.sum`. */
  cartTotal?: number;
  /** Why checkout is unavailable, in Ukrainian, when Silpo blocks it. */
  blockers?: string[];
  error?: string;
}

interface CartValidation {
  level?: string;
  type?: string;
  message?: string;
  context?: Record<string, unknown>;
}

/**
 * Turns Silpo's cart validations into actionable Ukrainian text.
 *
 * Discovered live: a 359 грн cart returns no checkout link at all, with
 * `{level:'error', type:'order', message:'order.cost.min', context:{orderCostMin:799}}`. Silpo
 * enforces a minimum order value, so without surfacing this the user just sees a missing link and
 * no reason. Only `level: 'error'` entries block checkout; `info` ones (e.g. a payment method
 * being unavailable below some total) are not the user's problem here.
 */
export function describeBlockers(cart: Record<string, unknown>): string[] {
  const validations = (cart.calculation as { validations?: CartValidation[] } | undefined)?.validations ?? [];
  return validations
    .filter((v) => v.level === 'error')
    .map((v) => {
      if (v.message === 'order.cost.min') {
        const min = v.context?.orderCostMin;
        return `мінімальна сума замовлення${typeof min === 'number' ? ` — ${min} грн` : ''}`;
      }
      if (v.message === 'product.offer.stock.max') return 'одного з товарів не вистачає на складі';
      if (v.type === 'timeslot') return 'час доставки більше не доступний — потрібно обрати новий слот';
      return v.message ?? 'кошик не пройшов перевірку Сільпо';
    });
}

/**
 * Reads the built cart back and extracts the checkout links (spec §6.3 `finish_with_checkout`).
 * The links are TOP-LEVEL on the response, not inside the opaque `cart` passthrough, and are
 * absent while the cart is empty or has validation errors — hence both being optional.
 *
 * Shared by the local tool and bot.ts's 🛒 handler. Returns `{error}` rather than throwing so
 * either caller can surface it as a plain message.
 *
 * The `cartWritten` check exists because the model can call this (a read tool) at any time, but
 * has no write tool — so calling it before the button has actually run
 * `silpo_add_or_update_cart_products` reads whatever is ALREADY in the real Silpo cart (stale, or
 * empty) and has nothing to do with the resolution just discussed. Verified live: asked to "Збери
 * кошик" in free text with nothing written yet, the model composed a fabricated cart status
 * ("мінімум 599 грн, у кошику 188 грн") matching neither the real (empty) cart nor session state —
 * a stated system-prompt rule against this did not stop it on retest, so the read itself is
 * refused here instead, before there is any real number for the model to embellish.
 */
export async function finishWithCheckout(
  userId: number,
  state: SessionState,
  mcp: SilpoMcpClient,
): Promise<CheckoutSummary> {
  if (!state.cartContext) return { error: 'Немає контексту кошика — спочатку потрібно його створити.' };
  if (!state.cartWritten) {
    return { error: 'Кошик ще не зібрано — товари додає лише кнопка 🛒 «Зібрати кошик».' };
  }

  const cart = await mcp.callTool<CartByIdResult>('silpo_get_shopping_cart_by_id', {
    shoppingCartId: state.cartContext.cartId,
  });

  state.stage = 'cart_built';
  await saveSession(userId, state);

  const blockers = describeBlockers(cart.cart);
  const cartTotal = (cart.cart.calculation as { total?: number } | undefined)?.total;

  return {
    ...(cart.checkoutWebLink === undefined ? {} : { checkoutWebLink: cart.checkoutWebLink }),
    ...(cart.checkoutMobileLink === undefined ? {} : { checkoutMobileLink: cart.checkoutMobileLink }),
    ...(cart.loyalty == null ? {} : { loyalty: cart.loyalty }),
    ...(typeof cartTotal === 'number' ? { cartTotal } : {}),
    ...(blockers.length > 0 ? { blockers } : {}),
  };
}

/**
 * Local (non-MCP) tools: the spec §6.3 four (`propose_menu`, `ensure_cart_context`,
 * `record_resolution`, `finish_with_checkout`), the durable-memory tools (`remember_fact`,
 * `forget_fact`, `recall_facts`, `recall_recipe`), and the ad-hoc list edits (`add_extra_items`,
 * `remove_items`). `state` is mutated in place; the caller (runAgentTurn) persists it and reads
 * `state.stage` afterwards.
 */
export function localTools(userId: number, state: SessionState, mcp: SilpoMcpClient): Record<string, Tool> {
  return {
    propose_menu: tool({
      description:
        'Зберігає запропоноване меню (дні, страви, інгредієнти) і переводить розмову в стан очікування підтвердження користувача.',
      inputSchema: proposeMenuInput,
      execute: async (input) => {
        state.menu = input.dishes;
        state.stage = 'menu_proposed';
        await saveSession(userId, state);
        return { ok: true };
      },
    }),

    ensure_cart_context: tool({
      description:
        'Встановлює контекст кошика (адреса, філія, тип доставки, часовий слот). Виклич це ПЕРЕД ' +
        'будь-яким пошуком чи додаванням товарів, якщо контексту ще немає. Якщо повернулось ' +
        '{needsAddress:true} — запитай у користувача адресу доставки текстом і виклич ще раз із ' +
        'параметром address.',
      inputSchema: z.object({
        address: z
          .string()
          .optional()
          .describe('Адреса доставки текстом, напр. «Київ, вулиця Хрещатик, 1». Лише якщо користувач її назвав.'),
      }),
      execute: async ({ address }) => {
        const result = await ensureCartContext(mcp, state, address);
        await saveSession(userId, state);
        return result;
      },
    }),

    record_resolution: tool({
      description:
        'Зберігає підібраний список товарів (інгредієнт → товар) і рахує підсумки: суму, ' +
        'частку акційних позицій, частку замін і перевірку бюджету. Виклич це ПІСЛЯ того, як ' +
        'підібрав товари для всіх інгредієнтів.',
      inputSchema: z.object({ items: z.array(resolvedItemSchema) }),
      execute: async ({ items }) => {
        const totals = await applyResolution(userId, state, items);
        return { ok: true, totals };
      },
    }),

    // Ad-hoc items OUTSIDE the meal plan's own ingredients — "додай чіпси і пиво". Input is names
    // + free-text quantities ONLY: no price, no productId, so the model cannot retype (and
    // subtly corrupt) tool-sourced numbers the way record_resolution's full-list replacement
    // would risk. See addExtraItems() above for the resolution + append + totals bookkeeping.
    add_extra_items: tool({
      description:
        'Додає до вже підібраного списку товари, яких НЕ було в меню — те, що користувач попросив ' +
        'окремо («додай чіпси і пиво», «ще купи вологі салфетки»). Викликай ЛИШЕ назви й кількість, ' +
        'якщо користувач її назвав — товар і ціну підбирає код за живим каталогом. НЕ вигадуй ' +
        'productId чи ціну. Контекст кошика (ensure_cart_context) має вже існувати.',
      inputSchema: extraItemsInput,
      execute: async ({ items }) => {
        const { added, misses, totals } = await addExtraItems(userId, state, mcp, items);
        return { ok: true, added, misses, totals };
      },
    }),

    // Removes an already-resolved line by name — "прибери лосось". Filters state.resolvedItems
    // in code, never by asking the model to retype everything that should stay. See removeItems()
    // above for the matching + totals/cartWritten bookkeeping.
    remove_items: tool({
      description:
        'Прибирає товари зі вже підібраного списку за назвою — те, що користувач попросив прибрати ' +
        '(«прибери лосось», «без чіпсів»). Викликай ЛИШЕ назви, як їх назвав користувач — код сам ' +
        'знаходить відповідну позицію. Якщо позицію не знайдено — скажи про це користувачу, не вигадуй.',
      inputSchema: removeItemsInput,
      execute: async ({ items }) => {
        const { removed, notFound, totals } = await removeItems(userId, state, items);
        return { ok: true, removed: removed.map((r) => r.title), notFound, totals };
      },
    }),

    // Memory writes are deliberately narrow. The model picks from a fixed set of kinds and stores
    // one short phrase — it cannot invent a schema, and `source: 'user'` is hard-coded rather than
    // taken as an argument so a model-inferred fact can never be recorded as something the user
    // said. The tool returns the stored text so the reply can echo it back: a memory the user
    // cannot see is one they cannot correct, and a silently wrong allergy is worse than none.
    remember_fact: tool({
      description:
        'Запамʼятовує факт про користувача НАДОВГО (між сесіями): алергію, дієту, нелюбов до ' +
        'продукту, вподобання чи побутову деталь. Виклич це, коли користувач сам повідомив таке ' +
        'про себе («у мене алергія на горіхи», «ми не їмо свинину», «я вегетаріанка»). ' +
        'НЕ вигадуй факти і не зберігай здогадки — лише те, що користувач прямо сказав. ' +
        'Після виклику ОБОВʼЯЗКОВО підтверди користувачеві, що саме ти запамʼятав.',
      inputSchema: z.object({
        kind: z
          .enum(FACT_KINDS)
          .describe(
            'allergy — алергія (жорстка заборона); diet — дієта, напр. вегетаріанство (жорстка ' +
              'заборона); dislike — просто не любить; preference — вподобання; household — побут ' +
              '(напр. «готуємо на 4 осіб»).',
          ),
        text: z.string().min(2).max(200).describe('Коротко, українською, напр. «арахіс» або «без свинини».'),
      }),
      execute: async ({ kind, text }) => {
        const { created } = await repo.addUserFact({ userId, kind, text: text.trim(), source: 'user' });
        return { ok: true, created, stored: `${kindLabel(kind)}: ${text.trim()}` };
      },
    }),

    forget_fact: tool({
      description:
        'Забуває раніше збережений факт про користувача. Виклич, коли користувач каже, що щось ' +
        'більше не актуальне («я більше не вегетаріанка», «забудь про алергію»). Спочатку виклич ' +
        'recall_facts, щоб дізнатися id потрібного факту.',
      inputSchema: z.object({ id: z.number().int().positive() }),
      execute: async ({ id }) => ({ ok: await repo.deactivateUserFact(userId, id) }),
    }),

    recall_facts: tool({
      description: 'Повертає всі збережені факти про користувача разом з їх id.',
      inputSchema: z.object({}),
      execute: async () => ({
        facts: (await repo.listUserFacts(userId)).map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
      }),
    }),

    // Checks for an already-cooked dish before inventing its ingredients from scratch. Read-only —
    // saving happens deterministically in bot.ts's ✅ handler, only once a resolution is clean.
    recall_recipe: tool({
      description:
        'Перевіряє, чи вже хтось готував цю страву — спочатку у цього користувача, потім у ' +
        'спільній базі інших користувачів — повертає збережений список інгредієнтів, якщо є. ' +
        'Виклич це ПЕРЕД тим, як самостійно вигадувати склад страви, коли назва схожа на щось, що ' +
        'могли просити раніше (напр. «борщ», «плов»). Якщо знайдено — адаптуй ці інгредієнти під ' +
        'поточний запит (розмір сім\'ї, нові побажання), а не копіюй бездумно; якщо source=' +
        '"shared" — це рецепт ІНШОГО користувача, тож зваж це ще уважніше. Якщо не знайдено — ' +
        'склади страву як завжди.',
      inputSchema: z.object({ dishName: z.string().min(1) }),
      execute: async ({ dishName }) => recallRecipe(userId, dishName),
    }),

    finish_with_checkout: tool({
      description:
        'Читає зібраний кошик і повертає посилання на оформлення та бонусний баланс. Виклич ' +
        'це ПІСЛЯ додавання товарів у кошик. Твоя робота закінчується цим посиланням — ' +
        'не намагайся оформити чи оплатити замовлення.',
      // No cartId argument: it is read from session state rather than trusted from the model,
      // which could otherwise pass a stale or invented cart id.
      inputSchema: z.object({}),
      execute: async () => finishWithCheckout(userId, state, mcp),
    }),
  };
}
