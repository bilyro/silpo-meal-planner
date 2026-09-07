# Deploy runbook (spec §8, Phase 7 item 1)

The reason to deploy is narrow and specific: **`PUBLIC_BASE_URL` must be a stable, internet-reachable
HTTPS origin**, because it is the OAuth redirect origin (`<PUBLIC_BASE_URL>/auth/callback`). With
`localhost` there, linking works only in a desktop browser on the machine running the server — a
phone opens the Telegram in-app WebView, the redirect to `localhost:3000` dies, the user reloads,
and the (single-use) broker state is already spent → `400 Invalid or expired state`. The full
diagnosis is in [README.md → Known issues](../README.md#known-issues). **This is the blocker for
demoing from a phone**, which is what the video needs.

A tunnel (`cloudflared tunnel --url http://localhost:3000`) fixes the same problem, but its hostname
changes on every restart, and every change means re-registering the DCR client (step 5). Deploy once
and the URL stops moving.

---

## 1. Prerequisites

```bash
brew install flyctl && fly auth login
```

## 2. Create the app and a database

```bash
fly launch --no-deploy            # pick a name; it rewrites `app` in fly.toml
fly postgres create --name silpo-chef-db --region waw
fly postgres attach silpo-chef-db # sets DATABASE_URL as a secret automatically
```

`fly postgres attach` writes `DATABASE_URL` for you — do **not** also set it by hand, and note it
points at Fly's internal `.flycast` address on port 5432. The host-port-5433 quirk is a local-Docker
concern only (see CLAUDE.md).

## 3. Point `PUBLIC_BASE_URL` at the real hostname

Edit `fly.toml` so `PUBLIC_BASE_URL` is exactly `https://<app-name>.fly.dev` — no trailing slash.
Getting this wrong is silent: the app boots fine and OAuth fails later with a redirect_uri mismatch.

## 4. Set the secrets

```bash
fly secrets set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=...
```

Never put these in `fly.toml` (committed) or bake them into the image — `.dockerignore` excludes
`.env` for exactly that reason, since image layers are additive and a secret copied in one layer
stays readable even if a later layer deletes it.

## 5. Deploy, then reset the DCR client — *do not skip this*

```bash
fly deploy
```

A Dynamic Client Registration bakes its `redirect_uris` in at registration time. The client
registered against the old `PUBLIC_BASE_URL` (localhost or a tunnel) is now wrong, and
`mcp.silpo.ua/authorize` will reject the new redirect_uri. Clear it once after the hostname changes:

```bash
fly postgres connect -a silpo-chef-db
```
```sql
DELETE FROM oauth_pending;
DELETE FROM oauth_clients;
```

`saveOauthClient` replaces rather than accumulates and `getOauthClient` returns the newest, so
re-registration then happens by itself on the next `/start`.

Any user who linked against the old origin must also `/logout` and `/start` again.

## 6. Verify the cold start

Migrations run on boot (`runMigrations()` in `src/index.ts`, before the port is bound), so a fresh
database needs no release command. Check that it actually happened rather than assuming:

```bash
fly logs                                    # expect: "Running migrations..." → "Migrations complete."
                                            # then "Web server listening" → "Bot started (long polling)"
curl -s https://<app>.fly.dev/healthz       # {"status":"ok"}          — process is up
curl -s https://<app>.fly.dev/readyz        # {"status":"ok","db":"ok"} — database is reachable
```

`/healthz` is the platform's liveness probe and deliberately touches nothing else; `/readyz` is the
one that proves Postgres is wired up. If `/readyz` returns 503, `DATABASE_URL` is wrong or the
attach did not happen — the app will still answer `/healthz`, so trust `/readyz` here.

Then the end-to-end check, **from a phone**, which is the thing the tunnel could never prove:

1. `/start` → tap «🔐 Підʼєднати Сільпо» → log in → the browser shows «Готово! Повертайтесь у
   Telegram» and the bot greets you by your real name with your family size.
2. «Сплануй вечері на 3 дні» → menu → ✅ → priced list → 🛒 → checkout link.
3. Open the link: the cart is really there in Silpo.

Remember the **799 грн minimum** — below it Silpo omits `checkoutWebLink` entirely and the bot says
why. Plan the demo basket above it (see [demo-script.md](demo-script.md)).

## 7. Capture the submission artefact

```bash
npm run export-log -- --limit 120 --out docs/tool-call-log.md
```

Writes the JSON-RPC transcript and the metrics table (call counts, distinct tools, p50/p95) that the
submission and the metrics slide both need. Personal argument fields are redacted; responses were
never stored.

---

## Rollback

```bash
fly releases              # find the previous version
fly deploy --image <previous-image-ref>
```

Migrations are forward-only. Rolling the app back does not roll the schema back, which is fine for
every migration in `drizzle/` so far (all additive), but is worth knowing before adding a
destructive one during the final days.

## Notes / limits

- **One machine on purpose.** Telegram long polling does not shard across instances, and boot-time
  migrations would race. If this ever needs to scale, move `runMigrations()` to a Fly release
  command and switch the bot to webhooks.
- **`auto_stop_machines = false`.** A suspended machine receives no long-poll updates and there is
  no inbound request to wake it, so the bot would simply go quiet.
- **Cost.** `shared-cpu-1x` / 512 MB plus the smallest Postgres is enough for the demo.
