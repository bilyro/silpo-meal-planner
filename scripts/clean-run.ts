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
import { savePlanFromState } from '../src/agent/plans.js';

/**
 * Three days of full meals — сніданок, обід, вечеря — for two, chosen for a cheap basket.
 *
 * Run with `--cheapest`, which drops selectProduct's promo preference so price alone decides
 * within the correctness tiers. Those tiers still apply: budget mode never buys duck for chicken,
 * never takes a processed form over the raw one, and never touches baby food.
 *
 * Every ingredient was checked against the live catalogue with scripts/probe-ingredients.ts.
 * Things that look obvious but do not work, and are therefore absent:
 *   «гречка» -> a Green Chef cereal BAR; «крупа гречана», «пшоно», «горох» -> nothing at all.
 *   «сіль» -> a 119 UAH speciality black salt, so seasoning is left off the list entirely.
 *   «мед» -> blackcurrant jam. «локшина»/«вермішель» -> instant ramen. «тріска» -> cod-roe pate.
 *
 * Repeats across meals are deduped by collectIngredients, which keeps the LARGEST stated amount
 * rather than summing, so one purchase covers every meal that needs it.
 *
 * «картопля» stays at «1 кг»: the exact input the model once turned into quantity 10, kept so the
 * regression is covered on every run.
 */
const MENU = [
  // ---- Day 1 ----
  {
    day: 1,
    dish: 'Сніданок: вівсянка на молоці з бананом',
    ingredients: [
      { name: 'каша вівсяна', qty: '200 г' },
      { name: 'молоко', qty: '500 мл' },
      { name: 'банан', qty: '2 шт' },
      { name: 'цукор', qty: '50 г' },
    ],
  },
  {
    day: 1,
    dish: 'Обід: борщ',
    ingredients: [
      { name: 'буряк', qty: '300 г' },
      { name: 'капуста', qty: '500 г' },
      { name: 'картопля', qty: '1 кг' },
      { name: 'морква', qty: '200 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'томатна паста', qty: '100 г' },
    ],
  },
  {
    day: 1,
    dish: 'Вечеря: макарони по-флотськи',
    ingredients: [
      { name: 'макарони', qty: '400 г' },
      { name: 'фарш', qty: '500 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'олія соняшникова', qty: '50 мл' },
    ],
  },
  // ---- Day 2 ----
  {
    day: 2,
    dish: 'Сніданок: омлет із хлібом',
    ingredients: [
      { name: 'яйця', qty: '6 шт' },
      { name: 'молоко', qty: '100 мл' },
      { name: 'хліб', qty: '1 шт' },
      { name: 'олія соняшникова', qty: '30 мл' },
    ],
  },
  {
    day: 2,
    dish: 'Обід: курячий суп',
    ingredients: [
      { name: 'куряче стегно', qty: '600 г' },
      { name: 'картопля', qty: '500 г' },
      { name: 'морква', qty: '200 г' },
      { name: 'цибуля', qty: '2 шт' },
      { name: 'петрушка', qty: '1 пучок' },
    ],
  },
  {
    day: 2,
    dish: 'Вечеря: тушкована капуста з рисом',
    ingredients: [
      { name: 'капуста', qty: '600 г' },
      { name: 'рис', qty: '300 г' },
      { name: 'морква', qty: '200 г' },
      { name: 'томатна паста', qty: '100 г' },
    ],
  },
  // ---- Day 3 ----
  {
    day: 3,
    dish: 'Сніданок: сирники зі сметаною',
    ingredients: [
      { name: 'сир кисломолочний', qty: '400 г' },
      { name: 'яйця', qty: '2 шт' },
      { name: 'борошно', qty: '100 г' },
      { name: 'цукор', qty: '50 г' },
      { name: 'сметана', qty: '200 мл' },
    ],
  },
  {
    day: 3,
    dish: 'Обід: оселедець з картоплею',
    ingredients: [
      { name: 'оселедець', qty: '300 г' },
      { name: 'картопля', qty: '800 г' },
      { name: 'цибуля', qty: '1 шт' },
      { name: 'олія соняшникова', qty: '30 мл' },
    ],
  },
  {
    day: 3,
    dish: 'Вечеря: запіканка з макаронами та сиром',
    ingredients: [
      { name: 'макарони', qty: '300 г' },
      { name: 'яйця', qty: '3 шт' },
      { name: 'молоко', qty: '200 мл' },
      { name: 'сир твердий', qty: '150 г' },
      { name: 'масло вершкове', qty: '50 г' },
    ],
  },
];

const CHEAPEST = process.argv.includes('--cheapest');

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
      preferCheapest: CHEAPEST,
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

    // Archive the plan, exactly as the Telegram 🛒 handler does. Without this the script's runs
    // leave no history, so `/plans` and the durable memory that reads past dishes stay empty no
    // matter how many times the deterministic path is exercised.
    const planId = await savePlanFromState(user.id, state);
    console.log(planId ? `\nplan archived as #${planId}` : '\nplan not archived (identical to the last one)');
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
