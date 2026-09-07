/**
 * ONE-OFF: clears the cart and drives the deterministic path end to end, with no Telegram in the
 * loop and no model anywhere. Uses exactly the functions the ✅ and 🛒 handlers call.
 *
 * The point is the regression: feed it the same «Картопля — 1 кг» that the model turned into
 * quantity 10, and check that computeQuantity/capToStock now produce a sane kilogram figure.
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadSession, saveSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../src/agent/cartContext.js';
import { resolveIngredients } from '../src/agent/resolveIngredients.js';
import { applyResolution, finishWithCheckout } from '../src/agent/localTools.js';

/** The menu the bot proposed at 07:11 — the same input that produced 10 kg of potatoes. */
const MENU = [
  {
    day: 1,
    dish: 'Запеканка картопляна з курячим філе',
    ingredients: [
      { name: 'картопля', qty: '1 кг' },
      { name: 'куряча грудка', qty: '500 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'сметана', qty: '200 мл' },
      { name: 'сир твердий', qty: '200 г' },
      { name: 'масло вершкове', qty: '100 г' },
    ],
  },
];

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    if (state.cartContext?.cartId) {
      console.log(`clearing cart ${state.cartContext.cartId} ...`);
      await mcp.callTool('silpo_clear_shopping_cart', { shoppingCartId: state.cartContext.cartId });
      console.log('cleared.\n');
    }

    // Wipe the carried-over resolution so nothing from the old chicken plan survives.
    delete state.resolvedItems;
    delete state.totals;
    state.menu = MENU;
    state.stage = 'menu_proposed';
    await saveSession(user.id, state);

    console.log('ensuring cart context (re-books an expired slot) ...');
    const ctx = await ensureCartContext(mcp, state);
    await saveSession(user.id, state);
    console.log(`  branch ${state.cartContext?.branchId}`);
    console.log(`  slot   ${state.cartContext?.timeslot?.start} → ${state.cartContext?.timeslot?.end}`);
    if ((ctx as { needsAddress?: boolean }).needsAddress) throw new Error('cart context needs an address');

    console.log('\nresolving ingredients against the live catalogue ...');
    const { items, misses } = await resolveIngredients(mcp, state.cartContext!, MENU, {
      restrictions: state.profile?.restrictions,
    });

    console.log(`\n${items.length} items resolved, ${misses.length} misses`);
    for (const i of items) {
      const flags = [i.isPromo ? '🔥' : '', i.wasSubstituted ? '🔄' : ''].join('');
      console.log(`  ${i.ingredient.padEnd(18)} → ${String(i.title).slice(0, 46).padEnd(48)} x${i.qty}  ${i.unitPrice} ${flags}`);
    }
    if (misses.length) console.log(`  misses: ${misses.join(', ')}`);

    const totals = await applyResolution(user.id, state, items);
    console.log(`\ntotals: ${JSON.stringify(totals)}`);

    // Mirrors the 🛒 handler exactly.
    const branchId = state.cartContext!.branchId;
    const products = items
      .filter((i) => i.companyId)
      .map((i) => ({ productId: i.productId, companyId: i.companyId, branchId, quantity: i.qty }));
    console.log(`\nwriting ${products.length} products to the cart ...`);
    await mcp.callTool('silpo_add_or_update_cart_products', {
      shoppingCartId: state.cartContext!.cartId,
      products,
    });

    const summary = await finishWithCheckout(user.id, state, mcp);
    await saveSession(user.id, state);
    console.log(`\n${JSON.stringify(summary, null, 2)}`);
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
