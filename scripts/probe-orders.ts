/**
 * ONE-OFF: dumps `silpo_get_my_online_orders` / `silpo_get_my_offline_orders` so a purchase-history
 * memory can be designed against the fields Silpo actually returns.
 *
 * The decisive questions this answers: do orders carry LINE ITEMS (product + quantity), or only a
 * total? And do offline (in-store) orders carry them too? A pantry ledger is only honest if the
 * answer is yes — otherwise "what's left" is inferred from carts that may never have been paid for.
 *
 * Read-only.
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { loadSession } from '../src/agent/session.js';
import { ensureCartContext } from '../src/agent/cartContext.js';

async function dump(mcp: SilpoMcpClient, tool: string, args: Record<string, unknown> = {}) {
  console.log(`\n${'='.repeat(70)}\n${tool}\n${'='.repeat(70)}`);
  try {
    const res = await mcp.callTool<Record<string, unknown>>(tool, args);
    console.log('TOP-LEVEL KEYS:', Object.keys(res).sort().join(', '));

    // The orders array is under whichever key holds a list.
    const arrayKey = Object.entries(res).find(([, v]) => Array.isArray(v))?.[0];
    const orders = (arrayKey ? res[arrayKey] : []) as Record<string, unknown>[];
    console.log(`orders under «${arrayKey ?? '(none)'}»: ${orders.length}`);
    if (!orders.length) {
      console.log(JSON.stringify(res, null, 2).slice(0, 1500));
      return;
    }

    console.log('KEYS ON FIRST ORDER:', Object.keys(orders[0]!).sort().join(', '));
    console.log('\nFULL FIRST ORDER (truncated to 4000 chars):');
    console.log(JSON.stringify(orders[0], null, 2).slice(0, 4000));

    console.log('\nORDER SUMMARY:');
    for (const o of orders.slice(0, 10)) {
      const lineKey = Object.entries(o).find(
        ([k, v]) => Array.isArray(v) && /product|item|position|line/i.test(k),
      )?.[0];
      const lines = (lineKey ? o[lineKey] : undefined) as unknown[] | undefined;
      console.log(
        `  ${String(o.createdAt ?? o.date ?? o.orderDate ?? '?').slice(0, 19).padEnd(21)} ` +
          `sum=${String(o.sum ?? o.total ?? o.totalSum ?? '?').padEnd(9)} ` +
          `lines=${lines ? `${lines.length} (under «${lineKey}»)` : 'NONE REPORTED'}`,
      );
    }
  } catch (err) {
    console.log('FAILED:', err instanceof Error ? err.message : err);
  }
}

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');

  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    await dump(mcp, 'silpo_get_my_online_orders');

    // Offline orders are 🔒: they need a live cart context like any product search does.
    await ensureCartContext(mcp, state);
    const ctx = state.cartContext!;
    await dump(mcp, 'silpo_get_my_offline_orders', {
      branchId: ctx.branchId,
      deliveryType: ctx.deliveryType,
      timeslotStart: ctx.timeslot!.start,
      timeslotEnd: ctx.timeslot!.end,
    });

    await dump(mcp, 'silpo_get_my_food_restrictions');
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
