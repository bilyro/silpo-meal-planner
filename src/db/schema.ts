import { pgTable, serial, text, boolean, integer, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';

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
  /**
   * A /start link is a real, valid Silpo authorize URL — nothing stops whoever ran /start from
   * forwarding it to someone else, who then logs into THEIR OWN real Silpo account and approves,
   * unknowingly handing their tokens to the Telegram chat that forwarded the link (Silpo does not
   * reliably echo `state`, so /auth/callback cannot otherwise tell which chat a code belongs to).
   *
   * `confirmed` closes this: /auth/callback saves tokens as usual but leaves this false and shows
   * a one-time code on the success page instead of finishing. getTokens() only returns rows where
   * this is true, so nothing in the app (including a fresh mcp.connect()) can use an unconfirmed
   * link. The code must be typed back into Telegram (see bot.ts's message:text handler) before the
   * link is trusted. In the forwarding attack, that code renders on the page the FORWARDED-TO
   * person is looking at, not in the forwarder's own chat — so completing the takeover now needs
   * that person to notice and relay a code, not just click once and approve, which a routine
   * "connect your account" flow never asks for.
   *
   * A background token refresh (the SDK's automatic 401-retry) calls saveTokens() too but never
   * touches this column — only server.ts's /auth/callback resets it — so an already-confirmed
   * session's routine refresh does not unexpectedly lock the user out.
   */
  confirmed: boolean('confirmed').notNull().default(false),
  /** Set alongside `confirmed = false`; cleared once confirmed. Null the rest of the time. */
  confirmCode: text('confirm_code'),
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

/**
 * A dish once cooked, remembered so the NEXT request for the same dish doesn't re-derive its
 * ingredient list from scratch — real testing this session found the model producing genuinely
 * different quantities and even different units for the "same" recipe run to run.
 *
 * Deliberately holds only `ingredientsJson` (names + free-text quantities, e.g. `[{name:
 * "буряк", qty: "3 шт"}]`) — never a `productId` or price. Those are the ephemeral half of a
 * resolution: prices, promos and stock drift constantly, which is exactly why
 * `resolveIngredients()` re-runs a full live search every time regardless of any cache. A recipe
 * is the durable half — what the dish IS — and stays useful long after any specific product
 * lookup would be stale.
 *
 * `dishNameKey` is the match key (trimmed, lowercased); `dishName` keeps the original casing
 * for display. One row per (user, dish): re-cooking the same dish updates `ingredientsJson` in
 * place (the newest version is treated as the most refined one) and bumps `timesUsed`, rather
 * than accumulating a row per occurrence.
 *
 * Scoped to one user — this user's own history, checked first and trusted most. See
 * `sharedRecipes` below for the cross-user pool consulted only when this table has nothing.
 */
export const recipes = pgTable(
  'recipes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    dishNameKey: text('dish_name_key').notNull(),
    dishName: text('dish_name').notNull(),
    ingredientsJson: jsonb('ingredients_json').notNull(),
    timesUsed: integer('times_used').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.dishNameKey)],
);

/**
 * The cross-user pool `recipes` falls back to when THIS user has never cooked a dish. Same
 * ingredients-only shape and the same "0 misses" correctness bar as `recipes` — every clean
 * resolution writes to both tables, not a separately curated promotion step.
 *
 * Unique on `dishNameKey` alone: there is exactly one shared entry per dish name, not one per
 * (user, dish). `contributedByUserId` is provenance only (who last refined it), never used to
 * filter or restrict who can read it.
 *
 * Naming a forbidden ingredient here is not a safety gap: a shared recipe's ingredient NAMES
 * still flow through the exact same `resolveIngredients` -> `selectProduct` -> `hardRestrictions`
 * pipeline as a personal one. A shared "борщ" naming «свинина» for a user with a «без свинини»
 * restriction simply fails to find a matching product for that one ingredient — the same miss
 * this pipeline already produces today, not a silent violation. What a shared entry can get
 * wrong is fit, not safety: a family size or preference that doesn't match this user, which is
 * why the model is told to adapt a shared suggestion even more than its own.
 *
 * Not touched by `/logout` — a contribution to the shared pool is aggregate data, not this
 * user's property to erase, the same reasoning `tool_call_log` already stands on.
 */
export const sharedRecipes = pgTable('shared_recipes', {
  id: serial('id').primaryKey(),
  dishNameKey: text('dish_name_key').notNull().unique(),
  dishName: text('dish_name').notNull(),
  ingredientsJson: jsonb('ingredients_json').notNull(),
  timesUsed: integer('times_used').notNull().default(1),
  contributedByUserId: integer('contributed_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
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
