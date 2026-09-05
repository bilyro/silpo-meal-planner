# Silpo Meal Planner Agent — Implementation Specification

**Project codename:** `silpo-meal-planner`
**Target:** «Сільпо» AI Factory hackathon (submission deadline **14 September 2026, 23:59:59 Kyiv time**; judging 15–28 Sept; winners 30 Sept)
**Author of the spec:** prepared for Roman; written so that an AI coding agent (or a developer) can implement it end-to-end without further context.
**Stack:** Node.js 20+, TypeScript, Vercel AI SDK (`ai`) with the Anthropic provider, `@modelcontextprotocol/sdk`, grammY (Telegram), PostgreSQL (or SQLite for the prototype), Docker.

---

## 0. How to read this document

Sections 1–3 explain *what* and *why*. Section 4 lists the hard facts about the Silpo MCP that the code must respect. Sections 5–7 are the design. Section 8 is the ordered, phased build plan with acceptance criteria for each phase — an implementing agent should execute Phase 0 → Phase 7 in order and not start a phase before the previous phase's acceptance criteria pass. Section 9 contains code sketches that are meant to be adapted, not copied blindly (library APIs drift; always check the installed version). Sections 10–12 cover testing, risks, and the submission checklist.

Things marked **⚠ DISCOVER** are facts the documentation does *not* specify; the implementer must obtain them at runtime from the server (`tools/list`) and adapt. Do not invent parameter names — read the JSON Schema the server returns.

---

## 1. What we are building (one paragraph)

A Telegram bot called **«Сільпо Шеф»** (working title) that acts as an *agent*, not a chatbot. A user writes something like *«Сплануй вечері на 4 дні для нашої сім'ї, бюджет до 1500 грн»*. The agent reads the user's Silpo profile (family members, pets, food restrictions, saved addresses) through the official Silpo MCP, proposes a menu, turns it into a shopping list, finds real products in the Silpo catalog, prefers items that are on promotion, checks stock and substitutes what is missing, builds a real shopping cart tied to a delivery slot, and hands the user a ready-to-pay checkout link. Every step that touches data is a real MCP tool call against `https://mcp.silpo.ua/mcp`.

---

## 2. Why this idea (mapping to the judging criteria)

The hackathon judges on six dimensions with no published weights. This project was chosen because it scores on all six at once and can be built by one developer in ~8 working days.

| Criterion | How this project addresses it |
|---|---|
| Guest / business value | Meal planning + grocery ordering is the highest-frequency pain for families; it raises average basket size and promo redemption for Silpo. |
| MCP utilization quality | Touches 6 of 7 tool categories: Profile, Product Search, Catalog/Promotions, Cart, Location & Delivery, Loyalty. Each call is *needed*, not decorative. |
| Agent capability | Multi-step reasoning: profile → menu → list → search → substitute → optimise for promos → cart → slot. State is carried across turns. |
| Integration realism | Uses only official tools, ends with the official `checkoutWebLink` — nothing that Silpo's own app could not ship. |
| Prototype / demo quality | Telegram is easy to screen-record; the visible payoff is a real cart appearing in the Silpo app. |
| Validation & scaling | Built-in metrics (time-to-cart, % promo items, substitution rate) + a clear path to Silpo app integration. |

Ideas that were considered and rejected: a pure reorder bot (uses too few tools, low "wow"), a budget optimiser alone (good, but it is a *sub-feature* of this project — see §6.4), an internal logistics tool (no access to internal data).

---

## 3. Product specification

### 3.1 Users and core scenario

Primary user: a Silpo customer with a «Власний Рахунок» account who orders online. The demo persona: a family of 3–4 with at least one dietary restriction stored in the profile.

Core scenario (the one that must work flawlessly for the video):

1. User opens the bot, taps **/start**, receives a one-time link to connect their Silpo account (OAuth). After login the bot says «Готово, {name}! Я бачу вашу сім'ю з N осіб…».
2. User: *«Сплануй вечері на 3 дні, без свинини, до 1200 грн».*
3. Bot (agent) replies with a 3-day menu, each dish with 4–8 ingredients, and asks for confirmation (inline buttons **✅ Так / ✏️ Змінити**).
4. On confirm the agent resolves ingredients to products, shows a compact table: product, qty, price, «🔥 акція» badge, «🔄 заміна» badge where a substitute was used, and the total vs. budget.
5. User taps **🛒 Зібрати кошик**. Agent creates/updates the cart, picks the nearest branch + first available time slot for the user's default address, and returns the cart summary + **checkout link** + bonus balance that can be applied.
6. User opens the link and finishes payment in Silpo's own checkout (out of scope).

### 3.2 Secondary scenarios (implement only after the core one is solid)

- **Change a dish**: «Заміни борщ на щось швидше» → agent regenerates one day and re-resolves only its ingredients.
- **Budget squeeze**: «Зроби дешевше на 200 грн» → agent swaps to cheaper/promo alternatives via `silpo_get_similar_products`.
- **Repeat last plan**: «Повтори минулого тижня» → read history from our DB (not Silpo) and rebuild.
- **Pets**: if `silpo_get_my_family` returns pets, the agent offers to add pet food from the catalog.

### 3.3 Explicit non-goals

