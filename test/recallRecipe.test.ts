/**
 * `recall_recipe` lets the model check whether a dish was already cooked for this user before
 * inventing an ingredient list from scratch — real testing this session found the model producing
 * genuinely different quantities and even different units for the "same" recipe run to run.
 *
 * The regression under test is the lookup shape, not the DB upsert (that's SQL-level and needs a
 * real Postgres connection to test meaningfully, which this file deliberately does not spin up —
 * see scripts/probe-recipes.ts for the live check): a found recipe must expose exactly what the
 * model needs (ingredients + how many times it's been used) and a missing one must say so plainly
 * rather than returning something that reads like an empty recipe.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/repo.js', () => ({ findRecipe: vi.fn() }));

import * as repo from '../src/db/repo.js';
import { recallRecipe } from '../src/agent/localTools.js';

const findRecipe = vi.mocked(repo.findRecipe);

beforeEach(() => vi.clearAllMocks());

describe('recallRecipe', () => {
  it('returns the stored ingredients and use count when the dish is known', async () => {
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
      dishName: 'Борщ',
      ingredients: [{ name: 'буряк', qty: '3 шт' }],
      timesUsed: 4,
    });
  });

  it('reports not found plainly, rather than an empty-looking recipe', async () => {
    findRecipe.mockResolvedValue(undefined);

    const result = await recallRecipe(1, 'плов');

    expect(result).toEqual({ found: false });
    // Specifically NOT an object that could be read as "found, with zero ingredients" —
    // that shape would let the model believe it already knows an empty recipe for this dish.
    expect(result).not.toHaveProperty('ingredients');
  });

  it('passes the dish name through to the lookup unmodified', async () => {
    findRecipe.mockResolvedValue(undefined);

    await recallRecipe(7, 'Плов з курятиною');

    expect(findRecipe).toHaveBeenCalledWith(7, 'Плов з курятиною');
  });
});
