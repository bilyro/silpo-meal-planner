import { describe, expect, it, vi } from 'vitest';
import { ensureCartContext } from '../src/agent/cartContext.js';
import type { SessionState } from '../src/agent/session.js';
import type { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return { stage: 'idle', metrics: { startedAt: new Date().toISOString(), toolCalls: 0 }, ...overrides };
}

/** Minimal fake satisfying the one method ensureCartContext actually calls. */
function makeMockMcp(responses: Record<string, unknown>) {
  const callTool = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (!(name in responses)) throw new Error(`Unexpected tool call in test: ${name}`);
    return responses[name];
  });
  return { mcp: { callTool } as unknown as SilpoMcpClient, callTool };
}

function callsTo(callTool: ReturnType<typeof vi.fn>, name: string) {
  return callTool.mock.calls.filter((c) => c[0] === name);
}

describe('ensureCartContext', () => {
  it('returns immediately if state.cartContext is already set, without any tool calls', async () => {
    const existingContext = { cartId: 'existing', branchId: 'b1', deliveryType: 'DeliveryHome' };
    const state = makeState({ cartContext: existingContext });
    const { mcp, callTool } = makeMockMcp({});

    const result = await ensureCartContext(mcp, state);

    expect(result).toEqual({ cartContext: existingContext });
    expect(callTool).not.toHaveBeenCalled();
  });

  describe('when a cart already exists on the account', () => {
    it('extracts recognizable fields from the cart object when present', async () => {
      const state = makeState();
      const { mcp, callTool } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: true, shoppingCartId: 'abc-123' },
        silpo_get_shopping_cart_by_id: {
          success: true,
          // Mirrors a REAL cart captured 6 Sept 2026: there is no top-level `branchId` — it lives
          // on the shipment. An earlier version of this file asserted a guessed `cart.branchId`,
          // which passed against the guess while silently producing '' against live data.
          cart: {
            id: 'abc-123',
            deliveryType: 'DeliveryHome',
            timeslot: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T12:00:00Z' },
            shipments: [{ id: 'ship-1', companyId: 'company-1', branchId: 'branch-9', products: [] }],
            calculation: { validations: [] },
          },
        },
      });

      const result = await ensureCartContext(mcp, state);

      expect(result).toEqual({
        cartContext: {
          cartId: 'abc-123',
          branchId: 'branch-9',
          deliveryType: 'DeliveryHome',
          timeslot: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T12:00:00Z' },
        },
      });
      expect(callsTo(callTool, 'silpo_get_shopping_cart_by_id')).toEqual([
        ['silpo_get_shopping_cart_by_id', { shoppingCartId: 'abc-123' }],
      ]);
    });

    it('rebooks the slot when the existing cart reports a timeslot validation error', async () => {
      // A cart outlives its slot: reopening one made earlier the same day returns
      // validations: [{level:'error', type:'timeslot', message:'timeslot.not_found'}] — observed
      // live. Without rebooking, every 🔒 cart-context tool rejects the stale slot.
      const state = makeState();
      const { mcp, callTool } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: true, shoppingCartId: 'abc-123' },
        silpo_get_shopping_cart_by_id: {
          success: true,
          cart: {
            deliveryType: 'DeliveryHome',
            timeslot: { start: 'stale-start', end: 'stale-end' },
            address: { city: 'Київ' },
            shipments: [{ branchId: 'branch-9', products: [] }],
            calculation: { validations: [{ level: 'error', type: 'timeslot', message: 'timeslot.not_found' }] },
          },
        },
        silpo_get_time_slots: {
          success: true,
          slots: [
            { start: 'gone', end: 'gone', available: false, deliveryType: 'DeliveryHome' },
            { start: 'fresh-start', end: 'fresh-end', available: true, deliveryType: 'DeliveryHome' },
          ],
        },
        silpo_update_shopping_cart: { success: true },
      });

      const result = await ensureCartContext(mcp, state);

      expect(result).toEqual({
        cartContext: {
          cartId: 'abc-123',
          branchId: 'branch-9',
          deliveryType: 'DeliveryHome',
          timeslot: { start: 'fresh-start', end: 'fresh-end' },
        },
      });
      // The update must echo the cart's own address and shipments back — the tool requires them.
      const update = callsTo(callTool, 'silpo_update_shopping_cart')[0];
      expect(update?.[1]).toMatchObject({
        shoppingCartId: 'abc-123',
        branchId: 'branch-9',
        timeslot: { start: 'fresh-start', end: 'fresh-end' },
        address: { city: 'Київ' },
      });
    });

    it('degrades gracefully when the undocumented cart object has none of the guessed field names', async () => {
      const state = makeState();
      const { mcp } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: true, shoppingCartId: 'abc-123' },
        silpo_get_shopping_cart_by_id: { success: true, cart: {} },
      });

      const result = await ensureCartContext(mcp, state);

      // Must not throw — cartId is still set, branchId/deliveryType fall back to best-effort ''.
      expect(result).toEqual({
        cartContext: { cartId: 'abc-123', branchId: '', deliveryType: '' },
      });
      expect(state.cartContext).toEqual(result && 'cartContext' in result ? result.cartContext : undefined);
    });
  });

  describe('when there is no cart yet', () => {
    it('returns needsAddress:true and stops immediately if there are no saved addresses', async () => {
      const state = makeState();
      const { mcp, callTool } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: false, shoppingCartId: null },
        silpo_get_my_delivery_addresses: { success: true, addresses: [] },
      });

      const result = await ensureCartContext(mcp, state);

      expect(result).toEqual({ needsAddress: true });
      expect(callsTo(callTool, 'silpo_get_available_delivery_types')).toHaveLength(0);
      expect(callsTo(callTool, 'silpo_find_address')).toHaveLength(0);
      expect(state.cartContext).toBeUndefined();
    });

    it('builds a cart end-to-end when the saved address already has coordinates, skipping geocoding and branch lookup', async () => {
      const state = makeState();
      const { mcp, callTool } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: false, shoppingCartId: null },
        silpo_get_my_delivery_addresses: {
          success: true,
          addresses: [
            {
              id: 'addr-1',
              city: 'Київ',
              street: 'Хрещатик',
              building: '1',
              apartment: null,
              latitude: 50.45,
              longitude: 30.52,
            },
          ],
        },
        // branchId already present on the option -> silpo_list_branches must not be called.
        silpo_get_available_delivery_types: {
          success: true,
          options: [{ deliveryType: 'DeliveryHome', branchId: 'branch-1', description: 'Доставка додому' }],
        },
        // first slot unavailable -> the available one must be picked instead.
        silpo_get_time_slots: {
          success: true,
          slots: [
            { start: '2026-01-02T08:00:00Z', end: '2026-01-02T09:00:00Z', available: false, deliveryType: 'DeliveryHome' },
            { start: '2026-01-02T10:00:00Z', end: '2026-01-02T12:00:00Z', available: true, deliveryType: 'DeliveryHome' },
          ],
        },
        silpo_create_shopping_cart: { success: true, shoppingCartId: 'cart-999' },
      });

      const result = await ensureCartContext(mcp, state);

      expect(callsTo(callTool, 'silpo_find_address')).toHaveLength(0);
      expect(callsTo(callTool, 'silpo_list_branches')).toHaveLength(0);

      const expectedContext = {
        cartId: 'cart-999',
        branchId: 'branch-1',
        deliveryType: 'DeliveryHome',
        timeslot: { start: '2026-01-02T10:00:00Z', end: '2026-01-02T12:00:00Z' },
      };
      expect(result).toEqual({ cartContext: expectedContext });
      // Mutated in place, per the function's documented contract.
      expect(state.cartContext).toBe(result && 'cartContext' in result ? result.cartContext : undefined);

      const createCall = callsTo(callTool, 'silpo_create_shopping_cart')[0];
      expect(createCall?.[1]).toMatchObject({
        latitude: 50.45,
        longitude: 30.52,
        addressType: 'house', // no apartment on the saved address
        deliveryType: 'DeliveryHome',
        branchId: 'branch-1',
      });
    });

    it('geocodes via silpo_find_address when the saved address has no coordinates, and looks up a branch when the delivery option has none', async () => {
      const state = makeState();
      const { mcp, callTool } = makeMockMcp({
        silpo_get_my_shopping_cart: { success: true, exists: false, shoppingCartId: null },
        silpo_get_my_delivery_addresses: {
          success: true,
          addresses: [
            {
              id: 'addr-2',
              city: 'Львів',
              street: 'Свободи',
              building: '10',
              apartment: '5',
              latitude: null,
              longitude: null,
            },
          ],
        },
        silpo_find_address: {
          success: true,
          addresses: [{ city: 'Львів', street: 'Свободи', houseNumber: '10', latitude: 49.84, longitude: 24.03 }],
        },
        // branchId is null here -> silpo_list_branches must be consulted.
        silpo_get_available_delivery_types: {
          success: true,
          options: [{ deliveryType: 'DeliveryHome', branchId: null, description: 'Доставка додому' }],
        },
        silpo_list_branches: {
          success: true,
          branches: [{ branchId: 'branch-open', hasPickup: false, open: true }],
        },
        silpo_get_time_slots: {
          success: true,
          slots: [{ start: '2026-01-03T10:00:00Z', end: '2026-01-03T12:00:00Z', available: true, deliveryType: 'DeliveryHome' }],
        },
        silpo_create_shopping_cart: { success: true, shoppingCartId: 'cart-111' },
      });

      const result = await ensureCartContext(mcp, state);

      const findAddressCalls = callsTo(callTool, 'silpo_find_address');
      expect(findAddressCalls).toHaveLength(1);
      expect(findAddressCalls[0]?.[1]).toEqual({ address: 'Львів, Свободи, 10' });

      const listBranchesCalls = callsTo(callTool, 'silpo_list_branches');
      expect(listBranchesCalls).toHaveLength(1);
      expect(listBranchesCalls[0]?.[1]).toEqual({ hasPickup: false });

      expect(result).toEqual({
        cartContext: {
          cartId: 'cart-111',
          branchId: 'branch-open',
          deliveryType: 'DeliveryHome',
          timeslot: { start: '2026-01-03T10:00:00Z', end: '2026-01-03T12:00:00Z' },
        },
      });

      const createCall = callsTo(callTool, 'silpo_create_shopping_cart')[0];
      expect(createCall?.[1]).toMatchObject({
        latitude: 49.84,
        longitude: 24.03,
        city: 'Львів',
        street: 'Свободи',
        house: '10', // geocoded houseNumber, not the original saved address's `building`
        addressType: 'flat', // saved address had a non-null apartment
        branchId: 'branch-open',
      });
    });
  });
});
