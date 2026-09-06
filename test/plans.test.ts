import { beforeEach, describe, expect, it, vi } from 'vitest';

// The repo module is mocked wholesale — importing it for real pulls in db/client.ts → config.ts,
// which reads .env and calls process.exit(1) when it is absent. Same trick as cartContext.test.ts's
// fake MCP client: keep the DB behind the repo boundary and the tests stay pure.
vi.mock('../src/db/repo.js', () => ({
  getLastPlan: vi.fn(),
  savePlan: vi.fn(),
  listRecentPlans: vi.fn(),
  saveSessionState: vi.fn(),
  getSessionState: vi.fn(),
}));

import * as repo from '../src/db/repo.js';
import {
  formatPlanDate,
  formatPlanSummary,
  isPlanComplete,
  loadLastPlanIntoState,
  parsePlanRow,
  repeatLastPlanTool,
  savePlanFromState,
  type StoredPlan,
} from '../src/agent/plans.js';
import type { SessionState } from '../src/agent/session.js';

const getLastPlan = vi.mocked(repo.getLastPlan);
const savePlan = vi.mocked(repo.savePlan);
const saveSessionState = vi.mocked(repo.saveSessionState);

const MENU: NonNullable<SessionState['menu']> = [
  { day: 1, dish: 'Курка з рисом', ingredients: [{ name: 'куряче філе', qty: '500 г' }] },
  { day: 2, dish: 'Борщ', ingredients: [{ name: 'буряк', qty: '2 шт' }] },
];

const ITEMS: NonNullable<SessionState['resolvedItems']> = [
  {
    ingredient: 'куряче філе',
    productId: 'p1',
    companyId: 'c1',
    title: 'Філе куряче охолоджене',
    qty: 1,
    unitPrice: 189.9,
    isPromo: true,
    wasSubstituted: false,
  },
];

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return { stage: 'idle', metrics: { startedAt: '2026-09-06T00:00:00Z', toolCalls: 0 }, ...overrides };
}

function makeRow(overrides: Partial<Parameters<typeof parsePlanRow>[0]> = {}) {
  return {
    id: 7,
    userId: 1,
    createdAt: new Date('2026-09-06T09:00:00Z'),
    menuJson: MENU as unknown,
    resolvedJson: ITEMS as unknown,
    totalsJson: { sum: 845.5, promoShare: 0.5, substitutionRate: 0 } as unknown,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  savePlan.mockResolvedValue(42);
  saveSessionState.mockResolvedValue(undefined);
});

describe('parsePlanRow', () => {
  it('reads a well-formed row', () => {
    const plan = parsePlanRow(makeRow());
    expect(plan?.menu).toEqual(MENU);
    expect(plan?.resolvedItems).toEqual(ITEMS);
    expect(plan?.totals?.sum).toBe(845.5);
  });

  it('returns undefined when the stored menu is not a usable menu at all', () => {
    expect(parsePlanRow(makeRow({ menuJson: null }))).toBeUndefined();
    expect(parsePlanRow(makeRow({ menuJson: { days: 3 } }))).toBeUndefined();
    expect(parsePlanRow(makeRow({ menuJson: [] }))).toBeUndefined();
    // Every entry malformed -> nothing left to replay.
    expect(parsePlanRow(makeRow({ menuJson: [{ dish: 'без дня' }] }))).toBeUndefined();
  });

  it('drops malformed days and ingredients but keeps the rest of the plan', () => {
    const plan = parsePlanRow(
      makeRow({
        menuJson: [
          { day: 1, dish: 'Ок', ingredients: [{ name: 'сіль', qty: '1 ч.л.' }, { qty: 'без назви' }, 'сміття'] },
          { day: 'два', dish: 'Битий день' },
          { day: 3, dish: 'Без інгредієнтів' },
        ],
      }),
    );
    expect(plan?.menu).toEqual([
      { day: 1, dish: 'Ок', ingredients: [{ name: 'сіль', qty: '1 ч.л.' }] },
      { day: 3, dish: 'Без інгредієнтів', ingredients: [] },
    ]);
  });

  it('tolerates missing or malformed resolved items and totals', () => {
    const plan = parsePlanRow(makeRow({ resolvedJson: null, totalsJson: 'totals' }));
    expect(plan?.menu).toEqual(MENU);
    expect(plan?.resolvedItems).toBeUndefined();
    expect(plan?.totals).toBeUndefined();
  });
});

