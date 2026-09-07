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
 * Two days of full meals — сніданок, обід, вечеря — for two people.
 *
 * Every ingredient here was checked against the live catalogue with
 * scripts/probe-ingredients.ts before being used, because plausible-sounding words resolve badly:
 * «мед» returns blackcurrant jam, «локшина» returns instant ramen, «тріска» returns cod-roe pâté,
 * and «геркулес» returns frozen dumplings. The phrasings below are the ones that actually land on
 * the food.
 *
 * Several ingredients repeat across meals. collectIngredients dedupes by name and keeps the
 * LARGEST stated amount rather than summing, because the units are frequently incomparable — so
 * «яйця 4 шт» wins over «яйця 2 шт» and one purchase covers both meals.
 *
 * «картопля» is still «1 кг»: that is the exact input the model once turned into quantity 10, so
 * keeping it here keeps the regression covered on every run.
 */
const MENU = [
  // ---- Day 1 ----
  {
    day: 1,
    dish: 'Сніданок: сирники зі сметаною та бананом',
    ingredients: [
      { name: 'сир кисломолочний', qty: '400 г' },
      { name: 'яйця', qty: '2 шт' },
      { name: 'борошно', qty: '100 г' },
      { name: 'сметана', qty: '200 мл' },
      { name: 'банан', qty: '2 шт' },
      { name: 'цукор', qty: '50 г' },
    ],
  },
  {
    day: 1,
    dish: 'Обід: курячий суп з картоплею',
    ingredients: [
      { name: 'куряче стегно', qty: '600 г' },
      { name: 'картопля', qty: '1 кг' },
      { name: 'морква', qty: '200 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'петрушка', qty: '1 пучок' },
    ],
  },
  {
    day: 1,
    dish: 'Вечеря: запечений хек з гарбузом',
    ingredients: [
      { name: 'хек', qty: '500 г' },
      { name: 'гарбуз', qty: '400 г' },
      { name: 'олія оливкова', qty: '50 мл' },
      { name: 'лимон', qty: '1 шт' },
    ],
  },
  // ---- Day 2 ----
  {
    day: 2,
    dish: 'Сніданок: омлет з помідорами та сиром',
    ingredients: [
      { name: 'яйця', qty: '4 шт' },
      { name: 'молоко', qty: '100 мл' },
      { name: 'помідори', qty: '200 г' },
      { name: 'сир твердий', qty: '100 г' },
      { name: 'масло вершкове', qty: '50 г' },
      { name: 'хліб', qty: '1 шт' },
    ],
  },
  {
    day: 2,
    dish: 'Обід: паста болоньєзе',
    ingredients: [
      { name: 'спагеті', qty: '400 г' },
      { name: 'фарш яловичий', qty: '500 г' },
      { name: 'помідори', qty: '400 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'часник', qty: '3 зубчики' },
      { name: 'сир твердий', qty: '100 г' },
    ],
  },
  {
    day: 2,
    dish: 'Вечеря: салат з лососем',
    ingredients: [
      { name: 'лосось', qty: '200 г' },
      { name: 'салат айсберг', qty: '1 шт' },
      { name: 'огірки', qty: '2 шт' },
      { name: 'помідори', qty: '200 г' },
      { name: 'олія оливкова', qty: '30 мл' },
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
