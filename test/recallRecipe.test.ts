/**
 * `recall_recipe` lets the model check whether a dish was already cooked before inventing an
 * ingredient list from scratch — real testing this session found the model producing genuinely
 * different quantities and even different units for the "same" recipe run to run.
 *
 * Checks this user's own history first, and only falls back to the cross-user `sharedRecipes`
 * pool if this user has never cooked the dish — the regression under test is that ORDER (personal
 * always wins when both exist) and that `source` correctly tells the model which one it got, so
 * a shared result can be treated with more adaptation caution than the user's own.
 *
 * Not tested here (SQL-level, needs a real Postgres connection — see scripts/probe-recipes.ts for
 * the live check): the upsert itself, and that a save writes to both tables.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({ findRecipe: vi.fn(), findSharedRecipe: vi.fn() }));

import * as repo from '../src/db/repo.js';
import { recallRecipe } from '../src/agent/localTools.js';

const findRecipe = vi.mocked(repo.findRecipe);
const findSharedRecipe = vi.mocked(repo.findSharedRecipe);

beforeEach(() => vi.clearAllMocks());

describe('recallRecipe', () => {
  it('returns the personal recipe, tagged as such, when it is known', async () => {
    findRecipe.mockResolvedValue({
      id: 1,
      userId: 1,
      dishNameKey: 'борщ',
      dishName: 'Борщ',
      ingredientsJson: [{ name: 'буряк', qty: '3 шт' }],
      timesUsed: 4,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof repo.findRecipe>>);

    const result = await recallRecipe(1, 'борщ');

    expect(result).toEqual({
      found: true,
      source: 'personal',
      dishName: 'Борщ',
      ingredients: [{ name: 'буряк', qty: '3 шт' }],
      timesUsed: 4,
    });
    // A personal hit is authoritative — the shared pool must not even be consulted.
    expect(findSharedRecipe).not.toHaveBeenCalled();
  });

  it('falls back to the shared pool, tagged as such, when this user has never cooked it', async () => {
    findRecipe.mockResolvedValue(undefined);
    findSharedRecipe.mockResolvedValue({
      id: 9,
      dishNameKey: 'плов',
      dishName: 'Плов',
      ingredientsJson: [{ name: 'рис', qty: '300 г' }],
      timesUsed: 7,
      contributedByUserId: 42,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof repo.findSharedRecipe>>);

    const result = await recallRecipe(1, 'плов');

    expect(result).toEqual({
      found: true,
      source: 'shared',
      dishName: 'Плов',
      ingredients: [{ name: 'рис', qty: '300 г' }],
      timesUsed: 7,
    });
  });

  it('reports not found plainly when neither table has it, rather than an empty-looking recipe', async () => {
    findRecipe.mockResolvedValue(undefined);
    findSharedRecipe.mockResolvedValue(undefined);

    const result = await recallRecipe(1, 'лазанья');

    expect(result).toEqual({ found: false });
    // Specifically NOT an object that could be read as "found, with zero ingredients" —
    // that shape would let the model believe it already knows an empty recipe for this dish.
    expect(result).not.toHaveProperty('ingredients');
  });

  it('passes the dish name through to both lookups unmodified', async () => {
    findRecipe.mockResolvedValue(undefined);
    findSharedRecipe.mockResolvedValue(undefined);

    await recallRecipe(7, 'Плов з курятиною');

    expect(findRecipe).toHaveBeenCalledWith(7, 'Плов з курятиною');
    expect(findSharedRecipe).toHaveBeenCalledWith('Плов з курятиною');
  });
});
