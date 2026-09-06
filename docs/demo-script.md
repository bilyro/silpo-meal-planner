# Demo script — «Сільпо Шеф» (≤ 3 min video)

The exact sequence to record for the hackathon submission (spec §8 Phase 7 step 2). Everything
below runs against a **real Silpo account with no sandbox** — see §4.6 of the spec. Building and
filling a cart is safe; nothing here places or pays for an order.

---

## ⚠️ The one trap that kills the demo: the 799 грн minimum

**Silpo withholds `checkoutWebLink` entirely — absent, not empty — whenever the cart total is below
799 грн** (`{level:'error', type:'order', message:'order.cost.min', context:{orderCostMin:799}}`;
verified live, see [`phase5-findings.md`](phase5-findings.md) §4). Instead of the link, the bot
correctly says «⚠️ Оформлення поки недоступне: мінімальна сума замовлення — 799 грн».

That message is honest engineering and a *terrible* final beat for a video. Two more things push the
total **down** after you write the request, so build in headroom:

- `computeQuantity` caps every line to what the branch actually has in stock, so a line can shrink.
- Ingredients the search cannot match land in «⚠️ Не знайшли» and contribute nothing.

**Therefore: ask for a plan large enough to land at ~1100–1400 грн of products, and do a rehearsal
run first to see the real number.** A 2-day dinner plan for two comes in around 300–500 грн and will
*not* clear the bar. Good shapes:

- «Сплануй вечері на 5 днів для сімʼї з 4 осіб, без свинини, до 1800 грн»
- «Сплануй обіди і вечері на 3 дні для сімʼї з 4 осіб, без свинини, до 1800 грн»

Keep the stated budget **above** the expected total so the list renders «(бюджет 1800 ✅)» rather
than a ⚠️ — the budget check compares against the products-only sum.

If a rehearsal lands short of 799 грн, either add days/meals to the request, or on the resolved list
type «додай ще один день» and re-confirm before recording.

---

## Pre-flight (before you hit record)

1. **`PUBLIC_BASE_URL` must be an internet-reachable HTTPS origin** if you will open the OAuth link
   on a phone. `cloudflared tunnel --url http://localhost:3000`, put the HTTPS URL in `.env`, then
   `DELETE FROM oauth_clients; DELETE FROM oauth_pending;` so the DCR client re-registers with the
   new redirect_uri. Recording on the desktop that runs the server works without a tunnel. See the
   README's Known issues.
2. `docker compose up -d postgres && npm run migrate && npm run dev` — confirm `GET /healthz`
   returns `{"status":"ok"}`.
3. **Clean the account:** in Telegram send `/clear` → «🗑 Так, очистити». A leftover cart from a
   rehearsal will be reused by `ensureCartContext` and its old items will inflate the total.
4. Decide whether to record the OAuth step. To show it, send `/logout` first — that drops tokens and
   conversation history and gives a genuine cold start. If the login flow is flaky on the day, skip
   it: record an already-linked account and cover onboarding in narration.
5. Have the **Silpo app** open on a second device, logged into the same account, on the cart screen.
   The strongest moment of the video is the cart appearing there with the same items.
6. Have a terminal ready with the `tool_call_log` query (below).
7. Confirm the profile has a **food restriction** stored (e.g. «без свинини»). The restriction is
   what makes the agent look like it knows the user rather than guessing.

Do **not** press **💸 Дешевше** or **✏️ Прибрати позицію** on camera — they are stubs that reply
with a one-line prompt. The buttons are visible in the screenshot; leave them unclicked.

---

## The recording — beat by beat

### 0:00–0:20 · Problem

One slide or voiceover over the empty Telegram chat: planning a week of family meals and turning it
into a grocery order is 20–30 minutes of work every week, and the promos get missed. Silpo already
knows the family, the restrictions and the address; nothing uses that.

### 0:20–0:40 · Connect (skippable)

Send **`/start`**. Tap **«🔐 Підʼєднати Сільпо»**, complete the Silpo login.

The bot answers from the real profile:

> Готово, {імʼя}! Я бачу вашу {сімʼю з N осіб}.
> Обмеження харчування: {…}.
> Також бачу N улюбленців 🐾

Say out loud: *nothing here was typed by me — it is the profile, family and restrictions read live
from the Silpo MCP.*

### 0:40–1:10 · The request and the menu

Type, in one message:

> Сплануй вечері на 5 днів для сімʼї з 4 осіб, без свинини, до 1800 грн

The bot shows a typing indicator while the agent loop runs, then renders:

