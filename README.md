# Сільпо Шеф — Silpo Meal Planner Agent

A Telegram bot that acts as an **agent, not a chatbot**. A user writes
«Сплануй вечері на 3 дні, без свинини, до 1200 грн». The bot reads their real Silpo profile
(family, pets, food restrictions, saved addresses) over the official Silpo MCP server, proposes a
menu, resolves every ingredient to a **real product in the real catalogue**, prefers promo items,
substitutes what is out of stock, builds a **real shopping cart** tied to a real delivery slot, and
hands back Silpo's own `checkoutWebLink`.

Built for the «Сільпо» AI Factory hackathon. Every step that touches data is a real MCP tool call
against `https://mcp.silpo.ua/mcp` — there is no mock layer and no sandbox.

Full design and phased build plan: [`docs/silpo-meal-planner-agent-spec.md`](docs/silpo-meal-planner-agent-spec.md).
Demo walkthrough for the video: [`docs/demo-script.md`](docs/demo-script.md).

---

## Why this is an agent, not a chatbot

Four design decisions carry that claim, and each one is visible in the code:

**1. The multi-step recipes are deterministic code, not LLM improvisation.**
Four **local (non-MCP) tools** are handed to the model alongside the Silpo ones. They look like
tools to the LLM, but their bodies are ordinary TypeScript that always does the same thing:

| Local tool | File | What it actually does |
|---|---|---|
| `ensure_cart_context` | [`src/agent/cartContext.ts`](src/agent/cartContext.ts) | Chains ~6 dependent MCP calls (cart → address → delivery type → branch → slot → create) in a fixed order, and re-books an expired slot |
| `propose_menu` | [`src/agent/localTools.ts`](src/agent/localTools.ts) | Stores the menu in session state and flips `stage` so the ✅/✏️ keyboard renders |
| `record_resolution` | [`src/agent/localTools.ts`](src/agent/localTools.ts) | Stores the resolved item list and computes totals, promo share, substitution rate |
| `finish_with_checkout` | [`src/agent/localTools.ts`](src/agent/localTools.ts) | Reads the cart back, extracts the checkout link, loyalty balance, and *why* checkout is blocked |

The model decides *when*; the code decides *how*. The whole ingredient→product resolution
([`src/agent/resolveIngredients.ts`](src/agent/resolveIngredients.ts) +
[`selectProduct.ts`](src/agent/selectProduct.ts)) runs the same way on every run, and is unit-tested
without touching the network.

**2. The cart-context precondition is enforced, not hoped for.**
Silpo's 🔒 tools (`silpo_find_products_batch`, `silpo_get_promotions`) hard-fail with
`MCP error -32602` unless `branchId`, `deliveryType`, `timeslotStart` and `timeslotEnd` already
exist. `ensureCartContext` establishes them before any search, and `resolveIngredients` throws
loudly if it is ever called without a timeslot rather than emitting a misleading "0 items found".

**3. The LLM never invents a product, a price, or availability.**
Everything the user sees about products is rendered from tool output in
[`src/bot/format.ts`](src/bot/format.ts) — from `SessionState.resolvedItems`, never from model
prose. On a proposed menu the model's own text is *dropped* and the menu is re-rendered from what
`propose_menu` stored ([`src/bot/bot.ts`](src/bot/bot.ts)). Hallucinated groceries are structurally
impossible, not merely discouraged by the prompt.

**4. Every MCP call is logged as evidence.**
One wrapper in [`src/mcp/SilpoMcpClient.ts`](src/mcp/SilpoMcpClient.ts) carries retry/backoff and
writes every call — user, tool, args, ok/error, duration — to the `tool_call_log` table. Both the
deterministic path and the model's own tool calls go through it, so the log is a complete record of
a session.

---

## The core scenario

1. `/start` → inline button «🔐 Підʼєднати Сільпо» → OAuth 2.1 (Authorization Code + PKCE, Dynamic
   Client Registration). Tokens are stored **server-side only**.
2. On return the bot greets from the real profile: «Готово, {імʼя}! Я бачу вашу сімʼю з N осіб…»,
   plus food restrictions and pets if the account has them.
3. User: «Сплануй вечері на 3 дні, без свинини, до 1200 грн» → the agent proposes a day-by-day menu
   with ingredients and asks **✅ Так / ✏️ Змінити**.
