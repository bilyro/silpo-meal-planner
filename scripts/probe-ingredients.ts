/**
 * ONE-OFF: resolves candidate ingredient strings against the live catalogue and prints what each
 * one maps to, without touching the cart. Cheaper than re-running the whole flow to find out that
 * «кабачок» still lands on baby-food purée.
 *
 *   npx tsx scripts/probe-ingredients.ts "кабачок" "цукіні" "часник свіжий"
 */

import { resolveIngredients } from '../src/agent/resolveIngredients.js';
import { newestUserSession, runProbe, withCartContext } from './lib/probe.js';

const CHEAPEST = process.argv.includes('--cheapest');
const CANDIDATES = process.argv.slice(2).filter((a) => a !== '--cheapest');

async function main() {
  if (CANDIDATES.length === 0) throw new Error('pass candidate ingredient names as arguments');

  const { user, state } = await newestUserSession();

  await withCartContext(user.id, state, async (mcp, ctx) => {
    // One synthetic day holding every candidate; qty is irrelevant here, only the match matters.
    const menu = [
      {
        day: 1,
        dish: 'probe',
        ingredients: CANDIDATES.map((name) => ({ name, qty: '1 шт' })),
      },
    ];

    const { items, misses } = await resolveIngredients(mcp, ctx, menu, {
      restrictions: state.profile?.restrictions,
      preferCheapest: CHEAPEST,
    });

    for (const name of CANDIDATES) {
      const hit = items.find((i) => i.ingredient === name);
      const mark = hit?.isPromo ? '🔥' : '  ';
      console.log(
        hit
          ? `${mark} ${name.padEnd(20)} → ${String(hit.title).slice(0, 58).padEnd(60)} ${hit.unitPrice}`
          : `   ${name.padEnd(20)} → (no match)`,
      );
    }
    if (misses.length) console.log(`\nmisses: ${misses.join(', ')}`);
  });
}

runProbe(main);
