/**
 * ONE-OFF: dumps the cart's own product lines in full, so a `product.offer.stock.max` validation
 * can be traced to the line that caused it. The cart is authoritative about stock at write time,
 * which a fresh search is not — the catalogue shifts between calls.
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    const res = await mcp.callTool<{ cart?: Record<string, unknown> }>('silpo_get_shopping_cart_by_id', {
      shoppingCartId: state.cartContext!.cartId,
    });
    const cart = res.cart ?? {};
    const shipments = (cart.shipments as { products?: Record<string, unknown>[] }[] | undefined) ?? [];
    const products = shipments.flatMap((s) => s.products ?? []);

    console.log('KEYS ON A CART LINE:');
    console.log(Object.keys(products[0] ?? {}).sort().join(', '));

    console.log('\nlines where the requested quantity exceeds what the line reports as available:');
    for (const p of products) {
      const qty = Number(p.quantity ?? 0);
      // Whichever of these the line actually carries.
      const limit = [p.stock, p.maxQuantity, p.availableQuantity, p.balance]
        .map(Number)
        .find((n) => Number.isFinite(n));
      const flag = limit !== undefined && qty > limit ? '  ⚠ OVER' : '';
      if (flag || limit === undefined) {
        console.log(`  ${String(p.name).slice(0, 50).padEnd(52)} qty=${qty} limit=${limit ?? '(none reported)'}${flag}`);
      }
    }

    console.log('\nFULL FIRST LINE:');
    console.log(JSON.stringify(products[0], null, 2));
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
