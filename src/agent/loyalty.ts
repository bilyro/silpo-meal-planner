/**
 * Loyalty, coupons and promo codes at checkout (spec §8 Phase 6 step 1).
 *
 * Split the way the rest of `agent/` is: thin MCP wrappers at the top, everything that decides or
 * renders is pure and lives below, so the whole display layer is testable without a mock client.
 *
 * Verified live against the dev account on 6 Sept 2026 — see the notes on each fetcher for what
 * the server actually returns; several of the shapes below differ from what spec §8 assumes.
 */

import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { escapeHtml, formatUah } from '../bot/format.js';

/** `silpo_get_loyalty_info` → `loyalty`. */
export interface LoyaltyInfo {
  card?: { barcode?: string; typeName?: string; memberId?: number };
  balance?: { total?: number; currency?: string; accounts?: Array<{ type?: string; amount?: number }> };
}

/** The `loyalty` block `silpo_get_shopping_cart_by_id` already returns (see localTools.ts). */
export interface CartLoyalty {
  bonusAvailable: number;
  bonusTotal: number;
  bonusRequested: number | null;
  isEnabled: boolean;
}

/**
 * One thing the user could get money off with. Two sources, and they behave differently:
 * a `coupon` is already attached to the loyalty card and applies itself at checkout, while a
 * `promo_code` carries a `code` string we can push into the cart ourselves.
 */
export interface Offer {
  kind: 'coupon' | 'promo_code';
  id: string;
  title: string;
  /** Silpo's own wording of the reward, e.g. «-10%» or «за 1 грн». */
  reward?: string;
  /** Present only when the offer can be applied programmatically. */
  code?: string;
  warning?: string;
  /** Last day the offer is valid, as Silpo returns it (`YYYY-MM-DD`). */
  endsAt?: string;
}

// ---------------------------------------------------------------------------
// MCP calls
// ---------------------------------------------------------------------------

/**
 * Loyalty card and balance.
 *
 * ⚠️ Largely redundant with what `finishWithCheckout` already has: on the dev account
 * `balance.total` (12.46) is exactly the cart's `loyalty.bonusTotal`, and the number that actually
 * matters at checkout — `bonusAvailable`, how much of the balance this particular cart may absorb
 * — exists ONLY on the cart (it was 0 while the balance was 12.46). What this call adds is the
 * per-account split (`Regular` vs `Moneybox` / «Скарбничка») and the card tier/barcode. So it is
 * optional garnish, not the source of the bonus figure; `formatLoyaltyBlock` works without it.
 *
 * Never throws: a decorative extra must not be able to fail a cart that was built successfully.
 */
export async function fetchLoyalty(mcp: SilpoMcpClient): Promise<LoyaltyInfo | undefined> {
  try {
    const res = await mcp.callTool<{ success?: boolean; loyalty?: LoyaltyInfo }>('silpo_get_loyalty_info', {});
    return res.loyalty;
  } catch {
    return undefined;
  }
}

/**
 * Everything the user could redeem, from both sources, normalised into one list.
 *
 * The two calls are independent, so they run together and fail independently — an account with
 * coupons but a broken promo-code endpoint still shows its coupons.
 */
export async function fetchOffers(mcp: SilpoMcpClient, now: Date = new Date()): Promise<Offer[]> {
  const [coupons, promoCodes] = await Promise.all([
    mcp.callTool<unknown>('silpo_get_my_coupons', {}).catch(() => undefined),
    mcp.callTool<unknown>('silpo_get_promo_codes', {}).catch(() => undefined),
  ]);
  return toOffers(coupons, promoCodes, now);
}

/** Fields `silpo_update_shopping_cart` insists on even when we only want to change one setting. */
interface CartSettings {
  deliveryType: unknown;
  timeslot: unknown;
  address: unknown;
  shipments: unknown;
}

export interface PromoCodeResult {
  ok: boolean;
  /** Ukrainian, ready to show to the user. */
  message: string;
  /** Silpo's total after the update, when it could be read back. */
  cartTotal?: number;
}

/**
 * Applies a promo code to the cart.
 *
 * ⚠️ UNVERIFIED against the live server — writing to a real account was out of scope for this
 * work, and the dev account has no promo codes to test with. Everything below follows the
 * `silpo_update_shopping_cart` inputSchema in docs/tools.json.
 *
 * Spec §8 Phase 6 says «calls silpo_update_shopping_cart with it», which reads like a one-field
 * patch. It is not: the tool requires `deliveryType`, `timeslot`, `address` and `shipments` on
 * every call, and its own description says to copy them from the current cart response as-is. So
 * this reads the cart first and echoes them back unchanged — omitting any of them is an input
 * validation error, and inventing them would silently move the order.
 *
 * Then it re-reads the cart, because the server accepts an unknown code without complaint: the
 * only reliable signal is whether `cart.promoCode` came back set (it is `null` on a cart with no
 * code — verified live).
 */
