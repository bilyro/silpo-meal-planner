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
