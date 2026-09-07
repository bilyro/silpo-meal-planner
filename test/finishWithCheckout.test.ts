/**
 * `finish_with_checkout` is a read tool the model can call at any time — it has no write tool, so
 * nothing stops it from calling this BEFORE the 🛒 button has actually written anything.
 *
 * Regression for a live incident (7 Sept 2026): a user typed «Збери кошик» as free text (the
 * button that should have existed didn't render — a separate bug). The model called this tool
 * with nothing ever written to the real cart, and composed a fabricated cart status — "мінімум
 * 599 грн, а в кошику лише 188 грн" — that matched neither the real (empty) cart nor session
 * state. A system-prompt rule against inventing this was already in place and did not stop it on
 * retest, so the read itself is refused here instead, before there is any real number for the
 * model to embellish. The guarantee under test is that refusal, not the prompt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({ saveSessionState: vi.fn(async () => {}) }));

import { finishWithCheckout } from '../src/agent/localTools.js';
import type { SessionState } from '../src/agent/session.js';
import type { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

function baseState(): SessionState {
  return {
    stage: 'list_resolved',
    cartContext: { cartId: 'cart-1', branchId: 'branch-1', deliveryType: 'delivery' },
    resolvedItems: [
      {
        ingredient: 'яловичина',
        productId: 'p1',
        companyId: 'c1',
        title: 'Яловичина, лопатка',
        qty: 0.8,
        unitPrice: 300,
        isPromo: false,
        wasSubstituted: false,
      },
    ],
    totals: { sum: 495.06, promoShare: 0, substitutionRate: 0 },
    metrics: { startedAt: new Date().toISOString(), toolCalls: 0 },
  };
}

function mockMcp() {
  const callTool = vi.fn(async () => ({
    cart: { calculation: { validations: [] } },
    checkoutWebLink: 'https://silpo.ua/checkout-new',
  }));
  return { callTool } as unknown as SilpoMcpClient;
}

beforeEach(() => vi.clearAllMocks());

describe('finishWithCheckout — refuses to read before anything was written', () => {
  it('returns an error and calls no Silpo tool when cartWritten is unset', async () => {
    const state = baseState();
    const mcp = mockMcp();

    const summary = await finishWithCheckout(1, state, mcp);

    expect(summary.error).toBeDefined();
    expect(summary.cartTotal).toBeUndefined();
    expect(summary.checkoutWebLink).toBeUndefined();
    expect((mcp.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('proceeds to the real read once the button has actually written the cart', async () => {
    const state = { ...baseState(), cartWritten: true };
    const mcp = mockMcp();

    const summary = await finishWithCheckout(1, state, mcp);

    expect(summary.error).toBeUndefined();
    expect(summary.checkoutWebLink).toBe('https://silpo.ua/checkout-new');
    expect(mcp.callTool).toHaveBeenCalledWith(
      'silpo_get_shopping_cart_by_id',
      expect.objectContaining({ shoppingCartId: 'cart-1' }),
    );
  });

  it('still refuses when a stale flag survived from an unrelated cart context', async () => {
    // cartContext missing is checked first regardless of cartWritten — different guard, same
    // "never fabricate" property: no cart id means nothing real to read either.
    const state: SessionState = { ...baseState(), cartWritten: true, cartContext: undefined };
    const mcp = mockMcp();

    const summary = await finishWithCheckout(1, state, mcp);

    expect(summary.error).toBeDefined();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});

describe('applyResolution — invalidates the flag for the new list', () => {
  it('resets cartWritten to false, so an old write cannot authorize reading for a new resolution', async () => {
    const { applyResolution } = await import('../src/agent/localTools.js');
    const state = { ...baseState(), cartWritten: true };

    await applyResolution(1, state, state.resolvedItems!);

    expect(state.cartWritten).toBe(false);
  });
});
