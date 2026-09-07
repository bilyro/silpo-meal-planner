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

import type { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { newestUserSession, runProbe, withCartContext } from './lib/probe.js';

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
  const { user, state } = await newestUserSession();

  await withCartContext(user.id, state, async (mcp, ctx) => {
    await dump(mcp, 'silpo_get_my_online_orders');

    // Offline orders are 🔒: they need a live cart context like any product search does.
    await dump(mcp, 'silpo_get_my_offline_orders', {
      branchId: ctx.branchId,
      deliveryType: ctx.deliveryType,
      timeslotStart: ctx.timeslot!.start,
      timeslotEnd: ctx.timeslot!.end,
    });

    await dump(mcp, 'silpo_get_my_food_restrictions');
  });
}

runProbe(main);
