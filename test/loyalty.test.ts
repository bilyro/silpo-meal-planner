import { describe, expect, it } from 'vitest';
import {
  firstApplicableCode,
  formatLoyaltyBlock,
  toOffers,
  type CartLoyalty,
  type Offer,
} from '../src/agent/loyalty.js';

const NOW = new Date('2026-09-06T12:00:00Z');

/** Verbatim from the live dev account on 6 Sept 2026 (`silpo_get_my_coupons`). */
const LIVE_COUPONS = {
  success: true,
  summary: 'Found 2 coupons',
  coupons: [
    {
      id: 569792377,
      active: true,
      useWay: 'Електронний',
      beginDate: '2026-09-01',
      endDate: '2026-12-31',
      endDateTime: '2026-12-31T23:59:59',
      description: 'на онлайн чек',
      limitText: '• Не діє на подарункові сертифікати',
      warningText: 'Максимальна знижка 100 грн',
      promoId: 304949,
      rewardText: '-10%',
      rewardValue: 10,
      rewardUnit: '%',
      rewardSign: '-',
      rewardLimit: 1000,
    },
    {
      id: 564582636,
      active: true,
      useWay: 'Електронний',
      beginDate: '2026-08-31',
      endDate: '2027-09-01',
      endDateTime: '2027-09-01T23:59:59',
      description: 'будь-який солодкий круасан при оплаті карткою',
      warningText: null,
      promoId: 246916,
      rewardText: 'за 1 грн',
      rewardValue: 1,
      rewardUnit: 'грн',
      rewardSign: 'за ',
      rewardLimit: 1,
    },
  ],
};

/** Verbatim from the live dev account: the account simply has none. */
const LIVE_EMPTY_PROMO_CODES = { success: true, summary: 'No promo codes', promoCodes: [], meta: { total: 0 } };

const cartLoyalty = (overrides: Partial<CartLoyalty> = {}): CartLoyalty => ({
  bonusAvailable: 0,
  bonusTotal: 12.46,
  bonusRequested: null,
  isEnabled: true,
  ...overrides,
});

describe('toOffers', () => {
  it('normalises the live coupon payload', () => {
    const offers = toOffers(LIVE_COUPONS, LIVE_EMPTY_PROMO_CODES, NOW);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      kind: 'coupon',
      id: '569792377',
      title: 'на онлайн чек',
      reward: '-10%',
      warning: 'Максимальна знижка 100 грн',
    });
    // Coupons carry no code, so nothing here is programmatically applicable.
    expect(offers.every((o) => o.code === undefined)).toBe(true);
    expect(firstApplicableCode(offers)).toBeUndefined();
  });

  it('keeps rewardText verbatim rather than composing sign+value+unit', () => {
    // «за 1 грн» means "buy it for 1 UAH"; composing would read as a 1 грн discount.
    const [, croissant] = toOffers(LIVE_COUPONS, undefined, NOW);
    expect(croissant?.reward).toBe('за 1 грн');
  });

  it('drops inactive and expired coupons but keeps one ending today', () => {
    const raw = {
      coupons: [
        { id: 1, active: false, description: 'вимкнений', endDate: '2027-01-01' },
        { id: 2, active: true, description: 'протермінований', endDate: '2026-09-01' },
        { id: 3, active: true, description: 'останній день', endDate: '2026-09-06' },
      ],
    };
    const offers = toOffers(raw, undefined, NOW);
    expect(offers.map((o) => o.title)).toEqual(['останній день']);
  });

  it('reads promo codes and puts the actionable ones first', () => {
    const promoCodes = { promoCodes: [{ code: 'SHEF10', description: 'знижка на перше замовлення' }] };
    const offers = toOffers(LIVE_COUPONS, promoCodes, NOW);
    expect(offers[0]).toMatchObject({ kind: 'promo_code', code: 'SHEF10' });
    expect(firstApplicableCode(offers)).toBe('SHEF10');
  });

  it('ignores promo-code entries with no usable code', () => {
    const offers = toOffers(undefined, { promoCodes: [{ description: 'без коду' }] }, NOW);
    expect(offers).toEqual([]);
  });

  it('survives junk or missing responses', () => {
    expect(toOffers(undefined, undefined, NOW)).toEqual([]);
    expect(toOffers('nope', { promoCodes: 'nope' }, NOW)).toEqual([]);
  });
});

