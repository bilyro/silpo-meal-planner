import { and, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from './client.js';
import {
  messages,
  oauthClients,
  oauthPending,
  oauthTokens,
  plans,
  recipes,
  sharedRecipes,
  sessions,
  toolCallLog,
  userFacts,
  users,
} from './schema.js';

export async function getOrCreateUser(telegramChatId: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.telegramChatId, telegramChatId) });
  if (existing) return existing;
  const [created] = await db.insert(users).values({ telegramChatId }).returning();
  if (!created) throw new Error('Failed to create user row');
  return created;
}

export async function getUserById(userId: number) {
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

/**
 * Newest registration wins. A DCR client bakes in the `redirect_uris` it was registered with, so
 * changing PUBLIC_BASE_URL (e.g. localhost → an HTTPS tunnel) requires re-registering; an
 * unordered findFirst() could keep handing back the stale client, whose redirect_uri no longer
 * matches what we send and which Silpo's /authorize then rejects with a 400.
 */
export async function getOauthClient(): Promise<OAuthClientInformationFull | undefined> {
  const row = await db.query.oauthClients.findFirst({
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });
  return row ? (row.registrationJson as OAuthClientInformationFull) : undefined;
}

export async function saveOauthClient(info: OAuthClientInformationFull): Promise<void> {
  await db.delete(oauthClients);
  await db.insert(oauthClients).values({
    clientId: info.client_id,
    clientSecret: info.client_secret ?? null,
    registrationJson: info,
  });
}

/** Only ever returns a CONFIRMED link — see the `confirmed` column doc in schema.ts. */
export async function getTokens(userId: number): Promise<OAuthTokens | undefined> {
  const row = await db.query.oauthTokens.findFirst({
    where: and(eq(oauthTokens.userId, userId), eq(oauthTokens.confirmed, true)),
  });
  if (!row) return undefined;
  return {
    access_token: row.accessToken,
    token_type: row.tokenType ?? 'Bearer',
    refresh_token: row.refreshToken ?? undefined,
    scope: row.scope ?? undefined,
    expires_in: row.expiresAt
      ? Math.max(0, Math.round((row.expiresAt.getTime() - Date.now()) / 1000))
      : undefined,
  };
}

export async function saveTokens(userId: number, tokens: OAuthTokens): Promise<void> {
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  const values = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt,
    tokenType: tokens.token_type,
    scope: tokens.scope ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(oauthTokens)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: oauthTokens.userId, set: values });
}

export async function deleteTokens(userId: number): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId));
}

/**
 * Called right after a fresh code exchange (server.ts's /auth/callback), AFTER saveTokens() has
 * already run for this grant. Explicitly forces confirmed back to false even if this userId was
 * confirmed before — a new exchange is a new grant (possibly a different Silpo account, in the
 * forwarding attack this column exists for) and must be re-confirmed regardless of history.
 */
export async function markUnconfirmed(userId: number, confirmCode: string): Promise<void> {
  await db.update(oauthTokens).set({ confirmed: false, confirmCode }).where(eq(oauthTokens.userId, userId));
}

/** Looked up by whoever types the code back into Telegram — may be a different chat than the one that ran /start. */
export async function findUnconfirmedByCode(confirmCode: string) {
  return db.query.oauthTokens.findFirst({
    where: and(eq(oauthTokens.confirmCode, confirmCode), eq(oauthTokens.confirmed, false)),
  });
}

export async function confirmLink(userId: number): Promise<void> {
  await db.update(oauthTokens).set({ confirmed: true, confirmCode: null }).where(eq(oauthTokens.userId, userId));
}

/**
 * Only ONE link attempt may be pending per user at a time: each /authorize generates a fresh PKCE
 * challenge, and because Silpo never echoes our `state` back (see SilpoAuthProvider), the callback
 * cannot tell which attempt a returning code belongs to. Keeping several rows meant a user tapping
 * an older /start button got matched against the newest verifier — a silent PKCE mismatch. Pruning
 * makes the newest row unambiguous, so a stale button fails loudly ("press /start again") instead.
 */
export async function savePendingAuth(state: string, userId: number, codeVerifier: string): Promise<void> {
  await db.delete(oauthPending).where(eq(oauthPending.userId, userId));
  await db.insert(oauthPending).values({ state, userId, codeVerifier });
}

export async function getPendingAuth(state: string) {
  return db.query.oauthPending.findFirst({ where: eq(oauthPending.state, state) });
}

/**
 * Fallback when the callback carries no state — see SilpoAuthProvider's class doc.
 *
 * ⚠ Not user-scoped, because a stateless callback carries nothing to scope it BY. With two users
 * linking concurrently this can attach the wrong Silpo account to the wrong Telegram chat. That is
 * acceptable only at this project's demo scale (one developer account, a couple of testers) and
 * MUST NOT ship to real multi-tenant use without Silpo fixing `state` echoing first.
 */
export async function getMostRecentPendingAuth() {
  return db.query.oauthPending.findFirst({
    orderBy: (row, { desc }) => [desc(row.createdAt)],
  });
}

