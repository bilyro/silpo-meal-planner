import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { ensureCartContext } from './cartContext.js';
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
  error?: string;
}

/**
 * Reads the built cart back and extracts the checkout links (spec §6.3 `finish_with_checkout`).
 * The links are TOP-LEVEL on the response, not inside the opaque `cart` passthrough, and are
 * absent while the cart is empty or has validation errors — hence both being optional.
 *
 * Shared by the local tool and bot.ts's 🛒 handler. Returns `{error}` rather than throwing so
 * either caller can surface it as a plain message.
 */
export async function finishWithCheckout(
  userId: number,
  state: SessionState,
  mcp: SilpoMcpClient,
): Promise<CheckoutSummary> {
  if (!state.cartContext) return { error: 'Немає контексту кошика — спочатку потрібно його створити.' };

  const cart = await mcp.callTool<CartByIdResult>('silpo_get_shopping_cart_by_id', {
    shoppingCartId: state.cartContext.cartId,
  });

  state.stage = 'cart_built';
  await saveSession(userId, state);

  return {
    ...(cart.checkoutWebLink === undefined ? {} : { checkoutWebLink: cart.checkoutWebLink }),
    ...(cart.checkoutMobileLink === undefined ? {} : { checkoutMobileLink: cart.checkoutMobileLink }),
    ...(cart.loyalty == null ? {} : { loyalty: cart.loyalty }),
  };
}

/**
 * Local (non-MCP) tools, spec §6.3 — all four are now present. `state` is mutated in place; the
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
