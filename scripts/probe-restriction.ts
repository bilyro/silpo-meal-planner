/**
 * Proves a stored dietary restriction actually changes which product is picked, by running
 * selectProduct over the SAME live candidate list twice — once unrestricted, once with the user's
 * stored allergies and diets in force.
 *
 * Without this the "restriction works" claim is untestable in practice: a restriction only visibly
 * bites when the forbidden product would otherwise have won, which depends on that day's prices.
 *
 *   npx tsx scripts/probe-restriction.ts фарш ковбаса
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../src/agent/cartContext.js';
import { hardRestrictions } from '../src/agent/memory.js';
import { selectProduct, type ProductCandidate } from '../src/agent/selectProduct.js';

const QUERIES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHEAPEST = process.argv.includes('--cheapest');

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const restrictions = await hardRestrictions(user.id, state);
  if (restrictions.length === 0) {
    console.log('No hard restrictions stored — run scripts/remember.ts first, or this proves nothing.');
    return;
  }
  console.log(`restrictions in force: ${JSON.stringify(restrictions)}`);
  console.log(`mode: ${CHEAPEST ? 'cheapest' : 'default (promo preferred)'}\n`);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    await ensureCartContext(mcp, state);
    const ctx = state.cartContext!;

    for (const query of QUERIES) {
      const res = await mcp.callTool<{ queries?: { products?: ProductCandidate[] }[] }>(
        'silpo_find_products_batch',
        {
          products: [query],
          branchId: ctx.branchId,
          deliveryType: ctx.deliveryType,
          timeslotStart: ctx.timeslot!.start,
          timeslotEnd: ctx.timeslot!.end,
          limit: 8,
        },
      );
      const candidates = res.queries?.[0]?.products ?? [];

      const free = selectProduct(query, candidates, { preferCheapest: CHEAPEST });
      const bound = selectProduct(query, candidates, { restrictions, preferCheapest: CHEAPEST });

      const changed = free?.product.name !== bound?.product.name;
      console.log(`«${query}» — ${candidates.length} candidates`);
      console.log(`  without restrictions: ${free?.product.name ?? '(none)'}`);
      console.log(`  with restrictions:    ${bound?.product.name ?? '(none — all excluded)'}`);
      console.log(`  ${changed ? '✅ RESTRICTION CHANGED THE PICK' : '— same pick either way'}\n`);
    }
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
