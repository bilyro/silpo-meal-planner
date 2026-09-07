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
  if (typeof p.stock !== 'number') return true;
  // Stock must cover at least ONE purchasable increment. A weighted item with stock 0.05 and
  // step 0.1 is listed as in-stock but cannot actually be bought, and adding it makes Silpo
  // reject the cart with `product.offer.stock.max`.
  const minimum = p.weighted ? (typeof p.step === 'number' && p.step > 0 ? p.step : 0.1) : 1;
  return p.stock >= minimum;
}

/**
 * Silpo's search is fuzzy — «куряче філе» returns «Качине філе» (duck) among its hits (spec §11
 * anticipated this). Require at least one meaningful word of the query to appear in the product
 * name, so an unrelated top hit cannot be selected silently.
 */
/**
 * Ukrainian food synonyms where the shopper's word and Silpo's catalogue word share no stem, so
 * stem matching alone rejects the right product. Verified live: searching «помідори» returns only
 * «Томат …» listings, which the filter then discarded, losing the ingredient entirely.
 *
 * Deliberately tiny. This is not a general thesaurus — it covers pairs actually observed in the
 * catalogue, and each entry should be added only after seeing the mismatch in real results.
 */
const SYNONYMS: Record<string, string[]> = {
  помідор: ['томат'],
  томат: ['помідор'],
  буряк: ['бурак'],
  квасоля: ['фасол'],
  олія: ['олив'],
};

/** Query stems to try for one word: the word's own stem plus any synonym stems. */
function stemsFor(word: string): string[] {
  const stem = word.slice(0, Math.max(4, word.length - 2));
  const synonyms = Object.entries(SYNONYMS)
    .filter(([key]) => word.startsWith(key.slice(0, Math.max(4, key.length - 1))))
    .flatMap(([, values]) => values);
  return [stem, ...synonyms];
}

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
  return words.every((w) => stemsFor(w).some((stem) => haystack.includes(stem)));
}

/**
 * True when a query word heads the product name. Silpo names products head-noun-first
 * («Морква мита», «Цибуля ріпчаста жовта»), so a query term appearing among the first two words
 * signals the product IS that thing, rather than merely containing it: «Сік Galicia Baby
 * яблуко-морква-гарбуз» is carrot juice, and passed the substring filter while being the wrong
 * food entirely. Used for ranking, not exclusion — a genuine product with an unusual name still
 * competes, just behind exact head matches.
 */
export function matchesHeadNoun(query: string, name: string): boolean {
  const head = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).join(' ');
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  return words.some((w) => head.includes(w.slice(0, Math.max(4, w.length - 2))));
}

/**
 * Product forms that are a poor stand-in for a raw ingredient: preserved, dried, powdered, frozen
 * or pre-cooked versions of the thing.
 *
 * Name-based because there is nothing better. The live `find_products_batch` payload carries only
 * `available, branchId, companyId, displayRatio, externalProductId, id, image, name, oldPrice,
 * price, slug, specialPrices, step, stock, weighted` — verified with scripts/probe-raw.ts. There is
 * no category, section or tag field to key off, so the name is the only signal available.
 *
 * These demote rather than exclude: frozen vegetables and canned tomatoes are perfectly good
 * cooking ingredients when nothing fresher exists, and demoting means the raw item wins whenever
 * one is on offer while the processed one still beats a miss.
 */
const PROCESSED_FORM_MARKERS = [
  'пюре',
  'сік',
  'консерв',
  'стерилізован',
  'маринован',
  'в маринаді',
  'гранульован',
  'сушен',
  'сушін',
  'заморожен',
  'фрі',
  'чіпси',
  'снек',
  'салат з',
  'по-домашньому',
  'млинц',
  'запіканка',
  'суп',
  'соус',
];

/**
 * Products that are never a substitute for a cooking ingredient, whatever the price.
 *
 * Excluded outright rather than demoted, on the same asymmetry the query filter uses: a miss
 * surfaces to the user as «не знайшли», whereas a false match silently puts baby food in a stew.
 * «кабачок» returning only «Пюре Gerber кабачок» should be a miss, not a purchase.
 */
const NEVER_AN_INGREDIENT = ['gerber', 'hipp', 'дитяч', 'корм для', 'для собак', 'для котів'];

/**
 * Markers in the QUERY are never held against the product: someone asking for «томатний сік» or
 * «заморожені овочі» means it, and «сушені гриби» should not be demoted for being dried.
 */
function hasMarker(markers: string[], query: string, name: string): boolean {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  return markers.some((m) => n.includes(m) && !q.includes(m));
}

