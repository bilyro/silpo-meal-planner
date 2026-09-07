# Silpo MCP tool coverage — all 40, audited

Derived from two sources, not from intent: `tool_call_log` (every call the bot has ever made, from
both the deterministic paths and the model's own) and a grep for `callTool` string literals in
`src/`. Regenerate the call counts with `npm run export-log`.

All 40 tools are handed to the model every turn — `SilpoMcpClient.toolsForAiSdk()` reads
`tools/list` at runtime and converts each tool's own JSON Schema, so no argument shape is
hard-coded. What follows is which of them the agent actually reaches.

| | Count |
|---|---:|
| Exposed to the model each turn | **40** |
| Wired into our own code | **19** |
| Ever actually called | **19** |
| Touched one way or the other | **21** |
| Never touched at all | **19** |

The two 19s are different sets — that difference is the interesting part.

---

## Used — wired *and* exercised (17)

| Tool | Called from | Why | Calls | Writes |
|---|---|---|---:|---|
| `silpo_get_my_profile` | `bot/welcome.ts` | Greet by real name | 19 | no |
| `silpo_get_my_food_restrictions` | `bot/welcome.ts` | Hard constraints on menu and product choice | 19 | no |
| `silpo_get_my_family` | `bot/welcome.ts` | Family size → portions; pets → pet food | 18 | no |
| `silpo_get_shopping_cart_by_id` | `cartContext`, `localTools`, `commands` | Checkout link, Silpo's total, validations | 13 | no |
| `silpo_find_products_batch` 🔒 | `resolveIngredients` | Up to 30 ingredient queries per call | 11 (10 ok) | no |
| `silpo_get_my_delivery_addresses` | `cartContext` | Use the saved address when there is one | 10 | no |
| `silpo_get_my_shopping_cart` | `cartContext` | Reuse a cart instead of creating a second | 9 | no |
| `silpo_add_or_update_cart_products` | `bot.ts` (🛒) | Writes the whole resolved list in ONE call | 3 | **yes** |
| `silpo_get_time_slots` | `cartContext` | First available slot — required by every 🔒 tool | 2 | no |
| `silpo_find_address` | `cartContext` | Geocode a free-text address | 1 | no |
| `silpo_get_available_delivery_types` | `cartContext` | Which types serve those coordinates | 1 | no |
| `silpo_create_shopping_cart` | `cartContext` | Create cart with address + branch + slot | 1 | **yes** |
| `silpo_update_shopping_cart` | `cartContext` | Re-book a slot that expired | 1 | **yes** |
| `silpo_get_loyalty_info` | `agent/loyalty.ts` | Bonus balance and tier | 1 | no |
| `silpo_get_my_coupons` | `agent/loyalty.ts` | Personal coupons for this basket | 1 | no |
| `silpo_get_promo_codes` | `agent/loyalty.ts` | Promo codes beside the checkout link | 1 | no |
| `silpo_clear_shopping_cart` | `bot.ts` (`/clear`) | Cleanup — there is no sandbox | 1 | **yes** |

Category coverage: **Profile · Location & Delivery · Cart · Product Search · Loyalty**.

## Wired but never triggered (2)

Live code on a branch that has not fired — not dead code.

| Tool | Where | Needs |
|---|---|---|
| `silpo_get_replacements` | `resolveIngredients.ts:229` | A matched product that is out of stock |
| `silpo_list_branches` | `cartContext.ts:245` | A delivery type that names no branch |

## The model reached for these on its own (2)

Nothing in our code wires either one. They appear in `tool_call_log` because the model chose them.

| Tool | Calls | Note |
|---|---:|---|
| `silpo_get_promotions` | 2 (1 ok) | Deliberately not wired: it returns promo *campaigns* with no product ids. Promo status is read per-product off `specialPrices` / `oldPrice` instead — cheaper and correct. |
| `silpo_get_my_promos` | 1 | Never wired. |

This is the payoff for exposing all 40 rather than a curated subset: the agent went past its scripted
paths. It is also the argument against trimming too aggressively.

## Never touched at all (19)

**Plausibly useful — the natural next features (6)**

| Tool | Would serve |
|---|---|
| `silpo_remove_cart_products` | The ✏️ «Прибрати позицію» stub |
| `silpo_get_similar_products` | The 💸 «Дешевше» budget-squeeze stub |
| `silpo_get_product_details` | Same — comparing a cheaper candidate |
| `silpo_get_products` | Single-product search outside the batch path |
| `silpo_get_coupon_details` | Explaining a coupon the agent surfaced |
| `silpo_get_my_online_orders` | «Замов як минулого разу» from real history |

**Off-mission for a meal planner (13)** — the trim candidates, 13,777 of 47,783 chars = **28.8%** of
the tool block:

`silpo_find_nova_poshta_offices` · `silpo_find_nova_poshta_settlements` ·
`silpo_add_or_update_certificates` · `silpo_get_my_certificates` · `silpo_get_my_favorites` ·
`silpo_add_or_update_favorite_products` · `silpo_get_categories` · `silpo_get_categories_tree` ·
`silpo_get_category` · `silpo_get_popular_categories` · `silpo_get_product_sets` ·
`silpo_get_my_premium_subscription` · `silpo_get_my_offline_orders`

Trimming these would cut the cached tool block by ~29%. The cost saving is small (~$0.012 per plan);
the real argument is accuracy — every irrelevant tool is one more thing the model can reach for
wrongly. The counter-argument is section 3 above, and that "all 40 exposed" is part of the pitch.
Undecided on purpose.
