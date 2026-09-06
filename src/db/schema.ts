import { pgTable, serial, text, boolean, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramChatId: text('telegram_chat_id').notNull().unique(),
  silpoProfileJson: jsonb('silpo_profile_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthClients = pgTable('oauth_clients', {
  id: serial('id').primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret'),
  registrationJson: jsonb('registration_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthTokens = pgTable('oauth_tokens', {
  userId: integer('user_id')
    .notNull()
    .references(() => users.id)
    .primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  tokenType: text('token_type'),
  scope: text('scope'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthPending = pgTable('oauth_pending', {
  state: text('state').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  userId: integer('user_id')
    .notNull()
    .references(() => users.id)
    .primaryKey(),
  stateJson: jsonb('state_json').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Rolling conversation history (spec §6.5 "last N messages", §9.4's recentMessages/appendMessages).
 * Only user/assistant prose is kept — tool calls and their results are deliberately not replayed,
 * since the authoritative view of what the agent has established lives in `sessions.state_json`
 * and is injected into the system prompt each turn.
 */
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  menuJson: jsonb('menu_json').notNull(),
  resolvedJson: jsonb('resolved_json'),
  totalsJson: jsonb('totals_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const toolCallLog = pgTable('tool_call_log', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  tool: text('tool').notNull(),
  argsJson: jsonb('args_json'),
  ok: boolean('ok').notNull(),
  ms: integer('ms').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
