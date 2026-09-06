/**
 * Product selection heuristic (spec §6.4), kept pure and MCP-free so it is unit-testable —
 * orchestration and tool calls live in resolveIngredients.ts.
 *
 * Deviates from spec §6.4 step 2 deliberately: the spec says to build a `Set<productId>` from
 * `silpo_get_promotions` and prefer members of it. That tool returns promo *campaigns* with no
 * product ids at all (verified live — see docs/phase5-findings.md), so promo status is read
 * per-product from `specialPrices` / `oldPrice`, which search results already carry. Cheaper too:
 * no extra call and no cross-referencing 1400-item campaigns.
 */

/** One candidate as returned inside `silpo_find_products_batch`'s `queries[].products[]`. */
export interface ProductCandidate {
  id: string;
  name: string;
  slug?: string;
  price: number;
  oldPrice?: number | null;
  stock?: number | null;
  available?: boolean | null;
  /** True for goods sold by weight, where `quantity` is in kg and must be a multiple of `step`. */
  weighted?: boolean | null;
  step?: number | null;
  /** e.g. "100г" — the unit `price` is quoted per, for weighted goods. */
  displayRatio?: string | null;
  specialPrices?: unknown;
  companyId?: string | null;
}

export interface SelectionOptions {
  /** Lowercased restriction keywords, e.g. ['свинина', 'лактоза']. */
  restrictions?: string[];
}

export interface Selection {
  product: ProductCandidate;
  isPromo: boolean;
  /** Price normalised per kg / per litre / per piece, for comparing unlike package sizes. */
  unitPrice: number;
}

export function isPromo(p: ProductCandidate): boolean {
  if (p.specialPrices != null && !(Array.isArray(p.specialPrices) && p.specialPrices.length === 0)) return true;
  return typeof p.oldPrice === 'number' && p.oldPrice > p.price;
}

export function isAvailable(p: ProductCandidate): boolean {
  if (p.available === false) return false;
  if (typeof p.stock === 'number' && p.stock <= 0) return false;
  return true;
}

/**
 * Silpo's search is fuzzy — «куряче філе» returns «Качине філе» (duck) among its hits (spec §11
 * anticipated this). Require at least one meaningful word of the query to appear in the product
 * name, so an unrelated top hit cannot be selected silently.
 */
export function matchesQuery(query: string, name: string): boolean {
  const haystack = name.toLowerCase();
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return true;
  // EVERY distinguishing word must appear, not merely one: «куряче філе» vs «Качине філе домашнє»
  // shares «філе», so an `.some()` check passed duck for a chicken query — the exact failure this
  // filter exists to prevent. Requiring all words can reject a valid oddly-named product, and that
  // asymmetry is deliberate: a miss surfaces to the user as «не знайшли», whereas a false match
  // silently orders the wrong meat and can violate a stated dietary restriction.
  //
  // Ukrainian inflects heavily («куряче» vs «курячий»), so compare on a truncated stem.
  return words.every((w) => haystack.includes(w.slice(0, Math.max(4, w.length - 2))));
}

export function violatesRestrictions(name: string, restrictions: string[] = []): boolean {
  const haystack = name.toLowerCase();
  return restrictions.some((r) => r.trim().length > 0 && haystack.includes(r.toLowerCase().trim()));
}

/**
 * Normalises price so different package sizes are comparable. `price` on a weighted product is
 * quoted per `displayRatio` (e.g. "100г"), so scale it to a full kg/litre; piece goods compare
 * as-is. Falls back to the raw price whenever the ratio can't be parsed — a wrong-but-consistent
 * comparison beats discarding the candidate.
 */
export function unitPrice(p: ProductCandidate): number {
  if (!p.weighted || !p.displayRatio) return p.price;
  const m = /([\d.,]+)\s*(кг|г|мл|л)/i.exec(p.displayRatio);
  if (!m?.[1] || !m[2]) return p.price;
  const amount = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return p.price;
  const unit = m[2].toLowerCase();
  const perBase = unit === 'г' || unit === 'мл' ? amount / 1000 : amount;
  return p.price / perBase;
}

/**
 * Picks one product for an ingredient: in stock and allowed first, then promo items ahead of
 * non-promo (spec §6.4 step 2 — promos are the business value), and cheapest per unit within
 * each group. Returns undefined when nothing survives filtering, which is the caller's signal to
 * try `silpo_get_replacements`.
 */
export function selectProduct(
  query: string,
  candidates: ProductCandidate[],
  options: SelectionOptions = {},
): Selection | undefined {
  const viable = candidates.filter(
    (p) =>
      isAvailable(p) &&
      !violatesRestrictions(p.name, options.restrictions) &&
      matchesQuery(query, p.name),
  );
  if (viable.length === 0) return undefined;

  const ranked = viable
    .map((product) => ({ product, isPromo: isPromo(product), unitPrice: unitPrice(product) }))
    .sort((a, b) => {
      if (a.isPromo !== b.isPromo) return a.isPromo ? -1 : 1;
      return a.unitPrice - b.unitPrice;
    });

  return ranked[0];
}

/**
 * Turns a free-text ingredient amount («500 г», «2 шт», «3 зубчики») into an orderable quantity.
 * Weighted goods are ordered in kg rounded UP to a whole number of `step` increments (Silpo
 * rejects off-step quantities); everything else is ordered as a whole number of packages, with
 * an unparseable or non-mass amount falling back to 1.
 */
export function computeQuantity(qtyText: string, p: ProductCandidate): number {
  const step = typeof p.step === 'number' && p.step > 0 ? p.step : undefined;
  const m = /([\d.,]+)\s*([\p{L}.]+)?/u.exec(qtyText.trim());
  const amount = m?.[1] ? Number(m[1].replace(',', '.')) : NaN;
  const unit = m?.[2]?.toLowerCase().replace(/\./g, '') ?? '';

  const isMass = ['кг', 'г', 'мл', 'л'].includes(unit);
  // A bare number means packages («2» tomatoes); an explicit «шт» says so outright. Anything else
  // («зубчики», «пучок», «гілочки», «ст.л.», «щіпка») counts PORTIONS OF one package, so the
  // number must not become a package count — «3 зубчики» is 3 cloves, i.e. one head of garlic,
  // not three of them.
  const isPieces = unit === '' || unit.startsWith('шт');

  if (p.weighted) {
    let kg = 0.5;
    if (Number.isFinite(amount) && isMass) {
      kg = unit === 'кг' || unit === 'л' ? amount : amount / 1000;
    }
    if (!step) return Math.max(kg, 0.1);
    return Math.max(Math.ceil(kg / step) * step, step);
  }

  if (Number.isFinite(amount) && isPieces) {
    return Math.max(Math.ceil(amount), 1);
  }
  return 1;
}
