import { describe, expect, it } from 'vitest';
import {
  computeQuantity,
  hasStockHeadroom,
  isAvailable,
  isPromo,
  matchesQuery,
  packMass,
  selectProduct,
  unitPrice,
  violatesRestrictions,
  type ProductCandidate,
} from '../src/agent/selectProduct.js';

/** Minimal viable candidate; override only what a case is actually about. */
function product(overrides: Partial<ProductCandidate> & { name: string; price: number }): ProductCandidate {
  return { id: `p-${overrides.name}`, available: true, stock: 10, ...overrides };
}

describe('isPromo', () => {
  it('treats a populated specialPrices as a promo', () => {
    expect(isPromo(product({ name: 'Сир', price: 100, specialPrices: [{ price: 80 }] }))).toBe(true);
    expect(isPromo(product({ name: 'Сир', price: 100, specialPrices: {} }))).toBe(true);
  });

  it('ignores null and empty specialPrices', () => {
    expect(isPromo(product({ name: 'Сир', price: 100, specialPrices: null }))).toBe(false);
    expect(isPromo(product({ name: 'Сир', price: 100, specialPrices: [] }))).toBe(false);
  });

  it('treats oldPrice above price as a promo, but not equal or below', () => {
    expect(isPromo(product({ name: 'Молоко', price: 40, oldPrice: 55 }))).toBe(true);
    expect(isPromo(product({ name: 'Молоко', price: 40, oldPrice: 40 }))).toBe(false);
    expect(isPromo(product({ name: 'Молоко', price: 40, oldPrice: 30 }))).toBe(false);
    expect(isPromo(product({ name: 'Молоко', price: 40, oldPrice: null }))).toBe(false);
  });
});

describe('isAvailable', () => {
  it('excludes explicitly unavailable or zero-stock products', () => {
    expect(isAvailable(product({ name: 'Рис', price: 50, available: false }))).toBe(false);
    expect(isAvailable(product({ name: 'Рис', price: 50, stock: 0 }))).toBe(false);
    // stock wins even when available is true — a listed-but-empty product cannot be picked.
    expect(isAvailable(product({ name: 'Рис', price: 50, available: true, stock: 0 }))).toBe(false);
  });

  it('keeps products with stock, and defaults to available when fields are absent', () => {
    expect(isAvailable(product({ name: 'Рис', price: 50, stock: 3 }))).toBe(true);
    expect(isAvailable({ id: 'x', name: 'Рис', price: 50 })).toBe(true);
  });
});

describe('unitPrice', () => {
  // These tests originally asserted that `price` was quoted per `displayRatio` and had to be
  // scaled up to a per-kg figure. That model was WRONG, and verifying against live data proved
  // it: «Часник» comes back as price=274 / displayRatio="100г", and 274 per 100 г would be
  // 2740 UAH/kg for garlic. Scaling quoted 1370 грн for a single line. `price` on a weighted
  // product is already per kilogram, and `displayRatio` describes the step unit (garlic
  // step=0.1 ⇒ 100 г). Rewritten as regression guards against reintroducing the scaling.
  it('returns the price unchanged for weighted goods — it is already per kg', () => {
    const garlic = product({ name: 'Часник', price: 274, weighted: true, step: 0.1, displayRatio: '100г' });
    expect(unitPrice(garlic)).toBe(274);
    const onion = product({ name: 'Цибуля', price: 39.99, weighted: true, step: 0.2, displayRatio: '100г' });
    expect(unitPrice(onion)).toBe(39.99);
  });

  it('returns price unchanged for non-weighted goods', () => {
    expect(unitPrice(product({ name: 'Кетчуп', price: 62, weighted: false, displayRatio: '100г' }))).toBe(62);
  });

  it('never returns NaN regardless of displayRatio', () => {
    const cases = [
      product({ name: 'Сир', price: 120, weighted: true }),
      product({ name: 'Сир', price: 120, weighted: true, displayRatio: 'шт' }),
      product({ name: 'Сир', price: 120, weighted: true, displayRatio: null }),
      product({ name: 'Олія', price: 90, weighted: true, displayRatio: '1л' }),
    ];
    for (const p of cases) {
      expect(unitPrice(p)).toBe(120 === p.price ? 120 : p.price);
      expect(Number.isFinite(unitPrice(p))).toBe(true);
    }
  });

  it('multiplied by computeQuantity gives a believable line total for real produce', () => {
    // The end-to-end property that actually matters: 100 г of garlic is ~27 грн, not 1370.
    const garlic = product({ name: 'Часник', price: 274, weighted: true, step: 0.1, displayRatio: '100г' });
    const qty = computeQuantity('3 зубчики', garlic);
    expect(unitPrice(garlic) * qty).toBeCloseTo(27.4, 2);
  });
});