- No payment/checkout inside the bot (there is **no checkout tool** in the MCP; the flow legitimately ends with `checkoutWebLink`).
- No recipe database of our own — the LLM generates menus; the MCP provides products.
- No web UI. Telegram only.
- No multi-language UI. Ukrainian only (the catalog is Ukrainian; product search must be sent in Ukrainian).

### 3.4 Success metrics (log these — they feed the "Validation & scaling" slide)

- `time_to_cart_seconds` from first message to checkout link
- `promo_share` = promo items / total items
- `substitution_rate` = items where a replacement was used
- `budget_hit` = final total ≤ requested budget (boolean)
- `tool_calls_per_session` (proves agentic behaviour)

---

## 4. Silpo MCP — hard facts the implementation must respect

Source: `https://ai-factory.silpo.ua/docs/mcp` (fetched 5 Sept 2026). Re-read it before starting; it may have been updated.

### 4.1 Endpoint & transport

- MCP endpoint: **`https://mcp.silpo.ua/mcp`**, Streamable HTTP transport.
- The tool catalog is **~40 tools**. Exact names, arguments and JSON Schemas are returned by the server after authorisation via `tools/list`. The docs say explicitly: *«Точні назви, аргументи та JSON Schema завжди повертає сам сервер після авторизації. Читай tools/list»*. **Never hard-code argument shapes without checking.**

### 4.2 Authentication — OAuth 2.1, Authorization Code + PKCE

- Metadata: `https://mcp.silpo.ua/.well-known/oauth-authorization-server`
- Dynamic Client Registration is supported: `POST /register` (RFC 7591).
- `/authorize` opens the Silpo login (`auth.silpo.ua`): phone + OTP, or password.
- After exchange we hold an **MCP token**; send it as `Authorization: Bearer <mcp_token>`. The client never sees the underlying Silpo JWT.
- `401 invalid_token` → refresh via the OAuth refresh flow. `403` → the tool is not permitted for this token. JSON-RPC `-32601` → tool not in this server version.
- Hackathon rule: tokens must be stored **server-side**, never in client/front-end code. Our Telegram bot is server-side, which satisfies this.
- **⚠ DISCOVER:** token lifetime, refresh-token issuance, and scopes are not documented. Read them from the metadata document and the token response at runtime; design the token store so that `expires_in` and `refresh_token` are optional.

### 4.3 Cart-context rule

Several tools (marked 🔒 in the docs, at least `silpo_find_products_batch` and `silpo_get_promotions`) require an **active cart context**: `branchId`, `deliveryType`, `timeslot`. The documented way to get them:

```
silpo_get_my_shopping_cart  →  (cartId or exists:false)
   └─ if none: silpo_create_shopping_cart (address / deliveryType / branchId / timeslot)
silpo_get_shopping_cart_by_id  →  full cart: items, delivery, timeslot, totals, validations, bonuses
silpo_get_time_slots           →  slots for the branch
```

Consequence for our design: **the very first thing the agent does after login is establish a cart context** (Phase 4), before any product search.

### 4.4 Tools we will use (grouped by when they are called)

| Phase in flow | Tool | Purpose | Writes? |
|---|---|---|---|
| Onboarding | `silpo_get_my_profile` | name, phone, email, birthdate | no |
| Onboarding | `silpo_get_my_family` | family members + pets with ages → portion sizing | no |
| Onboarding | `silpo_get_my_food_restrictions` | dietary restrictions → menu constraints | no |
| Onboarding | `silpo_get_my_delivery_addresses` | default address | no |
| Onboarding | `silpo_get_loyalty_info` | bonus balance to show at the end | no |
| Cart context | `silpo_get_my_shopping_cart` | existing cartId? | no |
| Cart context | `silpo_find_address` | text address → lat/lng (fallback if no saved address) | no |
| Cart context | `silpo_get_available_delivery_types` | delivery options for coordinates | no |
| Cart context | `silpo_list_branches` | choose branch (pickup / delivery) | no |
| Cart context | `silpo_get_time_slots` | first available slot | no |
| Cart context | `silpo_create_shopping_cart` | create cart with address/branch/slot (idempotent) | **yes** |
| Cart context | `silpo_get_shopping_cart_by_id` | read branchId/deliveryType/timeslot back | no |
| Resolve list | `silpo_find_products_batch` | up to 30 ingredient queries in parallel 🔒 | no |
| Resolve list | `silpo_get_products` | fallback single search with filters | no |
| Resolve list | `silpo_get_product_details` | stock, nutrition, price per unit | no |
| Resolve list | `silpo_get_promotions` | current promos 🔒 → prefer promo items | no |
| Resolve list | `silpo_get_replacements` | substitute out-of-stock items | no |
| Resolve list | `silpo_get_similar_products` | cheaper alternatives for budget squeeze | no |
| Build cart | `silpo_add_or_update_cart_products` | add items (needs productId + companyId + branchId) | **yes** |
| Build cart | `silpo_remove_cart_products` | remove on user edit | **yes** |
| Build cart | `silpo_update_shopping_cart` | set slot / promo code | **yes** |
| Finish | `silpo_get_shopping_cart_by_id` | totals, validations, `checkoutWebLink` / `checkoutMobileLink` | no |
| Finish | `silpo_get_my_coupons`, `silpo_get_promo_codes` | offer applicable coupon / code | no |
| Optional | `silpo_get_my_online_orders` | «повтори минуле замовлення» | no |

### 4.5 Rate limiting and errors

