/**
 * ONE-OFF: dumps the raw product payload for one ingredient query, so selection heuristics are
 * designed against the fields Silpo actually returns rather than the ones we wish it returned.
 *
 *   npx tsx scripts/probe-raw.ts "кабачок"
 */

import { newestUserSession, runProbe, withCartContext } from './lib/probe.js';

const QUERY = process.argv[2] ?? 'кабачок';

async function main() {
  const { user, state } = await newestUserSession();

  await withCartContext(user.id, state, async (mcp, ctx) => {
    const res = await mcp.callTool<{ queries?: { products?: Record<string, unknown>[] }[] }>(
      'silpo_find_products_batch',
      {
        products: [QUERY],
        branchId: ctx.branchId,
        deliveryType: ctx.deliveryType,
        timeslotStart: ctx.timeslot!.start,
        timeslotEnd: ctx.timeslot!.end,
        limit: 4,
      },
    );

    const products = res.queries?.[0]?.products ?? [];
    console.log(`query «${QUERY}» → ${products.length} candidates\n`);
    console.log('KEYS ON FIRST CANDIDATE:');
    console.log(Object.keys(products[0] ?? {}).sort().join(', '));
    console.log('\nFULL FIRST CANDIDATE:');
    console.log(JSON.stringify(products[0], null, 2));
    console.log('\nNAME | ratio | weighted | step | stock | available | price');
    for (const p of products) {
      console.log(
        `  ${String(p.name).slice(0, 46).padEnd(48)} ratio=${String(p.displayRatio).padEnd(7)} ` +
          `w=${String(p.weighted).padEnd(5)} step=${String(p.step).padEnd(4)} ` +
          `stock=${String(p.stock).padEnd(6)} avail=${String(p.available).padEnd(5)} ${p.price}`,
      );
    }
  });
}

runProbe(main);
