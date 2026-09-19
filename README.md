# atomic-market

Generic order-book worker for atomic swaps. No custody, no escrow — the
chain settles, this worker only matches listings and verifies payments.

Live at **https://entangleit.com/atomic-market** (Worker route on the
EntangleIT zone; `atomic-market.richard-hein.workers.dev` still serves the
same worker at the root for direct API use).

PocketPets keeps pointing at the legacy worker; this one serves new
markets (tickets, art, game items, Twetch NFTs) with per-market fees.

## Assets

- `ordinal` — any 1-sat ordinal. Atomic offers use the v2 swap template
  (payment → seller, 1 sat → buyer, fee, memo, change).
- `bsv21` — fungible tokens (`tokenId: <txid>_<vout>`, `tokenAmount` base
  units as a decimal string). Atomic offers use the v3 template.

Pet-specific fields (nickname, species, rarity…) live in `metadata`.
Clients that need them read them there; the worker never does.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/market[?kind=]` | active listings, newest first |
| GET | `/v1/market/recent[?limit=]` | paid/sold history |
| GET | `/v1/market/listing/:origin` | one listing, 404 when unknown |
| POST | `/v1/market/list` | validate + verify parent on chain |
| POST | `/v1/market/buy` | verify exact payment + fee → `paid` |
| POST | `/v1/market/settle` | verify transfer spends the origin → `sold` |
| POST | `/v1/market/cancel` | seller only → `cancelled` |
| GET | `/health` | `{ ok: true }` |

Errors are `{ error: { code, message } }`: `BAD_PARAM` (400),
`NOT_FOUND` (404), `ALREADY_LISTED` / `ALREADY_SOLD` (409), `NOT_SELLER`
(403), `PARENT_MISSING` / `TX_UNKNOWN` (502, indexer), `BAD_PAYMENT` /
`BAD_FEE` / `BAD_TRANSFER` (400, proof failed).

Race semantics: the first valid buy wins (`active` → `paid`); later buys
see `ALREADY_SOLD`. Atomic buys may settle straight to `sold`; escrow
sales go `paid` → `sold` via `/settle`. Double-spends that never confirm
are the buyer's risk — settlement is what proves delivery.

Fees: `fee_bps` per listing (default 200 = 2%), `max(1, floor(price ×
bps / 10000))` sats to `fee_address`, verified on every buy.

## Develop

```bash
node --test 'test/**/*.test.mjs'   # pure logic: validate, verify, store
```

`src/store.ts` is the only D1 touchpoint (`d1Store` in production,
`memoryStore` in tests). Verification takes a `fetchTx` injector —
WhatsOnChain in production, fixtures in tests.

## Deploy

```bash
# one time: create the D1 and put its id in wrangler.toml
npx wrangler d1 create atomic-market
npm run deploy
```