describe('violatesRestrictions', () => {
  it('matches case-insensitively and ignores blank entries', () => {
    expect(violatesRestrictions('Свинина охолоджена', ['свинина'])).toBe(true);
    expect(violatesRestrictions('свинина охолоджена', ['СВИНИНА'])).toBe(true);
    expect(violatesRestrictions('Філе куряче', ['свинина'])).toBe(false);
    expect(violatesRestrictions('Філе куряче', ['  '])).toBe(false);
    expect(violatesRestrictions('Філе куряче', [])).toBe(false);
    expect(violatesRestrictions('Філе куряче')).toBe(false);
  });

  /**
   * A plain substring match asks whether a product is NAMED after the forbidden thing, not whether
   * it IS the forbidden thing. Live check with «свинина» stored as a diet: «Сало Крафтяр», «Шинка
   * Елітна» and «Бекон Алан» were all selected happily, because pork reaches the catalogue under
   * every name except «свинина».
   */
  it('excludes pork sold under its other names', () => {
    for (const name of [
      'Сало Крафтяр подрібнене з часником та кропом',
      'Шинка «Родинна ковбаска» «Елітна» на дровах к/в в/ґ',
      'Бекон Алан с/к в/ґ, нарізка',
      'Буженина запечена',
      'Підчеревина копчена',
    ]) {
      expect(violatesRestrictions(name, ['свинина'])).toBe(true);
    }
  });

  it('reads the restriction out of a sentence, not just a bare word', () => {
    // The model stores what the user said, which is often «без свинини» rather than «свинина».
    expect(violatesRestrictions('Сало Крафтяр', ['без свинини'])).toBe(true);
  });

  it('does not exclude other meats when pork is the restriction', () => {
    // Over-exclusion is the safer error, but it still must not eat the whole catalogue.
    expect(violatesRestrictions('Курячий фарш із філе подрібнений', ['свинина'])).toBe(false);
    expect(violatesRestrictions('Фарш яловичий охолоджений', ['свинина'])).toBe(false);
    expect(violatesRestrictions('Молоко «Галичина» 1%', ['свинина'])).toBe(false);
  });

  it('expands nut and fish restrictions to the specific foods', () => {
    expect(violatesRestrictions('Арахісова паста', ['горіхи'])).toBe(true);
    expect(violatesRestrictions('Мигдаль смажений', ['горіхи'])).toBe(true);
    expect(violatesRestrictions('Оселедець філе слабосолений', ['риба'])).toBe(true);
    expect(violatesRestrictions('Картопля молода', ['риба'])).toBe(false);
  });

  /**
   * Ukrainian inflects these fish names irregularly — the nominative ending is REPLACED, not
   * appended (лосось→лосося, оселедець→оселедця, мінтай→мінтаю), so a stem copied from the
   * nominative word does not match the inflected form as a substring. «Філе лосося» previously
   * came back `false` under a стated fish allergy — the exact under-exclusion this feature exists
   * to prevent, and worse than a plain miss because it is silent.
   */
  it('matches fish names through their inflected forms, not just the nominative', () => {
    expect(violatesRestrictions('Філе лосося', ['риба'])).toBe(true);
    expect(violatesRestrictions('Стейк з оселедця', ['риба'])).toBe(true);
    expect(violatesRestrictions('Філе мінтаю', ['риба'])).toBe(true);
  });

  /**
   * The «ковбаса» case. Composition is not available anywhere in the API — checked directly:
   * silpo_get_product_details returns country, brand, seller and nutrition, and no product in any
   * category carries an ingredient list. So a sausage counts as containing the restricted meat
   * unless its name positively names a different one.
   */
  describe('composite meat products whose name hides what is in them', () => {
    it('excludes a sausage that does not say what meat it is', () => {
      for (const name of [
        'Ковбаса «Премія»® Українська с/к в/ґ, нарізка',
        'Ковбаса «Алан» «Брауншвейгська» с/к в/ґ',
        'Ковбаса Salsus Лікарська варена н/о в/ґ порційна',
        'Сосиски М\'ясний хутір Молочні н/о в/ґ',
        'Салямі Золотиста с/к в/ґ',
        'Паштет печінковий',
      ]) {
        expect(violatesRestrictions(name, ['свинина'])).toBe(true);
      }
    });

    it('allows one that names a permitted meat', () => {
      // Over-exclusion is the safer error, but a positively identified meat must still get through
      // or «без свинини» would empty the entire sausage aisle.
      expect(violatesRestrictions('Ковбаса куряча варена', ['свинина'])).toBe(false);
      expect(violatesRestrictions('Сосиски індичі', ['свинина'])).toBe(false);
      expect(violatesRestrictions('Ковбаса яловича с/к', ['свинина'])).toBe(false);
      expect(violatesRestrictions('Ковбаса веганська соєва', ['свинина'])).toBe(false);
    });

    it('lets a mackerel pâté clear an unrelated pork restriction', () => {
      // «скумбрі» must positively identify the meat as fish-not-pork, or an unnamed-meat sausage
      // rule ends up excluding fish products under a restriction that has nothing to do with fish.
      expect(violatesRestrictions('Паштет Hame зі скумбрією', ['свинина'])).toBe(false);
    });

    it('still excludes a sausage that names the very meat being avoided', () => {
      // The named meat clears a product only when it DIFFERS from the restricted one.
      expect(violatesRestrictions('Ковбаса з тунця', ['риба'])).toBe(true);
      expect(violatesRestrictions('Ковбаса куряча варена', ['курка'])).toBe(true);
    });

    it('has a composite-rule backstop even where the stem table already catches the phrase', () => {
      // «Ковбаса з тунця» above now passes via expandRestriction's own «тунц» stem before
      // isUnverifiableMeat runs at all, so it stops proving this rule specifically once that stem
      // exists. «плотва» is a fish with no catalogue presence and therefore no stem anywhere in
      // RESTRICTION_SYNONYMS, so a sausage naming it can ONLY be excluded by isUnverifiableMeat
      // treating the sausage as an unnamed meat under a fish restriction.
      expect(violatesRestrictions('Ковбаса з плотви', ['риба'])).toBe(true);
    });

    it('does not touch non-meat products', () => {
      // The rule keys off meat restrictions only; a lactose restriction must not swallow bread.
      expect(violatesRestrictions('Хліб «Кулиничі» тостовий', ['свинина'])).toBe(false);
      expect(violatesRestrictions('Ковбаса Українська', ['глютен'])).toBe(false);
    });

    it('catches milk hiding in a sausage name for a lactose restriction', () => {
      // «Молочні» shares no stem with «молоко» — the two had to be listed separately.
      expect(violatesRestrictions('Сосиски М\'ясний хутір Молочні н/о в/ґ', ['лактоза'])).toBe(true);
    });
  });

  it('leaves an unknown restriction as a literal match rather than ignoring it', () => {
    // Nothing in the synonym table covers this, so it must still behave like the old matcher.
    expect(violatesRestrictions('Кабачок цукіні', ['кабачок'])).toBe(true);
    expect(violatesRestrictions('Морква', ['кабачок'])).toBe(false);
  });
});