describe('savePlanFromState', () => {
  it('saves nothing until the cart is actually built', async () => {
    for (const stage of ['idle', 'menu_proposed', 'list_resolved'] as const) {
      expect(isPlanComplete(makeState({ stage, menu: MENU, resolvedItems: ITEMS }))).toBe(false);
      expect(await savePlanFromState(1, makeState({ stage, menu: MENU, resolvedItems: ITEMS }))).toBeUndefined();
    }
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('saves nothing when the cart was built from an empty menu or empty list', async () => {
    expect(await savePlanFromState(1, makeState({ stage: 'cart_built', resolvedItems: ITEMS }))).toBeUndefined();
    expect(await savePlanFromState(1, makeState({ stage: 'cart_built', menu: MENU }))).toBeUndefined();
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('persists menu, resolved items and totals once the cart is built', async () => {
    getLastPlan.mockResolvedValue(undefined);
    const totals = { sum: 845.5, promoShare: 1, substitutionRate: 0 };
    const state = makeState({ stage: 'cart_built', menu: MENU, resolvedItems: ITEMS, totals });

    expect(await savePlanFromState(1, state)).toBe(42);
    expect(savePlan).toHaveBeenCalledWith(1, { menu: MENU, resolved: ITEMS, totals });
  });

  it('skips a duplicate of the most recent plan (double-tap on 🛒)', async () => {
    getLastPlan.mockResolvedValue(makeRow());
    const state = makeState({ stage: 'cart_built', menu: MENU, resolvedItems: ITEMS });

    expect(await savePlanFromState(1, state)).toBeUndefined();
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('still saves when the list changed for the same menu (e.g. after «Дешевше»)', async () => {
    getLastPlan.mockResolvedValue(makeRow());
    const cheaper = [{ ...ITEMS[0]!, productId: 'p2', unitPrice: 99 }];
    const state = makeState({ stage: 'cart_built', menu: MENU, resolvedItems: cheaper });

    expect(await savePlanFromState(1, state)).toBe(42);
  });
});

describe('loadLastPlanIntoState', () => {
  it('answers friendly Ukrainian text — not an error — when nothing is saved', async () => {
    getLastPlan.mockResolvedValue(undefined);
    const state = makeState({ stage: 'idle' });

    const result = await loadLastPlanIntoState(1, state);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('ще немає збережених планів');
    expect(state.stage).toBe('idle');
    expect(state.menu).toBeUndefined();
    expect(saveSessionState).not.toHaveBeenCalled();
  });

  it('refuses a stored plan whose JSON no longer matches the SessionState shape', async () => {
    getLastPlan.mockResolvedValue(makeRow({ menuJson: { legacy: true } }));
    const state = makeState();

    const result = await loadLastPlanIntoState(1, state);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('застарілого формату');
    expect(state.menu).toBeUndefined();
  });

  it('restores the menu, rewinds to menu_proposed, and drops the stale products', async () => {
    getLastPlan.mockResolvedValue(makeRow());
    const cartContext = { cartId: 'c', branchId: 'b', deliveryType: 'DeliveryHome' };
    const state = makeState({
      stage: 'cart_built',
      cartContext,
      resolvedItems: ITEMS,
      totals: { sum: 845.5, promoShare: 1, substitutionRate: 0 },
    });

    const result = await loadLastPlanIntoState(1, state);

    expect(result.ok).toBe(true);
    expect(state.menu).toEqual(MENU);
    expect(state.stage).toBe('menu_proposed');
    // The whole point: nothing product-shaped survives into the live session, so the ✅ path is
    // forced to re-resolve against today's catalog before anything reaches the real cart.
    expect(state.resolvedItems).toBeUndefined();
    expect(state.totals).toBeUndefined();
    // Cart context is kept — ensureCartContext rebooks a stale slot on its own.
    expect(state.cartContext).toEqual(cartContext);
    expect(saveSessionState).toHaveBeenCalledWith(1, state);
  });
});

describe('formatPlanSummary', () => {
  const plan: StoredPlan = {
    id: 7,
    createdAt: new Date('2026-09-06T09:00:00Z'),
    menu: MENU,
    resolvedItems: ITEMS,
    totals: { sum: 845.5, promoShare: 1, substitutionRate: 0 },
  };

  it('renders days, dishes and the historical total in Ukrainian HTML', () => {
    const out = formatPlanSummary(plan);
    expect(out).toContain('Меню на 2 дні');
    expect(out).toContain('6 вересня');
    expect(out).toContain('День 1 — Курка з рисом');
    expect(out).toContain('Тоді вийшло 845.50 грн'); // formatUah pads kopiykas
    expect(out).toContain('1 позиція');
  });

  it('counts distinct days, not menu entries (two meals on one day is still one day)', () => {
    const sameDay: StoredPlan = {
      id: 8,
      createdAt: new Date('2026-01-11T00:00:00Z'),
      menu: [
        { day: 1, dish: 'Обід', ingredients: [] },
        { day: 1, dish: 'Вечеря', ingredients: [] },
      ],
    };
    expect(formatPlanSummary(sameDay)).toContain('Меню на 1 день');
  });

  it('escapes dish names and omits the price line when totals were never stored', () => {
    const nasty: StoredPlan = {
      id: 9,
      createdAt: new Date('2026-09-06T09:00:00Z'),
      menu: [{ day: 1, dish: 'Салат <b>з "перцем"</b> & сіллю', ingredients: [] }],
    };
    const out = formatPlanSummary(nasty);
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>з');
    expect(out).not.toContain('Тоді вийшло');
  });
});

describe('formatPlanDate', () => {
  it('uses Ukrainian genitive month names', () => {
    expect(formatPlanDate(new Date('2026-01-01T00:00:00Z'))).toBe('1 січня');
    expect(formatPlanDate(new Date('2026-09-06T00:00:00Z'))).toBe('6 вересня');
    expect(formatPlanDate(new Date('2026-12-31T00:00:00Z'))).toBe('31 грудня');
  });
});

describe('repeat_last_plan tool', () => {
  // The AI SDK passes these to every execute(); this tool ignores them entirely.
  const callOptions = { toolCallId: 'call-1', messages: [], context: undefined };

  it('is registered under the name the system prompt will reference', () => {
    expect(Object.keys(repeatLastPlanTool(1, makeState()))).toEqual(['repeat_last_plan']);
  });

  it('returns the restored menu and mutates state in place', async () => {
    getLastPlan.mockResolvedValue(makeRow());
    const state = makeState();
    const execute = repeatLastPlanTool(1, state).repeat_last_plan?.execute;
    expect(execute).toBeDefined();

    const out = (await execute?.({}, callOptions)) as { ok: boolean; menu?: unknown; previousTotalUah?: number };

    expect(out.ok).toBe(true);
    expect(out.menu).toEqual(MENU);
    expect(out.previousTotalUah).toBe(845.5);
    expect(state.stage).toBe('menu_proposed');
  });

  it('hands the model a ready Ukrainian sentence instead of throwing when nothing is saved', async () => {
    getLastPlan.mockResolvedValue(undefined);
    const execute = repeatLastPlanTool(1, makeState()).repeat_last_plan?.execute;

    const out = (await execute?.({}, callOptions)) as { ok: boolean; message?: string };

    expect(out.ok).toBe(false);
    expect(out.message).toContain('немає збережених планів');
  });
});
