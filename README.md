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

**3. The LLM never invents a product, a price, a quantity, or availability.**
Everything the user sees about products is rendered from tool output in
[`src/bot/format.ts`](src/bot/format.ts) — from `SessionState.resolvedItems`, never from model
prose. On a proposed menu the model's own text is *dropped* and the menu is re-rendered from what
`propose_menu` stored ([`src/bot/bot.ts`](src/bot/bot.ts)). Hallucinated groceries are structurally
impossible, not merely discouraged by the prompt — and since the model holds no cart-write tool,
that now covers what reaches the cart, not just what reaches the screen.

### Why the write tools are gated

This claim used to be true of the *display* and false of the *cart*. On 7 Sept 2026 a user answered
«Так» as free text instead of tapping ✅. That routed the turn to the agent loop rather than the
deterministic ✅ handler, and the model — which was then handed all 40 tools — called
`silpo_add_or_update_cart_products` itself, inventing `quantity: 10` for «Картопля — 1 кг» and `5`
for the chicken, against a branch that was not the session's. **Ten kilograms of potatoes went into
a real cart.** `computeQuantity` would have sent 1 kg and `capToStock` would have clamped it to
stock; neither runs on the model's path.

The fix is structural rather than a prompt instruction: the seven mutating tools are filtered out of
`toolsForAiSdk()`, so there is no cart-write tool for the model to reach for, however the user
phrases their confirmation. Cart changes happen only through the 🛒 button and `/clear`, where the
quantity, stock and branch guards live. Withholding beats refusing inside `execute` — a tool the
model can see is one it will try, and each attempt costs a step and a full-context round-trip.

Recorded in [`docs/mcp-tool-usage.md`](docs/mcp-tool-usage.md); regression tests in
[`test/writeGate.test.ts`](test/writeGate.test.ts).

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

