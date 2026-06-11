# nft-inventory-data_2026

Data home for the aDAO NFT pipeline. **All live data is under `data/v2/`** — the
top-level `data/*.json` files are the FROZEN pre-v2 system (last write 2026-06-07),
kept read-only during the migration; do not consume them, and do not delete them
until every page in `aDAO-links-site` is grepped for the old paths.

Producer map (who writes what) lives in `cron-scripts/README.md` → "Data & Pipeline
Registry". Rule: one fact, one producer. Read it before adding capture for anything.

## Files — `data/v2/`

| File | Producer | Description | Cadence |
|---|---|---|---|
| `nfts.json` | Render cron (`cron-scripts/nft-inventory`) | Canonical per-NFT state: owner, real_owner, broken, classification, listing | 15 min (hot) |
| `summary.json` | Render cron | Aggregates, stakers, marketplaces, backing, `staker_resolution`, `listing_resolver` | 15 min |
| `heartbeat.json` | Render cron | Freshness + stats canaries (`listing_resolver_warnings`, `staker_resolution_errors`) | 15 min |
| `daily/<date>.json` | Render cron | End-of-day snapshot | daily |
| `pending-claims.json` | Render cron | DAODAO unstaked-but-unclaimed: per-token address, `unstaked_at`, `release_at` | every run |
| `hot-set.json` | Render cron | Hot-path token ids | weekly (full) |
| `floor-history.json` | Render cron | Daily per-tier floors (listing + sales medians), DOM, bids — append-only | daily (full/warm) |
| `listing-first-seen.json` | Render cron | Days-on-market accrual map (since 2026-06-11) | daily (full/warm) |
| `sales-history.json` | Actions (backfill + 6h incremental) | All BBL sales from `settle` events | 6 h |
| `atrium-sales.json` | Actions | All Atrium sales from `buy_nft` events | 6 h |
| `boost-sales.json` | Actions (`boost-sales-fetch.js`) | Boost sales | 6 h |
| `sales-enriched.json` | Actions (`nft-analytics-builder.js`) | Per-sale USD enrichment. **`notional_usd` = sale value; `price_usd_at_sale` = denom UNIT price.** BBL rows carry `auction_id` and NO `marketplace` label | 6 h |
| `nft-analytics.json` | Actions | Aggregates: volume, leaderboards, monthly, flips | 6 h |
| `nft-provenance.json` | Actions | Per-token transfer spine (mint → today), 13 MB — fetch per-token client-side, never wholesale | 6 h |
| `broken-at.json` | events backfill (one-time) + 6h forward-fill | Break timestamp per broken token (1,093/1,093 at seed). NFTs can't unbreak — grows only | 6 h |
| `listing-history.json` | events backfill (one-time) + 6h forward-fill | Listing lifecycle: create (price/denom/seller/ts) → outcome sold/delisted/active. New creates append; actives auto-close | 6 h |

## Scripts (repo root)

| Script | Role |
|---|---|
| `bbl-sales-backfill.js` | One-time BBL sales seed. **Exports the resilient LCD pager + `eventsOf` — `require`d by every other sweep. Do not delete.** |
| `atrium-sales-backfill.js`, `nft-provenance-backfill.js` | One-time seeds (done) |
| `nft-events-backfill.js` | One-time breaks + listing-lifecycle seed (done 2026-06-11; re-runnable, shrink-guarded). **Exports the parsers used by the forward-fill.** |
| `nft-forward-incremental.js` | 6-hour incremental: sales + provenance + events forward-fill (per-stream watermarks; failed GitHub writes self-heal next run) |
| `boost-sales-fetch.js`, `nft-analytics-builder.js` | Boost sales + the enrichment/analytics pass |

## Workflows

| Workflow | Schedule | Status |
|---|---|---|
| NFT Incremental Update | every 6 h | live — the freshness engine |
| NFT Full Reconcile | weekly Sun | live — correctness backstop |
| NFT History Backfill | manual | one-time, DONE — keep for re-seeds |
| NFT Events Backfill | manual | one-time, DONE 2026-06-11 — keep for re-seeds |

## Consumers

NFT Explorer + Analytics tab (`aDAO-links-site`) read `data/v2/` via raw.githubusercontent.
The explorer hard-fails if `nfts.json` has fewer than 10,000 records — schema changes to
existing fields are breaking; new fields are additive-safe.
