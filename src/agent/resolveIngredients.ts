/**
 * Ingredient → product resolution (spec §8 Phase 5 steps 1–3), the orchestration half of the
 * selection logic whose pure core lives in `selectProduct.ts`.
 *
 * Flow: flatten + dedupe the menu's ingredients → `silpo_find_products_batch` in ≤30-item chunks
 * → `selectProduct` per ingredient → `silpo_get_replacements` for items that exist but are out of
 * stock. Produces `SessionState.resolvedItems` plus the list of ingredients nothing was found for.
 *
 * Deviations from the spec, both driven by live-verified behaviour in `docs/phase5-findings.md`:
 *
 * - §8 Phase 5 step 1 guesses `silpo_find_products_batch` takes `[{query, limit}]`. It actually
 *   takes `products: string[]` with a top-level `limit`, and the four cart-context fields are
 *   FLAT (`timeslotStart`/`timeslotEnd`, not a nested `timeslot`). The response nests results
 *   under `queries` — the inverse of the input key name.
 * - §8 Phase 5 step 2 says to fetch `silpo_get_promotions` and build a `Set<productId>`. That
 *   tool returns promo *campaigns* carrying no product ids, so it is not called here at all;
 *   `selectProduct` reads promo status per-product from `specialPrices`/`oldPrice` instead.
 */

import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import type { SessionState } from './session.js';
import {
  computeQuantity,
  isAvailable,
  isPromo,
  selectProduct,
  unitPrice,
  violatesRestrictions,
  type ProductCandidate,
} from './selectProduct.js';

type ResolvedItems = NonNullable<SessionState['resolvedItems']>;
type CartContext = NonNullable<SessionState['cartContext']>;
type Menu = NonNullable<SessionState['menu']>;

export interface ResolutionResult {
  items: ResolvedItems;
  /** Ingredient names nothing usable was found for. */
  misses: string[];
}

interface BatchQueryResult {
  query: string;
  totalFound: number;
  products: ProductCandidate[];
}

interface FindProductsBatchResult {
  success: boolean;
  queries?: BatchQueryResult[];
}

interface ReplacementsResult {
  success: boolean;
  items?: Array<{ productId: string; replacements?: ProductCandidate[] }>;
}

/** Silpo caps `products` at 30 per call (`maxItems` in the tool's own JSON Schema). */
const MAX_QUERIES_PER_BATCH = 30;
const RESULTS_PER_QUERY = 5;

interface WantedIngredient {
  name: string;
  qty: string;
}

/**
 * Rough magnitude of a free-text amount, used ONLY to pick between duplicate mentions of the same
 * ingredient — not for ordering (that is `computeQuantity`, which needs the product's weight step).
 * Mass/volume normalise to a common base so «500 г» and «1 кг» compare; counts stay as-is.
 */
function qtyMagnitude(qtyText: string): number {
  const m = /([\d.,]+)\s*(кг|г|мл|л)?/i.exec(qtyText.trim());
  const amount = m?.[1] ? Number(m[1].replace(',', '.')) : NaN;
  if (!Number.isFinite(amount)) return 0;
  const unit = m?.[2]?.toLowerCase();
  if (unit === 'кг' || unit === 'л') return amount * 1000;
  if (unit === 'г' || unit === 'мл') return amount;
  return amount;
}

/**
 * One product is bought per ingredient regardless of how many dishes use it, so when the same
 * ingredient appears on several days we keep the LARGEST stated amount. Summing would be more
 * accurate but the units are frequently incomparable («3 зубчики» vs «1 головка»); taking the max
 * at least errs toward buying enough rather than too little.
 */