Commands: `/start` · `/plan` · `/plans` · `/cart` · `/clear` (with confirmation) · `/memory` · `/forget` · `/logout` · `/help`.

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
[`docs/tools.json`](docs/tools.json), regenerate with `npm run spike`). `toolsForAiSdk()` reads
`tools/list` at runtime and converts each tool's own JSON Schema into an AI SDK tool, so **no
argument shape is hard-coded anywhere**. The model is handed **33 of them: every read tool, and no
tool that mutates the account.** The seven writes (`add_or_update_cart_products`,
`create_shopping_cart`, `update_shopping_cart`, `clear_shopping_cart`, `remove_cart_products`,
`add_or_update_favorite_products`, `add_or_update_certificates`) are reachable only through
`callTool()` on the deterministic paths — see [Why the write tools are gated](#why-the-write-tools-are-gated). On top
of that, **19 tools are called directly from our own code** on the deterministic paths below. Both
routes share one wrapper, so both are retried and both are logged.

Counting honestly, against `tool_call_log` and the source rather than intent: **19 tools are wired
into our code, 19 have actually been called, and 21 have been touched one way or the other** — the
two sets differ at the edges, and the difference is the interesting part. Two wired tools have never
had their branch reached, and two tools nobody wired were reached for by the model on its own.
Full breakdown: [`docs/mcp-tool-usage.md`](docs/mcp-tool-usage.md).

The table below is the 19 direct calls, verified against the source (grep for `callTool` in `src/`):

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
| Resolve list | `silpo_get_replacements` ◦ | `agent/resolveIngredients.ts` | Substitute an ingredient whose match is out of stock | no |
| Build cart | `silpo_add_or_update_cart_products` | `bot/bot.ts` (🛒 handler) | Write the whole resolved list in ONE batched call | **yes** |
| Finish | `silpo_get_shopping_cart_by_id` | `agent/localTools.ts`, `bot/commands.ts` | `checkoutWebLink`, Silpo's own total, bonus balance, and validation errors | no |
| Finish | `silpo_get_loyalty_info` | `agent/loyalty.ts` | Bonus balance and tier shown under the cart | no |
| Finish | `silpo_get_my_coupons` | `agent/loyalty.ts` | Personal coupons that apply to this basket | no |
| Finish | `silpo_get_promo_codes` | `agent/loyalty.ts` | Promo codes offered alongside the checkout link | no |
| Cleanup | `silpo_clear_shopping_cart` | `bot/bot.ts` (`/clear` → confirm) | Required by spec §4.6 — there is no sandbox, so cleanup must exist | **yes** |

◦ `silpo_get_replacements` and `silpo_list_branches` are implemented but have never been reached on
a real run — one needs an out-of-stock match, the other a delivery type that names no branch. Live
code on a branch that hasn't fired, not dead code.

Category coverage: **Profile · Location & Delivery · Cart · Product Search · Loyalty**. The loyalty
balance shown at the end (`💳 Бонусів доступно`) rides along on
`silpo_get_shopping_cart_by_id`'s top-level `loyalty` block rather than costing a separate call.

Every write above happens only after an explicit user action — 🛒 is the confirmation for the cart
build, and `/clear` asks a second time before clearing. That holds structurally rather than by
convention: the model is not handed a write tool at all, so there is no second route to one.
Nothing in this list can place or pay for an order; the MCP has no such tool.

**Deliberately not called:** `silpo_get_promotions`. Spec §6.4 assumed it returns a set of promo
product ids to prefer. It does not — it returns promo *campaigns* with no product ids at all
(verified live). Promo status is instead read per-product off `specialPrices` / `oldPrice`, which
`silpo_find_products_batch` results already carry. That is cheaper *and* correct. The model may
still call it for display context, and can reach any of the other 21 tools when a conversation calls
for it.

And it does: `tool_call_log` shows the model reaching for `silpo_get_promotions` and
`silpo_get_my_promos` on its own — two tools nothing in our code wires. That is the payoff for
exposing all 40 rather than a curated subset, and it is why the exposure strategy is worth the
tokens it costs.

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
  biggest trap for the demo video.
- Search is fuzzy: «куряче філе» returns «Качине філе» (duck). `selectProduct` requires every
  distinguishing query word to appear in the product name, and ranks head-noun matches above promo
  price — buying the wrong food is worse than missing a discount.
- **The search payload has no category field.** It carries only `available, branchId, companyId,
  displayRatio, externalProductId, id, image, name, oldPrice, price, slug, specialPrices, step,
  stock, weighted` (dump one with `npx tsx scripts/probe-raw.ts «кабачок»`). So "is this the
  ingredient or a processed version of it" has to be read off the name — there is nothing better to
  key on. `selectProduct` demotes processed forms (`пюре`, `гранульований`, `заморожен`, `в
  маринаді`, …) beneath the raw item and rejects non-ingredients (`Gerber`, `дитяч`, pet food)
  outright. Without it «картопля» bought frozen Aviko chips, «часник» bought garlic powder, and
  «кабачок» bought baby-food purée — each because the processed version leads with the ingredient
  word *and* was cheaper or on promo. Markers in the **query** are never held against a product, so
  «томатний сік» and «заморожені овочі» still resolve to exactly that.

---

## Status

Phases 0–6 are complete and **verified live against a real Silpo account** (6–7 Sept 2026). Phase 7
(deploy and submission) is in progress. A hardening pass landed 9–10 Sept 2026, independent of the
Phase 7 checklist below — a critical OAuth fix, an HTML-escaping fix, four correctness bugs from a
code-quality review, a feature-completion, a refactor, and a new daily message cap; see
[Hardening pass, 9-10 Sept 2026](#hardening-pass-9-10-sept-2026) below for what changed and how it
was verified.

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
- [x] **Phase 6** — loyalty, plan persistence, robustness. Loyalty and coupons
      (`silpo_get_loyalty_info`, `silpo_get_my_coupons`, `silpo_get_promo_codes`) appended to the
      cart reply; completed plans written to the `plans` table with `/plans` and «Повтори минулий
      план»; guardrails beyond the `MAX_TOOL_CALLS_PER_TURN` cap — a 60 s per-turn wall-clock
      deadline that cancels in-flight MCP requests, consecutive-duplicate call suppression, and a
      grammY error boundary so no handler can fail silently.
      **Not verified live:** `applyPromoCode` — test it on a throwaway cart, never the demo cart.
- [ ] **Phase 7** — deploy, record the ≤5 min video, pitch deck, submit.
      **Done:** the deploy is buildable and reproducible — [`fly.toml`](fly.toml), a
      [`.dockerignore`](.dockerignore) that keeps `.env` out of the image, a production-only
      dependency stage, migrations applied on boot, bounded graceful shutdown, and `/readyz`
      alongside `/healthz`. Runbook in [`docs/deploy.md`](docs/deploy.md); cold start verified
      locally (migrate → listen → both probes 200 → SIGTERM → clean exit). Submission artefacts:
      [`docs/tool-call-log.md`](docs/tool-call-log.md) (generated, not hand-written; regenerated
      10 Sept 2026 via `npm run export-log` — **200 calls across 18 distinct tools**) and
      [`docs/pitch-deck.md`](docs/pitch-deck.md).
      **Left:** `fly deploy` itself, three consecutive clean end-to-end runs from a phone, the video,
      and the submission form.

### Hardening pass, 9-10 Sept 2026

Six commits landed after the Phase 6 sign-off above, independent of the Phase 7 deploy checklist.
Verification for all of it: the unit suite (**249 tests across 18 files, `npm test`, all green** —
several of the fixes below were mutation-tested, i.e. the fix was temporarily reverted to confirm
the test actually fails without it, then restored) plus, for the two DB-touching pieces (link
confirmation, message counting), live scripts against the real dev Postgres using synthetic test
users. **None of this went through a real end-to-end Telegram OAuth conversation this session** —
that is a lower bar than "verified live" above, and is called out per item rather than implied.

- **Critical: closed an OAuth account-hijack hole** (`e40443b`, 9 Sept). `/start` hands out a real,
  valid Silpo authorize URL, and nothing stopped it being forwarded — even second-hand: whoever
  opened it would log into *their own* real Silpo account and unknowingly attach it to the
  *forwarder's* Telegram chat, because Silpo does not reliably echo `state`, so `/auth/callback` had
  no way to tell which link attempt a code belonged to. Fixed with a confirmation step: `oauth_tokens`
  gained `confirmed`/`confirmCode` (doc comment at `src/db/schema.ts:28–46`). A fresh token exchange
  is saved but left unconfirmed, and `/auth/callback` (`src/web/server.ts`) shows a one-time 6-digit
  code on the success page instead of finishing the link there. `getTokens()` only returns confirmed
  rows, so nothing — including a fresh `mcp.connect()` — can use an unconfirmed link. The code must be
  typed back into the Telegram chat that ran `/start`; `bot.ts`'s `message:text` handler recognizes a
  bare 6-digit message, looks it up via `repo.findUnconfirmedByCode`, and confirms. **This changes the
  linking UX** — see the note added to [Known issues](#known-issues) below. Unit-tested
  (`test/relink.test.ts`); not exercised through a real Silpo login this session.
- **HTML-escaping fix**, same commit. The default free-text reply path could carry an unescaped
  `<a>` tag surfaced through model-relayed text — closing a route where a link smuggled into the
  cross-user shared recipe pool would be echoed verbatim by the model. `stripLinks()`
  (`src/bot/format.ts:21–23`) now strips `<a>` tags there; the two structured render paths (menu,
  resolved list) were already safe since they never echo arbitrary text.
- **Four correctness bugs from a code-quality review** (`e40443b`):
  - `remove_items` could delete the wrong cart line for short Ukrainian words like «сир»/«рис»/
    «мед» — it reused `matchesQuery`'s deliberate "match everything when every word is under 4
    chars" fallback, correct for narrowing a search but wrong for picking exactly one line to
    delete. New `matchesForRemoval()` (`src/agent/selectProduct.ts:142`) never matches on
    empty/short-only input.
  - Restriction-synonym key `риб` (fish) is a literal substring of `гриб` (mushroom), so a stored
    mushroom-only restriction silently blocked fish too. `restrictionKeysFor` now matches per-word
    prefixes (`src/agent/selectProduct.ts:320–322`), as its own doc comment already claimed.
  - `removeItems`/`addExtraItems` called `applyResolution` — which unconditionally resets
    `cartWritten` — even on a no-op (every name missed), wrongly demanding the cart be rebuilt for a
    call that changed nothing.
  - The `propose_menu` retry regex used `зубч\w*` to catch garlic-clove quantities, but `\w` is
    ASCII-only and can't match the Cyrillic ending, so a menu whose only quantity unit was garlic
    cloves never reached the retry threshold (`src/agent/runAgentTurn.ts:86–92`).
  All four are unit-tested and mutation-verified.
- **Budget selection mode wired up** (`d236a77`, 9 Sept). `SelectionOptions.preferCheapest` existed
  and was unit-tested but had zero production callers. A stated budget (`state.request.budgetUah`
  set) now switches `resolveIngredients` to cheapest-first in both `bot.ts`'s `menu_confirm` handler
  and `localTools.ts`'s `addExtraItems`. Code-complete and unit-tested; not yet exercised against a
  real cart with a real stated budget.
- **Refactor** (`d1c2653`, 9 Sept): the connect / `catch(NeedsAuthError)` / close skeleton, copied
  across 5 bot handlers and already drifted (`clear_confirm` was missing the typing indicator the
  other four had), is now `withMcpSession()` (`src/bot/mcpSession.ts`) — used by every handler that
  talks to Silpo, including the ones in the [tools table](#silpo-mcp-tools-used) below. Cart-validation
  reading — independently reimplemented three times with three slightly different local types — is
  now one `getCartValidations()` + `CartValidation` type in `src/agent/cartContext.ts:114–130`. Both
  extractions are unit-tested, with the original call sites now verified to break together.
- **New: a daily per-user message cap** (`6bffa4d`, `734c997`, 9 Sept). This is an ordering agent,
  not an open-ended chat companion, so `DAILY_MESSAGE_LIMIT` (env, default **10**, raised from an
  initial 8) bounds a user to that many free-text turns per day — checked in `runAgentTurn` via
  `repo.countUserMessagesToday()` **before** session load and before any model or Silpo call, so
  hitting it costs nothing. A same-user concurrency guard (`turnsInProgress`, `src/bot/bot.ts:83`)
  closes the burst gap the count alone would leave open (several messages sent before the first turn
  finishes would otherwise all see the same pre-burst count and all pass). Button taps (✅ / 🛒 / etc.)
  are callback queries, not text messages, so they don't count against the cap. Mutation-verified
  against the gate itself; `countUserMessagesToday` live-verified against the dev DB (counts only
  `role='user'` rows, correctly excludes assistant replies).

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

`npm run dev` runs the web server and the Telegram bot (long polling) together, and applies any
pending migrations on boot — so the explicit `npm run migrate` above is only needed if you want to
migrate without starting anything. Production: `npm run build && npm start`.

Two HTTP probes, deliberately separate: `GET /healthz` is liveness ("the process is up") and touches
nothing else, so a brief database blip cannot cause a restart loop that also takes down
`/auth/callback`; `GET /readyz` runs a real `select 1` and returns 503 when Postgres is unreachable.

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
capping, fuzzy-match rejection), `cartContext` against a mocked MCP client, the Telegram formatters,
and the Phase 6 guardrails (per-turn deadline, duplicate suppression, call budget). Nothing in the
test suite touches the network or a real account — the whole suite runs in well under a second.

### Deploying

See [`docs/deploy.md`](docs/deploy.md). The point of deploying is narrow: `PUBLIC_BASE_URL` must be a
stable internet-reachable HTTPS origin, or linking from a phone fails (see
[Known issues](#known-issues)). The runbook covers the step it is easiest to forget — **after the
hostname changes you must clear `oauth_clients`**, because a DCR registration bakes its
`redirect_uris` in and the old one is now wrong.

### The submission log excerpt

```bash
npm run export-log                       # last 200 calls → docs/tool-call-log.md
npm run export-log -- --limit 120 --since 2026-09-07T09:00:00Z
```

Renders `tool_call_log` as a JSON-RPC transcript plus a metrics table (calls, distinct tools, p50 /
p95). The request frames are exactly what went over the wire; **responses are not stored** — they
carry the account holder's real name, family, addresses and orders — so each is annotated with the
recorded outcome only, and argument keys that identify the account holder are redacted. Product
names, branch and cart ids are left intact, since they are the part that shows the integration works.

---

## Known issues

### `PUBLIC_BASE_URL` must be an internet-reachable HTTPS origin, or phone-based linking fails

> **Since 9 Sept 2026 this section only covers reaching a successful `/auth/callback` redirect —
> that redirect no longer finishes the link by itself.** A confirmation step closes an
> account-hijack hole (see [Status](#status)): `/auth/callback` now shows a one-time 6-digit code on
> the success page, and the link stays unconfirmed — unusable by `getTokens()` — until that code is
> typed back into the Telegram chat that ran `/start`. Everything below (the broker, the state
> consumption, the phone-WebView failure mode) still describes reaching that page correctly; getting
> there is necessary but no longer sufficient.

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
  web/             Fastify: /healthz, /readyz, /auth/callback
  agent/           runAgentTurn, systemPrompt, local tools, cartContext,
                   resolveIngredients, selectProduct, session
  bot/             grammY bot, commands, keyboards, HTML formatting, welcome
scripts/           mcp-spike.ts (OAuth + tools/list), dump-tools.ts, export-tool-log.ts
docs/              spec, tools.json snapshot, phase5-findings, deploy, pitch-deck,
                   tool-call-log.md (generated)
drizzle/           generated SQL migrations
test/              unit tests (no network)
Dockerfile         multi-stage; .dockerignore keeps .env out of the image
fly.toml           deploy target — see docs/deploy.md
```