- HTTP 429 → per-user throttling; the docs mention a `Cookie: mcp-user={userId}` header used for throttling. Implement **exponential backoff with jitter** (base 500 ms, max 5 retries) in a single wrapper around every tool call.
- Cap the LLM at **≤ 25 tool calls per user turn** to avoid runaway loops.

### 4.6 Safety note about real data

There is **no sandbox**. The MCP acts on the developer's real Silpo account. Creating and filling a cart does **not** place an order — payment happens only via the external checkout link — so the demo is safe, but the implementer must never call any tool that could be interpreted as purchasing without explicit user confirmation, and must implement `/clear` (→ `silpo_clear_shopping_cart`) for cleanup.

---

## 5. Architecture

```
┌──────────────┐   long-polling / webhook   ┌──────────────────────────────┐
│  Telegram    │ ─────────────────────────▶ │  bot/  (grammY)              │
│  user        │ ◀───────────────────────── │  - commands, inline buttons  │
└──────────────┘                            │  - maps chatId → userId      │
                                            └──────────────┬───────────────┘
                                                           │
                                            ┌──────────────▼───────────────┐
                                            │  agent/  (Vercel AI SDK)     │
                                            │  - system prompt             │
                                            │  - runAgentTurn()            │
                                            │  - local tools (plan_menu,   │
                                            │    confirm, budget calc)     │
                                            │  - MCP tools (Silpo)         │
                                            └───────┬──────────────┬───────┘
                                                    │              │
                          ┌─────────────────────────▼──┐     ┌─────▼──────────────────────┐
                          │ mcp/  SilpoMcpClient         │     │ llm  Anthropic (claude-…)  │
                          │ - per-user Client+Transport  │     └────────────────────────────┘
                          │ - OAuthClientProvider impl   │
                          │ - retry/backoff, logging     │
                          └─────────────┬───────────────┘
                                        │ HTTPS  Bearer <mcp_token>
                          ┌─────────────▼───────────────┐
                          │  https://mcp.silpo.ua/mcp    │
                          └──────────────────────────────┘

┌──────────────────────────────┐        ┌──────────────────────────────┐
│ web/  (Fastify)              │        │ db/  Postgres (or SQLite)     │
│ GET /auth/start?state=…      │        │ users, oauth_tokens,          │
│ GET /auth/callback           │        │ sessions, plans, metrics      │
│ GET /healthz                 │        └──────────────────────────────┘
└──────────────────────────────┘
```

### 5.1 Components