4. **✅** → cart context is established, all ingredients are batch-searched, one product is picked
   per ingredient, and a priced list appears with 🔥 (promo) and 🔄 (substitute) badges, the total,
   and the total against the stated budget. Buttons: **🛒 Зібрати кошик / 💸 Дешевше / ✏️ Прибрати позицію**.
5. **🛒** → the items are written into the real Silpo cart in one batched call, and the bot replies
   with the item count, Silpo's own total (including delivery), the available bonus balance, and the
   **checkout link**.
6. The user pays in Silpo's own checkout. The bot never places or pays for an order — by design,
   and because the MCP has no checkout tool at all.

Commands: `/start` · `/plan` · `/cart` · `/clear` (with confirmation) · `/logout` · `/help`.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Telegram  ⇄  bot/ │ grammY: commands, inline keyboards,       │
                    │ HTML rendering — all product text comes   │
                    │ from session state, never from the model  │
                    └────────────┬─────────────────┬───────────┘
                                 │                 │
              free text ─────────┘                 └───────── ✅ / 🛒 buttons
                                 │                                   │
                    ┌────────────▼───────────┐         ┌─────────────▼──────────────┐
                    │ agent/runAgentTurn     │         │ deterministic path:        │
                    │ Vercel AI SDK loop     │         │ ensureCartContext →        │
                    │ (Claude) + 4 local     │         │ resolveIngredients →       │
                    │ tools + all 40 MCP     │         │ applyResolution →          │
                    │ tools, ≤25 steps/turn  │         │ finishWithCheckout         │
                    └────────────┬───────────┘         └─────────────┬──────────────┘
                                 └────────────┬──────────────────────┘
                                 ┌────────────▼───────────────┐
                                 │ mcp/SilpoMcpClient          │
                                 │ one Client + StreamableHTTP │
                                 │ transport per user; OAuth   │
                                 │ provider backed by Postgres;│
                                 │ retry+jitter; tool_call_log │
                                 └────────────┬────────────────┘
                                              ▼
                                   https://mcp.silpo.ua/mcp

  db/  Postgres via Drizzle — users, oauth_clients, oauth_tokens, oauth_pending,
       sessions, messages, plans, tool_call_log
  web/ Fastify — GET /healthz, GET /auth/callback (the OAuth redirect target)
