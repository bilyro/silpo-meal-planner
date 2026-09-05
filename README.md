# Сільпо Шеф — Silpo Meal Planner Agent

A Telegram bot that acts as an *agent*, not a chatbot: it reads a Silpo customer's profile
(family, pets, food restrictions, saved addresses) through the official Silpo MCP, proposes a
meal plan, resolves it to real products in the Silpo catalog, prefers promo items, builds a real
shopping cart tied to a delivery slot, and hands back a checkout link.

Built for the «Сільпо» AI Factory hackathon. Full design and phased build plan:
see the original spec (`silpo-meal-planner-agent-spec.md`) this repo implements.

## Status

Currently **Phase 0 — project skeleton**. See `docs/` and the phase list below.

- [x] Phase 0 — project skeleton (this commit)
- [ ] Phase 1 — MCP spike (login + `tools/list`)
- [ ] Phase 2 — OAuth linking through Telegram
- [ ] Phase 3 — Agent loop with MCP tools
- [ ] Phase 4 — Deterministic cart context
- [ ] Phase 5 — Ingredient → product resolution and cart build
- [ ] Phase 6 — Loyalty, polish, robustness
- [ ] Phase 7 — Demo, validation, submission

## Architecture

```
Telegram ⇄ bot/ (grammY) ⇄ agent/ (Vercel AI SDK, tool-calling loop) ⇄ mcp/ (SilpoMcpClient) ⇄ https://mcp.silpo.ua/mcp
                                          │
                                       db/ (Postgres via Drizzle)
web/ (Fastify) exposes /auth/start, /auth/callback (OAuth redirect), /healthz
```

## Setup

Prerequisites: Node.js 20+, Docker.

```bash
npm install
cp .env.example .env        # fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PUBLIC_BASE_URL
docker compose up -d postgres
npm run migrate
npm run dev
```

`npm run dev` starts the Fastify web server (health check at `GET /healthz`) and the Telegram
bot via long polling in the same process.

### Environment variables

See `.env.example`. Notably:

- `TELEGRAM_BOT_TOKEN` — from @BotFather.
- `ANTHROPIC_API_KEY` — for the agent loop (Claude, via `@ai-sdk/anthropic`).
- `PUBLIC_BASE_URL` — must be a stable, internet-reachable URL for the OAuth redirect
  (`<PUBLIC_BASE_URL>/auth/callback`); use `ngrok`/`cloudflared` in local dev.
- `SILPO_MCP_URL` — defaults to `https://mcp.silpo.ua/mcp`.
- `DATABASE_URL` — Postgres connection string.

### Database

Schema lives in `src/db/schema.ts` (Drizzle ORM). Migrations are generated with
`npx drizzle-kit generate` and applied with `npm run migrate`.

## Testing

```bash
npm test
```

## Tools used (Silpo MCP)

Filled in as each phase lands — see spec §4.4 for the full table this project implements
against (Profile, Cart context, Resolve list, Build cart, Finish categories).

## Repository layout

```
src/
  index.ts        boots the web server + bot
  config.ts        env parsing (zod)
  logger.ts        pino
  db/              drizzle schema, client, migrations
  mcp/             SilpoMcpClient, OAuth provider (Phase 1+)
  web/             Fastify: /auth/start, /auth/callback, /healthz
  agent/           runAgentTurn, system prompt, local tools (Phase 3+)
  bot/             grammY bot, commands, keyboards, formatting
scripts/           one-off spikes (mcp-spike.ts, dump-tools.ts) — Phase 1+
docs/              tools.json snapshot, demo script
test/              unit tests
```
