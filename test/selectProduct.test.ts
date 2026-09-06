import { describe, expect, it } from 'vitest';
import {
  computeQuantity,
  isAvailable,
  isPromo,
  matchesQuery,
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
  it('scales a weighted product quoted per 100г up to a per-kg figure', () => {
    // Real shape from silpo_find_products_batch: price 80.9 quoted per "100г" is 809 UAH/kg.
    const per100g = product({ name: 'Філе куряче', price: 80.9, weighted: true, displayRatio: '100г' });
    expect(unitPrice(per100g)).toBeCloseTo(809, 6);
  });

  it('makes differently-quoted weighted products comparable', () => {
    const per100g = product({ name: 'Філе А', price: 80.9, weighted: true, displayRatio: '100г' }); // 809/kg
    const perKg = product({ name: 'Філе Б', price: 250, weighted: true, displayRatio: '1кг' }); // 250/kg
    // Raw price would rank А cheaper (80.9 < 250); normalised, Б is far cheaper per kg.
    expect(unitPrice(per100g)).toBeGreaterThan(unitPrice(perKg));
    expect(unitPrice(perKg)).toBeCloseTo(250, 6);
  });

  it('returns price unchanged for non-weighted goods', () => {
    expect(unitPrice(product({ name: 'Кетчуп', price: 62, weighted: false, displayRatio: '100г' }))).toBe(62);
  });

  it('falls back to price when displayRatio is missing or unparseable, never NaN', () => {
    const noRatio = product({ name: 'Сир', price: 120, weighted: true });
    const badRatio = product({ name: 'Сир', price: 120, weighted: true, displayRatio: 'шт' });
    const nullRatio = product({ name: 'Сир', price: 120, weighted: true, displayRatio: null });
    for (const p of [noRatio, badRatio, nullRatio]) {
      expect(unitPrice(p)).toBe(120);
      expect(Number.isFinite(unitPrice(p))).toBe(true);
    }
  });

  it('handles millilitre and litre ratios', () => {
    expect(unitPrice(product({ name: 'Олія', price: 5, weighted: true, displayRatio: '100мл' }))).toBeCloseTo(50, 6);
    expect(unitPrice(product({ name: 'Олія', price: 90, weighted: true, displayRatio: '1л' }))).toBeCloseTo(90, 6);
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

  it('compares on normalised unit price, not raw price', () => {
    // Raw price favours the 100г listing; per-kg it is the more expensive one.
    const per100g = product({ name: 'Філе куряче А', price: 80.9, weighted: true, displayRatio: '100г' });
    const perKg = product({ name: 'Філе куряче Б', price: 250, weighted: true, displayRatio: '1кг' });

    expect(selectProduct('куряче філе', [per100g, perKg])?.product.name).toBe('Філе куряче Б');
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