```

Session state is one JSON row per Telegram chat (`sessions.state_json`): `stage`, `profile`,
`cartContext`, `request`, `menu`, `resolvedItems`, `totals`, `metrics`. `stage` decides which
inline keyboard renders next, and the whole object is injected into the system prompt every turn.
Conversation prose lives separately in `messages` (last 12 replayed per turn) so follow-ups like
«зроби дешевше» have context; tool calls are deliberately *not* replayed, because `sessions` is the
authoritative record of what actually happened.

---

## Silpo MCP tools used

**Exposure strategy.** The live server returns **40 tools** (full snapshot:
[`docs/tools.json`](docs/tools.json), regenerate with `npm run spike`). All 40 are handed to the
model each turn — `SilpoMcpClient.toolsForAiSdk()` reads `tools/list` at runtime and converts each
tool's own JSON Schema into an AI SDK tool, so **no argument shape is hard-coded anywhere**. On top
of that, **16 tools are called directly from our own code** on the deterministic paths below. Both
routes share one wrapper, so both are retried and both are logged.

The table below is the 16 direct calls, verified against the source (grep for `callTool` in `src/`):

| Flow step | Tool | Called from | Why | Writes? |
|---|---|---|---|---|
| Onboarding | `silpo_get_my_profile` | `bot/welcome.ts` | Greet by real name | no |
| Onboarding | `silpo_get_my_family` | `bot/welcome.ts` | Family size → portions; pets → pet-food upsell | no |
| Onboarding | `silpo_get_my_food_restrictions` | `bot/welcome.ts` | Hard constraints on the menu and on product selection | no |
| Cart context | `silpo_get_my_shopping_cart` | `agent/cartContext.ts` | Reuse an existing cart instead of creating a second one | no |
| Cart context | `silpo_get_shopping_cart_by_id` | `agent/cartContext.ts` | Read `branchId` / `deliveryType` / slot back off an existing cart | no |
| Cart context | `silpo_get_my_delivery_addresses` | `agent/cartContext.ts` | Use the saved address when there is one | no |
| Cart context | `silpo_find_address` | `agent/cartContext.ts` | Geocode a free-text address when there is none | no |
| Cart context | `silpo_get_available_delivery_types` | `agent/cartContext.ts` | Which delivery types serve those coordinates | no |
| Cart context | `silpo_list_branches` | `agent/cartContext.ts` | Pick an open branch when the delivery type doesn't name one | no |
| Cart context | `silpo_get_time_slots` | `agent/cartContext.ts` | First available slot — required before any 🔒 tool works | no |
| Cart context | `silpo_create_shopping_cart` | `agent/cartContext.ts` | Create the cart with address + branch + slot | **yes** |
| Cart context | `silpo_update_shopping_cart` | `agent/cartContext.ts` | Re-book the slot when a carried-over cart's slot has expired | **yes** |
| Resolve list | `silpo_find_products_batch` 🔒 | `agent/resolveIngredients.ts` | Up to 30 ingredient queries per call, chunked | no |
| Resolve list | `silpo_get_replacements` | `agent/resolveIngredients.ts` | Substitute an ingredient whose match is out of stock | no |
| Build cart | `silpo_add_or_update_cart_products` | `bot/bot.ts` (🛒 handler) | Write the whole resolved list in ONE batched call | **yes** |
| Finish | `silpo_get_shopping_cart_by_id` | `agent/localTools.ts`, `bot/commands.ts` | `checkoutWebLink`, Silpo's own total, bonus balance, and validation errors | no |
| Cleanup | `silpo_clear_shopping_cart` | `bot/bot.ts` (`/clear` → confirm) | Required by spec §4.6 — there is no sandbox, so cleanup must exist | **yes** |

Category coverage: **Profile · Location & Delivery · Cart · Product Search · Loyalty**. The loyalty
balance shown at the end (`💳 Бонусів доступно`) rides along on
`silpo_get_shopping_cart_by_id`'s top-level `loyalty` block rather than costing a separate call.

Every write above happens only after an explicit user action — 🛒 is the confirmation for the cart
build, and `/clear` asks a second time before clearing. Nothing in this list can place or pay for an
order; the MCP has no such tool.

**Deliberately not called:** `silpo_get_promotions`. Spec §6.4 assumed it returns a set of promo
product ids to prefer. It does not — it returns promo *campaigns* with no product ids at all
(verified live). Promo status is instead read per-product off `specialPrices` / `oldPrice`, which
`silpo_find_products_batch` results already carry. That is cheaper *and* correct. The model may
still call it for display context, and can reach any of the other 24 tools when a conversation calls
for it.

### What the live API actually does (and the spec got wrong)

Recorded in [`docs/phase5-findings.md`](docs/phase5-findings.md) — all observed against a real
account, not guessed:

- 🔒 tools take **flat** context args (`timeslotStart` / `timeslotEnd`), not a nested `timeslot`.
- `silpo_find_products_batch` takes `products: string[]`, and returns results under `queries` — the
  inverse of the input key name.
- `silpo_get_promotions` returns campaigns, not product ids (above).
- **Silpo enforces a 799 грн minimum order.** Below it, `checkoutWebLink` is *absent* — not empty —
  with `{level:'error', message:'order.cost.min'}` in the cart's validations. The bot surfaces the
  reason in Ukrainian instead of showing a mysteriously missing link. This is also the single
  biggest trap for the demo video; see [`docs/demo-script.md`](docs/demo-script.md).
- Search is fuzzy: «куряче філе» returns «Качине філе» (duck). `selectProduct` requires every
  distinguishing query word to appear in the product name, and ranks head-noun matches above promo
  price — buying the wrong food is worse than missing a discount.

---

## Status

Phases 0–5 are complete and **verified live against a real Silpo account** (6 Sept 2026). Phase 6 is
in progress.

- [x] **Phase 0** — project skeleton, config, Docker Postgres, Drizzle schema.
- [x] **Phase 1** — MCP spike: OAuth login + `tools/list` → [`docs/tools.json`](docs/tools.json),
      40 tools from the real server.
- [x] **Phase 2** — OAuth linking through Telegram. **Verified live**: tokens stored, valid ~30 days.
      Works today from a browser that can reach `PUBLIC_BASE_URL`; see [Known issues](#known-issues)
      before demoing from a phone.
- [x] **Phase 3** — agent loop. **Verified live**: «Хто я і що в мене за сімʼя?» answers from real
      profile tools; «Сплануй вечері на 2 дні» calls `propose_menu` and reaches `stage=menu_proposed`
      with the menu in session state. All 40 tools exposed, retry/backoff and `tool_call_log` on
      every call.
- [x] **Phase 4** — deterministic cart context. **Verified live**: a real cart created from a text
      address (branch + `DeliveryHome` + same-day slot), after which the 🔒 tools
      `silpo_get_promotions` and `silpo_find_products_batch` both succeed — the spec's actual
      acceptance test. The **expired-slot re-book path** (`rebookTimeslot`) has since also been
      exercised live against a carried-over cart. `/cart` and `/clear` implemented.
      Still unverified: reading a *pre-existing* cart created outside this bot — `cart` is an
      untyped passthrough, so `extractBranchId` reads the two field locations seen on a real cart
      and there may be others (see the ⚠ DISCOVER comment in `src/agent/cartContext.ts`).
- [x] **Phase 5** — ingredient → product resolution and cart build. **Verified live end-to-end**: a
      confirmed menu resolves to real catalogue products, writes into the real Silpo cart, and
      returns a working `checkoutWebLink`. Findings that corrected the spec are in
      [`docs/phase5-findings.md`](docs/phase5-findings.md).
      **Not done:** the **💸 «Дешевше»** (budget squeeze) and **✏️ «Прибрати позицію»** buttons are
      honest stubs — they reply with a one-line prompt that routes the user to free text, which the
      agent loop can act on since it holds the resolved list. `silpo_get_similar_products` and
      `silpo_remove_cart_products` are not called yet.
- [ ] **Phase 6** — loyalty, plan persistence, robustness. **In progress, landing now** in three
      parallel workstreams: loyalty/coupons (`silpo_get_loyalty_info`, `silpo_get_my_coupons`,
      `silpo_get_promo_codes`), writing completed plans to the `plans` table plus «Повтори минулий
      план», and guardrails beyond the existing `MAX_TOOL_CALLS_PER_TURN` cap (per-turn timeout,
      duplicate-call dedupe, error UX). The tools table above therefore reflects the deterministic
      calls as of this writing and will grow. `npm test` is green.
- [ ] **Phase 7** — deploy, record the ≤3 min video, pitch deck, submit.

Note: `SessionState.metrics.toolCalls` is currently a placeholder that nothing increments —
`tool_call_log` is the real per-session record and the one to query for the metrics slide.

---

## Setup

Prerequisites: Node.js 20+, Docker.

```bash
npm install
cp .env.example .env        # fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PUBLIC_BASE_URL
docker compose up -d postgres
npm run migrate             # applies drizzle/ SQL migrations
npm run dev                 # tsx watch — boots Fastify + the bot in one process
```

`npm run dev` runs the web server (`GET /healthz`) and the Telegram bot (long polling) together.
Production: `npm run build && npm start`.

> **Postgres runs on host port 5433, not 5432.** The dev machine already had a native Postgres on
> 5432, and Docker's port publish loses that conflict silently on macOS — connections reach the
> native instance with no error other than "role does not exist". `.env.example` already uses 5433;
> don't change it back without checking for the same conflict.

### Environment variables

| Var | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `ANTHROPIC_API_KEY` | for the agent loop, via `@ai-sdk/anthropic` |
| `AGENT_MODEL` | default `claude-haiku-4-5` |
| `PUBLIC_BASE_URL` | **must be internet-reachable HTTPS** — it is the OAuth redirect origin (`<PUBLIC_BASE_URL>/auth/callback`). Use `cloudflared tunnel --url http://localhost:3000` or ngrok in dev. See [Known issues](#known-issues). |
| `SILPO_MCP_URL` | defaults to `https://mcp.silpo.ua/mcp` |
| `DATABASE_URL` | Postgres connection string (port **5433**) |
| `MAX_TOOL_CALLS_PER_TURN` | default 25 — the runaway-loop cap |
| `LOG_LEVEL`, `PORT` | pino level; HTTP port |

