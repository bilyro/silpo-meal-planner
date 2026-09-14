# Demo script — «Сільпо Шеф» (≤ 5 min video)

The exact sequence to record for submission, mapped to the organizers' required structure:
**Проблема → Користувач → Рішення → Agent flow → MCP «Сільпо» → Demo → Цінність → Метрики →
Наступний крок.** One strong end-to-end scenario, not a feature tour.

Everything below runs against a **real Silpo account with no sandbox**. Building and filling a
cart is safe; nothing here places or pays for an order.

Timing budget (total 4:50, leaving buffer under the 5:00 cap):

| Beat | Time | Duration |
|---|---|---|
| Проблема | 0:00–0:15 | 15s |
| Користувач | 0:15–0:30 | 15s |
| Рішення | 0:30–0:50 | 20s |
| Agent flow | 0:50–1:15 | 25s |
| MCP «Сільпо» | 1:15–1:40 | 25s |
| **Demo** | 1:40–3:40 | **2:00** |
| Цінність | 3:40–4:00 | 20s |
| Метрики | 4:00–4:30 | 30s |
| Наступний крок | 4:30–4:50 | 20s |

---

## ⚠️ The one trap that kills the demo: the 799 грн minimum

**Silpo withholds `checkoutWebLink` entirely — absent, not empty — whenever the cart total is below
799 грн** (`{level:'error', type:'order', message:'order.cost.min', context:{orderCostMin:799}}`;
verified live, see [`phase5-findings.md`](phase5-findings.md) §4). Instead of the link, the bot
correctly says «⚠️ Оформлення поки недоступне: мінімальна сума замовлення — 799 грн» — honest
engineering, and a terrible final beat for a video if it happens on camera.

Two things push the total **down** after you write the request: `computeQuantity` caps every line
to actual branch stock, and unmatched ingredients land in «⚠️ Не знайшли» and contribute nothing.

**Therefore: ask for a plan large enough to land at ~1100–1400 грн, and do a rehearsal run first**
to see the real number. A 2-day dinner plan for two comes in around 300–500 грн and will *not*
clear the bar. Good shapes:

- «Сплануй вечері на 5 днів для сімʼї з 4 осіб, без свинини, до 1800 грн»
- «Сплануй обіди і вечері на 3 дні для сімʼї з 4 осіб, без свинини, до 1800 грн»

Keep the stated budget **above** the expected total so the list renders «(бюджет 1800 ✅)» rather
than a ⚠️. If a rehearsal lands short of 799 грн, add days/meals to the request, or on the resolved
list type «додай ще один день» and re-confirm before recording.

---

## Pre-flight (before you hit record)

1. **`PUBLIC_BASE_URL` must be an internet-reachable HTTPS origin** if you open the OAuth link on a
   phone. `cloudflared tunnel --url http://localhost:3000`, put the HTTPS URL in `.env`, then
   `DELETE FROM oauth_clients; DELETE FROM oauth_pending;` so the DCR client re-registers with the
   new redirect_uri. Recording on the desktop that runs the server works without a tunnel.
