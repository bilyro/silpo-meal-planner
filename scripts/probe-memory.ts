/**
 * Live check of the durable-memory path against the real database: store facts, recall them,
 * render the prompt block, and confirm the hard ones reach product selection.
 *
 * Writes and then retracts its own facts, so it leaves the account as it found it.
 *
 *   npx tsx scripts/probe-memory.ts
 */

import { desc, eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { plans, users } from '../src/db/schema.js';
import * as repo from '../src/db/repo.js';
import { loadSession } from '../src/agent/session.js';
import { formatMemoryBlock, hardRestrictions, recallMemory } from '../src/agent/memory.js';

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  const state = await loadSession(user.id);

  const before = await repo.listUserFacts(user.id);
  console.log(`existing facts: ${before.length}`);

  const seeded = [
    { kind: 'allergy', text: 'арахіс' },
    { kind: 'diet', text: 'без свинини' },
    { kind: 'dislike', text: 'броколі' },
    { kind: 'household', text: 'готуємо на 2 осіб' },
  ];
  for (const f of seeded) {
    const { created } = await repo.addUserFact({ userId: user.id, source: 'user', ...f });
    console.log(`  + ${f.kind}: ${f.text}${created ? '' : ' (already known — dedupe worked)'}`);
  }

  // Idempotency: storing the same fact twice must not duplicate the constraint.
  const again = await repo.addUserFact({ userId: user.id, kind: 'allergy', text: 'арахіс', source: 'user' });
  console.log(`\nre-storing «арахіс» created a new row? ${again.created} (expected: false)`);

  // Plan history is only archived by the Telegram 🛒 handler, so a database exercised solely
  // through scripts/clean-run.ts has none. Seed one so the recall path is proven against real rows
  // rather than assumed.
  const seededPlanId = await repo.savePlan(user.id, {
    menu: [
      { day: 1, dish: 'борщ', ingredients: [{ name: 'буряк', qty: '300 г' }] },
      { day: 1, dish: 'сирники', ingredients: [{ name: 'сир кисломолочний', qty: '400 г' }] },
    ],
    resolved: [{ ingredient: 'рис', title: 'Рис Тайський «Повна Чаша»', qty: 1, unitPrice: 50 }],
  });
  console.log(`\nseeded plan #${seededPlanId} to exercise history recall`);

  const memory = await recallMemory(user.id);
  console.log(`recalled: ${memory.facts.length} facts, ${memory.recentDishes.length} past dishes, ` +
    `${memory.recentlyBought.length} recently-bought items`);
  console.log(`  dishes: ${JSON.stringify(memory.recentDishes)}`);
  console.log(`  bought: ${JSON.stringify(memory.recentlyBought.map((i) => i.ingredient))}`);

  const restrictions = await hardRestrictions(user.id, state);
  console.log(`hard restrictions passed to selectProduct: ${JSON.stringify(restrictions)}`);
  console.log(`  → «броколі» excluded from filtering? ${!restrictions.includes('броколі')} (expected: true)`);

  console.log(`\n${'─'.repeat(70)}\nPROMPT BLOCK AS THE MODEL SEES IT\n${'─'.repeat(70)}`);
  console.log(formatMemoryBlock(memory));

  // Leave the account as we found it: retract only what this probe added.
  const after = await repo.listUserFacts(user.id);
  const addedIds = after.filter((f) => !before.some((b) => b.id === f.id)).map((f) => f.id);
  for (const id of addedIds) await repo.deactivateUserFact(user.id, id);
  console.log(`\nretracted ${addedIds.length} seeded facts; ` +
    `${(await repo.listUserFacts(user.id)).length} remain (was ${before.length})`);
  await db.delete(plans).where(eq(plans.id, seededPlanId));
  console.log(`deleted seeded plan #${seededPlanId}`);
}

main()
  .catch((err: unknown) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
