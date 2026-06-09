# NFT Inventory & History Pipeline — Session Handoff

**Purpose:** complete, self-contained context for the aDAO NFT data work done in the "NFT Inventory" chat, so the follow-on chats (NFT Page pipeline; DAO & TLA pipeline) can start cold without losing anything. Read this top-to-bottom and you have the full picture.

**Repo touched:** `nft-inventory-data_2026` (Terra `phoenix-1`). All NFT-history scripts, workflows, and data live here. Website is `website-adao-core` (Vercel). Render hosts the other crons.

**Status at handoff:** NFT history pipeline is **built, validated, and being deployed** (forward-update workflow running on GitHub Actions). Headline dataset: **1,244 sales** across BBL + Boost + Atrium, with honest USD analytics.

---

## 0. The three-chat plan

| Chat | Charter | State |
|---|---|---|
| **NFT Inventory** (this one) | Build the NFT sales/provenance/analytics pipeline + keep it current. | **Done.** Deploying forward updater. |
| **NFT Page pipeline** (next) | Surface `nft-analytics.json` / `sales-enriched.json` on the website. Replace the hand-maintained Top-10 widget with the live one. | Not started. |
| **DAO & TLA pipeline** (later) | Remaining dashboard/cron work predating this session (TLA deposits, treasury, Member Stats page, NestJS+Postgres horizon). | Carryover. |

---

## 1. What was built (the pipeline)

A complete chain-of-truth history layer for the aDAO NFT collection, in `data/v2/`:

| File | What | Producer |
|---|---|---|
| `nft-provenance.json` | Every `transfer_nft` ever — the hand-change spine (~9,763 tokens, ~19,811 events, full to block ~21.3M / Jun 4 2026). Each event classified. | `nft-provenance-backfill.js` |
| `sales-history.json` | BBL sales (`settle` events) — 1,213. | `bbl-sales-backfill.js` |
| `boost-sales.json` | BoostDAO sales — 30. | `boost-sales-fetch.js` |
| `atrium-sales.json` | Atrium sales (`buy_nft`) — dormant (1 test sale so far). | `atrium-sales-backfill.js` |
| `luna-usd-daily.json` | LUNA→USD daily oracle (CoinGecko, 1,473 pts, 2022→present). | static |
| `bluna-usd-daily.json` | bLUNA oracle + 12 monthly bLUNA/LUNA ratio anchors. | static |
| `sales-enriched.json` | Per-sale priced records, all venues merged (drill-down source). | `nft-analytics-builder.js` |
| `nft-analytics.json` | Dashboard-facing rollups (the headline). | `nft-analytics-builder.js` |

`data/v2/pixel-lions/` = same files for Pixel Lions — **built but parked (not surfaced)**.