export function collectIngredients(menu: Menu): WantedIngredient[] {
  const byName = new Map<string, WantedIngredient>();
  for (const day of menu) {
    for (const ing of day.ingredients ?? []) {
      const name = ing.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { name, qty: ing.qty ?? '' });
      } else if (qtyMagnitude(ing.qty ?? '') > qtyMagnitude(existing.qty)) {
        existing.qty = ing.qty ?? '';
      }
    }
  }
  return [...byName.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toResolvedItem(
  ingredient: string,
  qtyText: string,
  product: ProductCandidate,
  promo: boolean,
  perUnit: number,
  wasSubstituted: boolean,
  note?: string,
): ResolvedItems[number] {
  // `companyId` is REQUIRED by silpo_add_or_update_cart_products. The schema allows null, so a
  // missing one is surfaced as a note rather than silently dropped — the item still shows in the
  // list, but the cart build would reject it.
  const notes = [note, product.companyId ? undefined : 'немає companyId — не вдасться додати в кошик']
    .filter(Boolean)
    .join('; ');
  return {
    ingredient,
    productId: product.id,
    ...(product.companyId ? { companyId: product.companyId } : {}),
    title: product.name,
    qty: computeQuantity(qtyText, product),
    unitPrice: perUnit,
    isPromo: promo,
    wasSubstituted,
    ...(notes ? { note: notes } : {}),
  };
}

/**
 * Ranks replacement candidates. Deliberately skips `selectProduct`'s query-relevance filter: a
 * legitimate substitute usually has a different name (turkey fillet for chicken fillet), so
 * requiring the original query's stem would reject exactly the results we asked for. Availability
 * and food restrictions still apply — those are correctness, not relevance.
 */
function bestReplacement(candidates: ProductCandidate[], restrictions?: string[]): ProductCandidate | undefined {
  return candidates
    .filter((p) => isAvailable(p) && !violatesRestrictions(p.name, restrictions))
    .sort((a, b) => {
      const promoDelta = Number(isPromo(b)) - Number(isPromo(a));
      if (promoDelta !== 0) return promoDelta;
      return unitPrice(a) - unitPrice(b);
    })[0];
}

export async function resolveIngredients(
  mcp: SilpoMcpClient,
  cartContext: CartContext,
  menu: Menu,
  opts: { restrictions?: string[] } = {},
): Promise<ResolutionResult> {
  if (!cartContext.timeslot) {
    // The 🔒 batch-search tool requires timeslotStart/End; without them every call would fail
    // validation. Fail loudly here so the caller can tell the user to re-establish cart context.
    throw new Error('Cart context has no timeslot — call ensure_cart_context before resolving ingredients');
  }

  const wanted = collectIngredients(menu);
  if (wanted.length === 0) return { items: [], misses: [] };

  const searchContext = {
    branchId: cartContext.branchId,
    deliveryType: cartContext.deliveryType,
    timeslotStart: cartContext.timeslot.start,
    timeslotEnd: cartContext.timeslot.end,
  };

  // Candidates keyed by the query string we sent, so a failed chunk simply leaves its ingredients
  // absent from the map and they fall through to `misses` below.
  const candidatesByQuery = new Map<string, ProductCandidate[]>();
  const chunks = chunk(wanted, MAX_QUERIES_PER_BATCH);
  let failedChunks = 0;
  let lastChunkError: unknown;

  for (const group of chunks) {
    try {
      const res = await mcp.callTool<FindProductsBatchResult>('silpo_find_products_batch', {
        ...searchContext,
        products: group.map((w) => w.name),
        limit: RESULTS_PER_QUERY,
      });
      for (const entry of res.queries ?? []) {
        candidatesByQuery.set(entry.query.toLowerCase(), entry.products ?? []);
      }
    } catch (err) {
      // One bad chunk must not discard the others' work, so record and continue. If EVERY chunk
      // failed nothing useful happened, so the error is rethrown after the loop for the caller
      // to surface — a silent "0 items found" would be badly misleading there.
      failedChunks += 1;
      lastChunkError = err;
    }
  }
  if (failedChunks === chunks.length) throw lastChunkError;

  const items: ResolvedItems = [];
  const misses: string[] = [];

  for (const want of wanted) {
    const candidates = candidatesByQuery.get(want.name.toLowerCase()) ?? [];
    const picked = selectProduct(want.name, candidates, { restrictions: opts.restrictions });

    if (picked) {
      items.push(toResolvedItem(want.name, want.qty, picked.product, picked.isPromo, picked.unitPrice, false));
      continue;
    }

    // Nothing selectable. Replacements are only askable about a product we already know, and the
    // tool needs that product's companyId — so this path applies when the search DID return a
    // relevant match that was merely out of stock, not when the search found nothing at all.
    const outOfStockMatch = candidates.find(
      (p) => !isAvailable(p) && p.companyId && !violatesRestrictions(p.name, opts.restrictions),
    );
    if (!outOfStockMatch?.companyId) {
      misses.push(want.name);
      continue;
    }

    try {
      const res = await mcp.callTool<ReplacementsResult>('silpo_get_replacements', {
        branchId: cartContext.branchId,
        companyId: outOfStockMatch.companyId,
        productIds: [outOfStockMatch.id],
        deliveryType: cartContext.deliveryType,
      });
      const offered = (res.items ?? []).flatMap((entry) => entry.replacements ?? []);
      const substitute = bestReplacement(offered, opts.restrictions);
      if (!substitute) {
        misses.push(want.name);
        continue;
      }
      items.push(
        toResolvedItem(
          want.name,
          want.qty,
          substitute,
          isPromo(substitute),
          unitPrice(substitute),
          true,
          `заміна для «${want.name}» — товару не було в наявності`,
        ),
      );
    } catch {
      // A failed replacement lookup is not fatal to the rest of the list — treat as a miss so the
      // user still gets everything else and can decide what to do about this one ingredient.
      misses.push(want.name);
    }
  }

  return { items, misses };
}