`.env.example` is the authoritative list. Env is parsed and validated by zod in `src/config.ts`,
which exits 1 on anything missing or malformed.

### Database

Schema: `src/db/schema.ts` (Drizzle). Regenerate migrations with `npx drizzle-kit generate` after
editing it; apply with `npm run migrate`.

### Testing

```bash
npm test                                  # vitest run
npx vitest run test/selectProduct.test.ts # a single file
```

Unit tests cover the pure selection heuristic (promo preference, unit-price normalisation, stock
capping, fuzzy-match rejection), `cartContext` against a mocked MCP client, and the Telegram
formatters, with Phase 6 suites landing alongside. Nothing in the test suite touches the network or
a real account — the whole suite runs in well under a second.

---

## Known issues

### `PUBLIC_BASE_URL` must be an internet-reachable HTTPS origin, or phone-based linking fails

**Symptom:** Silpo login fails with `400 Invalid or expired state` (observed ~7 of 8 attempts,
6 Sept 2026).

`mcp.silpo.ua/authorize` is a broker in front of the real IdP. It discards our `client_id`,
`code_challenge` and `state`, and redirects to `auth.silpo.ua` using *Silpo's own* internal client
id, its own `redirect_uri=https://mcp.silpo.ua/callback`, and a freshly minted internal state UUID.
After login the broker looks that UUID up to reconstruct our original request and redirects onward
to *our* `redirect_uri`.

