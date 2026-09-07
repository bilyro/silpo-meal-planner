# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot («Сільпо Шеф») that acts as an agent, not a chatbot: it reads a Silpo grocery
customer's profile (family, pets, food restrictions, saved addresses) through the official Silpo
MCP server, proposes a meal plan, resolves ingredients to real catalog products (preferring promo
items), builds a real shopping cart tied to a delivery slot, and hands back a Silpo checkout link.
Built for the «Сільпо» AI Factory hackathon (deadline 14 Sept 2026).

**The full implementation spec lives at `docs/silpo-meal-planner-agent-spec.md`.** It is the
source of truth for scope, phased build order, database schema, agent system prompt, and code
sketches — read it before making architectural changes. This repo is being built by executing
that spec's phases in order (Phase 0 → 7); each phase has explicit acceptance criteria in §8 that
must pass before the next phase starts. Current status is tracked in `README.md`.

## Commands

```bash
npm install                 # install deps
cp .env.example .env        # then fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PUBLIC_BASE_URL
docker compose up -d postgres
npm run migrate             # applies drizzle/ SQL migrations
npm run dev                 # tsx watch src/index.ts — boots web server + bot together
npm run build                # tsc -> dist/
npm start                    # node dist/index.js (after build)
npm test                     # vitest run
npm run export-log           # tool_call_log -> docs/tool-call-log.md (submission deliverable)
npx drizzle-kit generate     # regenerate SQL migration after editing src/db/schema.ts
```

`src/index.ts` calls `runMigrations()` on boot before binding the port, so `npm run dev` /
`npm start` migrate by themselves and the standalone `npm run migrate` is only for migrating without
starting anything. This assumes **one instance** — two containers booting against an empty database
would race; see `docs/deploy.md`.

Run a single test file: `npx vitest run test/selectProduct.test.ts`.

**Postgres port**: the container maps to **host port 5433**, not 5432 — this machine already runs
a native Postgres on 5432, and Docker's port publish silently loses that conflict on macOS
(connections to `localhost:5432` reach the native instance, not the container, with no error other
than "role does not exist"). `DATABASE_URL` in `.env.example` already uses 5433; don't change it
back without checking for the same conflict.

## Architecture

```
Telegram ⇄ bot/ (grammY)  ⇄  agent/ (Vercel AI SDK tool-calling loop)  ⇄  mcp/ (SilpoMcpClient)  ⇄  https://mcp.silpo.ua/mcp
                                          │
                                       db/ (Postgres via Drizzle)
web/ (Fastify) exposes /auth/callback (OAuth redirect), /healthz
```

- **`src/bot/`** — grammY only. Commands, inline keyboards, HTML message formatting, typing
  indicators. Delegates free-text "thinking" to `agent/runAgentTurn`, but drives the ✅ / 🛒
  button paths **deterministically** in code rather than through the model. `💸 Дешевше` and
  `✏️ Прибрати позицію` are still stubs that route the user to free text.
- **`src/agent/`** — `runAgentTurn(userId, text)`, the Ukrainian system prompt, and the **local
  (non-MCP) tools** that encode multi-step recipes deterministically instead of letting the LLM
  improvise them: `ensure_cart_context`, `propose_menu`, `record_resolution`,
  `finish_with_checkout`, `repeat_last_plan`. Also `selectProduct` / `resolveIngredients`
  (ingredient → product), `cartContext`, `loyalty`, `plans`. See spec §6.
- **`src/mcp/`** (Phase 1+) — `SilpoMcpClient`: one MCP `Client` + `StreamableHTTPClientTransport`
  per user, OAuth (Authorization Code + PKCE) via a DB-backed `OAuthClientProvider`, retry/backoff
  wrapper around every tool call, and structured logging to `tool_call_log` (every call logged
  with user id, tool, duration, status — this log is a submission deliverable). The Silpo MCP
  returns ~40 tools; **never hard-code argument shapes** — they must be read at runtime from
  `tools/list` (dumped to `docs/tools.json` once Phase 1 lands) since the docs explicitly say the
  server is the only source of truth for schemas.
- **`src/web/`** — Fastify. `/healthz` (liveness — deliberately touches nothing else, so a database
  blip can't trigger a restart loop that also kills `/auth/callback`), `/readyz` (runs `select 1`,
  503 when Postgres is unreachable), and `/auth/callback` (the OAuth redirect target, must be
  reachable from the internet — ngrok/cloudflared in dev). There is no `/auth/start`: `/start` hands
  the authorize URL straight to the user as an inline button.
- **`src/db/`** — Drizzle ORM over Postgres. `schema.ts` defines the 8 tables (`users`,
  `oauth_clients`, `oauth_tokens`, `oauth_pending`, `sessions`, `messages`, `plans`,
  `tool_call_log`); generate
  migrations with `drizzle-kit generate` (writes to `drizzle/`), apply with `npm run migrate`
  (`src/db/migrate.ts`, using `drizzle-orm/node-postgres/migrator`).
- **`src/config.ts`** — zod-validated env parsing; loads `.env` via `process.loadEnvFile()` (not
  dotenv) and fails fast (exits 1) on missing/invalid vars.

### Deployment

`Dockerfile` (multi-stage) + `fly.toml`; runbook in `docs/deploy.md`. Two things there are easy to
break and expensive to notice:

- **`.dockerignore` must keep `.env` out.** The build stage does `COPY . .`, and image layers are
  additive — a secret copied in one layer stays readable even if a later layer deletes it.
- **Changing `PUBLIC_BASE_URL` requires clearing `oauth_clients`.** A Dynamic Client Registration
  bakes its `redirect_uris` in, so the client registered against the old origin makes
  `mcp.silpo.ua/authorize` reject the new redirect_uri.

### Hard constraints from the Silpo MCP (spec §4 — read before touching `mcp/` or `agent/`)

- Several tools (`silpo_find_products_batch`, `silpo_get_promotions`, marked 🔒 in the Silpo docs)
  require an **active cart context** (`branchId`, `deliveryType`, `timeslot`) to already exist.
  Consequence: the agent must call `ensure_cart_context` before any product search, every time.
- Tokens are OAuth 2.1 (Authorization Code + PKCE) via Dynamic Client Registration; store
  server-side only (this bot is server-side, satisfying the hackathon rule). Handle `401` by
  refreshing once, then falling back to a re-link prompt.
- Cap tool calls at `MAX_TOOL_CALLS_PER_TURN` (env, default 25) per agent turn to prevent runaway
  loops; back off with jitter on HTTP 429 (base 500 ms, max 5 retries).
- There is **no sandbox** — the MCP acts on a real Silpo account. Building a cart is safe (no
  order is placed until the user pays via the external `checkoutWebLink`), but never call anything
  that could be read as purchasing without explicit user confirmation, and keep `/clear` wired to
  `silpo_clear_shopping_cart`.
- The LLM must never invent products, prices, or availability — replies are rendered from tool
  output (`resolvedItems` in session state), not from free-text generation.

### Session state

Kept as one JSON row per Telegram chat in `sessions.state_json`. Shape is defined in spec §5.2
(`SessionState`: `stage`, `profile`, `cartContext`, `request`, `menu`, `resolvedItems`, `totals`,
`metrics`). `stage` drives which inline keyboard the bot renders next.

### Dependency version note

`ai` is on major v7 while `@ai-sdk/anthropic` is still on v4.x — this looks mismatched but isn't:
both pin the same `@ai-sdk/provider` (4.0.10) and `@ai-sdk/provider-utils` (5.0.36), which is what
actually has to line up. Don't "fix" this by forcing version alignment.
