import * as repo from '../db/repo.js';

export type SessionState = {
  stage: 'need_auth' | 'idle' | 'menu_proposed' | 'list_resolved' | 'cart_built';
  profile?: { name: string; familySize: number; hasPets: boolean; restrictions: string[] };
  cartContext?: {
    cartId: string;
    branchId: string;
    deliveryType: string;
    timeslot?: { start: string; end: string };
  };
  request?: { days: number; mealsPerDay: 'dinner' | 'all'; budgetUah?: number; extraConstraints: string[] };
  menu?: Array<{ day: number; dish: string; ingredients: Array<{ name: string; qty: string }> }>;
  resolvedItems?: Array<{
    ingredient: string;
    productId: string;
    companyId?: string;
    title: string;
    qty: number;
    unitPrice: number;
    isPromo: boolean;
    wasSubstituted: boolean;
    note?: string;
  }>;
  totals?: { sum: number; budget?: number; promoShare: number; substitutionRate: number };
  /**
   * True only once the 🛒 button has actually written `resolvedItems` to the real Silpo cart.
   *
   * Exists because `finish_with_checkout` is a read-only tool the model is allowed to call at any
   * time, but the model has no write tool — so calling it before this flag is true reads whatever
   * is ALREADY in the real cart (stale, or empty) and has nothing to do with the current
   * resolution. Verified live: asked to "Збери кошик" in free text with nothing written yet, the
   * model composed a fabricated cart status ("мінімум 599 грн, у кошику 188 грн") that matched
   * neither the real empty cart nor session state — a direct violation of "never invent prices."
   * Gating the read itself in `finishWithCheckout()` makes that structurally impossible instead of
   * relying on prompt wording, which measurably did not stop it on retest.
   */
  cartWritten?: boolean;
  metrics: { startedAt: string; toolCalls: number };
};

function defaultState(): SessionState {
  return { stage: 'idle', metrics: { startedAt: new Date().toISOString(), toolCalls: 0 } };
}

function looksLikeSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.stage === 'string' && typeof v.metrics === 'object' && v.metrics !== null;
}

export async function loadSession(userId: number): Promise<SessionState> {
  const stored = await repo.getSessionState(userId);
  if (looksLikeSessionState(stored)) return stored;
  return defaultState();
}

export async function saveSession(userId: number, state: SessionState): Promise<void> {
  await repo.saveSessionState(userId, state);
}