**Broker states are single-use — consumed by the first `/callback` hit, even one that then fails.**
Mint a real state (any `/authorize` 302's with one in its `Location`), then hit `/callback` twice:

```
# 1st hit, real unconsumed state (dummy code) → state WAS found, fails later:
→ 502  Token exchange failed
# 2nd hit, same state → already consumed:
→ 400  Invalid or expired state
# never-issued garbage UUID → never existed:
→ 400  Invalid or expired state
```

So a `400` means the state was **already consumed** — i.e. `/callback` got hit twice — not that it
expired. Ruled out by experiment: no TTL (states survived 600 s warm and 240 s of silence; 20/20
immediate mint→redeem round-trips succeeded), DCR client staleness, and `scope`.

**Root cause — our config, not Silpo's.** With `PUBLIC_BASE_URL=http://localhost:3000`, the Telegram
inline URL button opens in Telegram's in-app WebView on a phone. The first `/callback` hit succeeds
and 302's to `http://localhost:3000/auth/callback` — dead on a phone — so the user reloads or hands
off to the system browser, re-requesting the `mcp.silpo.ua` URL whose state is now spent → `400`.
The ~1-in-8 successes were desktop attempts, where `localhost:3000` genuinely resolves.

**✅ Confirmed (6 Sept 2026):** the same `/authorize` URL opened in a desktop browser *on the machine
running the server* completed first try, tokens stored, live MCP calls succeed.

**Fix for any other device (i.e. the real demo flow):** point `PUBLIC_BASE_URL` at an
internet-reachable HTTPS origin (`cloudflared tunnel --url http://localhost:3000`, ngrok, or a
deployed host), then **re-register the DCR client** — a registration bakes in its `redirect_uris`,
so the localhost-registered one must be discarded or `/authorize` rejects the new redirect_uri:

```sql
DELETE FROM oauth_clients; DELETE FROM oauth_pending;
```

`saveOauthClient` replaces rather than accumulates and `getOauthClient` returns the newest, so
re-registration then happens automatically.

> ⚠️ **Methodological note, kept deliberately.** An earlier revision of this section concluded the
> opposite — that the broker had a short state TTL and nothing was fixable on our side. That was
> **wrong**: it compared a garbage UUID against a state captured from an *already-completed* login.
> That state had already been consumed, so both returned `400` for *different* reasons and the match
> looked like proof. Always compare against a **freshly minted, unconsumed** state — the
> `502`-vs-`400` split is the only real discriminator.

### Other

- `silpo_get_shopping_cart_by_id`'s `cart` field is an untyped passthrough (its JSON Schema is
  literally `{type: object, additionalProperties: {}}`). Field locations were established by reading
  a real cart; a differently-shaped cart could still surprise `extractBranchId`.
- A cart outlives its delivery slot. Reopening one created earlier in the day yields
  `validations: [{level:'error', type:'timeslot'}]` and every 🔒 tool then rejects the stale slot.
  Handled by `rebookTimeslot`, but it is worth knowing when reading logs.

---

## Repository layout

```
src/
  index.ts         boots the web server + bot
  config.ts        zod-validated env
  logger.ts        pino
  db/              Drizzle schema, client, migrate, repo helpers
  mcp/             SilpoMcpClient, DB-backed OAuth provider
  web/             Fastify: /healthz, /auth/callback
  agent/           runAgentTurn, systemPrompt, local tools, cartContext,
                   resolveIngredients, selectProduct, session
  bot/             grammY bot, commands, keyboards, HTML formatting, welcome
scripts/           mcp-spike.ts (OAuth + tools/list), dump-tools.ts
docs/              spec, tools.json snapshot, phase5-findings, demo-script
drizzle/           generated SQL migrations
test/              unit tests (no network)
```