2. **Since 9 Sept, linking has an extra step**: after Silpo login, `/auth/callback` shows a one-time
   6-digit code instead of finishing immediately — type it back into the same Telegram chat to
   confirm the link (closes an account-hijack hole; see README's Known Issues). Rehearse this once
   so it isn't a surprise on camera, or skip recording the link step entirely (see step 4 below).
3. `docker compose up -d postgres && npm run migrate && npm run dev` — confirm `GET /healthz`
   returns `{"status":"ok"}`.
4. **Clean the account:** in Telegram send `/clear` → «🗑 Так, очистити». A leftover cart from a
   rehearsal will be reused by `ensureCartContext` and its old items will inflate the total.
5. Decide whether to record the OAuth step. To show it, send `/logout` first — that drops tokens and
   conversation history for a genuine cold start. If login is flaky on the day, skip it: record an
   already-linked account and cover onboarding in narration (this also sidesteps the confirm-code
   step above).
6. Have the **Silpo app** open on a second device, logged into the same account, on the cart screen.
   The strongest moment of the video is the cart appearing there with the same items.
7. Have a terminal ready with the `tool_call_log` queries (Метрики section, below).
8. Confirm the profile has a **food restriction** stored (e.g. «без свинини»). It's what makes the
   agent look like it knows the user rather than guessing.
9. Regenerate the log right before or right after the take: `npm run export-log` — the freshest
   `docs/tool-call-log.md` is a required submission artifact and should reflect this actual run.

Do **not** press **💸 Дешевше** or **✏️ Прибрати позицію** on camera — they route to free text
rather than being wired to their own buttons yet. Leave them unclicked, or narrate that free text
(«прибери лосось», «додай чіпси») already handles removal/addition through the agent loop if asked.

---

## The recording — beat by beat

### 0:00–0:15 · Проблема

Voiceover over an empty Telegram chat, or a phone next to a paper shopping list:

> «Що приготувати?» → «Що купити?» → 30-40 хвилин щотижня. Список пишеться десь окремо від
> застосунку, промо-акції перевіряються вибірково або не перевіряються взагалі, і кошик виходить
> дорожчим і менш повним, ніж міг би бути.

### 0:15–0:30 · Користувач

> Це та сама рутина для кожної родини, яка регулярно замовляє продукти в Сільпо — особливо коли
> є харчові обмеження чи алергії, які треба пам'ятати щоразу. Сільпо вже знає склад сім'ї,
> обмеження й адресу — просто ніхто не використовує ці дані, щоб відповісти на реальне запитання.

### 0:30–0:50 · Рішення

> «Сільпо Шеф» — телеграм-агент, який доводить це до кінця: одне повідомлення на вході, реальний
> зібраний кошик і посилання на оформлення — на виході. Все через офіційний Silpo MCP-сервер,
> проти справжнього акаунта, без пісочниці й без вигаданих даних.

*(Show the phone: chat on one side, Silpo app on the other — the visual for the whole video.)*

### 0:50–1:15 · Agent flow

> Модель вирішує ЩО і КОЛИ, а не ЯК. Чотири кроки — встановити контекст кошика, підібрати товари,
> зафіксувати список, прочитати кошик і видати посилання — виконує звичайний детермінований код,
> а не імпровізація LLM. І модель фізично не має інструменту, який може змінити кошик: усі
> мутуючі дії доступні лише коду, і без натискання кнопки нічого не записується.

### 1:15–1:40 · MCP «Сільпо»

> Бот читає всі 40 інструментів з реального сервера під час старту — жодна форма аргументів не
> захардкоджена. Моделі доступні 33 read-інструменти з шести категорій: профіль, пошук товарів,
> акції, кошик, доставка, лояльність. Сім інструментів, які можуть змінити акаунт, — недоступні
> моделі взагалі, лише нашому коду. Кожен виклик логується: інструмент, аргументи, статус,
> тривалість.

*(Optional visual: `docs/tools.json` scrolling, or the tools table from README/pitch-deck slide 4.)*

### 1:40–3:40 · Demo — the end-to-end scenario

This is the payoff — give it the most time, one clean unbroken run.

**Connect** *(skip if pre-linked; narrate instead)*: `/start` → «🔐 Підʼєднати Сільпо» → Silpo
login → type the 6-digit confirmation code back into the chat. Bot answers from the real profile:

> Готово, {імʼя}! Я бачу вашу {сімʼю з N осіб}.
> Обмеження харчування: {…}.

Say: *nothing here was typed by me — it's the profile and restrictions read live from Silpo MCP.*

**The request and the menu.** Type, in one message:

> Сплануй вечері на 5 днів для сімʼї з 4 осіб, без свинини, до 1800 грн

Bot renders (typing indicator, then):

> 🍽 **Меню на 5 днів**
> **День 1** — *{страва}* · • {інгредієнт} — {кількість} …
> Підтверджуєте меню? **[✅ Так] [✏️ Змінити]**

Point out: no pork anywhere, sized for four — neither fact was in the typed message.

**✅ — resolution against the real catalogue.** Tap **✅ Так**. Behind one tap: cart context
established (branch, delivery type, first slot), every ingredient batch-searched, one product
picked each.

> 🧾 **Список: N позицій — 1 2xx грн** (бюджет 1800 ✅)
> 🔥 K акційних · 🔄 M замін
> • {Товар} × {кількість} — {ціна} грн 🔥
> **[🛒 Зібрати кошик]**

Narrate: 🔥 is a real promo read per-product from `specialPrices`/`oldPrice`; 🔄 is a substitute
from `silpo_get_replacements` for an out-of-stock pick. *Every name and price here comes from a
tool result — the model cannot write them.*

**🛒 — the real cart and the checkout link.** Tap **🛒 Зібрати кошик**. One batched
`silpo_add_or_update_cart_products` call, then the cart is read back:

> 🛒 **Кошик зібрано** — N поз., {сума} грн
> 💳 Бонусів доступно: {баланс}
> 👉 **Оформити замовлення**

**Cut to the Silpo app**, refresh the cart — same items, same branch, same slot. Hold this shot for
2-3 seconds; it's the strongest single moment in the video. Note the bot stops at the checkout
link on purpose — the MCP has no checkout tool, and the agent must never pay for anything.

### 3:40–4:00 · Цінність

> Для гостя: менше часу на рутину, повніший і дешевший кошик — акції перевірені по кожній позиції,
> а не вибірково, і жодного ризику купити заборонений продукт, бо обмеження — тверде правило в
> коді, не прохання до моделі. Для бізнесу: більші кошики і вище викуп акційних товарів, бо агент
> перевіряє те, що покупець вручну ніколи не перевіряє повністю.

### 4:00–4:30 · Метрики

Cut to the terminal:

```sql
SELECT tool, ok, ms, created_at
FROM tool_call_log
WHERE user_id = (SELECT id FROM users ORDER BY id DESC LIMIT 1)
ORDER BY id;
```

Scroll the result — the whole session: profile reads, cart-context chain, batch search, replacement
lookups, cart write, cart read-back, with per-call durations and success flags. Follow with:

```sql
SELECT tool, count(*), round(avg(ms)) AS avg_ms
FROM tool_call_log GROUP BY tool ORDER BY count(*) DESC;
```

Say out loud, filling in the real numbers from this run: *time from request to checkout link,
number of MCP calls across N distinct tools, promo share and substitution rate — shown live as
«🔥 K акційних · 🔄 M замін» — and this ran on ~$0.003 per request thanks to prompt caching on the
tool block.*

### 4:30–4:50 · Наступний крок

> Той самий агент — усередині самого застосунку Сільпо, оскільки весь потік вже завершується на
> справжньому checkout Сільпо. План уже зберігається в базі — «Повтори минулий план» працює
> сьогодні, тож щотижневий авто-план по четвергах — наступний логічний крок. І інверсія: замість
> підбирати акції під обране меню, будувати меню з цьогорічних акцій напряму.

---

## Fallbacks if something goes wrong live

| Failure | What you see | Recovery |
|---|---|---|
| No checkout link | «⚠️ Оформлення поки недоступне: мінімальна сума замовлення — 799 грн» | Cart is under the minimum. Type «додай ще два дні», re-confirm, rebuild. Prevent it with the rehearsal run. |
| OAuth `400 Invalid or expired state` | Silpo error page instead of the callback | `PUBLIC_BASE_URL` is not reachable from the device that opened the link. Record on the desktop running the server, or set up the tunnel. |
| Stuck on the confirmation-code screen | callback page shows a code, nothing happens after | You (or whoever is on camera) need to actually type that code back into the Telegram chat that ran `/start` — it's a real extra step now, not a rendering glitch. |
| «Ваш звʼязок із Сільпо застарів» | any step | Tokens expired. `/start` and re-link. |
| «На жаль, не вдалося підібрати жодного товару» | after ✅ | Almost always a stale cart context. `/clear`, then re-confirm the menu. |
| Bot asks for a delivery address | after ✅ | The account has no saved address. Reply with plain text: «Київ, вулиця Хрещатик, 1». Worth pre-testing so it does not appear mid-take. |
| The menu appears without the ✅/✏️ buttons | after the request | The model narrated the menu instead of calling `propose_menu`. Re-send the request; the prompt makes this rare but not impossible. |
| "Досягли денного ліміту повідомлень" | after several free-text messages | The 10/day cap on text messages. Button taps (✅/🛒) don't count, so a normal button-driven demo won't hit it — but rehearsals that used lots of free text might. Wait for the next day, or raise `DAILY_MESSAGE_LIMIT` in `.env` for the recording session. |

---

## After recording

Send `/clear` → «🗑 Так, очистити» to empty the real cart, then `npm run export-log` one more time
so `docs/tool-call-log.md` reflects the actual submitted run — a required submission artifact.