> 🍽 **Меню на 5 днів**
> **День 1** — *{страва}* · • {інгредієнт} — {кількість} …
> …
> Підтверджуєте меню? **[✅ Так] [✏️ Змінити]**

Point out that the menu respects the restriction (no pork anywhere) and is sized for four people —
neither fact was in the message that was typed.

### 1:10–1:50 · ✅ — resolution against the real catalogue

Tap **✅ Так**. Behind this single tap the bot deterministically: establishes cart context (branch,
delivery type, first available time slot — mandatory before Silpo's 🔒 search tools will answer at
all), batch-searches every deduplicated ingredient, and picks one product each.

> 🧾 **Список: N позицій — 1 2xx грн** (бюджет 1800 ✅)
> 🔥 K акційних · 🔄 M замін
> • {Товар} × {кількість} — {ціна} грн 🔥
> …
> **[🛒 Зібрати кошик]**
> **[💸 Дешевше] [✏️ Прибрати позицію]**

Narrate the two badges: **🔥** is a real promo detected per-product from `specialPrices`/`oldPrice`
in the search results, and **🔄** is a substitute fetched from `silpo_get_replacements` because the
first choice was out of stock at that branch. Say plainly: *every product name and price on this
screen comes from a tool result — the model is not allowed to write them.*

### 1:50–2:20 · 🛒 — the real cart and the checkout link

Tap **🛒 Зібрати кошик**. One batched `silpo_add_or_update_cart_products` call, then the cart is
read back:

> 🛒 **Кошик зібрано** — N поз., {сума} грн
> 💳 Бонусів доступно: {баланс}
> 👉 **Оформити замовлення**

**Cut to the Silpo app** and refresh the cart: the same items, the same branch, the same delivery
slot. This is the payoff shot — hold it for a couple of seconds.

Note the total shown here is Silpo's own, including delivery, so it is higher than the list total.
Say that the bot stops at the checkout link on purpose: the MCP has no checkout tool, and the agent
must never pay for anything.

### 2:20–2:40 · Proof it is really MCP

Cut to the terminal:

```sql
SELECT tool, ok, ms, created_at
FROM tool_call_log
WHERE user_id = (SELECT id FROM users ORDER BY id DESC LIMIT 1)
ORDER BY id;
```

Scroll the result. It is the whole session: profile reads, the cart-context chain, the batch search,
the replacement lookups, the cart write, the cart read-back — with per-call durations and
success flags. Add a per-tool count if it reads better on screen:

```sql
SELECT tool, count(*), round(avg(ms)) AS avg_ms
FROM tool_call_log GROUP BY tool ORDER BY count(*) DESC;
```

### 2:40–3:00 · Metrics and scaling

One slide:

- time to cart: from the first message to the checkout link (read off `tool_call_log` timestamps)
- promo share and substitution rate: `totals.promoShare` / `totals.substitutionRate`, shown live in
  the list header as «🔥 K акційних · 🔄 M замін»
- tool calls per session: `SELECT count(*) FROM tool_call_log WHERE …`
- 16 Silpo tools called deterministically; all 40 exposed to the agent
- scaling: ship it inside the Silpo app itself, weekly auto-plans, family sharing

---

## Fallbacks if something goes wrong live

| Failure | What you see | Recovery |
|---|---|---|
| No checkout link | «⚠️ Оформлення поки недоступне: мінімальна сума замовлення — 799 грн» | Cart is under the minimum. Type «додай ще два дні», re-confirm, rebuild. Prevent it with the rehearsal run. |
| OAuth `400 Invalid or expired state` | Silpo error page instead of the callback | `PUBLIC_BASE_URL` is not reachable from the device that opened the link. Record on the desktop running the server, or set up the tunnel. |
| «Ваш звʼязок із Сільпо застарів» | any step | Tokens expired. `/start` and re-link. |
| «На жаль, не вдалося підібрати жодного товару» | after ✅ | Almost always a stale cart context. `/clear`, then re-confirm the menu. |
| Bot asks for a delivery address | after ✅ | The account has no saved address. Reply with plain text: «Київ, вулиця Хрещатик, 1». Worth pre-testing so it does not appear mid-take. |
| The menu appears without the ✅/✏️ buttons | after the request | The model narrated the menu instead of calling `propose_menu`. Re-send the request; the prompt makes this rare but not impossible. |

---

## After recording

Send `/clear` → «🗑 Так, очистити» to empty the real cart, and keep the `tool_call_log` rows —
a JSON-RPC / tool-log excerpt is a required submission artifact.
