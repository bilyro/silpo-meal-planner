import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import type { SessionState } from './session.js';

interface GetMyShoppingCartResult {
  success: boolean;
  shoppingCartId: string | null;
  exists: boolean;
}

interface DeliveryAddress {
  id: string;
  city: string | null;
  street: string | null;
  building: string | null;
  apartment: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface GetMyDeliveryAddressesResult {
  success: boolean;
  addresses: DeliveryAddress[];
}

interface FoundAddress {
  city: string | null;
  street: string | null;
  houseNumber: string | null;
  latitude: number;
  longitude: number;
}

interface FindAddressResult {
  success: boolean;
  addresses: FoundAddress[];
}

interface DeliveryTypeOption {
  deliveryType: string;
  branchId: string | null;
  description: string;
}

interface GetAvailableDeliveryTypesResult {
  success: boolean;
  options: DeliveryTypeOption[];
}

interface Branch {
  branchId: string;
  hasPickup: boolean | null;
  open: boolean | null;
}

interface ListBranchesResult {
  success: boolean;
  branches: Branch[];
}

interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
  deliveryType: string;
}

interface GetTimeSlotsResult {
  success: boolean;
  slots: TimeSlot[];
}

interface CreateShoppingCartResult {
  success: boolean;
  shoppingCartId: string;
}

interface GetShoppingCartByIdResult {
  success: boolean;
  cart: Record<string, unknown>;
}

// Delivery types that make sense for a home meal-planning flow, in priority order — self-pickup
// is the fallback when nothing else is available. Full enum is in docs/tools.json; the others
// (NovaPoshta, B2B, PreOrder, ...) don't apply to this bot's use case.
const DELIVERY_TYPE_PRIORITY = ['DeliveryHome', 'DeliveryFlat', 'LongDelivery', 'WideAssortDelivery', 'SelfPickup'];

function pickDeliveryType(options: DeliveryTypeOption[]): DeliveryTypeOption | undefined {
  for (const preferred of DELIVERY_TYPE_PRIORITY) {
    const match = options.find((o) => o.deliveryType === preferred);
    if (match) return match;
  }
  return options[0];
}

export type EnsureCartContextResult = { needsAddress: true } | { cartContext: NonNullable<SessionState['cartContext']> };

/**
 * Deterministic cart bootstrap (spec §4.3, §9.5): get cart → if none, resolve an address → pick
 * delivery type → pick a branch → pick a time slot → create the cart. Done in code rather than
 * left to the LLM because chaining ~6 dependent tool calls correctly is exactly the kind of thing
 * an agent can flub (spec §6.3's whole rationale for local tools).
 *
 * ⚠ DISCOVER: silpo_get_shopping_cart_by_id's `cart` field is an untyped passthrough of Silpo's
 * internal API response (its JSON Schema is `{type: object, additionalProperties: {}}` — no
 * documented fields at all). For a cart WE just created, we already know branchId/deliveryType/
 * timeslot from our own request and don't need to parse it. For a pre-existing cart (the `exists:
 * true` branch below), we have no choice but to guess plausible field names defensively; this is
 * unverified against real data (blocked on the Phase 2 OAuth issue) and should be corrected the
 * first time a real account with an existing cart exercises this path.
 */
