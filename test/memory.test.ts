import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({
  listUserFacts: vi.fn(async () => []),
  listRecentPlans: vi.fn(async () => []),
}));

import * as repo from '../src/db/repo.js';
import {
  formatMemoryBlock,
  hardRestrictions,
  isHardKind,
  recallMemory,
  type RecalledMemory,
} from '../src/agent/memory.js';

const listUserFacts = vi.mocked(repo.listUserFacts);
const listRecentPlans = vi.mocked(repo.listRecentPlans);

type Fact = { id: number; kind: string; text: string; source: 'user' | 'silpo' };

function fact(kind: string, text: string, id = 1): Fact {
  return { id, kind, text, source: 'user' };
}

/** listUserFacts returns full Drizzle rows; only these four fields are ever read. */
function facts(...rows: Fact[]) {
  listUserFacts.mockResolvedValue(rows as unknown as Awaited<ReturnType<typeof repo.listUserFacts>>);
}

function plans(...rows: { menuJson: unknown; resolvedJson?: unknown }[]) {
  listRecentPlans.mockResolvedValue(rows as unknown as Awaited<ReturnType<typeof repo.listRecentPlans>>);
}

function memory(over: Partial<RecalledMemory> = {}): RecalledMemory {
  return { facts: [], hardConstraints: [], recentDishes: [], recentlyBought: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  facts();
  plans();
});

/**
 * The hard/soft split is the safety property of this module: an allergy that degrades into a
 * preference still "mostly" avoids the allergen, which is the worst possible failure — wrong,
 * intermittent, and invisible.
 */
describe('hard vs soft facts', () => {
  it('treats allergies and diets as hard', () => {
    expect(isHardKind('allergy')).toBe(true);
    expect(isHardKind('diet')).toBe(true);
  });

  it('treats tastes and household notes as soft', () => {
    expect(isHardKind('dislike')).toBe(false);
    expect(isHardKind('preference')).toBe(false);
    expect(isHardKind('household')).toBe(false);
  });

  it('does not treat an unknown kind as hard', () => {
    // A kind we never defined must not accidentally gain filtering power.
    expect(isHardKind('whatever')).toBe(false);
  });
});

describe('hardRestrictions', () => {
  it('feeds allergies and diets to product selection', async () => {
    facts(fact('allergy', 'арахіс', 1), fact('diet', 'без свинини', 2));
    expect(await hardRestrictions(7, {})).toEqual(['арахіс', 'без свинини']);
  });

  it('leaves soft facts out — a dislike must not filter the catalogue', async () => {
    facts(fact('allergy', 'арахіс', 1), fact('dislike', 'броколі', 2));
    expect(await hardRestrictions(7, {})).toEqual(['арахіс']);
  });

  it('merges Silpo profile restrictions with stored ones', async () => {
    facts(fact('allergy', 'арахіс'));
    expect(await hardRestrictions(7, { profile: { restrictions: ['лактоза'] } })).toEqual([
      'лактоза',
      'арахіс',
    ]);
  });

  it('de-duplicates across the two sources, ignoring case and padding', async () => {
    facts(fact('diet', '  Свинина '));
    expect(await hardRestrictions(7, { profile: { restrictions: ['свинина'] } })).toEqual(['свинина']);
  });

  it('drops empty strings rather than excluding everything', async () => {
    // An empty restriction passed to selectProduct would match every product name.
    facts(fact('allergy', '   '));
    expect(await hardRestrictions(7, { profile: { restrictions: [''] } })).toEqual([]);
  });
});

describe('recallMemory', () => {
  it('collects dish names across recent plans for variety', async () => {
    plans({ menuJson: [{ dish: 'борщ' }, { dish: 'сирники' }] }, { menuJson: [{ dish: 'плов' }] });
    expect((await recallMemory(7)).recentDishes).toEqual(['борщ', 'сирники', 'плов']);
  });

  it('takes the at-home hint from the newest plan only', async () => {
    plans(
      { menuJson: [], resolvedJson: [{ ingredient: 'рис', title: 'Рис Тайський', qty: 1 }] },
      { menuJson: [], resolvedJson: [{ ingredient: 'гречка', title: 'Гречка', qty: 1 }] },
    );
    const recalled = await recallMemory(7);
    expect(recalled.recentlyBought.map((i) => i.ingredient)).toEqual(['рис']);
  });

  it('survives malformed plan JSON instead of throwing mid-turn', async () => {
    // plans stores opaque JSON, so anything could be in there — a crash here would kill the turn.
    plans({ menuJson: 'not an array', resolvedJson: { nope: true } }, { menuJson: [{ dish: 42 }, null] });
    const recalled = await recallMemory(7);
    expect(recalled.recentDishes).toEqual([]);
    expect(recalled.recentlyBought).toEqual([]);
  });

  it('exposes hard constraints alongside the raw facts', async () => {
    facts(fact('allergy', 'арахіс', 1), fact('preference', 'більше риби', 2));
    const recalled = await recallMemory(7);
    expect(recalled.hardConstraints).toEqual(['арахіс']);
    expect(recalled.facts).toHaveLength(2);
  });
});

describe('formatMemoryBlock', () => {
  it('is empty when there is nothing to remember, so no tokens are spent', () => {
    expect(formatMemoryBlock(memory())).toBe('');
  });

  it('states hard facts as prohibitions and soft ones as preferences', () => {
    const block = formatMemoryBlock(
      memory({ facts: [fact('allergy', 'арахіс', 1), fact('dislike', 'броколі', 2)] }),
    );
    const hardLine = block.indexOf('ЖОРСТКІ');
    const softLine = block.indexOf('Побажання');
    expect(hardLine).toBeGreaterThanOrEqual(0);
    expect(softLine).toBeGreaterThan(hardLine);
    // The allergen must sit in the prohibition section, not the preference one.
    expect(block.slice(hardLine, softLine)).toContain('арахіс');
    expect(block.slice(softLine)).toContain('броколі');
  });

  it('never presents past purchases as things the user still has', () => {
    // The load-bearing property: we know what entered a CART, never what was bought or eaten.
    // Wording that asserts possession would silently drop the ingredient from the shopping list.
    const block = formatMemoryBlock(
      memory({ recentlyBought: [{ ingredient: 'рис', title: 'Рис Тайський', qty: 1 }] }),
    );
    expect(block).toContain('ЗАПИТАЙ');
    expect(block).toContain('НЕ означає, що воно ще є вдома');
  });

  it('asks the model not to repeat recent dishes', () => {
    expect(formatMemoryBlock(memory({ recentDishes: ['борщ'] }))).toContain('НЕ повторюй');
  });

  it('wraps the block in a tag the model can delimit', () => {
    const block = formatMemoryBlock(memory({ facts: [fact('allergy', 'арахіс')] }));
    expect(block.startsWith('<memory>')).toBe(true);
    expect(block.endsWith('</memory>')).toBe(true);
  });
});
