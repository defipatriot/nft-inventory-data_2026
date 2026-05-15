# nft-inventory-data_2026

Hourly snapshots of the aDAO NFT collection state on-chain.

Produced by the [`nft-inventory`](https://github.com/defipatriot/cron-scripts/tree/main/nft-inventory) cron in [`cron-scripts`](https://github.com/defipatriot/cron-scripts).

---

## Files

| File | Description | Update cadence |
|---|---|---|
| [`data/nfts.json`](./data/nfts.json) | Full per-NFT inventory — owner, broken, rank, image, classification booleans | Hourly |
| [`data/summary.json`](./data/summary.json) | Aggregate counts (minted, broken, daodao, enterprise, holders) + per-owner counts | Hourly |
| [`data/heartbeat.json`](./data/heartbeat.json) | Uniform freshness signal — `capturedAt`, `status`, `stats` | Hourly |

---

## Schema — `summary.json`

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-05-15T00:30:00.000Z",
  "epoch": 185,
  "contracts": {
    "dao_main_wallet": "terra1sffd4...",
    "daodao_staking":  "terra1c57ur...",
    "enterprise_treasury": "terra1h8psj..."
  },
  "total_tokens": 10000,
  "minted_count": 4172,
  "unminted_count": 5828,
  "broken_count": 1093,
  "unbroken_count": 8907,
  "daodao_staked_count": 1673,
  "enterprise_staked_count": 898,
  "unique_holders": 346,
  "dao_members_count": 343,
  "per_owner_counts": { "terra1...": 503, "..." },
  "daodao_stakers":   [ { "address": "terra1...", "count": 25 }, "..." ]
}
```

## Schema — `nfts.json` (per-NFT record)

```json
{
  "id": "1",
  "owner": "terra1...",
  "broken": true,
  "rank": 3,
  "image": "ipfs://bafy.../1.png",
  "name": "AllianceDAO NFT #1",
  "dao": false,
  "minted": true,
  "daodao": false,
  "enterprise": false
}
```

---

## Consumers

- **`index.html`** (Alliance DAO dashboard) — replaces deving.zone dependency:
  - Mint Status slider, Broken Status slider
  - DAODAO Staked / Enterprise Staked tiles
  - DAO Members tile, Supply breakdown modal
  - DAO Broken/Held NFTs tile

- **Future:** TLA Stats page member context, NFT Explorer page

## Companion data

The companion [`marketplace-data_2026`](../marketplace-data_2026) repo provides current marketplace listings (BBL + Boost) which the dashboard merges with this inventory for the "currently listed" badges per NFT.
