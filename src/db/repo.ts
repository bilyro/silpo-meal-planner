import { eq } from 'drizzle-orm';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from './client.js';
import { oauthClients, oauthPending, oauthTokens, sessions, toolCallLog, users } from './schema.js';

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

export async function getTokens(userId: number): Promise<OAuthTokens | undefined> {
  const row = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.userId, userId) });
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
