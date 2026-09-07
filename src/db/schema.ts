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

/**
 * Durable per-user memory that outlives a planning session: allergies, diets, dislikes,
 * preferences, household notes.
 *
 * This exists because Silpo's own `silpo_get_my_food_restrictions` came back EMPTY on a real
 * linked account — the field exists but nobody fills it in, so a bot that trusts it alone knows
 * nothing about what the user cannot eat. Everything the user tells us in chat was previously
 * forgotten after 12 turns (the `messages` window), which is exactly the wrong lifetime for
 * "I'm allergic to peanuts".
 *
 * `kind` is load-bearing, not a label: `allergy` and `diet` are HARD constraints that filter
 * products, while `dislike` and `preference` only bias selection. Collapsing the two would let an
 * allergy degrade into a suggestion, so they are kept apart at the schema level and the split is
 * enforced in memory.ts.
 *
 * `source` records who asserted the fact, so one the model inferred from conversation can be told
 * apart from one the user stated outright — the same audit reasoning behind `tool_call_log`.
 *
 * Rows are deactivated (`active = false`), never deleted, so "I'm not vegetarian any more" stays
 * traceable rather than silently rewriting history.
 */
export const userFacts = pgTable('user_facts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  source: text('source').notNull(),
  active: boolean('active').notNull().default(true),
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
