# Pitch deck — «Сільпо Шеф» (7 slides)

Speaker content for the deck required by spec §8 Phase 7 item 3. Structured so each of the six
judging criteria (§2) is hit explicitly, in the order a judge scores them.

> **Placeholders marked `⟨fill⟩` must come from the actual demo run** — `npm run export-log`
> produces the call counts and latencies, and the bot's own reply produces the basket numbers.
> Do not estimate them: the entire pitch is "these are real numbers from a real account", and one
> invented figure undoes it.

---

## Slide 1 — The problem

**«Що приготувати?» → «Що купити?» → 40 хвилин у застосунку.**

- Deciding meals for the week, turning that into a shopping list, then finding each item in the app
  is the highest-frequency chore for a family — repeated weekly, forever.
- Every step loses people: the list is written elsewhere, promos are missed because nobody
  cross-checks 20 items against the current акції, and the basket ends up smaller than intended.
- Silpo already knows the family size, the dietary restrictions, the address and the order history.
  Nothing uses it to answer the actual question.

*Visual: a phone with a paper list next to the Silpo app.*

---

## Slide 2 — What we built

**Телеграм-агент, який планує меню і збирає справжній кошик.**

One message in: «Сплануй вечері на 3 дні, без свинини, до 1200 грн».
One link out: Silpo's own checkout, with a real cart behind it.

Between them, with no human in the loop: read the profile → propose a menu → convert it to
ingredients → find each one in the real catalogue → prefer promo items → substitute what is out of
stock → book a delivery slot → build the cart.

*Visual: three phone screenshots — request, priced list with 🔥/🔄 badges, checkout link.*

> Criterion: **Guest / business value.** Bigger, more complete baskets; promo redemption rises
> because the agent checks every item's `specialPrices`, which no shopper does by hand.

---

## Slide 3 — It is an agent, not a chatbot

Four design decisions carry that claim, and each is visible in the repo:

1. **Multi-step recipes are deterministic code.** Four local tools (`ensure_cart_context`,
   `propose_menu`, `record_resolution`, `finish_with_checkout`) look like tools to the model but are
   ordinary TypeScript. The model decides *when*; the code decides *how*.
2. **The 🔒 precondition is enforced.** Silpo's product-search tools hard-fail without an active
   cart context. `ensureCartContext` chains ~6 dependent calls (cart → address → delivery type →
   branch → slot → create) before any search, and re-books an expired slot.
3. **The LLM never invents a product, price, or availability.** Everything the user reads about
   products is rendered from tool output, never from model prose. Hallucinated groceries are
   structurally impossible, not merely discouraged by the prompt.
4. **Every call is logged as evidence** — one wrapper writes user, tool, args, status and duration
   to `tool_call_log`.

> Criterion: **Agent capability.** State carried across turns; a real dependency chain, not a
> single Q&A.

---

## Slide 4 — Real MCP, real account, no mocks

- **40 tools** read from the live server at runtime via `tools/list` — **no argument shape is
  hard-coded anywhere**, because Silpo's docs say the server is the only source of truth for
  schemas.
- **16 of them are called directly** by our own deterministic paths; the model can reach all 40.
- **6 of 7 tool categories** exercised: Profile · Product Search · Catalog/Promotions · Cart ·
  Location & Delivery · Loyalty.
- OAuth 2.1 (Authorization Code + PKCE, Dynamic Client Registration); tokens stored **server-side
  only**, per the hackathon rule.
- **There is no sandbox.** Everything in the demo happened against a real «Власний Рахунок».

**What we found that the docs do not say** — each verified live, each now handled:

| Finding | Consequence |
|---|---|
| 🔒 tools take **flat** `timeslotStart`/`timeslotEnd`, not a nested object | product search fails with `-32602` until you get this right |
| `find_products_batch` takes `products`, returns `queries` | the input and output key names are inverted |
| `get_promotions` returns **campaigns, no product ids** | promo status must be read per-product off `specialPrices`/`oldPrice` — cheaper *and* correct |
| **799 грн minimum order**: below it `checkoutWebLink` is *absent*, not empty | the bot explains why instead of showing a mysteriously missing link |
| Search is fuzzy — «куряче філе» returns «Качине філе» (duck) | `selectProduct` ranks head-noun match above promo price: buying the wrong food is worse than missing a discount |

> Criteria: **MCP utilization quality** and **Integration realism.** Every call is needed, not
> decorative, and the flow ends on Silpo's own `checkoutWebLink` — nothing Silpo's app could not ship.

*Visual: the JSON-RPC transcript from `docs/tool-call-log.md`, scrolling.*

---

## Slide 5 — Proof and metrics

From the recorded run (`npm run export-log`):

- MCP calls in one plan→cart session: **⟨fill⟩**, across **⟨fill⟩** distinct tools
- Time from request to checkout link: **⟨fill⟩**
- Items resolved: **⟨fill⟩** · on promo 🔥: **⟨fill⟩%** · substituted 🔄: **⟨fill⟩%**
- Basket total: **⟨fill⟩ грн** against a stated budget of ⟨fill⟩ грн
- Call latency p50 / p95: **⟨fill⟩ / ⟨fill⟩ ms**

Cost to run: **~$0.003 per request** on Claude Haiku 4.5. The 40-tool block is 89% of the input, so
it is sent under an Anthropic prompt-cache breakpoint — measured **5.6× cheaper** per request than
without it ($0.0194 → $0.0034), and the saving multiplies across the steps in a turn.

> Criterion: **Validation & scaling.** Instrumented from the first commit, not measured afterwards.

---

## Slide 6 — Robustness (what happens when it goes wrong)

Not a happy-path prototype:

- **≤25 MCP calls and a 60 s wall-clock deadline per turn** — a hung call cancels its in-flight HTTP
  request rather than leaving the user on a typing indicator.
- **Consecutive-duplicate suppression** — a model that reissues an identical call gets an error
  telling it to change course, and the suppressed call is still written to `tool_call_log` so it is
  visible as suppressed rather than simply missing.
- **Retry with jittered backoff** on 429 and transient network errors; one token refresh on 401,
  then an honest re-link prompt.
- **Expired delivery slots are re-booked** automatically — a cart outlives its slot, and every 🔒
  tool then rejects it.
- **Nothing can place or pay for an order.** Every write follows an explicit user tap, `/clear` asks
  a second time, and the MCP has no checkout tool at all.

> Criterion: **Prototype / demo quality.**

---

## Slide 7 — Where this goes

- **In-app**: the same agent inside the Silpo app — the whole flow already ends on Silpo's own
  checkout, so nothing about the integration changes.
- **Weekly auto-plan**: the `plans` table already stores completed plans; «Повтори минулий план»
  works today. A scheduled plan proposed every Thursday is the natural next step.
- **Family sharing**: one plan, several accounts — the profile tools already model the household.
- **Promo-first planning**: today the agent prefers promo items *for a chosen menu*; the inversion —
  build the menu *from* this week's акції — is the same code with the ranking flipped, and is worth
  real margin to Silpo.

**Ask:** access to a test account and a staging MCP so the next iteration is not built against
production.

---

## Deck production notes

- 7 slides, one idea each; slides 4 and 5 are the ones judges will linger on — keep the tables
  readable at video resolution.
- Ukrainian for anything the audience sees on-screen in the product; English is fine for the
  engineering slides if the audience prefers it — match the video's language.
- Do not read the slides aloud. Slide 4's table is the substance: it proves the integration was
  actually built against the live server, because none of it is in the documentation.
