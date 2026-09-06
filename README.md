# Сільпо Шеф — Silpo Meal Planner Agent

A Telegram bot that acts as an *agent*, not a chatbot: it reads a Silpo customer's profile
(family, pets, food restrictions, saved addresses) through the official Silpo MCP, proposes a
meal plan, resolves it to real products in the Silpo catalog, prefers promo items, builds a real
shopping cart tied to a delivery slot, and hands back a checkout link.

Built for the «Сільпо» AI Factory hackathon. Full design and phased build plan:
see the original spec (`silpo-meal-planner-agent-spec.md`) this repo implements.

## Status

Phases 0–4 complete and **verified live against a real Silpo account** (6 Sept 2026).

- [x] Phase 0 — project skeleton
- [x] Phase 1 — MCP spike (login + `tools/list`) — see `docs/tools.json` (40 tools, real account)
- [x] Phase 2 — OAuth linking through Telegram — **verified live**: tokens stored, valid 30 days.
      Getting there required fixing our own `PUBLIC_BASE_URL`/redirect handling; see "Known issues"
      for the diagnosis and the tunnel requirement before any non-desktop use.
- [x] Phase 3 — Agent loop with MCP tools — **verified live**: «Хто я і що в мене за сім'я?»
      returns real profile/family/restrictions sourced from tools, and «Сплануй вечері на 2 дні»
      calls `propose_menu` and reaches `stage=menu_proposed` with a full menu in session state.
      All ~40 tools exposed, retry/backoff + `tool_call_log` on every call.
- [x] Phase 4 — Deterministic cart context — **verified live**: `ensureCartContext` created a real
      cart (branch + `DeliveryHome` + same-day slot) from a text address, and the 🔒 cart-gated
      tools `silpo_get_promotions` and `silpo_find_products_batch` both succeed afterwards — the
      spec's actual acceptance test. `/cart` and `/clear` (with confirmation) implemented;
      6/6 unit tests against a mocked client.
      Still unverified: the *pre-existing cart* branch, since `silpo_get_shopping_cart_by_id`'s
      `cart` field has no documented shape — see the ⚠ DISCOVER comment in `src/agent/cartContext.ts`.
- [ ] Phase 5 — Ingredient → product resolution and cart build — **read `docs/phase5-findings.md`
      first**: live probing showed two spec assumptions are wrong (`silpo_get_promotions` returns
      campaigns, not product IDs; `find_products_batch` takes flat context args and `products`,
      not `queries`).
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

Two tables carry the agent's memory and are easy to confuse:

- `sessions` — one row per user, the authoritative `SessionState` (stage, cart context, menu,
  resolved items). Injected into the system prompt every turn.
- `messages` — rolling user/assistant prose, last 12 replayed into the model each turn so
  follow-ups like «зроби дешевше» have context. Tool calls are *not* replayed; `sessions` is the
  record of what actually happened. Cleared on `/logout`.

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

**✅ CONFIRMED (6 Sept 2026).** Opening that same `/authorize` URL in a **desktop** browser on the
machine running the server — where `localhost:3000` genuinely resolves — completed the flow first
try, with no SMS (existing `auth.silpo.ua` SSO session). Tokens were stored and live MCP calls
succeed. The failures were never Silpo's bug: they were `PUBLIC_BASE_URL=http://localhost:3000`
being unreachable from the phone the link was opened on.

**So: linking works today from the desktop running the server.** For any other device (i.e. the
real Telegram demo flow), `PUBLIC_BASE_URL` must first point at an internet-reachable HTTPS origin
and the DCR client must be re-registered, as above.

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
