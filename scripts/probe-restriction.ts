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

import { hardRestrictions } from '../src/agent/memory.js';
import { selectProduct, type ProductCandidate } from '../src/agent/selectProduct.js';
import { newestUserSession, runProbe, withCartContext } from './lib/probe.js';

const QUERIES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHEAPEST = process.argv.includes('--cheapest');

async function main() {
  const { user, state } = await newestUserSession();

  const restrictions = await hardRestrictions(user.id, state);
  if (restrictions.length === 0) {
    console.log('No hard restrictions stored — run scripts/remember.ts first, or this proves nothing.');
    return;
  }
  console.log(`restrictions in force: ${JSON.stringify(restrictions)}`);
  console.log(`mode: ${CHEAPEST ? 'cheapest' : 'default (promo preferred)'}\n`);

  await withCartContext(user.id, state, async (mcp, ctx) => {
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
  });
}

runProbe(main);