### Headline numbers (at handoff)
- **Volume — Tokens:** 181,213 LUNA · 56,992 bLUNA · 250 SOLID · 105 USDC · 1 ampLUNA
- **Volume — USD at sale:** ~$147,128 (vs ~$14,884 at today's price — the gap is the whole point; see §2)
- **Royalties to DAO — Tokens:** 8,831 LUNA · 2,850 bLUNA (≈$7,270 when earned / ≈$715 today)
- 978 first-sales + 233/29/3 resales = 1,244 total.

---

## 2. Decisions & rationale (the "why", so we don't relitigate)

**GitHub Actions vs Render.** Currently on **GitHub Actions** (workflows in this repo). Rationale: the pipeline's whole job is pushing to GitHub, Actions has the native token + native git, and it's free/unlimited on a public repo. Render is where the *other* crons live, so there's a consistency argument for moving it — but that's a *consolidation* choice, not a fix. **Open decision** (see §7). If we move to Render: needs a GitHub **PAT** (Render has no built-in token) and a different chaining mechanism (Render has no git checkout — see §4 "chaining").

**Full-sweep vs incremental forward updater.** The forward updater re-runs the **proven full sweepers** each day (idempotent — rebuilds the complete set from chain). Chosen for **correctness**: the full path is validated, completes in minutes, and self-heals. A true incremental (watermark + DESC-bounded "since last block" fetch) would be lighter but is fragile against the heterogeneous LCD pool and can't be tested from a sandbox — so it's a *later* optimization, not v1.

**USD-at-sale (notional) vs value-today.** A sale's honest USD value = `amount × token-USD on the sale's own date` (what the buyer actually paid). The "today's price × all volume" figure (what BBL/Boost report) is **misleading** — it collapses as LUNA falls and isn't even consistent across collections (BBL implied LUNA $0.090 for aDAO vs $0.256 for Pixel Lions). So **notional-at-sale is the headline; value-today is secondary context only.**

**bLUNA pricing = ratio curve, not raw.** CoinGecko's bLUNA (boneLUNA) USD series is illiquid/gappy (17-month hole) and produces impossible prints. Instead: monthly-median **bLUNA/LUNA ratio** anchors (1.16→1.76, staking accrual), interpolated, × the reliable LUNA oracle on the sale date.

**SOLID/USDC = par ($1); ampLUNA = source hint.** No oracle for SOLID; it trades ≈$1 (Boost's feed showed $1.035), so par is fine for the tiny volume. USDC = par. ampLUNA (1 sale) uses the Boost-provided USD. Replace with real oracles if Atrium/SOLID volume grows.

**Royalties expressed in TOKENS, not USD.** The DAO *holds* royalty tokens (doesn't sell them), so the honest figure is **8,831 LUNA + 2,850 bLUNA**, not "$7,270" (which implies realized dollars that never existed; those tokens are worth ~$715 today). USD kept only as labeled context. This is the third of the three headline metrics.

**Pixel Lions parked.** Backfilled and analyzed (notional ~$46,772) but **not surfaced** — kept in `data/v2/pixel-lions/`, available if we choose to show it later.

---

## 3. Findings & investigations (hard-won, don't re-discover)

- **Sales coverage = BBL + Boost + Atrium, and that's complete.** Checked provenance for *any* sale routing through an unknown venue: **zero** sale-tagged events fall outside BBL+Boost, and **Atrium has exactly 1 event in 3 years** (your test sale). aDAO simply doesn't trade elsewhere.
- **The "unknown" high-volume contracts are all benign** (identified via the inventory cron's constants):
  - `terra1yqv0af…g8ywv` = DAO distribution/mint wallet (5,930 out — the supply source).
  - `terra1h8psjg…rp4l7v` = DAO Treasury (898 broken NFTs, one-way in).
  - `terra1jw84ef…fte89`, `terra17tg0lk…yj09c`, `terra182fvr…0g98h` = DAO-sourced distribution rails (all fed by a single DAO address → rewards/claims, **not** an open secondary marketplace, which would have many sellers).
- **The classifier tags `sale` on `settle` (BBL/Boost) OR `buy_nft` (Atrium).** A *new* marketplace using a different settlement action would log as a plain `transfer` and need a new parser added — same pattern we used for Boost and Atrium. File this as the one thing to watch.
- **Validation:** the 10 reconstructed top sales match the site's existing Top-10 widget **exactly** (token, date, amount). Differences in USD are methodology (our per-date oracle + bLUNA ratio vs the widget's per-sale price + 1:1 bLUNA) and ours is the more defensible figure.
- **Boost was 30 sales, not 3.** The original "3" came from a 20-record HAR *sample* (3 of those 20 were aDAO); the real aDAO total (filtered query) is 30.
- **BBL/Boost `to_usd` are unreliable** — priced at ~today's LUNA, not at-sale (e.g. token #172: Boost said $26, our oracle $103). Reinforces using our oracle for LUNA/bLUNA.
- **Known provenance gap:** stakes use `send_nft` (not in the `transfer_nft` spine), so *stake-in* events aren't captured by provenance; unstake/claim are. A `send_nft` sweep is on the roadmap.

---

## 4. Technical specifics (the spec sheet)

**Contracts**
- NFT: `terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9`
- BBL marketplace `terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9` · BBL fee `terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75`
- Atrium marketplace `terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj` (v1.6.0-rc1)
- Boost launch `terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at`
- DAODAO staking `terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47` · Enterprise staking `terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv`
- DAO main `terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm` · DAO treasury `terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v` · royalty wallet `terra1g0mfrpswewteaf9ky4rlj09wh5njp6u9xxk94uszplw4qz2f9mzq3k27fm`

**Denoms** — `uluna`=LUNA · `terra17aj4ty…npc0ml`=bLUNA · `terra1ecgazyd…s5lvsct`=ampLUNA · `terra10aa3zdkrc7…s0muyst`=SOLID · `ibc/2C96…`=USDC (all 6 decimals).

**Atrium `buy_nft` event** (self-contained settle, on the marketplace contract): attrs `buyer, effective_fee_bps, fee, listing_id, nft_contract, price, royalty, seller, seller_receives, token_id`. Denom = the cw20 the buyer sent `price` of into the marketplace (a `wasm action=send, to=Atrium, amount=price` event → its `_contract_address`); native fallback parses a bank `transfer` to Atrium. Royalty recipient only present when `royalty>0`.

**Boost GraphQL** — `https://api.boostdao.io/graphql`, op `Launches` on `view_launch_prepared`. Where: `{launch_contract: BOOST, real_collection_id: <aDAO>, done: true, ...}`. Fields: `launch_id, from_nft_id, to_id, to_amount, to_usd, discount, creator`. **No timestamp/buyer** → recovered by joining `from_nft_id` to the provenance "NFT left Boost → buyer" event (ordered by `launch_id` as a time proxy).

**LCD pager (publicnode)** — the pool is heterogeneous (some backends ignore `pagination.offset`, prune, or page-ignore). Key trick: the `page` param **is** honored. The backfill uses a "tightest-forward-continuation" pager (accept the smallest forward block ≥ frontier, never far-forward, terminate at global max) for full ASC traversal. Endpoints: `terra-lcd.publicnode.com` + `terra.publicnode.com` with retry/backoff. Correctness > speed for one-time/daily sweeps.

**Chaining (why the workflow has a `git pull`)** — the sweepers push to GitHub but don't update the runner's local files; the analytics builder reads *local* files. So the workflow runs the sweepers, `git pull --ff-only` to bring the fresh seeds into the runner, then the boost fetch (writes local + pushes) and the builder (reads local). On **Render** there's no checkout, so this would instead chain via `/tmp` (each script writes local + pushes) or have the builder fetch inputs from GitHub.

**Conventions** — exact destination filenames on upload (no `_v2`/`_final` suffixes). Scripts run from repo root; data paths relative to `data/v2`. Env: `NFT_CONTRACT`/`COLLECTION` (default aDAO), `RUN_MODE=sample|full`, `GITHUB_TOKEN`/`GITHUB_REPO`/`GITHUB_BRANCH`.

---

## 5. How it runs / operating notes

- **Workflows** (`.github/workflows/`): `nft-backfill.yml` (manual one-time sweeps), `nft-analytics.yml` (manual rebuild), `nft-forward-update.yml` (**daily 06:00 UTC** + manual): provenance → BBL → Atrium → `git pull` → Boost → analytics.
- **Cost:** GitHub Actions is **free and unlimited on public repos** (this repo is public — raw files fetch without auth). Even if private: Free plan = 2,000 min/mo, this uses ~200–300; and the default Actions **spend limit is $0**, so jobs *stop* rather than bill. No push-trigger, so no self-triggering loops.
- **Green run looks like:** each step green; analytics logs `merged 30 Boost sales` / `merged 1 Atrium sales` / `priced 1244/1244`; final commit lands `nft-analytics.json` with `sales_count: 1244`.
- **Deliverables produced this session** (all uploaded to repo root unless noted): `nft-provenance-backfill.js`, `bbl-sales-backfill.js`, `atrium-sales-backfill.js`, `boost-sales-fetch.js`, `nft-analytics-builder.js`, `boost-sales.json` (data/v2), `nft-forward-update.yml` (.github/workflows), `README.md`.

---

## 6. Roadmap / what's next

**NFT pipeline (this chat's domain — all non-urgent)**
- Confirm the forward run is green; (optional) consolidate to Render.
- When Atrium/SOLID volume grows: real SOLID + ampLUNA oracles.
- Analytics extensions: floor-price tracking, listing/ask-price history (floor + DAO-arb signal), collection market cap (floor-based + backing-value-based) + spread, break-events sweep (forfeited ampLUNA), ampLUNA reward-distribution history, `send_nft` stake-in sweep.
- Builder refinements: LUNA-denominated flip P&L, first-sale vs true-resale hold-time split, on-chain boneLUNA `exchange_rate` (replace CoinGecko ratio), per-collection mint-phase tables.
- True incremental forward updater (optimization).

**NFT Page (Chat 2)**
- New page rendering `nft-analytics.json`: volume (tokens + USD-at-sale), royalties-in-tokens, monthly chart, top buyers/sellers, most-traded, flips. Live Top-10 from `sales-enriched.json` replacing the manual widget. Decide nav placement + tie-in to existing inventory tiles on `index.html`.

**DAO & TLA (Chat 3)**
- `index.html`: inline `fetchLiveTlaDeposits`/`queryChain` → `aDAOLive`; `dao_treasury.html` → `aDAOLive.getDaoTreasury()`; TLA Deposits modal → live per-pool; Enterprise Staked chart 403→503 cron-side fix; SS API → `/api/pools` migration.
- Member Stats page (`dao-tla.html`) — not built.
- Horizon: NestJS + Postgres; layered pipeline (discovery→pricing→entities→participants→rollups); three-cadence freshness (live/hourly/daily+rollups); parallel-run via `test.html`. LUNA what-if simulator (deferred).

---

## 7. Open decisions

1. **Render vs Actions for the forward updater** — keep on Actions (works now) or consolidate to Render (PAT + chaining rework). Leaning Actions-now, Render later.
2. **Atrium oracles** — add real SOLID/ampLUNA pricing only once volume justifies it.
3. **Pixel Lions** — leave parked unless there's a reason to surface it.

---

## Recent changes — 2026-06-09 reliability audit pass

- **Never-shrink publish guard** added to all 3 full sweepers (`nft-provenance-`, `bbl-sales-`, `atrium-sales-backfill.js`): a sweep producing fewer records than the committed file aborts (exit 1) instead of overwriting append-only history with a truncated set. (Weekly reconcile is the only full-sweep path; the 6h incremental merges and can't shrink by design.)
- **`nft-inventory.js` unstake fix** (cron-scripts): `buildTxSearchUrl`/`fetchDaodaoTxs` switched from the ignored `pagination.offset` to `page` + `ORDER_BY_DESC`. Note: the pending-claim tracker is forward-only — an already-watermarked miss needs a one-time `lastScannedHeight` rewind in `pending-claims.json` to recover; new unstakes are caught going forward.
- **`nft-analytics-builder.js`**: (F5 oracle staleness) extends the LUNA + bLUNA oracles to "now" using live `network-and-prices` prices (`luna_market.usd_price`, `token_prices.bLUNA.final_price_usd`), so sales dated after the static oracle's last entry price at a live value, falling back to the static oracle if the fetch fails; (F4) boost/atrium/bluna inputs now distinguish a corrupt file (throw) from an absent one (skip), so a corrupt input can't silently drop a whole venue.
- Full cross-system audit record + the F1–F8 checklist: `website-adao-core/CHANGES_PENDING.md` and `cron-scripts/README.md`.