describe('formatLoyaltyBlock', () => {
  it('says nothing at all for an empty account', () => {
    const out = formatLoyaltyBlock({
      cartLoyalty: cartLoyalty({ bonusTotal: 0 }),
      offers: [],
    });
    expect(out).toBe('');
  });

  it('shows the balance but not a zero spendable amount', () => {
    // Live: bonusAvailable was 0 while bonusTotal was 12.46 — «можна списати 0 грн» is noise.
    const out = formatLoyaltyBlock({ cartLoyalty: cartLoyalty() });
    expect(out).toContain('12.46 грн на рахунку');
    expect(out).not.toContain('списати');
  });

  it('offers to spend bonuses when the cart allows it', () => {
    const out = formatLoyaltyBlock({ cartLoyalty: cartLoyalty({ bonusAvailable: 8.5 }) });
    expect(out).toContain('можна списати 8.50 грн');
  });

  it('stays silent about spending when loyalty is disabled for the cart', () => {
    const out = formatLoyaltyBlock({ cartLoyalty: cartLoyalty({ bonusAvailable: 8.5, isEnabled: false }) });
    expect(out).toContain('12.46 грн на рахунку');
    expect(out).not.toContain('списати');
  });

  it('adds the Скарбничка split only when loyalty info carries one', () => {
    const info = {
      balance: {
        total: 12.46,
        accounts: [
          { type: 'Regular', amount: 12.46 },
          { type: 'Moneybox', amount: 40 },
        ],
      },
    };
    expect(formatLoyaltyBlock({ cartLoyalty: cartLoyalty(), info })).toContain('40 грн у Скарбничці');
    expect(formatLoyaltyBlock({ cartLoyalty: cartLoyalty() })).not.toContain('Скарбничці');
  });

  it('renders coupons with the auto-apply note', () => {
    const offers = toOffers(LIVE_COUPONS, LIVE_EMPTY_PROMO_CODES, NOW);
    const out = formatLoyaltyBlock({ cartLoyalty: cartLoyalty(), offers });
    expect(out).toContain('🎟 <b>Ваші пропозиції</b>');
    expect(out).toContain('<b>-10%</b> — на онлайн чек (до 31.12.2026)');
    expect(out).toContain('⚠️ Максимальна знижка 100 грн');
    expect(out).toContain('Купони застосуються автоматично при оплаті.');
  });

  it('reports an already-applied code instead of re-offering it', () => {
    const offers: Offer[] = [{ kind: 'promo_code', id: 'SHEF10', code: 'SHEF10', title: 'знижка' }];
    const out = formatLoyaltyBlock({ offers, appliedPromoCode: 'SHEF10' });
    expect(out).toContain('Промокод <b>SHEF10</b> застосовано');
    expect(out).not.toContain('Ваші пропозиції');
  });

  it('escapes offer text so Telegram HTML cannot be broken', () => {
    const offers: Offer[] = [{ kind: 'coupon', id: '1', title: 'знижка <b>на все</b> & більше' }];
    const out = formatLoyaltyBlock({ offers });
    expect(out).toContain('знижка &lt;b&gt;на все&lt;/b&gt; &amp; більше');
  });

  it('caps the list and counts the remainder', () => {
    const offers: Offer[] = Array.from({ length: 7 }, (_, i) => ({
      kind: 'coupon' as const,
      id: String(i),
      title: `купон ${i}`,
    }));
    const out = formatLoyaltyBlock({ offers });
    expect(out).toContain('купон 3');
    expect(out).not.toContain('купон 4');
    expect(out).toContain('…та ще 3');
  });
});
