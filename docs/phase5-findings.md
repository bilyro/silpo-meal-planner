# Phase 5 groundwork — verified against the live Silpo MCP (6 Sept 2026)

Captured while verifying Phase 4 on a real linked account. These are **observed responses**, not
schema guesses, and two of them contradict assumptions baked into the spec. Read this before
writing `selectProduct.ts`.

## 1. The 🔒 cart-context tools take FLAT args, not a nested timeslot

`silpo_get_promotions` and `silpo_find_products_batch` both require all four context fields, and
`timeslot` is **flattened**:

```
required: branchId, deliveryType, timeslotStart, timeslotEnd  (+ products for the batch tool)
```

Note `SessionState.cartContext` stores `timeslot: {start, end}`, so it must be spread out:

```ts
const ctx = {
  branchId: cc.branchId,
  deliveryType: cc.deliveryType,
  timeslotStart: cc.timeslot.start,
  timeslotEnd: cc.timeslot.end,
};
```

Calling without these fails fast with `MCP error -32602 Input validation error`.

## 2. `silpo_find_products_batch` takes `products`, not `queries`

The param is `products: string[]` — a plain array of search strings (spec §8 Phase 5 guessed
`[{query, limit}]`). `limit` is a separate top-level number. Results come back under a `queries`
key (confusingly the inverse of the input name):

```jsonc
{ "success": true, "summary": "Found 4 products across 2 search queries",
  "queries": [ { "query": "куряче філе", "totalFound": 13,
    "products": [ { "id": "1ed0764d-…", "name": "…", "price": 809.6, "oldPrice": null,
                    "stock": 13, "available": true, "weighted": true, "step": 0.65,
                    "displayRatio": "100г", "specialPrices": null, "companyId": "1ec88c5d-…" } ] } ] }
```

Useful fields for `selectProduct` (spec §6.4): `available`/`stock` for the in-stock filter,
`price` vs `oldPrice` and `specialPrices` for promo detection, `weighted`/`step`/`displayRatio`
for unit-price normalisation, and `companyId` — required later by
`silpo_add_or_update_cart_products`, so **carry it through into `resolvedItems`**.

⚠️ Search is fuzzy: querying «куряче філе» returned «Качине філе домашнє» (duck, not chicken) as a
hit. Spec §11 anticipated this. Do not trust rank-1 blindly — filter on the query terms actually
appearing in `name`, and re-check against food restrictions.

## 3. ⚠️ `silpo_get_promotions` returns CAMPAIGNS, not product IDs

This invalidates spec §6.4 step 2 and §8 Phase 5 step 2, which both assume you can build a
`Set<productId>` of promo items from this tool. You cannot — it returns promo *campaigns*:

```jsonc
{ "success": true, "summary": "Found 6 active promotions",
  "promotions": [ { "code": "only_online", "title": "Тільки Онлайн",
                    "productCount": 1401, "url": "https://silpo.ua/offers/only_online" } ] }
```

There are no product ids anywhere in the response. **Detect promos per-product instead**, from the
`specialPrices` and `oldPrice` fields already present on each `find_products_batch` result — that
is cheaper anyway (no extra call, no 1401-item cross-reference) and is what should populate
`resolvedItems[].isPromo`. Treat `silpo_get_promotions` as display-only context for the user
("6 акцій зараз"), not as a selection input.
