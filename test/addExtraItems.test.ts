/**
 * `add_extra_items` lets the user tack ad-hoc items onto the shopping list outside the meal
 * plan's own ingredients ("додай чіпси і пиво"). The model supplies ONLY names + free-text
 * quantities — never a productId or price — and this function resolves them against the live
 * catalogue exactly the way `resolveIngredients()` already does for recipe ingredients, then
 * APPENDS the result to `state.resolvedItems`. This is the same "never trust the model to retype
 * tool-sourced data" rule `applyResolution`'s `cartWritten` reset already enforces: only code ever
 * writes prices/ids into session state.
 *
 * The regression under test is the append, not the resolution heuristic (selectProduct.test.ts
 * covers that): a bug that replaced the list instead of appending to it, or that let a stored
 * allergy leak through for an ad-hoc item, would both be silent and costly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({
  saveSessionState: vi.fn(async () => {}),
  listUserFacts: vi.fn(async () => []),
}));

import * as repo from '../src/db/repo.js';
import { addExtraItems } from '../src/agent/localTools.js';
import type { SessionState } from '../src/agent/session.js';
import type { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

const listUserFacts = vi.mocked(repo.listUserFacts);

type Fact = { id: number; kind: string; text: string; source: 'user' | 'silpo' };
function facts(...rows: Fact[]) {
  listUserFacts.mockResolvedValue(rows as unknown as Awaited<ReturnType<typeof repo.listUserFacts>>);
}

function existingItem(): NonNullable<SessionState['resolvedItems']>[number] {
  return {
    ingredient: 'куряче філе',
    productId: 'p-chicken',
    companyId: 'c1',
    title: 'Філе куряче охолоджене',
    qty: 1,
    unitPrice: 150,
    isPromo: false,
    wasSubstituted: false,
  };
}

function baseState(): SessionState {
  return {
    stage: 'list_resolved',
    cartContext: {
      cartId: 'cart-1',
      branchId: 'branch-1',
      deliveryType: 'DeliveryHome',
      timeslot: { start: '2026-09-07T10:00:00Z', end: '2026-09-07T12:00:00Z' },
    },
    resolvedItems: [existingItem()],
    totals: { sum: 150, promoShare: 0, substitutionRate: 0 },
    metrics: { startedAt: new Date().toISOString(), toolCalls: 0 },
  };
}

/** Candidate for `silpo_find_products_batch`'s per-query result. */
function candidate(over: Record<string, unknown>) {
  return { id: 'p-chips', available: true, stock: 10, price: 45, name: 'Чіпси Lux Original', ...over };
}

function mockMcp(byQuery: Record<string, unknown[]>) {
  const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'silpo_find_products_batch') {
      const products = args.products as string[];
      return {
        success: true,
        queries: products.map((q) => ({ query: q, totalFound: (byQuery[q] ?? []).length, products: byQuery[q] ?? [] })),
      };
    }
    throw new Error(`unexpected tool call: ${tool}`);
  });
  return { callTool } as unknown as SilpoMcpClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  facts();
});

