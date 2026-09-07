/**
 * Stores one durable fact for the newest linked user, without going through Telegram or the model.
 * Handy for setting up a demo and for verifying that a stored allergy really reaches product
 * selection on the deterministic path.
 *
 *   npx tsx scripts/remember.ts diet свинина
 *   npx tsx scripts/remember.ts allergy арахіс
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import * as repo from '../src/db/repo.js';
import { FACT_KINDS, kindLabel } from '../src/agent/memory.js';

async function main() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');

  // Same thing /forget does, for resetting between demo runs.
  if (process.argv.includes('--forget')) {
    console.log(`retracted ${await repo.deactivateAllUserFacts(user.id)} facts`);
    return;
  }

  const kind = process.argv[2];
  const text = process.argv.slice(3).join(' ').trim();
  if (!kind || !text || !(FACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`usage: remember.ts <${FACT_KINDS.join('|')}> <text>   |   remember.ts --forget`);
  }

  const { created } = await repo.addUserFact({ userId: user.id, kind, text, source: 'user' });
  console.log(`${created ? 'stored' : 'already known'}: ${kindLabel(kind)} — ${text}`);

  const all = await repo.listUserFacts(user.id);
  console.log(`facts now: ${all.map((f) => `${f.kind}:${f.text}`).join(', ') || '(none)'}`);
}

main()
  .catch((err: unknown) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