export async function deletePendingAuth(state: string): Promise<void> {
  await db.delete(oauthPending).where(eq(oauthPending.state, state));
}

/** Raw JSON in/out — agent/session.ts owns the SessionState shape and any validation. */
export async function getSessionState(userId: number): Promise<unknown | undefined> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.userId, userId) });
  return row?.stateJson;
}

export async function saveSessionState(userId: number, state: unknown): Promise<void> {
  const values = { stateJson: state, updatedAt: new Date() };
  await db
    .insert(sessions)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: sessions.userId, set: values });
}

export type ChatRole = 'user' | 'assistant';

/** Oldest-first, so the result can be spread straight into a model `messages` array. */
export async function getRecentMessages(userId: number, limit = 12): Promise<{ role: ChatRole; content: string }[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messages.userId, userId),
    orderBy: (m, { desc }) => [desc(m.createdAt), desc(m.id)],
    limit,
  });
  return rows.reverse().map((r) => ({ role: r.role as ChatRole, content: r.content }));
}

export async function appendMessages(
  userId: number,
  entries: { role: ChatRole; content: string }[],
): Promise<void> {
  const rows = entries.filter((e) => e.content.trim().length > 0);
  if (rows.length === 0) return;
  await db.insert(messages).values(rows.map((e) => ({ userId, role: e.role, content: e.content })));
}

export async function deleteMessages(userId: number): Promise<void> {
  await db.delete(messages).where(eq(messages.userId, userId));
}

export async function logToolCall(entry: {
  userId: number;
  tool: string;
  args?: unknown;
  ok: boolean;
  ms: number;
  error?: string;
}): Promise<void> {
  await db.insert(toolCallLog).values({
    userId: entry.userId,
    tool: entry.tool,
    argsJson: entry.args ?? null,
    ok: entry.ok,
    ms: entry.ms,
    error: entry.error ?? null,
  });
}

// ── Saved plans (spec §8 Phase 6 item 2) ────────────────────────────────────────────────────────

/**
 * Raw JSON in/out, same house rule as `getSessionState`: `agent/plans.ts` owns the typed shapes
 * and does all validation, the repo only moves opaque JSON across the DB boundary.
 */
export async function savePlan(
  userId: number,
  plan: { menu: unknown; resolved?: unknown; totals?: unknown },
): Promise<number> {
  const [row] = await db
    .insert(plans)
    .values({
      userId,
      menuJson: plan.menu,
      resolvedJson: plan.resolved ?? null,
      totalsJson: plan.totals ?? null,
    })
    .returning({ id: plans.id });
  if (!row) throw new Error('Failed to insert plan row');
  return row.id;
}

/**
 * Newest first, with `id` breaking ties: `createdAt` defaults to `now()`, which in Postgres is the
 * transaction start time, so two plans saved in one transaction would otherwise be unordered.
 */
export async function getLastPlan(userId: number) {
  return db.query.plans.findFirst({
    where: eq(plans.userId, userId),
    orderBy: (p, { desc }) => [desc(p.createdAt), desc(p.id)],
  });
}

export async function listRecentPlans(userId: number, limit = 5) {
  return db.query.plans.findMany({
    where: eq(plans.userId, userId),
    orderBy: (p, { desc }) => [desc(p.createdAt), desc(p.id)],
    limit,
  });
}

/** Who asserted a fact — same boundary-typing pattern as `ChatRole` above. */
export type FactSource = 'user' | 'silpo';

/**
 * Durable memory rows (see schema.ts `userFacts`). Only ACTIVE facts are ever read back into a
 * plan: a retracted allergy must stop constraining the menu immediately, while the row survives
 * for audit.
 */
export async function listUserFacts(
  userId: number,
): Promise<{ id: number; kind: string; text: string; source: FactSource }[]> {
  const rows = await db.query.userFacts.findMany({
    where: and(eq(userFacts.userId, userId), eq(userFacts.active, true)),
    orderBy: (f, { asc }) => [asc(f.id)],
  });
  return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, source: r.source as FactSource }));
}

/**
 * Inserts a fact, de-duplicating on (kind, text) among the user's active rows so a user who
 * repeats "у мене алергія на арахіс" across sessions does not accumulate identical constraints
 * that then get injected into the prompt three times over.
 */
export async function addUserFact(entry: {
  userId: number;
  kind: string;
  text: string;
  source: FactSource;
}): Promise<{ created: boolean }> {
  const existing = await db.query.userFacts.findFirst({
    where: and(
      eq(userFacts.userId, entry.userId),
      eq(userFacts.kind, entry.kind),
      eq(userFacts.text, entry.text),
      eq(userFacts.active, true),
    ),
  });
  if (existing) return { created: false };
  await db.insert(userFacts).values(entry);
  return { created: true };
}

