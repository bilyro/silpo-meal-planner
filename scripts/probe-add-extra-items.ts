/**
 * ONE-OFF: live verification for the `add_extra_items` feature — ad-hoc items outside the meal
 * plan's own ingredients ("додай чіпси і пиво"). Confirms against the REAL catalogue (via the
 * synthetic test user, id 2 — see the task's data-safety notes) that:
 *
 *   1. «чіпси» and «пиво» resolve to real, sane products (not baby food, not something the
 *      raw-vs-processed demotion wrongly excludes).
 *   2. A second call APPENDS to an existing resolvedItems list rather than replacing it.
 *   3. A stored hard restriction (allergy) still excludes a conflicting ad-hoc item.
 *
 *   npx tsx scripts/probe-add-extra-items.ts
 */

import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { addExtraItems } from '../src/agent/localTools.js';
import { ensureCartContext } from '../src/agent/cartContext.js';
import * as repo from '../src/db/repo.js';
import { loadSession } from '../src/agent/session.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { runProbe } from './lib/probe.js';

// This task's own synthetic user (created for this feature's live verification), addressed by
// its fixed fake chat id rather than "newest" — another synthetic user (id 3, chat id
// "debug-synthetic-phase0") already exists in this DB from earlier work this session, and
// "newest" would pick THAT one instead.
const FAKE_CHAT_ID = 'synthetic-test-user-add-extra';

async function main() {
  const user = await db.query.users.findFirst({ where: eq(users.telegramChatId, FAKE_CHAT_ID) });
  if (!user) throw new Error(`synthetic user "${FAKE_CHAT_ID}" not found — expected it to already exist`);
  const state = await loadSession(user.id);
  console.log(`running against user id ${user.id} (must be the synthetic test user, not 1)`);
  if (user.id === 1) throw new Error('refusing to run against user id 1 — this would touch real live session state');

  const mcp = new SilpoMcpClient(user.id);
  await mcp.connect();
  try {
    // The synthetic user's OAuth token is a literal copy of the real account's, so
    // `silpo_get_my_shopping_cart` finds the SAME real, currently-active cart user 1 is using
    // tonight. ensureCartContext's own guess at that pre-existing cart's timeslot shape came back
    // empty here (its `DeliveryExpressByPromise` type has no listed slots via `silpo_get_time_slots`
    // — a separate, pre-existing gap in that guess, not something this task touches). Rather than
    // rebooking the REAL cart's real slot (which would mutate live state on the shared account),
    // this overrides the LOCAL search-context copy only, with a real bookable `DeliveryHome` slot
    // for the same branch — never written back via `silpo_update_shopping_cart`, so the real cart
    // itself is untouched; `silpo_find_products_batch` is a read tool that only needs a
    // plausible branch/time window to search against.
    const established = await ensureCartContext(mcp, state);
    if ('needsAddress' in established) throw new Error('account has no saved address');
    const slotsRes = await mcp.callTool<{ slots: { start: string; end: string; available: boolean }[] }>(
      'silpo_get_time_slots',
      { branchId: established.cartContext.branchId, deliveryTypes: ['DeliveryHome'] },
    );
    const slot = slotsRes.slots.find((s) => s.available);
    if (!slot) throw new Error('no available DeliveryHome slot to build a search context from');
    state.cartContext = { ...established.cartContext, deliveryType: 'DeliveryHome', timeslot: { start: slot.start, end: slot.end } };
    console.log(`search context timeslot: ${slot.start} .. ${slot.end}`);

    console.log('\n=== 1) resolve "чіпси" + "пиво" from empty resolvedItems ===');
    state.resolvedItems = [];
    const first = await addExtraItems(user.id, state, mcp, [{ name: 'чіпси' }, { name: 'пиво' }]);
    for (const item of first.added) {
      console.log(`  ${item.ingredient.padEnd(10)} -> ${item.title} (${item.unitPrice} грн, promo=${item.isPromo})`);
    }
    if (first.misses.length) console.log(`  misses: ${first.misses.join(', ')}`);
    console.log(`  state.resolvedItems.length = ${state.resolvedItems?.length}, totals.sum = ${state.totals?.sum}`);

    console.log('\n=== 2) append "печиво" on top — original two items must survive untouched ===');
    const before = state.resolvedItems ? JSON.parse(JSON.stringify(state.resolvedItems)) : [];
    const second = await addExtraItems(user.id, state, mcp, [{ name: 'печиво' }]);
    const survived = before.every(
      (item: unknown, i: number) => JSON.stringify(item) === JSON.stringify(state.resolvedItems?.[i]),
    );
    console.log(`  added: ${second.added.map((a) => a.title).join(', ') || '(none)'}`);
    console.log(`  state.resolvedItems.length = ${state.resolvedItems?.length} (expected 3)`);
    console.log(`  first two items unchanged: ${survived}`);
    console.log(`  totals.sum = ${state.totals?.sum}`);

    console.log('\n=== 3) restriction enforcement: store an allergy, then ask for a conflicting item ===');
    await repo.addUserFact({ userId: user.id, kind: 'allergy', text: 'горіхи', source: 'user' });
    const beforeLen = state.resolvedItems?.length ?? 0;
    const third = await addExtraItems(user.id, state, mcp, [{ name: 'арахіс' }]);
    console.log(`  added: ${third.added.map((a) => a.title).join(', ') || '(none)'}`);
    console.log(`  misses: ${third.misses.join(', ') || '(none)'}`);
    console.log(`  resolvedItems.length before=${beforeLen} after=${state.resolvedItems?.length} (should be equal if excluded)`);
    // Clean up the fact so reruns of this probe start fresh.
    const stored = await repo.listUserFacts(user.id);
    const nutFact = stored.find((f) => f.kind === 'allergy' && f.text === 'горіхи');
    if (nutFact) await repo.deactivateUserFact(user.id, nutFact.id);
  } finally {
    await mcp.close();
  }
}

runProbe(main);