describe('addExtraItems — appends without disturbing the existing list', () => {
  it('keeps the original item untouched and adds the new one', async () => {
    const state = baseState();
    const mcp = mockMcp({ чіпси: [candidate({})] });

    const result = await addExtraItems(1, state, mcp, [{ name: 'чіпси' }]);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.title).toBe('Чіпси Lux Original');
    expect(result.misses).toEqual([]);

    // The append, not a replace: the original item is still there, unchanged, plus the new one.
    expect(state.resolvedItems).toHaveLength(2);
    expect(state.resolvedItems?.[0]).toEqual(existingItem());
    expect(state.resolvedItems?.[1]?.title).toBe('Чіпси Lux Original');

    // Totals recomputed over the COMBINED list via the same computeTotals() the confirmed-menu
    // path uses, not hand-added.
    expect(state.totals?.sum).toBe(150 + 45);
    expect(state.stage).toBe('list_resolved');
  });

  it('resolves multiple ad-hoc items and appends all of them', async () => {
    const state = baseState();
    const mcp = mockMcp({
      чіпси: [candidate({})],
      пиво: [{ id: 'p-beer', available: true, stock: 5, price: 60, name: 'Пиво світле' }],
    });

    const result = await addExtraItems(1, state, mcp, [{ name: 'чіпси' }, { name: 'пиво' }]);

    expect(result.added).toHaveLength(2);
    expect(state.resolvedItems).toHaveLength(3);
    expect(state.totals?.sum).toBe(150 + 45 + 60);
  });

  it('throws when cart context has no timeslot, instead of silently skipping resolution', async () => {
    const state = { ...baseState(), cartContext: { cartId: 'c', branchId: 'b', deliveryType: 'DeliveryHome' } };
    const mcp = mockMcp({});

    await expect(addExtraItems(1, state, mcp, [{ name: 'чіпси' }])).rejects.toThrow(/timeslot/);
    // Nothing added, nothing mutated, on the guard path.
    expect(state.resolvedItems).toHaveLength(1);
  });
});

describe('addExtraItems — a stored hard restriction still excludes a conflicting extra item', () => {
  it('never adds a product violating a stored allergy, even when explicitly requested', async () => {
    facts({ id: 1, kind: 'allergy', text: 'горіхи', source: 'user' });
    const state = baseState();
    // Only a nut-containing candidate exists for this query — nothing else to fall back to.
    const mcp = mockMcp({ арахіс: [{ id: 'p-nuts', available: true, stock: 10, price: 30, name: 'Арахіс солоний' }] });

    const result = await addExtraItems(1, state, mcp, [{ name: 'арахіс' }]);

    expect(result.added).toHaveLength(0);
    expect(result.misses).toEqual(['арахіс']);
    // The pre-existing item is untouched and nothing forbidden slipped into the list.
    expect(state.resolvedItems).toHaveLength(1);
    expect(state.resolvedItems?.[0]).toEqual(existingItem());
  });
});

describe('addExtraItems — preloadedFacts skips the redundant listUserFacts query', () => {
  it('still excludes a conflicting extra item when facts are passed in directly', async () => {
    // No facts() call here — listUserFacts must never be hit when preloadedFacts is supplied.
    const state = baseState();
    const mcp = mockMcp({ арахіс: [{ id: 'p-nuts', available: true, stock: 10, price: 30, name: 'Арахіс солоний' }] });
    const preloadedFacts = [{ id: 1, kind: 'allergy', text: 'горіхи', source: 'user' as const }];

    const result = await addExtraItems(1, state, mcp, [{ name: 'арахіс' }], preloadedFacts);

    expect(result.added).toHaveLength(0);
    expect(result.misses).toEqual(['арахіс']);
    expect(listUserFacts).not.toHaveBeenCalled();
  });
});

describe('applyResolution reuse — cartWritten is invalidated by an append too', () => {
  it('resets a stale cartWritten flag when extra items grow the list', async () => {
    const state = { ...baseState(), cartWritten: true };
    const mcp = mockMcp({ чіпси: [candidate({})] });

    await addExtraItems(1, state, mcp, [{ name: 'чіпси' }]);

    expect(state.cartWritten).toBe(false);
  });

  it('does NOT reset cartWritten when nothing resolves (a no-op)', async () => {
    // Every requested item missing leaves the list unchanged — a built cart must not be marked
    // stale for a call that added nothing.
    const state = { ...baseState(), cartWritten: true };
    const mcp = mockMcp({});

    const result = await addExtraItems(1, state, mcp, [{ name: 'нонейкзистент' }]);

    expect(result.added).toHaveLength(0);
    expect(state.cartWritten).toBe(true);
    expect(state.resolvedItems).toHaveLength(1);
  });
});