describe('matchesQuery', () => {
  it('matches the intended product and tolerates Ukrainian inflection', () => {
    expect(matchesQuery('куряче філе', 'Філе куряче охолоджене')).toBe(true);
    // «курячий» vs «куряче» — stem truncation is what makes this work.
    expect(matchesQuery('курячий', 'Філе куряче')).toBe(true);
  });

  it('stays permissive when every query word is shorter than the 4-char threshold', () => {
    // All words filtered out => no signal to filter on, so nothing is excluded. Deliberate:
    // over-filtering would drop valid hits for short ingredients like «рис» or «сіль».
    expect(matchesQuery('рис', 'Кетчуп томатний')).toBe(true);
  });

  it('rejects a product sharing no query stem', () => {
    expect(matchesQuery('куряче філе', 'Кетчуп томатний')).toBe(false);
    expect(matchesQuery('гречка', 'Олія соняшникова')).toBe(false);
  });

  it('bridges Ukrainian catalogue synonyms that share no stem', () => {
    // Live: searching «помідори» returns only «Томат …» listings, so stem matching alone lost the
    // ingredient. Regression guard for the small curated synonym map.
    expect(matchesQuery('помідори', 'Томат на гілці рожевий')).toBe(true);
    // The bridge is narrow — an unrelated product still fails.
    expect(matchesQuery('помідори', 'Олія соняшникова')).toBe(false);
  });

  it('rejects cheeses that are not the requested kind', () => {
    // Live: «сир пармезан» returns Gouda and truffle cheese at 1699 грн — Silpo matched «сир»
    // and ignored «пармезан». Rejecting them is correct; a miss beats buying the wrong cheese.
    expect(matchesQuery('сир пармезан', 'Сир Veldhuyzen Kaas Гауда Блек Лейбл')).toBe(false);
    expect(matchesQuery('сир пармезан', 'Сир Пармезан витриманий')).toBe(true);
  });

  it('rejects duck for a chicken query — the case this filter exists for', () => {
    // Regression guard. This originally passed (duck admitted) because matchesQuery used
    // `.some()`: «філе» alone satisfied it. Now every distinguishing word must match, so the
    // missing «куряче» stem correctly rejects it. See docs/phase5-findings.md.
    expect(matchesQuery('куряче філе', 'Качине філе домашнє')).toBe(false);
    // …while a genuine chicken fillet still matches despite Ukrainian inflection.
    expect(matchesQuery('куряче філе', 'Філе куряче охолоджене')).toBe(true);
  });
});

