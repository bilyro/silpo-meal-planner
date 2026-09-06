# Сільпо Шеф — Silpo Meal Planner Agent

A Telegram bot that acts as an *agent*, not a chatbot: it reads a Silpo customer's profile
(family, pets, food restrictions, saved addresses) through the official Silpo MCP, proposes a
meal plan, resolves it to real products in the Silpo catalog, prefers promo items, builds a real
shopping cart tied to a delivery slot, and hands back a checkout link.

Built for the «Сільпо» AI Factory hackathon. Full design and phased build plan:
see the original spec (`silpo-meal-planner-agent-spec.md`) this repo implements.

## Status

Currently **Phase 3 — code complete, live verification pending**. See `docs/` and the phase list below.

- [x] Phase 0 — project skeleton
- [x] Phase 1 — MCP spike (login + `tools/list`) — see `docs/tools.json` (40 tools, real account)
- [x] Phase 2 — OAuth linking through Telegram — code complete; live end-to-end confirmation
      blocked on a Silpo-side issue, see "Known issues" below. Retry with a fast single attempt;
      see git log for `feat: Phase 2 OAuth linking` for implementation details.
- [x] Phase 3 — Agent loop with MCP tools — code complete (all ~40 tools exposed to the model,
      retry/backoff + tool_call_log, system prompt, session state, `propose_menu`); live
      verification of the acceptance scenarios in Telegram is blocked on the same Phase 2 login
      issue (need a linked account to exercise the tool-calling loop for real).
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

## Known issues

**Silpo's OAuth login intermittently fails with "Invalid or expired state" before ever
redirecting back to our `/auth/callback`** (observed ~1-in-8 attempts succeeding in Phase 2
testing on 6 Sept 2026). Root cause, confirmed by direct HTTP probing (not our code):
`mcp.silpo.ua/authorize` is a broker in front of the real IdP, not the IdP itself. It ignores
our request's `client_id`/`code_challenge`/`state` and redirects to `auth.silpo.ua` using
*Silpo's own* internal client id and a freshly generated internal state UUID. After login,
`auth.silpo.ua` redirects back to `mcp.silpo.ua/callback?code=...&state=<their-uuid>`, which
looks up that UUID server-side to reconstruct the original request — and this lookup expires
quickly enough that a normal phone+OTP login (SMS delivery + typing) often outlasts it:

```
curl "https://mcp.silpo.ua/callback?code=test123&state=00000000-0000-0000-0000-000000000000"
→ Invalid or expired state
```

That's the exact error text users see, reproduced with a dummy UUID — proof it's Silpo's broker
rejecting its own expired internal state, unrelated to anything this project sends. Nothing in
`SilpoAuthProvider`/`SilpoMcpClient` can influence this (also ruled out: our OAuth `state` param,
reusing one DCR client vs. registering fresh each time, and cookies — only one `set-cookie` was
present, `__cf_bm`, Cloudflare bot-management, not an app session).

**Workaround:** have the OTP ready to enter the instant you tap the Telegram link; retry on
failure. **Worth reporting** to `mcp@silpo.club` (contact given in the MCP docs) since it likely
affects every hackathon participant equally.

## Tools used (Silpo MCP)

The live server exposes 40 tools as of the Phase 1 spike (`docs/tools.json`, generated via
`npm run spike`) — confirms every tool spec §4.4 lists as needed, plus a few not yet used
(Nova Poshta lookup, favorites, certificates, category browsing). See spec §4.4 for the
per-phase table of which tool is called when and why.

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