/** True when the product is a processed form of the ingredient rather than the ingredient. */
export function isProcessedForm(query: string, name: string): boolean {
  return hasMarker(PROCESSED_FORM_MARKERS, query, name);
}

/** True when the product is not food-for-cooking at all (baby food, pet food). */
export function isNeverAnIngredient(query: string, name: string): boolean {
  return hasMarker(NEVER_AN_INGREDIENT, query, name);
}

export function violatesRestrictions(name: string, restrictions: string[] = []): boolean {
  const haystack = name.toLowerCase();
  return restrictions.some((r) => r.trim().length > 0 && haystack.includes(r.toLowerCase().trim()));
}

/**
 * The price to multiply `computeQuantity`'s result by.
 *
 * Verified against live data (6 Sept 2026): for weighted goods `price` is already **per kilogram**
 * — «Часник» price=274 / «Цибуля ріпчаста жовта» price=39.99, both `displayRatio: "100г"`. Reading
 * that ratio as the price basis (an earlier version divided by it) inflated every weighted item
 * tenfold and quoted 1370 грн for garlic. `displayRatio` describes the STEP unit instead, which
 * `step` already states numerically (garlic step=0.1 ⇒ 100 г).
 *
 * So the price needs no normalisation: weighted `qty` is in kg against a per-kg price, and piece
 * `qty` is a package count against a per-package price. Kept as a named function because it is
 * the single place this reasoning lives, and because a future per-unit comparison across package
 * sizes would slot in here.
 */
export function unitPrice(p: ProductCandidate): number {
  return p.price;
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
      !isNeverAnIngredient(query, p.name) &&
      matchesQuery(query, p.name),
  );
  if (viable.length === 0) return undefined;

  const ranked = viable
    .map((product) => ({
      product,
      isPromo: isPromo(product),
      unitPrice: unitPrice(product),
      headMatch: matchesHeadNoun(query, product.name),
      processed: isProcessedForm(query, product.name),
    }))
    .sort((a, b) => {
      // Head-noun match outranks even a promo: «морква» matched «Сік ... яблуко-морква-гарбуз»
      // (carrot JUICE) and, being on promo, beat actual carrots. Buying the wrong food is worse
      // than missing a discount.
      if (a.headMatch !== b.headMatch) return a.headMatch ? -1 : 1;
      // Then the raw form ahead of the processed one. Head-noun matching does not separate these:
      // «Картопля Aviko фрі швидкозаморожена» and «Часник «Премія»® гранульований» both lead with
      // the ingredient, so both looked like the real thing, and both won on being cheaper or on
      // promo. Frozen chips are not what a casserole wants, and garlic powder is not three cloves.
      if (a.processed !== b.processed) return a.processed ? 1 : -1;
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
/** Binary floating point makes 3 × 0.2 = 0.6000000000000001; weights need no more than grams. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
    // Only a stated mass gives a real target. For anything else («3 зубчики», «2 шт», «за смаком»)
    // buy the smallest purchasable increment: one step is a head of garlic or a couple of carrots,
    // whereas the old 0.5 kg default bought half a kilo of garlic for three cloves.
    const stepSize = step ?? 0.1;
    let kg = stepSize;
    if (Number.isFinite(amount) && isMass) {
      const target = unit === 'кг' || unit === 'л' ? amount : amount / 1000;
      // Round the multiplication too: 3 × 0.2 lands on 0.6000000000000001 in binary floating
      // point, which reaches the user as «× 0.60» and Silpo as an off-step quantity.
      kg = step ? Math.max(Math.ceil(target / step) * step, step) : Math.max(target, 0.1);
    }
    return round3(capToStock(kg, p, stepSize));
  }

  const pieces = Number.isFinite(amount) && isPieces ? Math.max(Math.ceil(amount), 1) : 1;
  return capToStock(pieces, p, 1);
}

/**
 * Never order more than Silpo has. Requesting above the listed stock makes the cart fail
 * validation with `product.offer.stock.max` and withholds the checkout link entirely — observed
 * live on a 0.4 kg cheese line against 0.2 kg of stock. Cutting the amount down still cooks the
 * meal imperfectly; a blocked checkout helps nobody.
 */
function capToStock(quantity: number, p: ProductCandidate, increment: number): number {
  if (typeof p.stock !== 'number' || quantity <= p.stock) return quantity;
  // Round DOWN to a whole increment so the capped amount stays purchasable.
  const capped = Math.floor(p.stock / increment) * increment;
  return capped >= increment ? capped : increment;
}