describe('selectProduct', () => {
  it('prefers a promo item even when it is more expensive per unit', () => {
    // Spec §6.4 step 2: promo preference outranks price. This is the project's business value.
    const cheapNoPromo = product({ name: 'Філе куряче звичайне', price: 50 });
    const dearPromo = product({ name: 'Філе куряче преміум', price: 80, oldPrice: 100 });

    const picked = selectProduct('куряче філе', [cheapNoPromo, dearPromo]);

    expect(picked?.product.name).toBe('Філе куряче преміум');
    expect(picked?.isPromo).toBe(true);
    expect(picked?.unitPrice).toBe(80);
  });

  it('picks the cheapest per unit within the same promo group', () => {
    const a = product({ name: 'Філе куряче А', price: 90 });
    const b = product({ name: 'Філе куряче Б', price: 60 });
    const c = product({ name: 'Філе куряче В', price: 75 });

    expect(selectProduct('куряче філе', [a, b, c])?.product.name).toBe('Філе куряче Б');
  });

  it('ranks a head-noun match above a promo on a merely-related product', () => {
    // The live failure this guards: «морква» matched «Сік Galicia Baby яблуко-морква-гарбуз»
    // (carrot JUICE) which, being on promo, outranked actual carrots. Buying the wrong food is
    // worse than missing a discount, so a head-noun match now wins first.
    const juice = product({ name: 'Сік Galicia яблуко-морква-гарбуз', price: 20.99, oldPrice: 30 });
    const carrots = product({ name: 'Морква мита', price: 54.99, weighted: true, step: 0.2 });

    const picked = selectProduct('морква', [juice, carrots]);

    expect(picked?.product.name).toBe('Морква мита');
  });

  it('excludes a restricted product even when it is cheapest and on promo', () => {
    const forbidden = product({ name: 'Фарш свинина домашній', price: 40, oldPrice: 90 });
    const allowed = product({ name: 'Фарш яловичий', price: 120 });

    const picked = selectProduct('фарш', [forbidden, allowed], { restrictions: ['свинина'] });

    expect(picked?.product.name).toBe('Фарш яловичий');
    expect(picked?.isPromo).toBe(false);
  });

  it('excludes out-of-stock products', () => {
    const outOfStock = product({ name: 'Філе куряче дешеве', price: 20, stock: 0 });
    const inStock = product({ name: 'Філе куряче звичайне', price: 95 });

    expect(selectProduct('куряче філе', [outOfStock, inStock])?.product.name).toBe('Філе куряче звичайне');
  });

  it('returns undefined when nothing survives filtering — the caller’s cue to seek replacements', () => {
    const all = [
      product({ name: 'Філе куряче А', price: 50, available: false }),
      product({ name: 'Філе куряче Б', price: 60, stock: 0 }),
    ];
    expect(selectProduct('куряче філе', all)).toBeUndefined();
    expect(selectProduct('куряче філе', [])).toBeUndefined();
  });
});

