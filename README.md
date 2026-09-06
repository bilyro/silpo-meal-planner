# Сільпо Шеф — Silpo Meal Planner Agent

A Telegram bot that acts as an *agent*, not a chatbot: it reads a Silpo customer's profile
(family, pets, food restrictions, saved addresses) through the official Silpo MCP, proposes a
meal plan, resolves it to real products in the Silpo catalog, prefers promo items, builds a real
shopping cart tied to a delivery slot, and hands back a checkout link.

Built for the «Сільпо» AI Factory hackathon. Full design and phased build plan:
see the original spec (`silpo-meal-planner-agent-spec.md`) this repo implements.

## Status

Currently **Phase 4 — code complete, live verification pending**. See `docs/` and the phase list below.

- [x] Phase 0 — project skeleton
- [x] Phase 1 — MCP spike (login + `tools/list`) — see `docs/tools.json` (40 tools, real account)
- [x] Phase 2 — OAuth linking through Telegram — code complete; live end-to-end confirmation
      blocked on a Silpo-side issue, see "Known issues" below. Retry with a fast single attempt;
      see git log for `feat: Phase 2 OAuth linking` for implementation details.
- [x] Phase 3 — Agent loop with MCP tools — code complete (all ~40 tools exposed to the model,
      retry/backoff + tool_call_log, system prompt, session state, `propose_menu`); live
      verification of the acceptance scenarios in Telegram is blocked on the same Phase 2 login
      issue (need a linked account to exercise the tool-calling loop for real).
- [x] Phase 4 — Deterministic cart context — `ensure_cart_context` local tool, `/cart` and
      `/clear` commands (with confirmation) all code-complete and unit-tested against a mocked
      MCP client (`test/cartContext.test.ts`, 6/6 passing). One real gap: `silpo_get_shopping_cart_by_id`'s
      `cart` field has no documented shape at all, so the "pre-existing cart" branch extracts
      fields defensively and needs correcting against real data once a live account is available
      — see the code comment in `src/agent/cartContext.ts`.
- [ ] Phase 5 — Ingredient → product resolution and cart build
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

**Silpo login fails with `400 Invalid or expired state` (observed ~7 of 8 attempts, 6 Sept 2026).**

`mcp.silpo.ua/authorize` is a broker in front of the real IdP. It discards our `client_id`,
`code_challenge` and `state`, and redirects to `auth.silpo.ua` using *Silpo's own* internal client
id, its own `redirect_uri=https://mcp.silpo.ua/callback`, and a freshly minted internal state UUID.
After login, `auth.silpo.ua` returns to `mcp.silpo.ua/callback?code=…&state=<their-uuid>`, and the
broker looks that UUID up to reconstruct our original request and redirect onward to *our*
`redirect_uri`.

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
expired. Ruled out by experiment: no TTL (states survived 600s warm and 240s of total silence;
20/20 immediate mint→redeem round-trips succeeded), DCR client staleness (a stale and a fresh
client behave identically; `/authorize` validates `client_id` and ours passes), and `scope`.

> ⚠️ An earlier revision of this section claimed the opposite — that the broker had a short state
> TTL and nothing was fixable on our side. That was **wrong**, and worth recording as a
> methodological warning: it compared a garbage UUID against a state captured from an
> *already-completed* login. That state had already been consumed, so both returned `400` for
> *different* reasons and the match looked like proof. Always compare against a **freshly minted,
> unconsumed** state — the `502`-vs-`400` split is the only real discriminator.

**Most likely remaining cause — our config, not Silpo's:** `.env` ships
`PUBLIC_BASE_URL=http://localhost:3000`, and the Telegram link is an inline URL button, which on a
phone opens Telegram's in-app WebView. The first `/callback` hit succeeds and 302's the browser to
`http://localhost:3000/auth/callback` — dead on a phone — so the user reloads or hands off to the
system browser, re-requesting the `mcp.silpo.ua` URL whose state is now spent → `400`. The ~1-in-8
successes fit desktop attempts, where `localhost:3000` genuinely resolves.

**Fix:** point `PUBLIC_BASE_URL` at an internet-reachable HTTPS origin (`cloudflared tunnel --url
http://localhost:3000`, ngrok, or a deployed host) as the spec always required, then **re-register
the DCR client** — a registration bakes in its `redirect_uris`, so the localhost-registered client
must be discarded or `/authorize` will reject the new redirect_uri:

```sql
DELETE FROM oauth_clients; DELETE FROM oauth_pending;
```

`saveOauthClient` now replaces rather than accumulates, and `getOauthClient` returns the newest, so
re-registration happens automatically once `PUBLIC_BASE_URL` changes.

**Zero-OTP way to confirm:** on the desktop running the server, open the `/authorize` URL in a
browser already signed in to `auth.silpo.ua` (no SMS needed — Duende SSO session), with DevTools →
Network → *Preserve log*. If `mcp.silpo.ua/callback` appears once and 302's to localhost, the
theory holds and the tunnel fixes it. If it appears once and 400's, the theory is wrong and it is
genuinely Silpo's bug — report to `mcp@silpo.club`.

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
