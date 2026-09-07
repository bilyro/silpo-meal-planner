/**
 * Shared plumbing for the one-off probe scripts in scripts/: load the newest linked account, run
 * against a real MCP connection (with a cart context established, for the scripts that search the
 * live catalogue), and always drain the Postgres pool on exit.
 *
 * Extracted after this preamble had been copy-pasted into 9 separate scripts — flagged by an
 * architecture review during the durable-memory work. Every probe still does this against the
 * SAME real linked account and real Silpo MCP the bot uses; nothing here is a mock.
 */

import { desc } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { loadSession, type SessionState } from '../../src/agent/session.js';
import { SilpoMcpClient } from '../../src/mcp/SilpoMcpClient.js';
import { ensureCartContext } from '../../src/agent/cartContext.js';

export type { SessionState };

/** The account every probe script runs against: whichever one linked most recently. */
export async function newestUser() {
  const [user] = await db.select().from(users).orderBy(desc(users.id)).limit(1);
  if (!user) throw new Error('no linked user');
  return user;
}

export async function newestUserSession() {
  const user = await newestUser();
  const state = await loadSession(user.id);
  return { user, state };
}

/**
 * `main().catch(report).finally(drain the pool)` — identical across every probe script until now.
 * A leaked pool handle is why a probe script that forgot this would hang instead of exiting.
 */
export function runProbe(main: () => Promise<void>): void {
  main()
    .catch((err: unknown) => {
      console.error('FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

/**
 * Connects an MCP client for `userId` and closes it in a `finally`. Split out from
 * `withCartContext` below because some probes only read a cart Silpo already built
 * (`silpo_get_shopping_cart_by_id`) and have no need to establish — or pay the latency of
 * establishing — a context first.
 */
export async function withMcp<T>(userId: number, fn: (mcp: SilpoMcpClient) => Promise<T>): Promise<T> {
  const mcp = new SilpoMcpClient(userId);
  await mcp.connect();
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

/**
 * `withMcp` plus `ensureCartContext`: every 🔒 search tool needs a branch/timeslot context first.
 * Throws rather than silently continuing when the account has no saved address to establish one
 * from — the scripts this replaces mostly skipped that check and would have failed later anyway,
 * on a confusing `state.cartContext!` null-assertion instead of this actionable message.
 */
export async function withCartContext<T>(
  userId: number,
  state: SessionState,
  fn: (mcp: SilpoMcpClient, ctx: NonNullable<SessionState['cartContext']>) => Promise<T>,
): Promise<T> {
  return withMcp(userId, async (mcp) => {
    const result = await ensureCartContext(mcp, state);
    if ('needsAddress' in result) {
      throw new Error('cart context needs a delivery address — the linked account has none saved');
    }
    return fn(mcp, result.cartContext);
  });
}
