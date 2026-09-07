/**
 * One-off live verification for the 1h prompt-cache TTL change in SilpoMcpClient.toolsForAiSdk().
 *
 * Calls runAgentTurn() twice in a row for the most-recently-linked account: the first call is a
 * cold cache (expects cache_creation.ephemeral_1h_input_tokens populated, not ephemeral_5m), the
 * second call shortly after expects cache_read_input_tokens populated (proving reads still work
 * under the new TTL). runAgentTurn.ts has temporary console.error instrumentation added for this
 * (reverted afterward via `git checkout -- src/agent/runAgentTurn.ts`).
 *
 * Snapshots + restores sessions.state_json and deletes any messages rows this script adds, so the
 * account's real conversation history is untouched.
 *
 *   npx tsx scripts/probe-cache-ttl.ts
 */

import { eq, gt } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { messages, sessions } from '../src/db/schema.js';
import { runAgentTurn } from '../src/agent/runAgentTurn.js';
import { newestUser, runProbe } from './lib/probe.js';

async function main() {
  const user = await newestUser();
  console.log(`using user id=${user.id}`);

  const [sessionBefore] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
  const beforeMax = (await db.select({ id: messages.id }).from(messages)).reduce((m, r) => Math.max(m, r.id), 0);
  console.log(`messages.id watermark before: ${beforeMax}`);

  console.log('\n--- turn 1 (expect cold cache: cache_creation ephemeral_1h) ---');
  const r1 = await runAgentTurn(user.id, 'Привіт! Що вмієш?');
  console.log('reply 1 (truncated):', r1.text.slice(0, 200));

  console.log('\n--- turn 2, immediately after (expect cache_read_input_tokens > 0) ---');
  const r2 = await runAgentTurn(user.id, 'А що ще?');
  console.log('reply 2 (truncated):', r2.text.slice(0, 200));

  // Cleanup: delete only the messages rows this script added.
  const added = await db.select({ id: messages.id }).from(messages).where(gt(messages.id, beforeMax));
  console.log(`\ndeleting ${added.length} messages rows added by this probe (ids: ${added.map((m) => m.id).join(',')})`);
  for (const m of added) {
    await db.delete(messages).where(eq(messages.id, m.id));
  }

  // Restore session state exactly as found.
  if (sessionBefore) {
    await db.update(sessions).set({ stateJson: sessionBefore.stateJson }).where(eq(sessions.userId, user.id));
    console.log('session state restored to pre-probe snapshot');
  } else {
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    console.log('no session existed before probe — deleted any session row created');
  }
}

runProbe(main);
