import { eq } from 'drizzle-orm';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from './client.js';
import { oauthClients, oauthPending, oauthTokens, users } from './schema.js';

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

export async function getOauthClient(): Promise<OAuthClientInformationFull | undefined> {
  const row = await db.query.oauthClients.findFirst();
  return row ? (row.registrationJson as OAuthClientInformationFull) : undefined;
}

export async function saveOauthClient(info: OAuthClientInformationFull): Promise<void> {
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

export async function savePendingAuth(state: string, userId: number, codeVerifier: string): Promise<void> {
  await db.insert(oauthPending).values({ state, userId, codeVerifier });
}

export async function getPendingAuth(state: string) {
  return db.query.oauthPending.findFirst({ where: eq(oauthPending.state, state) });
}

/** Fallback when the callback carries no state — see SilpoAuthProvider's class doc. */
export async function getMostRecentPendingAuth() {
  return db.query.oauthPending.findFirst({
    orderBy: (row, { desc }) => [desc(row.createdAt)],
  });
}

export async function deletePendingAuth(state: string): Promise<void> {
  await db.delete(oauthPending).where(eq(oauthPending.state, state));
}