/** Retracts one fact by id, scoped to its owner so an id from another user cannot be touched. */
export async function deactivateUserFact(userId: number, id: number): Promise<boolean> {
  const updated = await db
    .update(userFacts)
    .set({ active: false })
    .where(and(eq(userFacts.userId, userId), eq(userFacts.id, id), eq(userFacts.active, true)))
    .returning({ id: userFacts.id });
  return updated.length > 0;
}

/** Retracts every active fact — the `/forget` escape hatch. Returns how many were retracted. */
export async function deactivateAllUserFacts(userId: number): Promise<number> {
  const updated = await db
    .update(userFacts)
    .set({ active: false })
    .where(and(eq(userFacts.userId, userId), eq(userFacts.active, true)))
    .returning({ id: userFacts.id });
  return updated.length;
}

/**
 * Erases every fact row outright — for account disconnect (`/logout`), not for retracting one
 * fact. `deactivateAllUserFacts` keeps rows for audit, which is right for `/forget` but wrong here:
 * allergy/diet text must not survive in the database for whoever links this chat next to inherit,
 * same as `deleteTokens`/`deleteMessages` for the same handler.
 */
export async function deleteUserFacts(userId: number): Promise<void> {
  await db.delete(userFacts).where(eq(userFacts.userId, userId));
}

// ── Recipes (durable per-dish ingredient lists) ────────────────────────────────────────────────

/** Lowercased, trimmed match key — the same normalization used everywhere else in this codebase. */
function dishKey(dishName: string): string {
  return dishName.trim().toLowerCase();
}

/**
 * `column + 1`, generic over which table's `timesUsed` column it targets — `saveRecipe` and
 * `saveSharedRecipe` are otherwise near-identical upserts with no other structural link between
 * them, so a future change to how the count is bumped (e.g. capping it) had no way to land in
 * both places at once. This is the one piece worth sharing that way: `sql` fragments are tied to
 * a specific column reference, so the surrounding insert/conflict shape (different target tables,
 * different conflict keys, different extra columns) stays written out per function rather than
 * forced through a generic wrapper that would be harder to follow than the duplication it removes.
 */
function bumpTimesUsed(column: AnyPgColumn) {
  return sql`${column} + 1`;
}

/**
 * Saves or refreshes one dish's ingredient list. One row per (user, dish): re-cooking the same
 * dish updates `ingredientsJson` in place — the newest version is treated as the most refined
 * one — and bumps `timesUsed`, rather than accumulating a row per occurrence.
 */
export async function saveRecipe(
  userId: number,
  dishName: string,
  ingredients: { name: string; qty: string }[],
): Promise<void> {
  const key = dishKey(dishName);
  await db
    .insert(recipes)
    .values({ userId, dishNameKey: key, dishName, ingredientsJson: ingredients })
    .onConflictDoUpdate({
      target: [recipes.userId, recipes.dishNameKey],
      set: {
        dishName,
        ingredientsJson: ingredients,
        timesUsed: bumpTimesUsed(recipes.timesUsed),
        lastUsedAt: sql`now()`,
      },
    });
}

/** Exact normalized-name match — deliberately not fuzzy; see localTools.ts's recallRecipe(). */
export async function findRecipe(userId: number, dishName: string) {
  return db.query.recipes.findFirst({
    where: and(eq(recipes.userId, userId), eq(recipes.dishNameKey, dishKey(dishName))),
  });
}

export async function listRecipes(userId: number, limit = 20) {
  return db.query.recipes.findMany({
    where: eq(recipes.userId, userId),
    orderBy: (r, { desc }) => [desc(r.lastUsedAt)],
    limit,
  });
}

/** For account disconnect (`/logout`) — recipes are this household's data, same as messages/facts. */
export async function deleteRecipes(userId: number): Promise<void> {
  await db.delete(recipes).where(eq(recipes.userId, userId));
}

// ── Shared recipes (cross-user pool, consulted only when the personal one has nothing) ─────────

/**
 * Upserts the shared entry for a dish, mirroring `saveRecipe()` — every clean resolution writes
 * to both tables, not a separately curated promotion step. `contributedByUserId` is provenance
 * only; it is overwritten to whoever refined the recipe most recently, same as `ingredientsJson`.
 */
export async function saveSharedRecipe(
  dishName: string,
  ingredients: { name: string; qty: string }[],
  contributedByUserId: number,
): Promise<void> {
  const key = dishKey(dishName);
  await db
    .insert(sharedRecipes)
    .values({ dishNameKey: key, dishName, ingredientsJson: ingredients, contributedByUserId })
    .onConflictDoUpdate({
      target: sharedRecipes.dishNameKey,
      set: {
        dishName,
        ingredientsJson: ingredients,
        contributedByUserId,
        timesUsed: bumpTimesUsed(sharedRecipes.timesUsed),
        lastUsedAt: sql`now()`,
      },
    });
}

/** Exact normalized-name match, same as `findRecipe()` — the shared-pool fallback. */
export async function findSharedRecipe(dishName: string) {
  return db.query.sharedRecipes.findFirst({
    where: eq(sharedRecipes.dishNameKey, dishKey(dishName)),
  });
}