export async function ensureCartContext(
  mcp: SilpoMcpClient,
  state: SessionState,
  /**
   * Free-text address supplied by the user, used when the account has no saved delivery address
   * (spec §8 Phase 4 step 2). Verified necessary against a real account: `silpo_get_my_delivery_addresses`
   * returned an empty list, so without this the flow could only ever report `needsAddress`.
   */
  addressText?: string,
): Promise<EnsureCartContextResult> {
  if (state.cartContext) return { cartContext: state.cartContext };

  const existing = await mcp.callTool<GetMyShoppingCartResult>('silpo_get_my_shopping_cart');

  if (existing.exists && existing.shoppingCartId) {
    const { cart } = await mcp.callTool<GetShoppingCartByIdResult>('silpo_get_shopping_cart_by_id', {
      shoppingCartId: existing.shoppingCartId,
    });
    // Best-effort extraction from the undocumented `cart` shape — see the ⚠ DISCOVER note above.
    const branchId = String(cart.branchId ?? cart.branch_id ?? (cart.branch as { id?: string } | undefined)?.id ?? '');
    const deliveryType = String(cart.deliveryType ?? cart.delivery_type ?? '');
    const rawTimeslot = (cart.timeslot ?? cart.timeSlot) as { start?: string; end?: string } | undefined;
    const cartContext: NonNullable<SessionState['cartContext']> = {
      cartId: existing.shoppingCartId,
      branchId,
      deliveryType,
      ...(rawTimeslot?.start && rawTimeslot?.end
        ? { timeslot: { start: rawTimeslot.start, end: rawTimeslot.end } }
        : {}),
    };
    state.cartContext = cartContext;
    return { cartContext };
  }

  const { addresses } = await mcp.callTool<GetMyDeliveryAddressesResult>('silpo_get_my_delivery_addresses');
  const savedAddress = addresses[0];
  if (!savedAddress && !addressText) return { needsAddress: true };

  let latitude = savedAddress?.latitude ?? null;
  let longitude = savedAddress?.longitude ?? null;
  let city = savedAddress?.city ?? null;
  let street = savedAddress?.street ?? null;
  let house = savedAddress?.building ?? null;
  const hasApartment = Boolean(savedAddress?.apartment);

  // Geocode when we have only text: either the user supplied an address (no saved one exists), or
  // the saved address is missing coordinates. A user-supplied address takes precedence, since the
  // user is answering a direct question about where to deliver right now.
  if (addressText || latitude == null || longitude == null) {
    const query =
      addressText ?? [savedAddress?.city, savedAddress?.street, savedAddress?.building].filter(Boolean).join(', ');
    const found = await mcp.callTool<FindAddressResult>('silpo_find_address', { address: query });
    const geocoded = found.addresses[0];
    if (!geocoded) return { needsAddress: true };
    latitude = geocoded.latitude;
    longitude = geocoded.longitude;
    city = geocoded.city;
    street = geocoded.street;
    house = geocoded.houseNumber;
  }

  const { options } = await mcp.callTool<GetAvailableDeliveryTypesResult>('silpo_get_available_delivery_types', {
    latitude,
    longitude,
  });
  const chosen = pickDeliveryType(options);
  if (!chosen) return { needsAddress: true };

  let branchId = chosen.branchId ?? undefined;
  if (!branchId) {
    const { branches } = await mcp.callTool<ListBranchesResult>('silpo_list_branches', {
      hasPickup: chosen.deliveryType === 'SelfPickup',
    });
    const openBranch = branches.find((b) => b.open !== false) ?? branches[0];
    if (!openBranch) return { needsAddress: true };
    branchId = openBranch.branchId;
  }

  const { slots } = await mcp.callTool<GetTimeSlotsResult>('silpo_get_time_slots', {
    branchId,
    deliveryTypes: [chosen.deliveryType],
  });
  const slot = slots.find((s) => s.available) ?? slots[0];
  if (!slot) return { needsAddress: true };

  const created = await mcp.callTool<CreateShoppingCartResult>('silpo_create_shopping_cart', {
    addressType: hasApartment ? 'flat' : 'house',
    latitude,
    longitude,
    city: city ?? undefined,
    street: street ?? undefined,
    house: house ?? undefined,
    deliveryType: chosen.deliveryType,
    timeslot: { start: slot.start, end: slot.end },
    branchId,
  });

  const cartContext: NonNullable<SessionState['cartContext']> = {
    cartId: created.shoppingCartId,
    branchId,
    deliveryType: chosen.deliveryType,
    timeslot: { start: slot.start, end: slot.end },
  };
  state.cartContext = cartContext;
  return { cartContext };
}
