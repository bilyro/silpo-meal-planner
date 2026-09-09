/**
 * `remove_items` lets the user drop an already-resolved line by name ("прибери лосось"). It
 * filters `state.resolvedItems` in code, never by asking the model to retype everything that
 * should stay — the same "code resolves it, the model only supplies inputs" shape `addExtraItems`
 * already uses for the opposite direction.
 *
 * The regression under test is the filter, not the matching heuristic (`matchesQuery` is already
 * covered by selectProduct.test.ts): removing the WRONG line, removing too many at once, or
 * failing to invalidate a stale `cartWritten` flag would all be silent and costly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({ saveSessionState: vi.fn(async () => {}) }));

import { removeItems } from '../src/agent/localTools.js';
import type { SessionState } from '../src/agent/session.js';

type Item = NonNullable<SessionState['resolvedItems']>[number];

function item(over: Partial<Item>): Item {
  return {
    ingredient: 'товар',
    productId: 'p',
    companyId: 'c',
    title: 'Товар',
    qty: 1,
    unitPrice: 10,
    isPromo: false,
    wasSubstituted: false,
    ...over,
  };
}

function baseState(items: Item[]): SessionState {
  return {
    stage: 'list_resolved',
    resolvedItems: items,
    totals: { sum: items.reduce((s, i) => s + i.unitPrice * i.qty, 0), promoShare: 0, substitutionRate: 0 },
    metrics: { startedAt: new Date().toISOString(), toolCalls: 0 },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('removeItems — filters without touching what stays', () => {
  it('removes the matching line and leaves the others untouched', async () => {
    const salmon = item({ ingredient: 'лосось', title: 'Лосось філе охолоджене', unitPrice: 300 });
    const rice = item({ ingredient: 'рис', title: 'Рис довгозернистий', unitPrice: 50 });
    const state = baseState([salmon, rice]);

    const result = await removeItems(1, state, ['лосось']);

    expect(result.removed).toEqual([salmon]);
    expect(result.notFound).toEqual([]);
    expect(state.resolvedItems).toEqual([rice]);
    expect(state.totals?.sum).toBe(50);
  });

  it('matches by the resolved product title too, not only the original ingredient name', async () => {
    // The user is far more likely to name what they SEE ("прибери печиво") than the generic
    // ingredient string the model originally searched for.
    const cookies = item({ ingredient: 'снек', title: 'Печиво Konti Super Kontik', unitPrice: 60 });
    const state = baseState([cookies]);

    const result = await removeItems(1, state, ['печиво']);

    expect(result.removed).toEqual([cookies]);
    expect(state.resolvedItems).toEqual([]);
  });

  it('reports a name that matches nothing, without touching the list', async () => {
    const rice = item({ ingredient: 'рис', title: 'Рис довгозернистий' });
    const state = baseState([rice]);

    const result = await removeItems(1, state, ['лосось']);

    expect(result.removed).toEqual([]);
    expect(result.notFound).toEqual(['лосось']);
    expect(state.resolvedItems).toEqual([rice]);
  });

  it('removes at most one line per requested name, not every line that shares a word', async () => {
    // "яловина" would stem-match BOTH lines below — sweeping both because the user only meant one
    // would be a worse mistake than occasionally needing to ask again with a more specific name.
    const forBorscht = item({ ingredient: 'яловина', title: 'Яловичина на борщ', unitPrice: 200 });
    const forStew = item({ ingredient: 'яловина стейк', title: 'Яловичий стейк', unitPrice: 500 });
    const state = baseState([forBorscht, forStew]);

    const result = await removeItems(1, state, ['яловина']);

    expect(result.removed).toHaveLength(1);
    expect(state.resolvedItems).toHaveLength(1);
  });

  it('handles several names in one call, mixing hits and misses', async () => {
    const salmon = item({ ingredient: 'лосось', title: 'Лосось філе' });
    const rice = item({ ingredient: 'рис', title: 'Рис' });
    const state = baseState([salmon, rice]);

    const result = await removeItems(1, state, ['лосось', 'арахіс']);

    expect(result.removed.map((r) => r.ingredient)).toEqual(['лосось']);
    expect(result.notFound).toEqual(['арахіс']);
    expect(state.resolvedItems).toEqual([rice]);
  });

  it('resets a stale cartWritten flag when a line is actually removed', async () => {
    const salmon = item({ ingredient: 'лосось' });
    const state = { ...baseState([salmon]), cartWritten: true };

    await removeItems(1, state, ['лосось']);

    expect(state.cartWritten).toBe(false);
  });

  it('does NOT reset cartWritten when every requested name misses (a no-op)', async () => {
    // A typo or an already-gone item leaves the list unchanged — a built cart must not be marked
    // stale for a call that changed nothing, which would wrongly demand pressing 🛒 again.
    const rice = item({ ingredient: 'рис' });
    const state = { ...baseState([rice]), cartWritten: true };

    const result = await removeItems(1, state, ['лосось']);

    expect(result.removed).toEqual([]);
    expect(state.cartWritten).toBe(true);
    expect(state.resolvedItems).toEqual([rice]);
  });
});
