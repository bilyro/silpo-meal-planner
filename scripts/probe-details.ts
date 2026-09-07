/**
 * ONE-OFF: dumps `silpo_get_product_details` for the top candidate of a query, to find out whether
 * the catalogue carries COMPOSITION (ingredient list) for composite products.
 *
 * The decisive question: «Ковбаса «Премія» Українська» is pork, but its name never says so, and
 * chicken sausage exists — so a name-based restriction filter cannot tell them apart. If details
 * carry an ingredient list, the filter can read it. If not, the ambiguity is unresolvable and the
 * honest answer is to say so rather than guess.
 *
 *   npx tsx scripts/probe-details.ts ковбаса
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../src/agent/cartContext.js';

const QUERY = process.argv[2] ?? 'ковбаса';

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    await ensureCartContext(mcp, state);
    const ctx = state.cartContext!;

    const found = await mcp.callTool<{ queries?: { products?: Record<string, unknown>[] }[] }>(
      'silpo_find_products_batch',
      {
        products: [QUERY],
        branchId: ctx.branchId,
        deliveryType: ctx.deliveryType,
        timeslotStart: ctx.timeslot!.start,
        timeslotEnd: ctx.timeslot!.end,
        limit: 3,
      },
    );
    const candidates = found.queries?.[0]?.products ?? [];
    console.log(`«${QUERY}» → ${candidates.length} candidates\n`);

    for (const c of candidates) {
      console.log(`${'='.repeat(70)}\n${String(c.name)}\n${'='.repeat(70)}`);
      try {
        const details = await mcp.callTool<Record<string, unknown>>('silpo_get_product_details', {
          slug: c.slug,
          branchId: ctx.branchId,
          deliveryType: ctx.deliveryType,
          timeslotStart: ctx.timeslot!.start,
          timeslotEnd: ctx.timeslot!.end,
        });
        const product = (details.product ?? details) as Record<string, unknown>;
        console.log('KEYS:', Object.keys(product).sort().join(', '));

        // Anything that might carry an ingredient list.
        for (const [k, v] of Object.entries(product)) {
          if (/compos|ingredient|склад|описан|description|nutri|energy|prop|attr|spec/i.test(k)) {
            console.log(`\n  ${k}: ${JSON.stringify(v).slice(0, 900)}`);
          }
        }
      } catch (err) {
        console.log('FAILED:', err instanceof Error ? err.message : err);
      }
      console.log();
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