export async function applyPromoCode(
  mcp: SilpoMcpClient,
  cartId: string,
  code: string,
): Promise<PromoCodeResult> {
  const before = await readCart(mcp, cartId);
  const settings = cartSettings(before);
  if (!settings) {
    return { ok: false, message: 'Не вдалося прочитати кошик — спробуйте ще раз.' };
  }

  await mcp.callTool('silpo_update_shopping_cart', {
    shoppingCartId: cartId,
    ...settings,
    promoCode: code,
  });

  const after = await readCart(mcp, cartId);
  const applied = str(after?.promoCode);
  const total = num((asRecord(after?.calculation) ?? {}).total);

  if (applied && applied.toLowerCase() === code.toLowerCase()) {
    return {
      ok: true,
      message: `Промокод <b>${escapeHtml(code)}</b> застосовано${total === undefined ? '' : ` — до сплати ${formatUah(total)} грн`}.`,
      ...(total === undefined ? {} : { cartTotal: total }),
    };
  }
  return {
    ok: false,
    message: `Сільпо не прийняло промокод <b>${escapeHtml(code)}</b> — можливо, він недійсний для цього замовлення.`,
    ...(total === undefined ? {} : { cartTotal: total }),
  };
}

async function readCart(mcp: SilpoMcpClient, cartId: string): Promise<Record<string, unknown> | undefined> {
  const res = await mcp.callTool<{ cart?: Record<string, unknown> }>('silpo_get_shopping_cart_by_id', {
    shoppingCartId: cartId,
  });
  return res.cart;
}

function cartSettings(cart: Record<string, unknown> | undefined): CartSettings | undefined {
  if (!cart) return undefined;
  const { deliveryType, timeslot, address, shipments } = cart;
  if (deliveryType === undefined || timeslot === undefined || address === undefined || shipments === undefined) {
    return undefined;
  }
  return { deliveryType, timeslot, address, shipments };
}

// ---------------------------------------------------------------------------
// Pure normalisation
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A `YYYY-MM-DD` end date means the offer is good *through* that day, so a bare `Date.parse`
 * (UTC midnight) would retire it a day early. Timestamps that already carry a time are used as-is.
 */
function isExpired(endsAt: string | undefined, now: Date): boolean {
  if (!endsAt) return false;
  const at = Date.parse(endsAt.includes('T') ? endsAt : `${endsAt}T23:59:59`);
  return Number.isFinite(at) && at < now.getTime();
}

/**
 * Live shape of `silpo_get_my_coupons.coupons[]`:
 * `{id, active, description, limitText, warningText, endDate, endDateTime, rewardText,
 *   rewardValue, rewardUnit, rewardSign, rewardLimit, promoId, …}`.
 *
 * Use `rewardText` verbatim and never compose the reward from `rewardSign`+`rewardValue`+
 * `rewardUnit`: a live coupon reads `sign:"за "`, `value:1`, `unit:"грн"` and means «за 1 грн»
 * (buy it for 1 UAH), which naive concatenation would render as a 1 грн discount.
 *
 * Coupons carry no code — they sit on the loyalty card and apply themselves — so they are shown,
 * not applied. Only `promoCodes[]` entries are actionable.
 */
export function toOffers(couponsResponse: unknown, promoCodesResponse: unknown, now: Date = new Date()): Offer[] {
  const coupons = asArray(asRecord(couponsResponse)?.coupons)
    .map(asRecord)
    .filter((c): c is Record<string, unknown> => c !== undefined)
    .filter((c) => c.active !== false)
    .map((c): Offer => {
      const offer: Offer = {
        kind: 'coupon',
        id: String(c.id ?? c.promoId ?? ''),
        title: str(c.description) ?? 'купон',
      };
      const reward = str(c.rewardText);
      const warning = str(c.warningText);
      const endsAt = str(c.endDateTime) ?? str(c.endDate);
      if (reward) offer.reward = reward;
      if (warning) offer.warning = warning;
      if (endsAt) offer.endsAt = endsAt;
      return offer;
    });

  // INFERRED, not verified: the dev account returns `{promoCodes: [], meta:{total:0}}`, so the
  // element shape is unknown. Read the code from whichever of the plausible keys is present and
  // drop anything with no code at all — an entry we cannot name is also one we cannot apply.
  const promoCodes = asArray(asRecord(promoCodesResponse)?.promoCodes)
    .map(asRecord)
    .filter((p): p is Record<string, unknown> => p !== undefined)
    .map((p): Offer | undefined => {
      const code = str(p.code) ?? str(p.promoCode) ?? str(p.name);
      if (!code) return undefined;
      const offer: Offer = {
        kind: 'promo_code',
        id: code,
        code,
        title: str(p.description) ?? str(p.title) ?? code,
      };
      const reward = str(p.rewardText) ?? str(p.discountText);
      const warning = str(p.warningText);
      const endsAt = str(p.endDateTime) ?? str(p.endDate) ?? str(p.dateTo);
      if (reward) offer.reward = reward;
      if (warning) offer.warning = warning;
      if (endsAt) offer.endsAt = endsAt;
      return offer;
    })
    .filter((o): o is Offer => o !== undefined);

  // Actionable offers first: those are the ones the «застосувати» button can do something with.
  return [...promoCodes, ...coupons].filter((o) => !isExpired(o.endsAt, now));
}

