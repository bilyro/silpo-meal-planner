/**
 * ONE-OFF: dumps the raw product payload for one ingredient query, so selection heuristics are
 * designed against the fields Silpo actually returns rather than the ones we wish it returned.
 *
 *   npx tsx scripts/probe-raw.ts "кабачок"
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../src/agent/cartContext.js';

const QUERY = process.argv[2] ?? 'кабачок';

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    await ensureCartContext(mcp, state);
    const ctx = state.cartContext!;

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
    console.log('\nNAMES + any category-ish fields:');
    for (const p of products) {
      const catish = Object.fromEntries(
        Object.entries(p).filter(([k]) => /categ|section|group|tag|type|kind|class/i.test(k)),
      );
      console.log(`  ${String(p.name).slice(0, 55).padEnd(57)} ${JSON.stringify(catish)}`);
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
