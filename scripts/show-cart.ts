/**
 * Prints the live state of the current user's Silpo cart: item lines, Silpo's own total, the
 * checkout link, and — importantly — any `validations` explaining why checkout is blocked.
 *
 * Read-only: it calls `silpo_get_shopping_cart_by_id` and nothing else. Handy when the bot is not
 * running, or to see what Silpo thinks the cart is without going through Telegram.
 *
 *   npx tsx scripts/show-cart.ts
 */

import { pool } from '../src/db/client.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { users } from '../src/db/schema.js';
import { db } from '../src/db/client.js';
import { desc } from 'drizzle-orm';

interface CartResult {
  cart?: Record<string, unknown>;
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
}

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('No user rows — nobody has linked an account yet.');

  const state = await loadSession(user.id);
  if (!state.cartContext) throw new Error('No cart context in session state — no cart has been built.');

  console.log(`user #${user.id} · stage=${state.stage} · cart ${state.cartContext.cartId}`);
  if (state.cartContext.timeslot) {
    const end = new Date(state.cartContext.timeslot.end);
    const mins = Math.round((end.getTime() - Date.now()) / 60000);
    console.log(
      `slot ${state.cartContext.timeslot.start} → ${state.cartContext.timeslot.end} ` +
        (mins < 0 ? `(EXPIRED ${-mins} min ago)` : `(${mins} min left)`),
    );
  }

  const mcp = new SilpoMcpClient(user.id);
  try {
    await mcp.connect();
    const res = await mcp.callTool<CartResult>('silpo_get_shopping_cart_by_id', {
      shoppingCartId: state.cartContext.cartId,
    });
    const cart = (res.cart ?? {}) as Record<string, unknown>;

    const shipments = (cart.shipments as { products?: unknown[] }[] | undefined) ?? [];
    const products = shipments.flatMap((s) => s.products ?? []) as Record<string, unknown>[];
    console.log(`\nitems in Silpo's cart: ${products.length}`);
    for (const p of products) {
      const name = p.name ?? p.title ?? '(unnamed)';
      console.log(`  · ${String(name).slice(0, 60)}  x${p.quantity ?? '?'}  ${p.price ?? p.sum ?? ''}`);
    }

    for (const key of ['sum', 'total', 'totalSum', 'productsSum', 'deliverySum']) {
      if (cart[key] !== undefined) console.log(`${key}: ${JSON.stringify(cart[key])}`);
    }

    // Validations live under `calculation`, not at the top level — the same path hasTimeslotError
    // uses. Reading `cart.validations` here silently reported "no validations" on a blocked cart.
    const calculation = cart.calculation as
      | { validations?: { level?: string; message?: string; type?: string; productId?: string }[] }
      | undefined;
    const validations = calculation?.validations ?? [];
    if (validations.length) {
      console.log('\nvalidations (why checkout may be blocked):');
      const byId = new Map(products.map((p) => [String(p.productId ?? p.id), String(p.name ?? '?')]));
      for (const v of validations) {
        const who = v.productId ? ` ← ${byId.get(String(v.productId)) ?? v.productId}` : '';
        console.log(`  [${v.level}] ${v.type ?? ''} ${v.message ?? ''}${who}`);
      }
    }

    const link = res.checkoutWebLink ?? res.checkoutMobileLink;
    console.log(`\ncheckout link: ${link ?? 'ABSENT — see validations above'}`);
  } finally {
    await mcp.close();
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
