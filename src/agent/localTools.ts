import { tool, type Tool } from 'ai';
import { z } from 'zod';
import * as repo from '../db/repo.js';
import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { ensureCartContext } from './cartContext.js';
import { FACT_KINDS, kindLabel } from './memory.js';
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
 * `record_resolution`, `finish_with_checkout`) plus the durable-memory tools
 * (`remember_fact`, `forget_fact`, `recall_facts`). `state` is mutated in place; the
 * caller (runAgentTurn) persists it and reads `state.stage` afterwards.
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
