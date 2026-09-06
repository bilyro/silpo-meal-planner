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
