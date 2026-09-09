/**
 * Prints the live state of the current user's Silpo cart: item lines, Silpo's own total, the
 * checkout link, and — importantly — any `validations` explaining why checkout is blocked.
 *
 * Read-only: it calls `silpo_get_shopping_cart_by_id` and nothing else. Handy when the bot is not
 * running, or to see what Silpo thinks the cart is without going through Telegram.
 *
 *   npx tsx scripts/show-cart.ts
 */

import { newestUserSession, runProbe, withMcp } from './lib/probe.js';
import { getCartValidations } from '../src/agent/cartContext.js';

interface CartResult {
  cart?: Record<string, unknown>;
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
}

async function main() {
  const { user, state } = await newestUserSession();
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

  await withMcp(user.id, async (mcp) => {
    const res = await mcp.callTool<CartResult>('silpo_get_shopping_cart_by_id', {
      shoppingCartId: state.cartContext!.cartId,
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

    // Reading `cart.validations` here used to silently report "no validations" on a blocked cart
    // — they live under `calculation`, not the top level. getCartValidations() is the one shared
    // reader for this (agent/cartContext.ts), not a third independently-typed local copy.
    const validations = getCartValidations(cart);
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
  });
}

runProbe(main);
