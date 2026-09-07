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

/**
 * Three days of dinners for two. Day 1 is the menu the bot proposed at 07:11 — the same input that
 * produced 10 kg of potatoes — kept deliberately so the regression stays covered. Days 2 and 3
 * exist to carry the basket over Silpo's 799 грн minimum, below which `checkoutWebLink` is absent
 * rather than empty.
 *
 * Note that `цибуля` appears on two days: collectIngredients dedupes by name and keeps the LARGEST
 * stated amount rather than summing, because the units are frequently incomparable.
 */
const MENU = [
  {
    day: 1,
    dish: 'Запеканка картопляна з курячим філе',
    ingredients: [
      // «картопля мита», not «картопля»: the bare word ranks «Картопля Aviko фрі
      // швидкозаморожена» first (it is on promo and «Картопля» genuinely is the head noun), which
      // is not what a casserole wants. «мита» echoes a real product name, so it lands on the raw
      // potato — verified with scripts/probe-ingredients.ts. Still «1 кг», which keeps the
      // quantity regression that produced 10 kg of potatoes.
      { name: 'картопля мита', qty: '1 кг' },
      { name: 'куряча грудка', qty: '500 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'сметана', qty: '200 мл' },
      { name: 'сир твердий', qty: '200 г' },
      { name: 'масло вершкове', qty: '100 г' },
    ],
  },
  {
    day: 2,
    dish: 'Паста з лососем у вершковому соусі',
    ingredients: [
      { name: 'спагеті', qty: '400 г' },
      { name: 'лосось', qty: '300 г' },
      { name: 'вершки', qty: '200 мл' },
      // No «часник»: every phrasing tried either misses entirely or lands on granulated garlic
      // powder. No «сир пармезан» either — nothing in the catalogue matches it, so the pasta uses
      // the same hard cheese as day 1 (collectIngredients dedupes it to one line, which is right:
      // you buy one block of cheese for the week).
      { name: 'сир твердий', qty: '100 г' },
      { name: 'олія оливкова', qty: '50 мл' },
    ],
  },
  {
    day: 3,
    dish: 'Овочеве рагу з куркою та печерицями',
    ingredients: [
      { name: 'куряче стегно', qty: '600 г' },
      { name: 'морква', qty: '300 г' },
      // «кабачок» resolved to «Пюре Gerber кабачок» — baby food. Mushrooms resolve cleanly.
      { name: 'печериці', qty: '300 г' },
      { name: 'гарбуз', qty: '400 г' },
      { name: 'помідори', qty: '400 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'рис', qty: '300 г' },
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