- **bot/** — grammY bot. Owns Telegram-specific things only: commands (`/start`, `/plan`, `/cart`, `/clear`, `/logout`), inline keyboards, message formatting (HTML parse mode), typing indicator while the agent works. Delegates every "thinking" step to `agent/`.
- **agent/** — one function `runAgentTurn(userId, userMessage, sessionState) → {reply, sessionState}`. Uses Vercel AI SDK `generateText` with `tools = {...localTools, ...silpoMcpTools}` and multi-step execution. Holds the system prompt (§6.1) and the small set of **local tools** (§6.3).
- **mcp/** — `SilpoMcpClient`: creates one MCP `Client` + `StreamableHTTPClientTransport` per user, with an `OAuthClientProvider` backed by the DB. Exposes `listTools()`, `callTool(name, args)` with retry/backoff and structured logging (every call is logged with user id, tool, duration, status — this log is a hackathon deliverable).
- **web/** — tiny Fastify server for the OAuth redirect (`/auth/callback`) and health check. Must be reachable from the internet (ngrok / cloudflared in dev; Fly.io or Railway for the demo).
- **db/** — Drizzle ORM (or Knex, which Roman already knows) over Postgres. Tables in §5.3. SQLite via `better-sqlite3` is acceptable for the prototype; keep the schema the same.
- **llm** — Anthropic via `@ai-sdk/anthropic`. Use a Sonnet-class model for the agent loop (tool use quality matters more than speed); a Haiku-class model is fine for menu-text rewriting if cost is a concern.

### 5.2 Session state (kept in DB as JSON, one row per Telegram chat)

```ts
type SessionState = {
  stage: 'need_auth' | 'idle' | 'menu_proposed' | 'list_resolved' | 'cart_built';
  profile?: { name: string; familySize: number; hasPets: boolean; restrictions: string[] };
  cartContext?: { cartId: string; branchId: string; deliveryType: string; timeslot?: { start: string; end: string } };
  request?: { days: number; mealsPerDay: 'dinner' | 'all'; budgetUah?: number; extraConstraints: string[] };
  menu?: Array<{ day: number; dish: string; ingredients: Array<{ name: string; qty: string }> }>;
  resolvedItems?: Array<{
    ingredient: string; productId: string; companyId?: string; title: string;
    qty: number; unitPrice: number; isPromo: boolean; wasSubstituted: boolean; note?: string
  }>;
  totals?: { sum: number; budget?: number; promoShare: number; substitutionRate: number };
  metrics: { startedAt: string; toolCalls: number };
};
```

### 5.3 Database tables

```
users            (id pk, telegram_chat_id unique, silpo_profile_json, created_at)
oauth_clients    (id pk, client_id, client_secret_nullable, registration_json, created_at)  -- DCR result, one row
oauth_tokens     (user_id fk pk, access_token, refresh_token nullable, expires_at nullable, token_type, scope, updated_at)
oauth_pending    (state pk, user_id fk, code_verifier, created_at)  -- deleted after callback
sessions         (user_id fk pk, state_json, updated_at)
plans            (id pk, user_id fk, menu_json, resolved_json, totals_json, created_at)  -- history
tool_call_log    (id pk, user_id fk, tool, args_json, ok bool, ms int, error text, created_at)
```

### 5.4 Environment variables

```
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
PUBLIC_BASE_URL=https://<your-tunnel-or-host>      # used for OAuth redirect_uri
SILPO_MCP_URL=https://mcp.silpo.ua/mcp
DATABASE_URL=postgres://... | file:./data.sqlite
LOG_LEVEL=info
MAX_TOOL_CALLS_PER_TURN=25
```

---

## 6. Agent design

### 6.1 System prompt (Ukrainian; keep it in `agent/systemPrompt.ts`)

```
Ти — «Сільпо Шеф», агент для планування меню та збирання кошика в «Сільпо».
Ти НЕ вигадуєш товари, ціни чи наявність — усе береш з інструментів Сільпо (MCP).

Порядок роботи:
1. Якщо профіль ще не завантажено — виклич silpo_get_my_profile, silpo_get_my_family,
   silpo_get_my_food_restrictions, silpo_get_my_delivery_addresses. Врахуй обмеження харчування
   як ЖОРСТКІ правила (ніколи не пропонуй заборонені продукти).
2. Якщо немає контексту кошика — встанови його (ensure_cart_context) ПЕРЕД будь-яким пошуком товарів.
3. Склади меню під запит користувача (кількість днів, бюджет, побажання) — коротко, українською,
   на сім'ю потрібного розміру. Поклич propose_menu, щоб зберегти його, і ЗАЧЕКАЙ підтвердження.
4. Після підтвердження перетвори інгредієнти на список запитів (українською, узагальнено:
   «куряче філе», «рис», «морква») і виклич silpo_find_products_batch. Для кожного інгредієнта обирай
   1 товар: спочатку той, що в акції (silpo_get_promotions), потім найдешевший за одиницю, і лише
   в наявності. Якщо немає — silpo_get_replacements. Не додавай товари поза списком.
5. Збери кошик через silpo_add_or_update_cart_products (пакетно, не по одному, якщо схема дозволяє).
6. Прочитай кошик (silpo_get_shopping_cart_by_id), покажи підсумок, суму проти бюджету,
   кількість акційних позицій і посилання на оформлення. Запропонуй застосувати бонуси/купони,
   якщо є (silpo_get_loyalty_info, silpo_get_my_coupons).

Правила:
- Ніколи не оформлюй та не оплачуй замовлення. Твоя робота закінчується посиланням на checkout.
- Будь-яку зміну кошика роби лише після явного підтвердження користувача.
- Якщо інструмент повернув помилку — поясни коротко і запропонуй наступний крок; не повторюй
  один і той самий виклик більше 2 разів.
- Відповідай стисло. Використовуй HTML-форматування Telegram (<b>, <i>), без Markdown-таблиць.
```

### 6.2 Tool exposure strategy

Expose **all** Silpo MCP tools returned by `tools/list` to the model — hiding them lowers the "MCP utilization" score and the model handles 40 tools fine. But *route* the model with the system prompt above and with a few **local tools** that encapsulate multi-step recipes we do not want the LLM to improvise each time.

### 6.3 Local (non-MCP) tools

| Tool | Description | Implementation |
|---|---|---|
| `ensure_cart_context` | Guarantees `cartContext` exists. Runs the sequence from §4.3 deterministically in code: get cart → if none, pick default address → delivery types → branches → time slots → create cart → read back. Returns `{cartId, branchId, deliveryType, timeslot}`. | Pure TS calling `SilpoMcpClient` directly. Deterministic code is more reliable than letting the LLM chain 6 calls. |
| `propose_menu` | Args: `{days, dishes:[{day, dish, ingredients:[{name, qty}]}]}`. Persists to session, sets `stage='menu_proposed'`, tells bot to render confirm buttons. Returns `{ok:true}`. | Validation with Zod. |
| `record_resolution` | Args: the resolvedItems list (§5.2). Computes totals, promoShare, substitutionRate, budget check; persists; sets `stage='list_resolved'`. | Pure TS. |
| `finish_with_checkout` | Args: `{cartId}`. Reads cart via MCP, extracts `checkoutWebLink`/`checkoutMobileLink`, totals, validation messages; logs metrics; sets `stage='cart_built'`. | Wraps MCP call; formats reply. |

### 6.4 Selection heuristic for products (implement in `agent/selectProduct.ts`, and also describe it in the prompt)

For each ingredient with a candidate list:
1. Filter out products not in stock and products conflicting with restrictions (keyword match on title, e.g. «свинина», «лактоза»; the LLM double-checks).
2. Prefer candidates present in `silpo_get_promotions` result (or flagged as promo in the product payload — **⚠ DISCOVER** the exact field).
3. Among remaining, choose the lowest **price per base unit** (kg/l/pc) that still covers the required quantity; compute needed package count.
4. If the running total exceeds the budget by > 5 %, iterate over the most expensive 3 items and try `silpo_get_similar_products` for cheaper alternatives.
5. If nothing found → `silpo_get_replacements`; mark `wasSubstituted=true` and add a note.

### 6.5 Turn loop (pseudo)

```
runAgentTurn(userId, text):
  state = loadSession(userId)
  if no token → return "натисніть /start щоб під'єднати Сільпо"
  tools = localTools + mcpClient.toolsForAiSdk()
  result = generateText({
     model, system: SYSTEM_PROMPT + serialize(state),
     messages: last N messages (N=12) + user text,
     tools, stopWhen: stepCountIs(MAX_TOOL_CALLS_PER_TURN)   // AI SDK v5; use maxSteps in v4
  })
  persist updated state (local tools mutate it), log tool calls
  return result.text + UI hints (which inline keyboard to show, from state.stage)
```

---

## 7. Repository layout

```
silpo-meal-planner/
  package.json
  tsconfig.json
  .env.example
  docker-compose.yml           # postgres + app
  Dockerfile
  README.md                    # setup, demo script, architecture diagram
  src/
    index.ts                   # boots web server + bot
    config.ts                  # env parsing (zod)
    logger.ts                  # pino
    db/
      schema.ts                # drizzle schema (tables from §5.3)
      client.ts
      migrate.ts
    mcp/
      SilpoAuthProvider.ts     # implements OAuthClientProvider from @modelcontextprotocol/sdk
      SilpoMcpClient.ts        # per-user client, callTool with retry, tools → AI SDK adapter
      types.ts                 # hand-written TS types for the payloads we actually read
    web/
      server.ts                # fastify: /auth/start, /auth/callback, /healthz
    agent/
      systemPrompt.ts
      runAgentTurn.ts
      localTools.ts            # ensure_cart_context, propose_menu, record_resolution, finish_with_checkout
      cartContext.ts           # deterministic cart bootstrap (used by ensure_cart_context)
      selectProduct.ts         # heuristic from §6.4
      session.ts               # load/save SessionState
    bot/
      bot.ts                   # grammY setup, middleware (auth check, typing)
      commands.ts              # /start /plan /cart /clear /logout /help
      keyboards.ts              # inline keyboards per stage
      format.ts                # HTML formatting helpers (menu, item table, cart summary)
  scripts/
    mcp-spike.ts               # Phase 1: login + tools/list + one call, prints JSON
    dump-tools.ts              # saves tools/list schema to docs/tools.json
  docs/
    tools.json                 # snapshot of tools/list (for reference in README)
    demo-script.md
  test/
    selectProduct.test.ts
    cartContext.test.ts        # with a mocked SilpoMcpClient
```

---

## 8. Implementation plan — phases with acceptance criteria

Time budget assumes 5 Sept start and 14 Sept deadline. Keep **13–14 Sept** free for the video and submission.

### Phase 0 — Project skeleton (½ day)

1. `npm init -y`; install: `typescript tsx ai @ai-sdk/anthropic @ai-sdk/mcp @modelcontextprotocol/sdk grammy fastify zod pino drizzle-orm pg` (or `better-sqlite3`), dev: `@types/node vitest drizzle-kit`.
2. `tsconfig.json` with `"module": "NodeNext"`, `"target": "ES2022"`, `"strict": true`.
3. `config.ts` parses env with Zod; fail fast on missing vars.
4. `docker-compose.yml` with Postgres 16; `npm run migrate` creates tables from §5.3.
5. Create the Telegram bot via @BotFather; put the token in `.env`.

**Accept:** `npm run dev` starts, `/healthz` returns 200, bot answers `/start` with a placeholder.

### Phase 1 — MCP spike: prove we can log in and call a tool (1 day) — *highest risk, do first*

1. Implement `SilpoAuthProvider` (see §9.1) with an **in-memory** store for this spike.
2. Write `scripts/mcp-spike.ts`: create transport + client, call `client.connect()`. The SDK will discover `/.well-known/oauth-authorization-server`, perform Dynamic Client Registration (`POST /register`), and throw `UnauthorizedError` with the authorization URL → print it, open it, log in with phone+OTP, capture `code` on the redirect, call `transport.finishAuth(code)`, reconnect.
3. Call `client.listTools()` and save the full result to `docs/tools.json` (`scripts/dump-tools.ts`). **Read this file carefully** — it is the only authoritative source of argument names.
4. Call `silpo_get_my_profile` and `silpo_get_my_shopping_cart`; print the raw JSON.
5. Note in `docs/tools.json` header: token lifetime, whether a refresh token was issued, the scopes.

**Accept:** `tools.json` exists with ~40 tools; `silpo_get_my_profile` returns the developer's real name. If DCR fails or redirect URIs are restricted, stop and check docs / hackathon chat before continuing — everything else depends on this.

### Phase 2 — OAuth linking through Telegram (1 day)

1. `/start` → if no token for this chat: create `oauth_pending` row with a random `state` and fresh PKCE verifier; build the authorize URL via the SDK's auth helpers (or manually from the metadata) with `redirect_uri = PUBLIC_BASE_URL + '/auth/callback'`; send the user an inline button «🔐 Під'єднати Сільпо».
2. `GET /auth/callback?code&state` → look up pending row → exchange code (the SDK's `finishAuth` does this for you if you keep a transport instance per pending auth; otherwise call the token endpoint manually with the stored verifier) → save `oauth_tokens` → delete pending row → show an HTML page «Готово, повертайтесь у Telegram» → send a Telegram message to the chat with profile summary (calls `silpo_get_my_profile`, `silpo_get_my_family`, `silpo_get_my_food_restrictions`).
3. Persist the DCR client in `oauth_clients` so registration happens once, not per user.
4. `/logout` deletes tokens; `/start` again should re-link.
5. Handle `401 invalid_token`: attempt refresh once, otherwise mark session `need_auth` and prompt to re-link.

**Accept:** two different Telegram accounts can link independently; restarting the process keeps them linked; `401` after manual token deletion leads to a clean re-link prompt.

### Phase 3 — Agent loop with MCP tools (1 day)

1. `SilpoMcpClient.toolsForAiSdk()` — either use `@ai-sdk/mcp`'s `createMCPClient({ transport: { type: 'http', url, authProvider } })` and `await mcp.tools()` (simplest), or adapt the low-level client's `listTools()` schemas into AI SDK `tool({ inputSchema: jsonSchema(...) , execute })` objects. Prefer `@ai-sdk/mcp` unless it fights the auth provider.
2. Wrap every execute in retry/backoff (§4.5) and write a `tool_call_log` row.
3. Implement `runAgentTurn` (§6.5) with the system prompt; wire it to any non-command text in the bot; show `sendChatAction('typing')` every 4 s while running.
4. Local tool `propose_menu` + inline keyboard rendering.

**Accept:** in Telegram, «Хто я і що в мене за сім'я?» produces a correct answer sourced from tools; «Сплануй вечері на 2 дні» produces a menu and the ✅/✏️ buttons; the log shows the tool calls.

### Phase 4 — Deterministic cart context (1 day)

1. `cartContext.ts`: implement `ensureCartContext(userId)` per §4.3 — get cart; if missing, take the first saved delivery address (`silpo_get_my_delivery_addresses`), geocode if only text (`silpo_find_address`), `silpo_get_available_delivery_types`, choose delivery if available else pickup, `silpo_list_branches` (nearest), `silpo_get_time_slots` (first open), `silpo_create_shopping_cart`, then `silpo_get_shopping_cart_by_id` to read back `branchId/deliveryType/timeslot`.
2. If the user has no saved address: the local tool returns `{needsAddress:true}` and the agent asks for a text address, then geocodes it.
3. Expose as local tool `ensure_cart_context`; cache in session.
4. `/cart` command shows the current cart; `/clear` calls `silpo_clear_shopping_cart` after confirmation.

**Accept:** a fresh account gets a valid cart context in one call; `silpo_get_promotions` (🔒) succeeds afterwards.

### Phase 5 — Ingredient → product resolution and cart build (2 days) — *the core value*

1. After ✅ on the menu, the agent builds the ingredient query list (deduplicated, generic Ukrainian nouns, ≤ 30 per batch) and calls `silpo_find_products_batch`. **⚠ DISCOVER** the exact args (likely an array of `{query, limit}` plus cart context fields).
2. Fetch promotions once per session (`silpo_get_promotions`) and build a `Set<productId>`.
3. Run `selectProduct` (§6.4) per ingredient; for misses call `silpo_get_replacements`.
4. Call `record_resolution`; render the item table (HTML), totals vs budget, 🔥 / 🔄 badges, and buttons **🛒 Зібрати кошик / ✏️ Прибрати позицію / 💸 Дешевше**.
5. On 🛒: `silpo_add_or_update_cart_products` with all items (**⚠ DISCOVER** batch shape: products array of `{productId, companyId, quantity}` + `branchId`). Then `finish_with_checkout`.
6. «💸 Дешевше» → budget squeeze loop (§6.4 step 4) then re-render.
7. «✏️ Прибрати позицію» → ask which, `silpo_remove_cart_products` if already in cart, else drop from resolvedItems.

**Accept:** the core scenario (§3.1) completes end-to-end; the cart is visible in the Silpo app with the same items; the reply contains a working checkout link; metrics logged.

### Phase 6 — Loyalty, polish, robustness (1 day)

1. At finish: `silpo_get_loyalty_info` (bonus balance), `silpo_get_my_coupons` / `silpo_get_promo_codes`; if a promo code applies, offer a button that calls `silpo_update_shopping_cart` with it.
2. Save each completed plan to `plans` and implement «Повтори минулий план».
3. Error UX: every tool failure → short Ukrainian message + suggested action; never a stack trace.
4. Guardrails: cap tool calls per turn; 60 s timeout per turn; dedupe identical consecutive tool calls.
5. Unit tests: `selectProduct` (promo preference, unit price, budget squeeze), `cartContext` with a mocked client.
6. README with architecture diagram, setup, and the tools used table (§4.4) — judges read this.

**Accept:** tests green; three consecutive full runs on a clean account succeed without manual intervention.

### Phase 7 — Demo, validation, submission (1–1.5 days, 13–14 Sept)

1. Deploy (Fly.io / Railway / a VPS) so the OAuth callback URL is stable; verify a cold start.
2. Record the video (≤ 3 min): problem → live Telegram flow → cart appears in Silpo app → show `tool_call_log` / JSON-RPC log to prove MCP usage → metrics slide → scaling plan (in-app integration, family sharing, weekly auto-plan). Upload to YouTube (unlisted is fine).
3. Prepare a short pitch deck (5–7 slides) matching the six criteria.
4. Submit: video link, repo link (public or with judge access), README with demo script, and a JSON-RPC log excerpt.

**Accept:** the submission form is confirmed before 14 Sept 23:59 Kyiv.

---

## 9. Code sketches (adapt to installed versions)

### 9.1 `SilpoAuthProvider` — `OAuthClientProvider` backed by the DB

```ts
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformation, OAuthTokens, OAuthClientMetadata }
  from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from '../db/client.js';

export class SilpoAuthProvider implements OAuthClientProvider {
  constructor(private userId: string, private onRedirect: (url: URL) => Promise<void>) {}

  get redirectUrl() { return `${process.env.PUBLIC_BASE_URL}/auth/callback`; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'silpo-meal-planner',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',   // public client + PKCE; change if /register returns a secret
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return db.getOauthClient();                       // one shared DCR registration
  }
  async saveClientInformation(info: OAuthClientInformation) { await db.saveOauthClient(info); }

  async tokens(): Promise<OAuthTokens | undefined> { return db.getTokens(this.userId); }
  async saveTokens(t: OAuthTokens) { await db.saveTokens(this.userId, t); }

  async redirectToAuthorization(url: URL) { await this.onRedirect(url); } // bot sends the link

  async saveCodeVerifier(v: string) { await db.savePending(this.userId, v); }
  async codeVerifier() { return (await db.getPending(this.userId)).code_verifier; }
}
```

The `state` parameter: the SDK lets you pass `state` when starting auth (check the installed version's `auth()` / transport options). Encode the userId (or a random id mapped to it) so `/auth/callback` knows which user to complete.

### 9.2 `SilpoMcpClient`

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export class SilpoMcpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  constructor(private userId: string, private auth: SilpoAuthProvider) {}

  async connect() {
    this.transport = new StreamableHTTPClientTransport(new URL(process.env.SILPO_MCP_URL!), { authProvider: this.auth });
    this.client = new Client({ name: 'silpo-meal-planner', version: '0.1.0' }, { capabilities: {} });
    try { await this.client.connect(this.transport); }
    catch (e) { if (e instanceof UnauthorizedError) throw new NeedsAuthError(); throw e; }
  }

  async finishAuth(code: string) { await this.transport!.finishAuth(code); }

  async listTools() { return (await this.client!.listTools()).tools; }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    return withRetry(async () => {
      const t0 = Date.now();
      const res = await this.client!.callTool({ name, arguments: args });
      await db.logToolCall({ userId: this.userId, tool: name, args, ok: !res.isError, ms: Date.now() - t0 });
      if (res.isError) throw new ToolError(name, res.content);
      return parseContent<T>(res.content);          // content[0].text is usually JSON
    }, { retries: 5, baseMs: 500, retryOn: (e) => e.status === 429 || e.code === 'ECONNRESET' });
  }
}
```

### 9.3 Exposing MCP tools to the AI SDK

Option A (preferred): `@ai-sdk/mcp`

```ts
import { createMCPClient } from '@ai-sdk/mcp';
const mcp = await createMCPClient({
  transport: { type: 'http', url: process.env.SILPO_MCP_URL!, authProvider: new SilpoAuthProvider(userId, onRedirect) },
});
const silpoTools = await mcp.tools();   // Record<string, Tool>
```

Option B: adapt manually from `listTools()`:

```ts
import { tool, jsonSchema } from 'ai';
const silpoTools = Object.fromEntries(list.map(t => [t.name, tool({
  description: t.description ?? t.name,
  inputSchema: jsonSchema(t.inputSchema as any),
  execute: (args) => mcpClient.callTool(t.name, args as Record<string, unknown>),
})]));
```

### 9.4 Agent turn

```ts
import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export async function runAgentTurn(userId: string, text: string) {
  const state = await loadSession(userId);
  const tools = { ...localTools(userId, state), ...(await silpoToolsFor(userId)) };
  const result = await generateText({
    model: anthropic(process.env.AGENT_MODEL ?? 'claude-sonnet-4-5'),  // any current Sonnet-class id
    system: SYSTEM_PROMPT + '\n\n<session_state>' + JSON.stringify(publicState(state)) + '</session_state>',
    messages: [...(await recentMessages(userId, 12)), { role: 'user', content: text }],
    tools,
    stopWhen: stepCountIs(Number(process.env.MAX_TOOL_CALLS_PER_TURN ?? 25)),   // v4: maxSteps
  });
  await saveSession(userId, state);               // local tools mutate `state`
  await appendMessages(userId, text, result.text);
  return { text: result.text, stage: state.stage };
}
```

### 9.5 Deterministic cart bootstrap (`cartContext.ts`) — shape only, args come from `tools.json`

```ts
export async function ensureCartContext(mcp: SilpoMcpClient, state: SessionState) {
  if (state.cartContext) return state.cartContext;
  const existing = await mcp.callTool<{ cartId?: string; exists?: boolean }>('silpo_get_my_shopping_cart', {});
  let cartId = existing.cartId;
  if (!cartId) {
    const addresses = await mcp.callTool<any[]>('silpo_get_my_delivery_addresses', {});
    const addr = addresses[0]; if (!addr) return { needsAddress: true };
    const types = await mcp.callTool<any>('silpo_get_available_delivery_types', { latitude: addr.latitude, longitude: addr.longitude });
    const deliveryType = pickDeliveryType(types);
    const branches = await mcp.callTool<any>('silpo_list_branches', { latitude: addr.latitude, longitude: addr.longitude, deliveryType });
    const branchId = branches[0].id;
    const slots = await mcp.callTool<any>('silpo_get_time_slots', { branchId, deliveryType });
    const timeslot = slots[0];
    const created = await mcp.callTool<{ shoppingCartId: string }>('silpo_create_shopping_cart',
      { addressType: 'saved', ...addr, deliveryType, branchId, timeslot });
    cartId = created.shoppingCartId;
  }
  const cart = await mcp.callTool<any>('silpo_get_shopping_cart_by_id', { shoppingCartId: cartId });
  state.cartContext = { cartId, branchId: cart.branchId, deliveryType: cart.deliveryType, timeslot: cart.timeslot };
  return state.cartContext;
}
```

### 9.6 Telegram formatting example

```
🍽 <b>Меню на 3 дні</b> (сім'я з 4)
<b>День 1</b> — Курка з рисом і овочами
<b>День 2</b> — Паста з томатним соусом
<b>День 3</b> — Рибні котлети з пюре
[✅ Так, збираємо список]  [✏️ Змінити]

🧾 <b>Список: 18 позицій — 1 134 грн</b> (бюджет 1 200 ✅)
🔥 7 акційних · 🔄 2 заміни
• Філе куряче 1 кг — 189 грн 🔥
• Рис довгозернистий 1 кг — 62 грн
…
[🛒 Зібрати кошик]  [💸 Дешевше]  [✏️ Прибрати позицію]
```

---

## 10. Testing and validation

- **Unit:** `selectProduct` (promo wins over price; unit-price normalisation; budget squeeze reduces total; restriction keywords filter), `ensureCartContext` with a mocked `SilpoMcpClient` (both "cart exists" and "no cart" branches), Zod validation of `propose_menu` args.
- **Integration (manual, real account):** the three scenarios in §3.1–3.2, run on a *clean* cart (`/clear` first). Record each run's `tool_call_log` count and `time_to_cart_seconds`.
- **Prompt regression:** keep 5 example user requests in `docs/eval-prompts.md` and check that each produces a menu that honours restrictions and budget.
- **Validation story for judges:** run the flow with 3–5 real people (family/friends), collect: did the menu fit, how many items they would remove, time saved vs. manual ordering. Put the numbers on the final slide.

---

## 11. Risks and fallbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| DCR / redirect URI restrictions block a server-side OAuth flow | medium | Phase 1 first. Fallback: complete OAuth once on the developer machine with the SDK, store the tokens in DB, and have the bot use them for the demo account (documented honestly as "single-account prototype"). |
| Tool argument shapes differ from assumptions | high | `tools.json` is the source of truth; all MCP calls go through one client with typed wrappers written *after* reading it. |
| `silpo_find_products_batch` returns noisy matches («курка» → snacks) | medium | Use specific generic nouns, `limit` 5, let `selectProduct` filter by category/unit; fallback to `silpo_get_products` with category filter. |
| 429 rate limits during batch resolution | medium | Backoff wrapper; batch instead of per-item calls; cache promotions and category tree per session. |
| LLM hallucinates products/prices | medium | System prompt forbids it; the reply is rendered from `resolvedItems` (tool data), not from free text. |
| Token expiry mid-demo | low | Refresh on 401; re-link prompt; pre-warm before recording. |
| Not registered before 31 Aug | ? | Confirm registration status. Even if not eligible, the project is a strong portfolio piece; adapt the README to "built on the official Silpo MCP". |

---

## 12. Submission checklist (14 Sept)

- [ ] Deployed bot with stable `PUBLIC_BASE_URL`; cold-start verified
- [ ] Public repo: README (setup, architecture, tools table, demo script), `docs/tools.json`, tests passing
- [ ] Video pitch ≤ 3 min on YouTube: problem → live flow → cart in Silpo app → MCP log → metrics → scaling
- [ ] JSON-RPC / `tool_call_log` excerpt attached
- [ ] Slides (5–7) aligned to the six criteria
- [ ] Tokens are stored server-side only (no secrets in repo; `.env.example` present)
- [ ] Form submitted before 23:59:59 Kyiv; confirmation saved

---

## Appendix A — Quick reference

- Hackathon page: https://ai-factory.silpo.ua/ (section `#mcp`)
- MCP docs: https://ai-factory.silpo.ua/docs/mcp
- MCP endpoint: `https://mcp.silpo.ua/mcp` · OAuth metadata: `https://mcp.silpo.ua/.well-known/oauth-authorization-server`
- Claude Code quick test: `claude mcp add --transport http silpo https://mcp.silpo.ua/mcp` (useful to explore tools interactively before writing code)
- Libraries: `@modelcontextprotocol/sdk`, `ai`, `@ai-sdk/anthropic`, `@ai-sdk/mcp`, `grammy`, `fastify`, `zod`, `drizzle-orm`, `pino`, `vitest`

## Appendix B — Suggested day-by-day schedule

| Date | Work |
|---|---|
| Sat 5 Sept | Phase 0 + start Phase 1 (spike) |
| Sun 6 | Finish Phase 1; dump `tools.json`; read all schemas |
| Mon 7 | Phase 2 (OAuth via Telegram) |
| Tue 8 | Phase 3 (agent loop + menu) |
| Wed 9 | Phase 4 (cart context) |
| Thu 10 – Fri 11 | Phase 5 (resolution + cart build) |
| Sat 12 | Phase 6 (loyalty, tests, README) |
| Sun 13 | Deploy, dry-run demo, record video, slides |
| Mon 14 | Buffer + submit early in the day |
