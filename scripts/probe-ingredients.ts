/**
 * ONE-OFF: resolves candidate ingredient strings against the live catalogue and prints what each
 * one maps to, without touching the cart. Cheaper than re-running the whole flow to find out that
 * «кабачок» still lands on baby-food purée.
 *
 *   npx tsx scripts/probe-ingredients.ts "кабачок" "цукіні" "часник свіжий"
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../src/agent/cartContext.js';
import { resolveIngredients } from '../src/agent/resolveIngredients.js';

const CHEAPEST = process.argv.includes('--cheapest');
const CANDIDATES = process.argv.slice(2).filter((a) => a !== '--cheapest');

async function main() {
  if (CANDIDATES.length === 0) throw new Error('pass candidate ingredient names as arguments');

  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    await ensureCartContext(mcp, state);

    // One synthetic day holding every candidate; qty is irrelevant here, only the match matters.
    const menu = [
      {
        day: 1,
        dish: 'probe',
        ingredients: CANDIDATES.map((name) => ({ name, qty: '1 шт' })),
      },
    ];

    const { items, misses } = await resolveIngredients(mcp, state.cartContext!, menu, {
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
  } finally {
    await mcp.close();
  }
}

main()
  .catch((err: unknown) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
