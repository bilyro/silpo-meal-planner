import { logger } from '../logger.js';
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
 * Pulls the branch id out of a fetched cart. Confirmed against a real cart (6 Sept 2026): there
 * is NO top-level `branchId` — it lives on each shipment, with a secondary copy inside the
 * delivery calculation. An earlier guess at `cart.branchId` silently produced '' and broke every
 * downstream 🔒 tool call, so both known locations are read explicitly.
 */
export function extractBranchId(cart: Record<string, unknown>): string {
  const shipment = (cart.shipments as { branchId?: string }[] | undefined)?.[0];
  if (shipment?.branchId) return shipment.branchId;
  const delivery = (cart.calculation as { delivery?: Record<string, { branchId?: string }> } | undefined)?.delivery;
  for (const option of Object.values(delivery ?? {})) {
    if (option && typeof option === 'object' && option.branchId) return option.branchId;
  }
  return '';
}

export interface CartValidation {
  level?: string;
  type?: string;
  message?: string;
  context?: Record<string, unknown>;
  productId?: string;
}

/**
 * Silpo nests checkout-blocking validations under `calculation`, not the cart's top level — a
 * detail three independent call sites (this file's `hasTimeslotError`, `localTools.ts`'s
 * `describeBlockers`, `scripts/show-cart.ts`) used to re-derive on their own, each with its own
 * slightly different local `CartValidation` type. One shared reader means a future change to
 * where/how Silpo reports validations only needs fixing here.
 */
export function getCartValidations(cart: Record<string, unknown>): CartValidation[] {
  return (cart.calculation as { validations?: CartValidation[] } | undefined)?.validations ?? [];
}

/** True when Silpo reports the cart's delivery slot as no longer bookable. */
export function hasTimeslotError(cart: Record<string, unknown>): boolean {
  return getCartValidations(cart).some((v) => v.level === 'error' && v.type === 'timeslot');
}

/**
 * A slot this close to ending is treated as already gone: resolving ingredients takes several
 * batched searches, so a slot expiring mid-run is as useless as one that expired an hour ago.
 */
const TIMESLOT_EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * True when the slot has passed (or is about to) by the wall clock, regardless of what Silpo says.
 *
 * `hasTimeslotError` alone is not enough, and the gap is not theoretical: an *empty* cart reports
 * no timeslot validation at all, so after a `/clear` the stale slot survived `ensureCartContext`
 * and every 🔒 search then ran against a dead slot. Observed 7 Sept 2026 — «картопля» came back as
 * «Картопляні зрази з капустою», three of six ingredients missed entirely, and the cart came back
 * with `product.offer.status.not_available`. The results looked like a bad search heuristic; the
 * real cause was the expired slot upstream of it.
 */
export function isTimeslotExpired(
  timeslot: { start?: string; end?: string } | undefined,
  now: number = Date.now(),
): boolean {
  const end = timeslot?.end ? Date.parse(timeslot.end) : NaN;
  if (!Number.isFinite(end)) return false; // no parseable slot: leave it to hasTimeslotError
  return end - TIMESLOT_EXPIRY_MARGIN_MS <= now;
}

/**
 * Books the next available slot on an existing cart. `silpo_update_shopping_cart` requires the
 * cart's current `address` and `shipments` to be echoed back alongside the new slot, so they are
 * taken from the fetched cart rather than reconstructed.
 */
async function rebookTimeslot(
  mcp: SilpoMcpClient,
  cart: Record<string, unknown>,
  cartId: string,
  branchId: string,
  deliveryType: string,
): Promise<{ start: string; end: string } | undefined> {
  const { slots } = await mcp.callTool<GetTimeSlotsResult>('silpo_get_time_slots', {
    branchId,
    ...(deliveryType ? { deliveryTypes: [deliveryType] } : {}),
  });
  const slot = slots.find((s) => s.available);
  if (!slot) return undefined;

  await mcp.callTool('silpo_update_shopping_cart', {
    shoppingCartId: cartId,
    deliveryType,
    timeslot: { start: slot.start, end: slot.end },
    address: cart.address,
    shipments: cart.shipments,
    branchId,
  });
  return { start: slot.start, end: slot.end };
}

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
  // The cached context is trusted for everything EXCEPT the slot, which expires on a wall clock we
  // do not control. Returning it unconditionally meant a session that crossed a slot boundary kept
  // a dead slot for as long as it lived — and every 🔒 search then ran against it, returning
  // nonsense that looked like a bad search heuristic. Dropping the slot here sends us down the
  // path below, which re-reads the cart and books the next open one.
  if (state.cartContext && !isTimeslotExpired(state.cartContext.timeslot)) {
    return { cartContext: state.cartContext };
  }
  if (state.cartContext) {
    logger.info(
      { cartId: state.cartContext.cartId, timeslot: state.cartContext.timeslot },
      'Cached cart context has an expired delivery slot; re-establishing',
    );
    delete state.cartContext;
  }

  const existing = await mcp.callTool<GetMyShoppingCartResult>('silpo_get_my_shopping_cart');

  if (existing.exists && existing.shoppingCartId) {
    const { cart } = await mcp.callTool<GetShoppingCartByIdResult>('silpo_get_shopping_cart_by_id', {
      shoppingCartId: existing.shoppingCartId,
    });
    const branchId = extractBranchId(cart);
    const deliveryType = String(cart.deliveryType ?? '');
    const rawTimeslot = cart.timeslot as { start?: string; end?: string } | undefined;

    // A cart outlives its delivery slot: reopening one created earlier in the day yields
    // `validations: [{level:'error', type:'timeslot', message:'timeslot.not_found'}]`, and every
    // 🔒 cart-context tool then rejects the stale slot. Book the next open one before returning.
    let timeslot = rawTimeslot?.start && rawTimeslot?.end ? { start: rawTimeslot.start, end: rawTimeslot.end } : undefined;
    if (branchId && (hasTimeslotError(cart) || isTimeslotExpired(rawTimeslot))) {
      timeslot = await rebookTimeslot(mcp, cart, existing.shoppingCartId, branchId, deliveryType);
    }

    const cartContext: NonNullable<SessionState['cartContext']> = {
      cartId: existing.shoppingCartId,
      branchId,
      deliveryType,
      ...(timeslot ? { timeslot } : {}),
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