/** The offer the apply-button should target, if any: the first one carrying a real code. */
export function firstApplicableCode(offers: Offer[]): string | undefined {
  return offers.find((o) => o.kind === 'promo_code' && o.code)?.code;
}

// ---------------------------------------------------------------------------
// Pure formatting
// ---------------------------------------------------------------------------

/** Telegram messages are capped at 4096 chars and the checkout reply already carries the list. */
const MAX_OFFERS_SHOWN = 4;

function formatDate(iso: string): string {
  const [datePart] = iso.split('T');
  const parts = (datePart ?? '').split('-');
  const [y, m, d] = parts;
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

function bonusLine(cartLoyalty: CartLoyalty | null | undefined, info: LoyaltyInfo | undefined): string | undefined {
  const balance = cartLoyalty?.bonusTotal ?? info?.balance?.total;
  const moneybox = info?.balance?.accounts?.find((a) => a.type === 'Moneybox')?.amount;
  const available = cartLoyalty?.isEnabled ? cartLoyalty.bonusAvailable : undefined;

  // Nothing on the card and nothing spendable: say nothing rather than «0 грн бонусів».
  if (!balance && !available) return undefined;

  const parts: string[] = [];
  if (balance) parts.push(`${formatUah(balance)} грн на рахунку`);
  if (moneybox) parts.push(`${formatUah(moneybox)} грн у Скарбничці`);
  // bonusAvailable is per-cart and is routinely 0 even with a positive balance (Silpo caps how
  // much of an order bonuses may cover), so mention spending only when it is actually possible.
  if (available) parts.push(`можна списати ${formatUah(available)} грн`);
  return `💳 <b>Балобонуси:</b> ${parts.join(' · ')}`;
}

export interface LoyaltyBlockInput {
  /** From `finishWithCheckout` — the authoritative source of the bonus numbers. */
  cartLoyalty?: CartLoyalty | null;
  /** From `fetchLoyalty` — optional; only adds the Скарбничка split. */
  info?: LoyaltyInfo | undefined;
  offers?: Offer[];
  /** A code already on the cart (`cart.promoCode`), so it is reported as applied, not offered. */
  appliedPromoCode?: string | null;
}

/**
 * Renders the loyalty/coupon block appended to the checkout reply. Pure — every value comes from
 * tool output, per spec §11 (nothing user-visible may be model prose).
 *
 * Returns '' when there is nothing to say: an account with a zero balance, no coupons and no
 * promo codes must add no lines at all, not an empty header.
 */
export function formatLoyaltyBlock(input: LoyaltyBlockInput): string {
  const lines: string[] = [];

  const bonus = bonusLine(input.cartLoyalty, input.info);
  if (bonus) lines.push(bonus);

  const applied = str(input.appliedPromoCode ?? undefined);
  if (applied) lines.push(`🏷 Промокод <b>${escapeHtml(applied)}</b> застосовано`);

  // An applied code is no longer an offer to make.
  const offers = (input.offers ?? []).filter((o) => o.code === undefined || o.code !== applied);
  if (offers.length > 0) {
    lines.push('🎟 <b>Ваші пропозиції</b>');
    for (const offer of offers.slice(0, MAX_OFFERS_SHOWN)) {
      const reward = offer.reward ? `<b>${escapeHtml(offer.reward)}</b> — ` : '';
      const until = offer.endsAt ? ` (до ${formatDate(offer.endsAt)})` : '';
      const code = offer.code ? ` <code>${escapeHtml(offer.code)}</code>` : '';
      lines.push(`• ${reward}${escapeHtml(offer.title)}${code}${until}`);
      if (offer.warning) lines.push(`   ⚠️ ${escapeHtml(offer.warning)}`);
    }
    const hidden = offers.length - MAX_OFFERS_SHOWN;
    if (hidden > 0) lines.push(`   …та ще ${hidden}`);
    // Coupons are attached to the loyalty card and need no action from us; without this the user
    // sees a discount listed and wonders why there is no button for it.
    if (offers.some((o) => o.kind === 'coupon')) {
      lines.push('<i>Купони застосуються автоматично при оплаті.</i>');
    }
  }

  return lines.join('\n');
}