describe('computeQuantity', () => {
  const weighted = (step?: number): ProductCandidate =>
    product({ name: 'Філе куряче', price: 100, weighted: true, ...(step === undefined ? {} : { step }) });
  const piece = product({ name: 'Морква', price: 20, weighted: false });

  it('orders exactly one step when the recipe amount equals it', () => {
    expect(computeQuantity('500 г', weighted(0.5))).toBeCloseTo(0.5, 10);
  });

  it('rounds UP to the next step, never down', () => {
    // Under-ordering is the wrong failure: 600 г must become 1.0 kg, not 0.5.
    const qty = computeQuantity('600 г', weighted(0.5));
    expect(qty).toBeCloseTo(1, 10);
    expect(qty).toBeGreaterThan(0.6);
  });

  it('always yields a whole multiple of an awkward step', () => {
    // Silpo rejects off-step quantities, so 500 г against a 0.65 step must become 0.65.
    const step = 0.65;
    const qty = computeQuantity('500 г', weighted(step));
    expect(qty).toBeCloseTo(0.65, 10);
    expect(qty / step).toBeCloseTo(Math.round(qty / step), 10);
  });

  it('handles kilogram amounts and a missing step', () => {
    expect(computeQuantity('2 кг', weighted(0.5))).toBeCloseTo(2, 10);
    expect(computeQuantity('500 г', weighted(undefined))).toBeCloseTo(0.5, 10);
  });

  it('falls back to a positive default for weighted goods with an unparseable amount', () => {
    expect(computeQuantity('за смаком', weighted(0.5))).toBeGreaterThan(0);
    expect(computeQuantity('за смаком', weighted(undefined))).toBeGreaterThan(0);
  });

  it('counts pieces for piece goods', () => {
    expect(computeQuantity('2 шт', piece)).toBe(2);
    expect(computeQuantity('1 шт', piece)).toBe(1);
  });

  it('rounds a fractional piece count up to one whole package', () => {
    expect(computeQuantity('0.5 шт', piece)).toBe(1);
  });

  it('counts packages only for bare numbers and «шт», not for portion units', () => {
    // Bare number or explicit «шт» = package count.
    expect(computeQuantity('2 шт', piece)).toBe(2);
    expect(computeQuantity('3', piece)).toBe(3);
    // Portion-of-a-package units must NOT become package counts: «3 зубчики» is three garlic
    // cloves — one head — not three heads. Regression guard; this returned 3 before the fix.
    expect(computeQuantity('3 зубчики', piece)).toBe(1);
    expect(computeQuantity('2 гілочки', piece)).toBe(1);
    expect(computeQuantity('1 пучок', piece)).toBe(1);
    expect(computeQuantity('2 ст.л.', piece)).toBe(1);
  });

  it('orders a single package when a mass is given for a non-weighted product', () => {
    // A 400 г tin of chickpeas is one package, not 400 of anything.
    expect(computeQuantity('400 г', piece)).toBe(1);
  });

  it('never returns a non-positive or non-finite quantity', () => {
    const inputs = ['500 г', '600 г', '2 кг', '2 шт', '0.5 шт', '3 зубчики', 'за смаком', '', '0 шт'];
    for (const qty of [weighted(0.5), weighted(0.65), weighted(undefined), piece]) {
      for (const text of inputs) {
        const n = computeQuantity(text, qty);
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Category filtering. Silpo's search payload carries no category, section or tag field — only
 * name, price, stock, weighted and friends (verified with scripts/probe-raw.ts) — so "is this the
 * ingredient or a processed version of it" has to be read off the name.
 *
 * All three cases below were live failures on 7 Sept 2026: the query word appears in each product
 * name and each leads with it, so both the wrong-noun filter and the head-noun rank passed them,
 * and each then won on being cheaper or on promo.
 */
describe('processed forms and non-ingredients', () => {
  it('prefers the raw potato over frozen chips', () => {
    const picked = selectProduct('картопля', [
      product({ name: 'Картопля Aviko Оригінальна фрі швидкозаморожена', price: 199, oldPrice: 249 }),
      product({ name: 'Картопля рожева мита', price: 36.49, weighted: true, step: 0.1 }),
    ]);
    expect(picked?.product.name).toBe('Картопля рожева мита');
  });

  it('prefers fresh garlic over granulated garlic, despite the powder being cheaper and on promo', () => {
    const picked = selectProduct('часник', [
      product({ name: 'Часник «Премія»® гранульований', price: 14.99, oldPrice: 19.99 }),
      product({ name: 'Часник білий фасований', price: 44.49, weighted: true, step: 0.1 }),
    ]);
    expect(picked?.product.name).toBe('Часник білий фасований');
  });

  it('rejects baby food outright rather than buying it as a vegetable', () => {
    // «кабачок» returned nothing but this. A miss the user sees beats purée in a stew.
    expect(selectProduct('кабачок', [product({ name: 'Пюре Gerber кабачок', price: 65.99 })])).toBeUndefined();
  });

  it('still takes a processed form when it is all there is', () => {
    // Demotion, not exclusion: canned tomatoes beat no tomatoes.
    const picked = selectProduct('помідори', [
      product({ name: 'Томати консервовані Верес', price: 89 }),
    ]);
    expect(picked?.product.name).toBe('Томати консервовані Верес');
  });

  it('does not hold a form against a product the user asked for by that form', () => {
    // Someone asking for juice means juice; asking for frozen vegetables means frozen.
    const juice = selectProduct('томатний сік', [
      product({ name: 'Сік Ніжин томатний прямого віджиму', price: 59.99 }),
      product({ name: 'Томат Azura Чері круглий', price: 71.99 }),
    ]);
    expect(juice?.product.name).toBe('Сік Ніжин томатний прямого віджиму');

    const frozen = selectProduct('заморожені овочі', [
      product({ name: 'Суміш овочева Лімо швидкозаморожена', price: 99 }),
    ]);
    expect(frozen?.product.name).toBe('Суміш овочева Лімо швидкозаморожена');
  });

  it('keeps head-noun matching as the stronger signal', () => {
    // A raw item that does not lead with the query word must still lose to one that does; the
    // processed check is a tiebreak beneath it, not a replacement for it.
    const picked = selectProduct('морква', [
      product({ name: 'Сік Galicia Baby яблуко-морква-гарбуз', price: 20 }),
      product({ name: 'Морква', price: 17.49, weighted: true, step: 0.1 }),
    ]);
    expect(picked?.product.name).toBe('Морква');
  });

  it('is neutral when every candidate shares the marker', () => {
    // «салат» as an ingredient: if all candidates are salads the demotion cancels out and price
    // decides, rather than everything being rejected.
    const picked = selectProduct('салат', [
      product({ name: 'Салат з капустою свіжий', price: 90 }),
      product({ name: 'Салат з огірками', price: 60 }),
    ]);
    expect(picked?.product.name).toBe('Салат з огірками');
  });
});

/**
 * Recipes count pieces; the catalogue sells packages. `displayRatio` carries the pack size when
 * there is one ("10шт" on a carton of eggs), which is the only signal available for this — there
 * is no unit-count field (see scripts/probe-raw.ts).
 */
describe('piece counts against multi-packs', () => {
  const eggs = (overrides: Partial<ProductCandidate> = {}) =>
    product({ name: 'Яйця курячі Ситий двір С2', price: 54.99, displayRatio: '10шт', step: 1, ...overrides });

  it('buys one carton for four eggs, not four cartons', () => {
    // The live bug: «яйця 4 шт» ordered 4 packages, roughly forty eggs for ₴220.
    expect(computeQuantity('4 шт', eggs())).toBe(1);
  });

  it('rounds up to the next whole package', () => {
    expect(computeQuantity('12 шт', eggs())).toBe(2);
    expect(computeQuantity('10 шт', eggs())).toBe(1);
    expect(computeQuantity('21 шт', eggs())).toBe(3);
  });

  it('never orders less than one package', () => {
    expect(computeQuantity('1 шт', eggs())).toBe(1);
  });

  it('leaves single-item products counting as before', () => {
    // «хліб 1 шт» is one loaf; a mass ratio says nothing about piece counts.
    const bread = product({ name: 'Хліб Фітнес тостовий', price: 34.99, displayRatio: '450г', step: 1 });
    expect(computeQuantity('1 шт', bread)).toBe(1);
    expect(computeQuantity('2 шт', bread)).toBe(2);
  });

  it('ignores a ratio of exactly 1шт, which adds nothing', () => {
    const single = product({ name: 'Салат Айсберг', price: 76.11, displayRatio: '1шт', step: 1 });
    expect(computeQuantity('2 шт', single)).toBe(2);
  });

  it('ignores displayRatio entirely for weighted goods', () => {
    // Weighted items are ordered in kilograms; the piece branch never runs for them.
    const potato = product({ name: 'Картопля рожева мита', price: 36.49, weighted: true, step: 0.1, displayRatio: '100г' });
    expect(computeQuantity('1 кг', potato)).toBe(1);
  });

  it('still caps at available stock', () => {
    expect(computeQuantity('50 шт', eggs({ stock: 2 }))).toBe(2);
  });

  it('treats a non-countable amount as one package', () => {
    for (const text of ['за смаком', '', '400 г']) {
      expect(computeQuantity(text, eggs())).toBe(1);
    }
  });
});

/**
 * The mirror of the egg case: a recipe states a MASS and the catalogue sells packages.
 * `displayRatio` carries the package size on non-weighted goods ("220г" tub, "0,7кг" pasta pack) —
 * verified against live data with scripts/probe-raw.ts, including that pasta really is sold in
 * 400–700 g packs rather than priced per 100 g.
 */
describe('recipe masses against packaged goods', () => {
  const tub = (ratio: string, overrides: Partial<ProductCandidate> = {}) =>
    product({ name: 'Сир кисломолочний President', price: 66.99, displayRatio: ratio, step: 1, ...overrides });

  it('buys two tubs when the recipe needs more than one holds', () => {
    expect(computeQuantity('400 г', tub('220г'))).toBe(2);
  });

  it('buys one when a single package covers it', () => {
    expect(computeQuantity('200 г', tub('220г'))).toBe(1);
    expect(computeQuantity('220 г', tub('220г'))).toBe(1);
  });

  it('reads кг and л package sizes, including a comma decimal', () => {
    // «Вироби макаронні «Повна Чаша»® вермішель спагеті» really is listed as 0,7кг.
    expect(computeQuantity('400 г', tub('0,7кг'))).toBe(1);
    expect(computeQuantity('1 кг', tub('0,7кг'))).toBe(2);
    expect(computeQuantity('200 мл', tub('1л'))).toBe(1);
    expect(computeQuantity('1.5 л', tub('1л'))).toBe(2);
  });

  it('treats millilitres and grams as interchangeable', () => {
    // Close enough for milk and cream, and the only sensible reading of «200 мл» in a recipe.
    expect(computeQuantity('500 мл', tub('250г'))).toBe(2);
  });

  it('falls back to one package when there is no usable ratio', () => {
    expect(computeQuantity('400 г', tub('10шт'))).toBe(1);
    expect(computeQuantity('400 г', tub(''))).toBe(1);
    expect(computeQuantity('400 г', product({ name: 'X', price: 1, step: 1 }))).toBe(1);
  });

  it('never applies a package size to a weighted product', () => {
    // On weighted goods displayRatio is a PRICE BASIS, not a package. Reading «Часник» ratio "100г"
    // as a pack size is the mistake that once quoted 1370 грн for garlic.
    const garlic = product({ name: 'Часник', price: 274, weighted: true, step: 0.1, displayRatio: '100г' });
    expect(packMass(garlic)).toBeUndefined();
    expect(computeQuantity('300 г', garlic)).toBe(0.3);
  });

  it('still caps at stock', () => {
    expect(computeQuantity('2 кг', tub('220г', { stock: 3 }))).toBe(3);
  });

  it('leaves piece counts to the piece rules', () => {
    expect(computeQuantity('4 шт', tub('10шт'))).toBe(1);
    expect(computeQuantity('2 шт', tub('220г'))).toBe(2);
  });
});

/**
 * Budget mode. Normally a promo item outranks a cheaper plain one, because promo redemption is the
 * business value. When the shopper asks for the cheapest basket that preference is backwards: a
 * discounted premium brand routinely costs more than an undiscounted own brand.
 */
describe('preferCheapest', () => {
  const promoPremium = product({ name: 'Сир твердий Президент', price: 120, oldPrice: 160 });
  const plainOwnBrand = product({ name: 'Сир твердий «Премія»®', price: 80 });

  it('normally takes the promo item even when a plain one is cheaper', () => {
    const picked = selectProduct('сир твердий', [promoPremium, plainOwnBrand]);
    expect(picked?.product.name).toBe('Сир твердий Президент');
  });

  it('takes the cheaper item in budget mode', () => {
    const picked = selectProduct('сир твердий', [promoPremium, plainOwnBrand], { preferCheapest: true });
    expect(picked?.product.name).toBe('Сир твердий «Премія»®');
  });

  it('still takes a promo item when it is also the cheapest', () => {
    const cheapPromo = product({ name: 'Сир твердий Дешевий', price: 50, oldPrice: 90 });
    const picked = selectProduct('сир твердий', [cheapPromo, plainOwnBrand], { preferCheapest: true });
    expect(picked?.product.name).toBe('Сир твердий Дешевий');
    expect(picked?.isPromo).toBe(true);
  });

  it('does NOT relax the wrong-food guards — cheap is no reason to buy duck for chicken', () => {
    const duck = product({ name: 'Качине філе', price: 10 });
    const chicken = product({ name: 'Куряче філе охолоджене', price: 200 });
    const picked = selectProduct('куряче філе', [duck, chicken], { preferCheapest: true });
    expect(picked?.product.name).toBe('Куряче філе охолоджене');
  });

  it('does NOT relax raw-over-processed either', () => {
    const chips = product({ name: 'Картопля Aviko фрі швидкозаморожена', price: 30 });
    const raw = product({ name: 'Картопля рожева мита', price: 36.49, weighted: true, step: 0.1 });
    const picked = selectProduct('картопля', [chips, raw], { preferCheapest: true });
    expect(picked?.product.name).toBe('Картопля рожева мита');
  });

  it('still refuses non-ingredients however cheap', () => {
    expect(
      selectProduct('кабачок', [product({ name: 'Пюре Gerber кабачок', price: 5 })], { preferCheapest: true }),
    ).toBeUndefined();
  });

  it('still respects dietary restrictions', () => {
    const pork = product({ name: 'Фарш свинина', price: 10 });
    const beef = product({ name: 'Фарш яловичий', price: 300 });
    const picked = selectProduct('фарш', [pork, beef], { preferCheapest: true, restrictions: ['свинина'] });
    expect(picked?.product.name).toBe('Фарш яловичий');
  });
});

/**
 * Last-unit avoidance. Silpo reported «Олія соняшникова «Чумак»» with stock 1, accepted the search,
 * then rejected the cart with `product.offer.stock.max` — reproducibly across runs, because the
 * unit went between the two calls. A blocked checkout costs more than the few hryvnia saved, and
 * budget mode makes it likelier: the cheapest listing is often the last clearance unit.
 */
describe('stock headroom', () => {
  it('takes the better-stocked listing over a cheaper last unit', () => {
    const lastOne = product({ name: 'Олія соняшникова «Чумак»', price: 67.99, stock: 1 });
    const plenty = product({ name: 'Олія соняшникова «Повна Чаша»®', price: 76.49, stock: 25 });
    const picked = selectProduct('олія соняшникова', [lastOne, plenty], { preferCheapest: true });
    expect(picked?.product.name).toBe('Олія соняшникова «Повна Чаша»®');
  });

  it('still takes the last unit when it is the only match', () => {
    // Demotion, not exclusion — one bottle beats no bottle.
    const lastOne = product({ name: 'Олія соняшникова «Чумак»', price: 67.99, stock: 1 });
    expect(selectProduct('олія соняшникова', [lastOne])?.product.name).toBe('Олія соняшникова «Чумак»');
  });

  it('treats unknown stock as fine — absence of data is not scarcity', () => {
    expect(hasStockHeadroom(product({ name: 'X', price: 1, stock: null }))).toBe(true);
    expect(hasStockHeadroom(product({ name: 'X', price: 1, stock: undefined }))).toBe(true);
  });

  it('needs two whole units for a counted good', () => {
    expect(hasStockHeadroom(product({ name: 'X', price: 1, stock: 1 }))).toBe(false);
    expect(hasStockHeadroom(product({ name: 'X', price: 1, stock: 2 }))).toBe(true);
  });

  it('measures headroom in steps for weighted goods', () => {
    // 0.15 kg of something sold in 100 g steps is one step and a half — not enough.
    expect(hasStockHeadroom(product({ name: 'X', price: 1, weighted: true, step: 0.1, stock: 0.15 }))).toBe(false);
    expect(hasStockHeadroom(product({ name: 'X', price: 1, weighted: true, step: 0.1, stock: 0.2 }))).toBe(true);
    expect(hasStockHeadroom(product({ name: 'X', price: 1, weighted: true, step: 1.4, stock: 250 }))).toBe(true);
  });

  it('does not outrank the correctness tiers', () => {
    // A well-stocked wrong food still loses to a scarce right one.
    const duckPlenty = product({ name: 'Качине філе', price: 10, stock: 99 });
    const chickenScarce = product({ name: 'Куряче філе охолоджене', price: 200, stock: 1 });
    const picked = selectProduct('куряче філе', [duckPlenty, chickenScarce], { preferCheapest: true });
    expect(picked?.product.name).toBe('Куряче філе охолоджене');
  });
});
