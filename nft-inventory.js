// =============================================================================
// NFT Inventory Cron — Rev B.2
// =============================================================================
//
// Captures full per-NFT state for the aDAO collection from on-chain truth.
// Replaces the dashboard's dependency on the third-party deving.zone feed.
//
// Rev B.2 (2026-06-07) — Clean-break path migration:
//   • Output path moved from `data/` → `data/v2/` in the data repo. Old `data/`
//     folder is abandoned (it contained pre-Rev-B data with classification bugs).
//     Consumer pages must swap `/data/foo.json` → `/data/v2/foo.json`.
//   • History reset accepted as the cost of accurate data going forward.
//   • Old data files preserved in `data/` for archaeological review (find when
//     bugs were introduced, salvage anything truthful before that point).
//
// Rev B.1 (2026-06-07) — Polish micro-rev:
//   • Added `dao_wallet_8ywv_held` to heartbeat (was missing, only affected display).
//   • Added `daodao_staked_broken` — broken NFTs staked on DAODAO. Insight: breaking
//     an NFT only forfeits FUTURE ampLUNA rewards; owner keeps the NFT + voting power.
//   • Added `user_held_broken` — broken NFTs held in individual wallets.
//   • Added `user_liquid_count` alias for `user_held_count` (clearer naming).
//
// Rev B (2026-06-06) — Major expansion:
//   • Fixed classification: Treasury (898 broken) was previously mislabeled as
//     "enterprise" — now correctly distinguished from the real Enterprise NFT
//     staking contract (which holds 100 broken + 403 real user stakes).
//   • Enterprise staker resolution via members{} query (per-user counts).
//   • All 3 marketplaces (BBL, Atrium, Boost) — sellers resolved from
//     marketplace contracts (not raw cw721 owner).
//   • Backing & yield: ampLUNA treasury balance + per-NFT share + boost-mechanic
//     metrics. Daily snapshot enables future timeline tracking (Rev C).
//
// What it produces (uploaded to `nft-inventory-data_2026` under `data/v2/`):
//
//   data/v2/nfts.json       ← per-NFT records: { id, owner, real_owner, broken,
//                             listing{...}, classification flags, ... }
//                             (large file, ~10k entries, ~2.5 MB)
//   data/v2/summary.json    ← aggregate counts + per-holder breakdowns + backing
//                             + marketplace stats + daodao_stakers + enterprise_stakers
//   data/v2/heartbeat.json  ← uniform freshness contract
//   data/v2/daily/<date>.json ← daily snapshot of summary (for movement/yield timeline)
//
// The OLD `data/` folder (pre-Rev-B) is ABANDONED. It contains pre-cleanup data with
// classification bugs (treasury mislabeled, no Atrium, etc.). Retained for archaeology.
//
// Schedule: hourly at :30 (Render cron: `30 * * * *`)
// Runtime:  ~70 seconds (10k chain queries + 3 marketplaces + enterprise + backing)
//
// Backward compatibility: existing record-level fields (dao, daodao, enterprise)
// are preserved as aliases so the current dashboard JS continues to work during
// the Rev B → Rev 2 (page migration) window. New code should prefer the clean
// names (unminted, daodao_staked, treasury_held).
//
// Architecture rule preserved: marketplaces and Enterprise queries are
// independent — failures are non-fatal. Aggregate counts still ship even if
// any single sub-system fails. See cron-scripts/README.md for the broader
// "independent systems" principle.
// =============================================================================

const https = require('https');
const fs    = require('fs');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

// aDAO NFT collection
const ADAO_NFT_CONTRACT = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';

// Known custody locations
// Verified live 2026-06-06 via chain queries; see Rev B session log.
const DAO_MAIN_WALLET           = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';
const DAODAO_STAKING_CONTRACT   = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';
const DAO_TREASURY_CONTRACT     = 'terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v'; // previously mislabeled "enterprise" — holds 898 broken NFTs for DAO governance
const ENTERPRISE_NFT_STAKING    = 'terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv'; // REAL Enterprise NFT staking; holds 503 NFTs (100 broken/DAO + 403 user stakes)
const DAO_WALLET_8YWV           = 'terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv'; // small DAO-controlled wallet with 2 broken NFTs

// Marketplaces
const BBL_MARKETPLACE    = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9'; // bbl-necropolis-marketplace v2.2.2
const ATRIUM_MARKETPLACE = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj'; // atrium-marketplace v1.6.0-rc1
const BOOST_MARKETPLACE  = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at'; // launch-nft v1.4.0 (launch-nft-permissionless)

// Backing token — aDAO NFT collection accrues ampLUNA from Alliance staking
const AMPLUNA_CW20 = 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';

// Query/pagination tuning
const ALL_TOKENS_PAGE      = 30;     // CW721 default cap
const MARKETPLACE_PAGE     = 30;     // BBL/Atrium/Boost default
const ENTERPRISE_MEMBERS_PAGE = 30;
const NFT_INFO_CONCURRENCY = 30;     // benchmarked: 100 queries in ~470ms; 10k → ~47s
const HTTP_TIMEOUT_MS      = 15000;
const RETRIES              = 3;

// GitHub publish (matches other crons' env contract)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Output path within the data repo. Rev B.2 (2026-06-07): moved from `data/` → `data/v2/`
// to make a clean break from the pre-Rev-B data which had classification bugs (treasury
// mislabeled as enterprise, no Atrium awareness, etc.). The old `data/` folder is
// abandoned but retained for archaeological purposes — see "Pre-Rev-B data" in README.
//
// To migrate: any consumer page should swap `/data/foo.json` → `/data/v2/foo.json`.
const OUTPUT_PATH = 'data/v2';

// Sister cron data repos (read-only fetches for prices & catalog token metadata)
// These are PUBLIC — no auth needed.
const PRICES_DATA_URL  = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';
const CATALOG_DATA_URL = 'https://raw.githubusercontent.com/defipatriot/tla-chain-registry/main/2026/current.json';

// DAODAO pending-claim tracking (Rev B.3). Forward-only state persisted in the data repo.
const PENDING_CLAIMS_PATH    = `${OUTPUT_PATH}/pending-claims.json`;
const PENDING_CLAIMS_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUTPUT_PATH}/pending-claims.json`;
const UNSTAKE_WINDOW_SECONDS = 604800;                      // 7-day DAODAO claim queue (claim_duration in unstake events)
const UNSTAKE_WINDOW_MS      = UNSTAKE_WINDOW_SECONDS * 1000;

// ─── Rev C: tiered run modes (hot / warm / cold-full) ───────────────────────
// One script, three Render cron jobs, selected by RUN_MODE. The ONLY thing mode
// changes is which token IDs get per-NFT fetched (Phase 1+2). Phases 3-7 (cheap
// aggregate queries) run identically in every mode, so the merged output is always
// a complete 10k picture — just with stale-but-stable records for tokens outside
// the scope (those can't move without a governance prop and are reconciled weekly).
//   full (weekly, default): enumerate + fetch all 10k, full reconcile, (re)write hot-set.json
//   warm (daily):           hot set ∪ staked sets; merge fresh onto the last full base
//   hot  (every 15 min):    hot set only (user-held + marketplace + pending); merge onto base
// Default is 'full' so existing/unconfigured deployments behave exactly as before.
const RUN_MODE = (process.env.RUN_MODE || 'full').toLowerCase();
const HOT_SET_PATH    = `${OUTPUT_PATH}/hot-set.json`;
const HOT_SET_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUTPUT_PATH}/hot-set.json`;
const NFTS_RAW_URL    = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUTPUT_PATH}/nfts.json`;
// Owners that mark an NFT as "stable" (pure DAO custody, can't move without a prop).
// Anything NOT owned by one of these is user-held or marketplace-owned → hot.
// The two staking contracts are stable-ish but get their own (warm) refresh cadence.
const STABLE_DAO_OWNERS = [DAO_MAIN_WALLET, DAO_TREASURY_CONTRACT, DAO_WALLET_8YWV];
const STAKING_OWNERS    = [DAODAO_STAKING_CONTRACT, ENTERPRISE_NFT_STAKING];

// TLA epoch math (for heartbeat consistency with other crons)
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
function currentEpoch() {
    return Math.floor((Date.now() - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;
}

function todayUtcDate() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-nft-inventory/2.2' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 100)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label, maxTries = RETRIES) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 500;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

async function tryFetchJson(url, label, timeoutMs = HTTP_TIMEOUT_MS) {
    // Returns null on failure instead of throwing — for optional dependencies.
    try {
        return await fetchJson(url, label, timeoutMs);
    } catch (e) {
        console.warn(`  ⚠ ${label} fetch failed (non-fatal): ${e.message}`);
        return null;
    }
}

async function queryContract(contract, queryObj, label = '') {
    const b64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const tryLcd = async (base) => {
        const url = `${base}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`;
        return (await fetchJson(url, label || `LCD ${base.slice(8, 28)}`)).data;
    };
    try {
        return await tryLcd(TERRA_LCD_PRIMARY);
    } catch (e1) {
        return await tryLcd(TERRA_LCD_FALLBACK);
    }
}

async function queryContractSafe(contract, queryObj, label = '') {
    // Returns null on failure — for non-critical queries.
    try {
        return await queryContract(contract, queryObj, label);
    } catch (e) {
        console.warn(`  ⚠ ${label} query failed (non-fatal): ${e.message}`);
        return null;
    }
}

// Parallel mapping with bounded concurrency. Errors don't abort the whole batch;
// individual failures are returned as { _error } objects so callers can decide.
async function parallelMap(items, fn, concurrency) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); }
            catch (e) { results[i] = { _error: e.message }; }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}

// -----------------------------------------------------------------------------
// PHASE 1 — Enumerate all token IDs via paginated all_tokens
// -----------------------------------------------------------------------------

async function enumerateAllTokens() {
    console.log('🔍 Phase 1: enumerating all token IDs...');
    const t0 = Date.now();
    const all = [];
    let startAfter = null;
    let page = 0;
    while (true) {
        const query = startAfter
            ? { all_tokens: { limit: ALL_TOKENS_PAGE, start_after: startAfter } }
            : { all_tokens: { limit: ALL_TOKENS_PAGE } };
        const data = await queryContract(ADAO_NFT_CONTRACT, query, `all_tokens page ${page}`);
        const tokens = data?.tokens || [];
        if (tokens.length === 0) break;
        all.push(...tokens);
        startAfter = tokens[tokens.length - 1];
        page++;
        if (page % 50 === 0) {
            process.stdout.write(`  Page ${page}: cumulative ${all.length} tokens\r`);
        }
        if (tokens.length < ALL_TOKENS_PAGE) break;
    }
    console.log(`  ✓ ${all.length} token IDs (${page} pages) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return all;
}

// -----------------------------------------------------------------------------
// PHASE 2 — Per-NFT: owner + attributes (broken, rank, image)
// -----------------------------------------------------------------------------

function extractAttr(attributes, traitType) {
    if (!Array.isArray(attributes)) return null;
    const found = attributes.find(a => a?.trait_type === traitType);
    return found ? found.value : null;
}

function classifyOwner(owner, broken) {
    // Returns the classification flags for one NFT given its raw cw721 owner.
    // The seller resolution (for marketplace listings) happens in a later phase
    // and overwrites `real_owner` — this function uses raw chain ownership.
    const f = {
        // Backward-compat aliases (preserve current dashboard JS during Rev 2 migration)
        dao:        owner === DAO_MAIN_WALLET,
        daodao:     owner === DAODAO_STAKING_CONTRACT,
        enterprise: owner === DAO_TREASURY_CONTRACT, // PRESERVED for backward compat — but now means "treasury_held"

        // Canonical clean names (use these going forward)
        unminted:                owner === DAO_MAIN_WALLET,
        daodao_staked:           owner === DAODAO_STAKING_CONTRACT,
        treasury_held:           owner === DAO_TREASURY_CONTRACT,
        dao_wallet_8ywv_held:    owner === DAO_WALLET_8YWV,
        enterprise_staked:       owner === ENTERPRISE_NFT_STAKING && !broken,
        enterprise_dao_broken:   owner === ENTERPRISE_NFT_STAKING && broken,
        bbl_listed:              owner === BBL_MARKETPLACE,
        atrium_listed:           owner === ATRIUM_MARKETPLACE,
        boost_listed:            owner === BOOST_MARKETPLACE,

        // Set later by applyPendingClaimFlags() once pending-claim data is known.
        // A DAODAO-unstaked NFT sits in the contract's 7-day claim queue: still in
        // custody (owner == staking contract) but no longer actively staked.
        daodao_pending_claim:    false,

        // Set later by applyStakerResolution() — true for an Enterprise stake whose
        // staker can't be enumerated (abandoned contract). Explorer label: "Enterprise (legacy)".
        enterprise_unattributed: false,
    };
    // user_held = everything else (individual wallet, not in any known custody)
    const knownCustody = (
        f.unminted || f.daodao_staked || f.treasury_held || f.dao_wallet_8ywv_held ||
        f.enterprise_staked || f.enterprise_dao_broken ||
        f.bbl_listed || f.atrium_listed || f.boost_listed
    );
    f.user_held = !knownCustody;
    return f;
}

async function fetchOneNft(tokenId) {
    const data = await queryContract(
        ADAO_NFT_CONTRACT,
        { all_nft_info: { token_id: tokenId } },
        `nft #${tokenId}`,
    );
    const owner = data?.access?.owner;
    const extension = data?.info?.extension || {};
    const attrs = extension.attributes || [];
    const brokenStr = extractAttr(attrs, 'broken');
    const rankStr   = extractAttr(attrs, 'Rarity') ?? extractAttr(attrs, 'rank');
    const broken = brokenStr === 'true' || brokenStr === true;
    const rankNum = (() => {
        const n = parseInt(rankStr, 10);
        return Number.isFinite(n) ? n : null;
    })();
    const cls = classifyOwner(owner, broken);
    return {
        id: tokenId,
        owner,                          // raw cw721 owner (might be a marketplace/staking contract)
        real_owner: owner,              // overwritten by Phase 4 for marketplace-listed NFTs
        broken,
        rank: rankNum,
        image: extension.image || null,
        name:  extension.name  || null,

        // Marketplace listing detail — populated by Phase 4
        listing: null,                  // { marketplace, seller, price_raw, denom, price_token_symbol, price_token_decimals, price_display, price_usd, internal_id, listing_type, created_at?, raw }

        // Minted = anything that has been claimed by a user OR moved into DAO control mechanisms.
        // Backward-compat semantic preserved: minted = !held by DAO main wallet (unminted set).
        minted: !cls.unminted,

        // Spread all the classification flags onto the record
        ...cls,
    };
}

async function fetchAllNftInfo(tokenIds) {
    console.log(`📦 Phase 2: fetching per-NFT info for ${tokenIds.length} tokens (concurrency ${NFT_INFO_CONCURRENCY})...`);
    const t0 = Date.now();
    let progressDone = 0;
    const reportEvery = Math.max(500, Math.floor(tokenIds.length / 20));
    const records = await parallelMap(tokenIds, async (id) => {
        const r = await fetchOneNft(id);
        progressDone++;
        if (progressDone % reportEvery === 0) {
            const pct = ((progressDone / tokenIds.length) * 100).toFixed(0);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            process.stdout.write(`  ${progressDone}/${tokenIds.length} (${pct}%) — ${elapsed}s elapsed\r`);
        }
        return r;
    }, NFT_INFO_CONCURRENCY);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const failed = records.filter(r => r._error);
    console.log(`  ✓ ${records.length - failed.length}/${records.length} NFTs captured in ${elapsed}s`);
    if (failed.length > 0) {
        console.log(`  ⚠ ${failed.length} failures (sample): ${failed.slice(0, 3).map(f => f._error).join(' | ')}`);
    }
    return records.filter(r => r && !r._error);
}

// -----------------------------------------------------------------------------
// PHASE 3 — Enterprise NFT staking members
// -----------------------------------------------------------------------------
//
// Enterprise NFT staking contract holds 503 NFTs total: 100 broken (DAO control)
// + 403 real user stakes. We query `members{}` paginated to get per-user weight
// (= NFT count staked). Failures are non-fatal — aggregate counts still ship.
//
// The "DAO control" 100 are detected via Phase 2 (broken && owner == ENTERPRISE_NFT_STAKING).
// The 403 real stakers come from members{} response.

async function fetchEnterpriseStakers() {
    console.log('👥 Phase 3: fetching Enterprise NFT stakers (via members{})...');
    const t0 = Date.now();
    const all = [];
    let startAfter = null;
    let page = 0;
    try {
        while (true) {
            const query = startAfter
                ? { members: { limit: ENTERPRISE_MEMBERS_PAGE, start_after: startAfter } }
                : { members: { limit: ENTERPRISE_MEMBERS_PAGE } };
            const data = await queryContract(ENTERPRISE_NFT_STAKING, query, `enterprise members page ${page}`);
            const members = data?.members || [];
            if (members.length === 0) break;
            all.push(...members);
            startAfter = members[members.length - 1]?.user || members[members.length - 1]?.address;
            page++;
            if (members.length < ENTERPRISE_MEMBERS_PAGE) break;
        }
    } catch (e) {
        console.warn(`  ⚠ Enterprise members fetch failed (non-fatal): ${e.message}`);
        return [];
    }
    // Normalize entries — Enterprise's exact field name may be `user` or `address`,
    // and weight may be `weight` or `nfts` depending on the contract version.
    const stakers = all
        .map(m => ({
            address: m.user || m.address,
            count: Number(m.weight || m.nfts || m.count || 0),
        }))
        .filter(s => s.address && s.count > 0)
        .sort((a, b) => b.count - a.count);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const total = stakers.reduce((sum, s) => sum + s.count, 0);
    console.log(`  ✓ ${stakers.length} Enterprise stakers (total ${total} NFTs staked) in ${elapsed}s`);
    return stakers;
}

// -----------------------------------------------------------------------------
// PHASE 4 — Marketplace queries (BBL + Atrium + Boost)
// -----------------------------------------------------------------------------
//
// Each marketplace stores its listings differently. We normalize to a common
// shape and merge back into the per-NFT records, overwriting `real_owner` with
// the original seller (so the explorer page shows the rightful owner, not the
// marketplace contract address).
//
// Each marketplace is queried independently in parallel — one failure doesn't
// stall the others. Per-marketplace failure logs warning and returns [].

// BBL: query `auction_by_contract` with nft_contract filter
//
// Response per auction:
//   { auction_id, auction_type, nft_contract, token_id, seller, denom,
//     reserve_price, amount, bidder, end_time, creator_address, royalty_fee,
//     is_settled, offers }
async function fetchBblListings() {
    const out = [];
    const seenIds = new Set();
    let startAfter = null;
    let page = 0;
    while (true) {
        const params = {
            nft_contract: ADAO_NFT_CONTRACT,
            limit: MARKETPLACE_PAGE,
            ...(startAfter ? { start_after: startAfter } : {}),
        };
        const data = await queryContract(BBL_MARKETPLACE, { auction_by_contract: params }, `bbl page ${page}`);
        const auctions = data?.auctions || [];
        if (auctions.length === 0) break;                       // exhausted
        // Pagination-progress vs kept-listings are tracked SEPARATELY: a page can be all
        // settled auctions (0 kept) while still advancing the cursor (new ids). Only zero
        // NEW ids means the contract is returning the same window — the stuck guard.
        let newIds = 0;
        for (const a of auctions) {
            const id = a?.auction_id;
            if (id == null || seenIds.has(String(id))) continue;
            seenIds.add(String(id));
            newIds++;
            if (a.is_settled === true) continue;                // settled = sold/closed, never a live listing
            out.push(a);
        }
        if (newIds === 0) break;                                // stuck pagination (same window returned)
        // BBL pagination key: most likely auction_id (numeric, string-typed). We pass the last one.
        const lastId = auctions[auctions.length - 1]?.auction_id;
        if (!lastId) break;
        startAfter = lastId;
        page++;
        // NOTE (bug fix 2026-06-10): do NOT break on a short page (`auctions.length <
        // MARKETPLACE_PAGE`). The contract can return fewer rows than the limit mid-sweep
        // (server-side filtering after pagination), and breaking there silently dropped the
        // NEWEST auctions — verified live: 6 listings (auction_ids ~17.7K, sellers …jy9mpm /
        // …s2xt53) missing vs warlock's 35. Loop ends only on empty page / stuck ids / cap.
        if (page > 100) { console.warn('  ⚠ BBL pagination cap hit (100 pages) — stopping'); break; }
    }
    return out.map(a => ({
        marketplace: 'BBL',
        internal_id: a.auction_id,
        token_id: a.token_id,
        seller: a.seller,
        price_raw: a.reserve_price,
        denom: a.denom,
        listing_type: a.auction_type, // 'buy_now' or auction-style
        royalty_fee: a.royalty_fee,
        creator_address: a.creator_address,
        bidder: a.bidder,
        end_time: a.end_time,
        raw: a,
    }));
}

// Atrium: query `listings_by_collection` with collection filter
//
// Response per listing:
//   { id, seller, nft_contract, token_id, price, payment: {Cw20: {contract_addr}},
//     expires_at, created_at, whitelisted_buyer, time_locked_until, locked_for, whitelist }
// Atrium's `listings_by_collection` *variant* is stable, but the collection field
// NAME has drifted across contract upgrades — it now rejects `collection` with a 500
// ("unknown field `collection`"). We probe the common CosmWasm field-name conventions
// once per process, memoize the winner, and reuse it for pagination. If none match, we
// surface the contract's full valid-field list (untruncated) so it can be pinned in one
// follow-up. Either way there's no regression: Atrium-held NFTs are already classified
// by cw721 ownership; this only adds price/seller detail on top.
let ATRIUM_COLLECTION_FIELD = null;
const ATRIUM_COLLECTION_FIELD_CANDIDATES = [
    'collection_addr', 'nft_contract', 'collection_address',
    'address', 'contract', 'contract_addr', 'cw721', 'collection',
];

async function resolveAtriumCollectionField() {
    if (ATRIUM_COLLECTION_FIELD) return ATRIUM_COLLECTION_FIELD;
    for (const field of ATRIUM_COLLECTION_FIELD_CANDIDATES) {
        try {
            const data = await queryContract(
                ATRIUM_MARKETPLACE,
                { listings_by_collection: { [field]: ADAO_NFT_CONTRACT, limit: 1 } },
                `atrium probe ${field}`
            );
            if (data && (Array.isArray(data.listings) || Array.isArray(data))) {
                ATRIUM_COLLECTION_FIELD = field;
                console.log(`  ℹ Atrium collection field resolved to '${field}'`);
                return field;
            }
        } catch (_) { /* wrong field name → try the next candidate */ }
    }
    // Nothing matched — log the contract's full error body (fetchJson truncates to 100
    // chars, so do a direct fetch here to capture the "expected one of …" field list).
    try {
        const b64 = Buffer.from(JSON.stringify({ listings_by_collection: { collection: ADAO_NFT_CONTRACT, limit: 1 } })).toString('base64');
        const res = await fetch(`${TERRA_LCD_PRIMARY}/cosmwasm/wasm/v1/contract/${ATRIUM_MARKETPLACE}/smart/${b64}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-nft-inventory/2.2' } });
        const body = await res.text().catch(() => '');
        console.warn(`  ⚠ Atrium collection field unresolved — contract reports: ${body.slice(0, 400)}`);
    } catch (_) { /* diagnostic only */ }
    return null;
}

async function fetchAtriumListings() {
    const field = await resolveAtriumCollectionField();
    if (!field) return [];   // ownership classification already covers Atrium-held NFTs
    const out = [];
    const seenIds = new Set();
    let startAfter = null;
    let page = 0;
    while (true) {
        const params = {
            [field]: ADAO_NFT_CONTRACT,
            limit: MARKETPLACE_PAGE,
            ...(startAfter ? { start_after: startAfter } : {}),
        };
        const data = await queryContract(ATRIUM_MARKETPLACE, { listings_by_collection: params }, `atrium page ${page}`);
        const listings = data?.listings || [];
        if (listings.length === 0) break;
        let added = 0;
        for (const l of listings) {
            const id = l?.id;
            if (id == null || seenIds.has(String(id))) continue;
            seenIds.add(String(id));
            out.push(l);
            added++;
        }
        if (added === 0) break;
        const lastId = listings[listings.length - 1]?.id;
        if (lastId == null) break;
        startAfter = lastId;
        page++;
        if (listings.length < MARKETPLACE_PAGE) break;
        if (page > 100) { console.warn('  ⚠ Atrium pagination cap hit (100 pages) — stopping'); break; }
    }
    return out.map(l => {
        // Atrium payment is wrapped: { Cw20: { contract_addr: 'terra1...' } } or { Native: 'uluna' }
        const pay = l.payment || {};
        let denom = null;
        if (pay.Cw20) denom = 'cw20:' + (pay.Cw20.contract_addr || pay.Cw20);
        else if (pay.Native) denom = pay.Native;
        return {
            marketplace: 'Atrium',
            internal_id: l.id,
            token_id: l.token_id,
            seller: l.seller,
            price_raw: l.price,
            denom,
            listing_type: 'fixed',
            created_at: l.created_at,  // block height
            expires_at: l.expires_at,
            whitelisted_buyer: l.whitelisted_buyer,
            raw: l,
        };
    });
}

// Boost: query `launches` — returns ALL launches across ALL collections + ALL history
// (active + cancelled + done). We must client-side filter.
//
// Per-launch shape (varies a lot):
//   { id, name, cancelled, done, owner (=seller), from: {contract, token_id},
//     to_info: { native?: 'uluna'|'ibc/...'|'cw20:terra1...', cw20?: 'terra1...' },
//     runtime: {
//       nft?: { setup: { to_amount: '...' }, runtime: {} },
//       la?:  { setup: { to_amount: '...' }, runtime: {...} },
//     }
//   }
async function fetchBoostListings() {
    const out = [];
    const seenIds = new Set();
    let startAfter = null;
    let page = 0;
    // Boost may use `start_after` keyed by id. We try empty first, then paginate.
    while (true) {
        const params = { ...(startAfter != null ? { start_after: startAfter } : {}) };
        const data = await queryContract(BOOST_MARKETPLACE, { launches: params }, `boost page ${page}`);
        // Boost's response format: data is an array directly (not wrapped in {launches: [...]}).
        // Defensive: accept either shape.
        const arr = Array.isArray(data) ? data : (data?.launches || data?.data || []);
        if (!Array.isArray(arr) || arr.length === 0) break;
        let added = 0;
        for (const l of arr) {
            const id = l?.id;
            if (id == null || seenIds.has(String(id))) continue;
            seenIds.add(String(id));
            out.push(l);
            added++;
        }
        if (added === 0) break;
        const lastId = arr[arr.length - 1]?.id;
        if (lastId == null) break;
        startAfter = lastId;
        page++;
        if (arr.length < MARKETPLACE_PAGE) break;
        if (page > 200) { console.warn('  ⚠ Boost pagination cap hit (200 pages) — stopping'); break; }
    }
    // Filter to active aDAO launches only
    const active = out.filter(l =>
        l && !l.cancelled && !l.done &&
        l.from?.contract === ADAO_NFT_CONTRACT
    );
    return active.map(l => {
        // Boost to_info shape: defensive — may be either {native: 'X'} or {cw20: 'X'}
        // And `native` field sometimes contains a 'cw20:' prefix string. Normalize.
        const info = l.to_info || {};
        let denom = null;
        if (info.cw20) denom = 'cw20:' + info.cw20;
        else if (info.native) denom = info.native; // already includes cw20: prefix if applicable
        // Amount: from runtime.nft.setup.to_amount OR runtime.la.setup.to_amount
        const rt = l.runtime || {};
        const amount = rt.nft?.setup?.to_amount || rt.la?.setup?.to_amount || null;
        return {
            marketplace: 'Boost',
            internal_id: l.id,
            token_id: l.from?.token_id,
            seller: l.owner,
            price_raw: amount,
            denom,
            listing_type: rt.la ? 'launch_agreement' : 'setup',
            name: l.name || null,
            raw: l,
        };
    });
}

// Orchestrator — runs all 3 in parallel, returns combined list
//
// BBL liveness cross-check (added 2026-06-10): the BBL contract can hold auctions that
// are structurally live (is_settled:false, no bidder, end_time 0) yet NOT visible or
// buyable on BBL — verified live with auction 14765 / token #745, which set a phantom
// $17.59 floor while BBL's UI and API both ignored it. We can't fix BBL; we define what
// "listed" means for this pipeline: VISIBLE AND BUYABLE ON THE VENUE. Warlock (BBL's own
// API, the same one bbl-rarity mirrors) is the liveness oracle for BBL specifically:
// chain auctions absent from warlock are EXCLUDED from listings and logged as warnings
// (flagged, never silent). If warlock itself is unreachable, we keep the chain set
// unfiltered and warn — a BBL API outage must not blank our listings (F7: degrade
// honestly, don't amplify).

const WARLOCK_NFTS_API = 'https://warlock.backbonelabs.io/api/v1/dapps/necropolis/nfts';
const WARLOCK_PER_PAGE = 60;
const WARLOCK_PAGE_CAP = 12;   // 720 records, far above any plausible live-listing count

// Fetch the set of auction_ids warlock currently serves for this collection.
// price-asc puts listed tokens first, so we stop at the first page with zero auctions.
// Returns { ok, ids:Set<string>, byAuctionId:Map<string,{token_id,seller}> }.
async function fetchWarlockLiveBblAuctions() {
    const ids = new Set();
    const byAuctionId = new Map();
    try {
        for (let p = 1; p <= WARLOCK_PAGE_CAP; p++) {
            const url = `${WARLOCK_NFTS_API}?nftContract=${ADAO_NFT_CONTRACT}&page=${p}&perPage=${WARLOCK_PER_PAGE}&types=all&sort=price-asc`;
            const j = await fetchJsonWithRetry(url, `warlock listings p${p}`);
            const nfts = Array.isArray(j?.nfts) ? j.nfts : [];
            if (nfts.length === 0) break;
            let pageAuctions = 0;
            for (const n of nfts) {
                if (n?.auction?.auction_id != null) {
                    const id = String(n.auction.auction_id);
                    ids.add(id);
                    byAuctionId.set(id, { token_id: String(n.nft_token_id), seller: n.auction.seller });
                    pageAuctions++;
                }
            }
            if (pageAuctions === 0) break;   // price-asc lists auctions first — past them now
        }
        return { ok: true, ids, byAuctionId };
    } catch (e) {
        console.warn(`  ⚠ warlock liveness check unavailable: ${e.message}`);
        return { ok: false, ids, byAuctionId };
    }
}

async function fetchMarketplaces() {
    console.log('🏪 Phase 4: fetching marketplace listings (BBL + Atrium + Boost)...');
    const t0 = Date.now();
    const [bblChain, atrium, boost, warlock] = await Promise.all([
        fetchBblListings().catch(e => { console.warn(`  ⚠ BBL failed: ${e.message}`); return []; }),
        fetchAtriumListings().catch(e => { console.warn(`  ⚠ Atrium failed: ${e.message}`); return []; }),
        fetchBoostListings().catch(e => { console.warn(`  ⚠ Boost failed: ${e.message}`); return []; }),
        fetchWarlockLiveBblAuctions(),
    ]);

    const listingWarnings = [];
    let bbl = bblChain;
    if (warlock.ok && warlock.ids.size > 0) {
        // Exclude chain-only auctions (on-chain but not served by BBL's own API/UI).
        bbl = [];
        for (const l of bblChain) {
            if (warlock.ids.has(String(l.internal_id))) { bbl.push(l); continue; }
            listingWarnings.push({ scope: 'bbl', reason: 'chain_only_not_on_warlock', auction_id: String(l.internal_id), token_id: String(l.token_id), seller: l.seller });
            console.warn(`  ⚠ BBL auction ${l.internal_id} (token #${l.token_id}) is on-chain but NOT on warlock — excluded from listings (phantom/cancelled-unclaimed)`);
        }
        // Inverse check — warlock listings our chain sweep missed. After the pagination
        // fix this should be empty; if it ever isn't, that's the completeness detector.
        const chainIds = new Set(bblChain.map(l => String(l.internal_id)));
        for (const [id, info] of warlock.byAuctionId) {
            if (!chainIds.has(id)) {
                listingWarnings.push({ scope: 'bbl', reason: 'warlock_only_missing_from_chain_sweep', auction_id: id, token_id: info.token_id, seller: info.seller });
                console.warn(`  ⚠ warlock serves auction ${id} (token #${info.token_id}) but the chain sweep didn't return it — completeness gap`);
            }
        }
    } else if (bblChain.length > 0) {
        listingWarnings.push({ scope: 'bbl', reason: 'warlock_unavailable_chain_set_unfiltered', chain_count: bblChain.length });
        console.warn(`  ⚠ warlock unavailable — BBL listings (${bblChain.length}) published unfiltered (no liveness cross-check this run)`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ BBL ${bbl.length} (chain ${bblChain.length}, warlock ${warlock.ids.size}), Atrium ${atrium.length}, Boost ${boost.length} listings in ${elapsed}s`);
    return { bbl, atrium, boost, listingWarnings };
}

// -----------------------------------------------------------------------------
// PHASE 5 — DAODAO stakers via daodao.zone indexer
// -----------------------------------------------------------------------------
//
// The on-chain DAODAO contract (dao-voting-cw721-staked v2.5.0) has NO
// enumerable staker list — only per-address `staked_nfts(address)` queries.
// The indexer is the canonical source for "who staked what." Non-fatal.

const DAODAO_INDEXER_URL = `https://indexer.daodao.zone/phoenix-1/contract/${DAODAO_STAKING_CONTRACT}/daoVotingCw721Staked/topStakers`;

async function fetchDaodaoStakers() {
    console.log('👥 Phase 5: fetching DAODAO stakers (via daodao.zone indexer)...');
    try {
        const data = await fetchJson(DAODAO_INDEXER_URL, 'daodao-indexer-topStakers');
        if (!Array.isArray(data)) {
            console.warn('  ⚠ Indexer returned non-array response');
            return [];
        }
        // Indexer entry shape: { address, count, votingPowerPercent }
        const stakers = data.map(s => ({
            address: s.address,
            count: s.count || 0,
            voting_power_pct: s.votingPowerPercent || 0,
        })).sort((a, b) => b.count - a.count);
        console.log(`  ✓ ${stakers.length} DAODAO stakers (from indexer)`);
        return stakers;
    } catch (e) {
        console.warn(`  ⚠ DAODAO stakers fetch failed (non-fatal): ${e.message}`);
        return [];
    }
}

// -----------------------------------------------------------------------------
// PHASE 5b — Resolve staked NFTs to their REAL staker (per-token)
// -----------------------------------------------------------------------------
//
// Holder/leaderboard views group records by `real_owner`. Active DAODAO and
// Enterprise stakes sit at the staking CONTRACT on-chain, so without this they
// appear as phantom whales (the contract counted as one giant holder) and the
// real stakers vanish. We resolve each staked token back to its staker, exactly
// the way mergeMarketplaceListings() resolves a listing back to its seller:
//   • DAODAO     → staked_nfts{address,start_after,limit}  (flat array of token ids)
//   • Enterprise → user_stake{user,limit}                  ({ tokens[], total_user_stake })
//
// Both verify completeness against the known per-staker count and push any gap
// to `_errors` rather than silently truncating. `enterprise_dao_broken` (the ~100
// DAO-governance NFTs) are NOT resolved — they correctly stay attributed to the
// Enterprise contract address. Unresolved tokens fall back to real_owner = owner
// (never null — the explorer hard-fails on a null owner).

const STAKE_RESOLVE_CONCURRENCY = 5;          // gentle on publicnode (matches adao-positions ≤5 rule)
const DAODAO_STAKED_PAGE = 30;                // cw721-staked staked_nfts page size
const ENTERPRISE_USER_STAKE_LIMIT = 1000;     // larger than any single staker's holding (max ~100 today)

// DAODAO: staked_nfts(address) per staker → { map: {token_id(str) -> staker}, errors }
async function resolveDaodaoStakerTokens(daodaoStakers) {
    console.log(`🧩 Phase 5b: resolving DAODAO staked tokens → staker (${daodaoStakers.length} stakers)...`);
    const t0 = Date.now();
    const map = {};
    const errors = [];      // hard: flips heartbeat → partial
    const warnings = [];    // soft: logged + surfaced, status stays ok (e.g. indexer lag)
    await parallelMap(daodaoStakers, async (s) => {
        const expected = Number(s.count || 0);
        const collected = [];
        let startAfter = null;
        for (let page = 0; page < 500; page++) {
            const q = { staked_nfts: { address: s.address, limit: DAODAO_STAKED_PAGE, ...(startAfter ? { start_after: startAfter } : {}) } };
            const res = await queryContractSafe(DAODAO_STAKING_CONTRACT, q, `daodao staked_nfts ${s.address.slice(-6)} p${page}`);
            if (res == null) {                                  // query FAILED (not empty) — do not coerce
                errors.push({ scope: 'daodao', address: s.address, reason: 'query_failed', page });
                return;                                         // leave this staker's tokens unresolved
            }
            const tokens = Array.isArray(res) ? res : (Array.isArray(res.token_ids) ? res.token_ids : []);
            for (const t of tokens) collected.push(String(t));
            if (tokens.length < DAODAO_STAKED_PAGE) break;      // authoritative: chain returned the full page-tail
            startAfter = String(tokens[tokens.length - 1]);
        }
        // The chain pagination above is authoritative. The indexer count is only a
        // cross-check — a mismatch usually means indexer lag, not missing data, so
        // it's a warning, not a status-flipping error.
        if (expected && collected.length !== expected) {
            warnings.push({ scope: 'daodao', address: s.address, reason: 'count_vs_indexer', indexer: expected, chain: collected.length });
        }
        for (const tid of collected) map[tid] = s.address;
    }, STAKE_RESOLVE_CONCURRENCY);
    console.log(`  ✓ DAODAO: ${Object.keys(map).length} tokens → staker (${errors.length} errors, ${warnings.length} warnings) in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    return { map, errors, warnings };
}

// Enterprise: user_stake(user,limit) per member → { map, errors }
async function resolveEnterpriseStakerTokens(enterpriseStakers) {
    console.log(`🧩 Phase 5b: resolving Enterprise staked tokens → staker (${enterpriseStakers.length} stakers)...`);
    const t0 = Date.now();
    const map = {};
    const errors = [];      // hard: flips heartbeat → partial (incl. real truncation)
    const warnings = [];    // soft: members-weight cross-check lag
    await parallelMap(enterpriseStakers, async (s) => {
        const expected = Number(s.count || 0);
        const collected = [];
        let startAfter = null;
        let total = null;
        for (let page = 0; page < 50; page++) {
            const q = { user_stake: { user: s.address, limit: ENTERPRISE_USER_STAKE_LIMIT, ...(startAfter ? { start_after: startAfter } : {}) } };
            const res = await queryContractSafe(ENTERPRISE_NFT_STAKING, q, `enterprise user_stake ${s.address.slice(-6)} p${page}`);
            if (res == null) {                                  // query FAILED — do not coerce
                errors.push({ scope: 'enterprise', address: s.address, reason: 'query_failed', page });
                return;
            }
            const tokens = Array.isArray(res.tokens) ? res.tokens : [];
            for (const t of tokens) collected.push(String(t));
            total = res.total_user_stake != null ? Number(res.total_user_stake) : total;
            // Default (no limit) caps at 50; with an explicit high limit the full set comes
            // back. Stop once we have the whole set; only paginate if the contract truncated.
            if (total != null && collected.length >= total) break;
            if (tokens.length < ENTERPRISE_USER_STAKE_LIMIT) break;
            startAfter = String(tokens[tokens.length - 1]);
        }
        // total_user_stake is the contract's own authoritative count → a shortfall is a
        // REAL truncation (the exact bug class we're killing), so it's a hard error.
        if (total != null && collected.length !== total) {
            errors.push({ scope: 'enterprise', address: s.address, reason: 'truncated', total, got: collected.length });
        } else if (expected && collected.length !== expected) {
            warnings.push({ scope: 'enterprise', address: s.address, reason: 'count_vs_members', members: expected, chain: collected.length });
        }
        for (const tid of collected) map[tid] = s.address;
    }, STAKE_RESOLVE_CONCURRENCY);
    console.log(`  ✓ Enterprise: ${Object.keys(map).length} tokens → staker (${errors.length} errors, ${warnings.length} warnings) in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    return { map, errors, warnings };
}

// Apply both maps to records. Active stakes only; enterprise_dao_broken stays = contract.
// Unresolved stragglers keep real_owner = owner (never null) and are recorded as WARNINGS
// (not status-flipping errors): DAODAO unresolved = pending-tracker lag; Enterprise unresolved
// = stakes locked in the abandoned Enterprise contract whose owner isn't enumerable via
// members{}. The latter are tagged enterprise_unattributed so the explorer can label them
// "Enterprise (legacy, unattributed)" distinctly from the DAO-broken set.
function applyStakerResolution(records, daodaoMap, enterpriseMap, warnings) {
    let resolved = 0, daodaoStranded = 0, enterpriseStranded = 0;
    for (const r of records) {
        const tid = String(r.id);
        if (r.daodao_staked) {
            const staker = daodaoMap[tid];
            if (staker) { r.real_owner = staker; resolved++; }
            else {
                // In DAODAO custody but absent from every active staked_nfts list ⇒ definitionally
                // in the unstaking claim queue (custody = active + pending; no third state). The tx
                // tracker hasn't captured this one yet, so we know it IS pending but not WHO unstaked
                // it — classify as pending, leave real_owner = contract (no fabricated address), warn.
                r.daodao_pending_claim = true;
                r.daodao_staked = false;
                r.real_owner = r.owner;
                warnings.push({ scope: 'daodao', token_id: tid, reason: 'pending_untracked' });
                daodaoStranded++;
            }
        } else if (r.enterprise_staked) {            // NOT enterprise_dao_broken (stays = DAO/contract)
            const staker = enterpriseMap[tid];
            if (staker) { r.real_owner = staker; resolved++; }
            else {
                warnings.push({ scope: 'enterprise', token_id: tid, reason: 'legacy_unattributed' });
                r.real_owner = r.owner;
                r.enterprise_unattributed = true;     // abandoned contract — staker not enumerable
                enterpriseStranded++;
            }
        }
    }
    console.log(`  ✓ Staker resolution: ${resolved} → real staker | ${daodaoStranded} DAODAO stranded (tracker lag) | ${enterpriseStranded} Enterprise legacy-unattributed`);
    return { resolved, daodaoStranded, enterpriseStranded };
}

// Change 2 — per-record pending-claim flag. in_window + claimable map token_id → unstaker.
// Marks daodao_pending_claim=true, daodao_staked=false, real_owner=unstaker, so the token
// attributes to the person (not the contract) and drops out of the "currently staked" filter.
function applyPendingClaimFlags(records, pendingBlock) {
    const pendingByToken = {};
    for (const e of [...(pendingBlock.in_window || []), ...(pendingBlock.claimable || [])]) {
        if (e && e.token_id != null && e.address) pendingByToken[String(e.token_id)] = e.address;
    }
    let flagged = 0;
    for (const r of records) {
        const addr = pendingByToken[String(r.id)];
        if (addr) {
            r.daodao_pending_claim = true;
            r.daodao_staked = false;
            r.real_owner = addr;
            flagged++;
        } else if (r.daodao_pending_claim) {
            r.daodao_pending_claim = false;          // stale flag carried from base (claimed/restaked since)
        }
    }
    console.log(`  ✓ Pending-claim flags: ${flagged} tokens marked daodao_pending_claim (excluded from staked)`);
    return flagged;
}

// -----------------------------------------------------------------------------
// PHASE 6 — Backing & yield: ampLUNA balance + per-NFT share
// -----------------------------------------------------------------------------
//
// The NFT contract continuously stakes LUNA in the Alliance module. Daily,
// Eris's bot triggers `alliance_claim_rewards` which:
//   - Claims LUNA from all validators
//   - Bonds it to Eris (Staking Hub) → produces ampLUNA
//   - Splits 90% to NFT contract (rewards for unbroken NFTs)
//   - Splits 10% to DAO main wallet (treasury share)
//
// We capture the NFT contract's current ampLUNA balance. Per-NFT share is
// computed as: balance / unbroken_count. Daily yield emerges from day-over-day
// balance deltas (tracked via daily snapshots).

async function fetchBackingData(unbrokenCount) {
    console.log('💰 Phase 6: fetching backing data (ampLUNA balance)...');
    try {
        const balData = await queryContract(
            AMPLUNA_CW20,
            { balance: { address: ADAO_NFT_CONTRACT } },
            'ampluna balance'
        );
        const balanceRaw = balData?.balance || '0';
        const balanceAmpLuna = Number(balanceRaw) / 1e6;
        const perNftAmpLuna = unbrokenCount > 0 ? balanceAmpLuna / unbrokenCount : 0;
        console.log(`  ✓ Treasury holds ${balanceAmpLuna.toFixed(2)} ampLUNA`);
        console.log(`  ✓ Per-unbroken share: ${perNftAmpLuna.toFixed(4)} ampLUNA`);
        return {
            ampluna_balance_raw: balanceRaw,
            ampluna_balance: balanceAmpLuna,
            per_nft_ampluna_share: perNftAmpLuna,
            unbroken_count: unbrokenCount,
            captured_at: new Date().toISOString(),
        };
    } catch (e) {
        console.warn(`  ⚠ Backing data fetch failed (non-fatal): ${e.message}`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// PHASE 7 — Price data from sister crons
// -----------------------------------------------------------------------------
//
// We fetch already-published price data instead of querying price sources
// directly. This avoids duplication, keeps load off CoinGecko/Eris, and
// inherits the sister crons' price-validation logic.
//
//   network-and-prices-data_2026 → LUNA price + Astroport snapshot prices
//   tla-chain-registry           → Eris exchange rates + token catalog
//
// Used to:
//   1. Compute ampLUNA → USD for the backing display
//   2. Compute marketplace listing prices in USD (any payment token)

async function fetchPriceData() {
    console.log('💱 Phase 7: fetching price data from sister crons...');
    const t0 = Date.now();
    const [pricesDoc, catalogDoc] = await Promise.all([
        tryFetchJson(PRICES_DATA_URL, 'network-and-prices'),
        tryFetchJson(CATALOG_DATA_URL, 'tla-chain-registry'),
    ]);
    if (!pricesDoc && !catalogDoc) {
        console.warn('  ⚠ Both price sources unavailable — USD computation will be skipped');
        return { prices: {}, tokens: {}, ampluna_usd: null, luna_usd: null };
    }
    // --- LUNA → USD ---
    // Real network-and-prices schema: token_prices.LUNA.final_price_usd, plus luna_market.usd_price.
    // (Older assumed schema prices.LUNA.usd / luna_usd kept as last-resort fallbacks.)
    const luna_usd = pricesDoc?.token_prices?.LUNA?.final_price_usd
                  ?? pricesDoc?.luna_market?.usd_price
                  ?? pricesDoc?.prices?.LUNA?.usd
                  ?? pricesDoc?.luna_usd
                  ?? null;

    // --- Per-symbol USD price map from network-and-prices token_prices ---
    // token_prices is keyed by canonical symbol; each carries final_price_usd.
    const priceBySymbol = {};
    if (pricesDoc?.token_prices) {
        for (const [sym, p] of Object.entries(pricesDoc.token_prices)) {
            const usd = p?.final_price_usd ?? p?.prices?.astroport?.price_usd ?? null;
            if (usd != null) priceBySymbol[sym] = Number(usd);
        }
    }

    // --- Token map for symbol/decimals/USD lookups ---
    // The catalog (tla-chain-registry) publishes tokens keyed by address with symbol+decimals
    // but NO price. We join the per-symbol USD price onto each, so decodeTokenDenom finds
    // `final_price_usd` keyed by address, the way it expects.
    const tokenByAddr = {};
    const tokenBySymbol = {};
    if (catalogDoc?.tokens) {
        for (const [addr, t] of Object.entries(catalogDoc.tokens)) {
            const usd = (t.symbol && priceBySymbol[t.symbol] != null) ? priceBySymbol[t.symbol] : null;
            const rec = { ...t, address: addr, final_price_usd: usd };
            tokenByAddr[addr] = rec;
            if (t.symbol) tokenBySymbol[t.symbol] = rec;
        }
    }

    // --- ampLUNA → USD ---
    // Primary: token_prices.ampLUNA.final_price_usd (already LUNA × Eris hub ratio).
    // Fallbacks: lst_ratios.ampLUNA.ratio × luna_usd; then the joined catalog token.
    let ampluna_usd = priceBySymbol['ampLUNA'] ?? null;
    if (ampluna_usd == null) {
        const ratio = pricesDoc?.lst_ratios?.ampLUNA?.ratio;
        if (ratio != null && luna_usd != null) ampluna_usd = Number(ratio) * Number(luna_usd);
    }
    if (ampluna_usd == null) {
        const amplunaToken = tokenByAddr[AMPLUNA_CW20] || tokenBySymbol['ampLUNA'];
        if (amplunaToken?.final_price_usd != null) ampluna_usd = Number(amplunaToken.final_price_usd);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const pricedCount = Object.values(tokenByAddr).filter(t => t.final_price_usd != null).length;
    console.log(`  ✓ LUNA $${luna_usd?.toFixed?.(4) ?? 'n/a'}, ampLUNA $${ampluna_usd?.toFixed?.(4) ?? 'n/a'}, ${pricedCount}/${Object.keys(tokenByAddr).length} catalog tokens priced in ${elapsed}s`);
    return {
        luna_usd,
        ampluna_usd,
        tokens_by_addr: tokenByAddr,
        tokens_by_symbol: tokenBySymbol,
    };
}

// Helper — given a denom (cw20:terra1... or uluna or ibc/...) and price data,
// return { symbol, decimals, price_usd, price_display_for_amount(raw) }
function decodeTokenDenom(denom, priceData) {
    if (!denom) return null;
    const tokens = priceData.tokens_by_addr || {};
    let symbol = denom, decimals = 6, price_usd = null;
    if (denom === 'uluna') {
        symbol = 'LUNA';
        decimals = 6;
        price_usd = priceData.luna_usd;
    } else if (denom.startsWith('cw20:')) {
        const addr = denom.slice(5);
        const tok = tokens[addr];
        if (tok) {
            symbol = tok.symbol || denom;
            decimals = tok.decimals ?? 6;
            price_usd = tok.final_price_usd != null ? Number(tok.final_price_usd) : null;
        }
    } else if (denom.startsWith('ibc/')) {
        const tok = tokens[denom];
        if (tok) {
            symbol = tok.symbol || denom;
            decimals = tok.decimals ?? 6;
            price_usd = tok.final_price_usd != null ? Number(tok.final_price_usd) : null;
        }
    } else {
        // Unknown denom shape — return raw
    }
    return { symbol, decimals, price_usd };
}

// Decorate one listing with price_display and price_usd
function decorateListing(listing, priceData) {
    if (!listing || !listing.denom || !listing.price_raw) return listing;
    const tok = decodeTokenDenom(listing.denom, priceData);
    if (!tok) return listing;
    const amount_human = Number(listing.price_raw) / Math.pow(10, tok.decimals);
    return {
        ...listing,
        price_token_symbol: tok.symbol,
        price_token_decimals: tok.decimals,
        price_display: `${amount_human.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tok.symbol}`,
        price_amount: amount_human,
        price_usd: tok.price_usd != null ? +(amount_human * tok.price_usd).toFixed(6) : null,
        price_usd_source: tok.price_usd != null ? 'sister-cron' : null,
    };
}

// -----------------------------------------------------------------------------
// MERGE: apply marketplace listings + decorate records
// -----------------------------------------------------------------------------
//
// For each NFT whose raw owner is a marketplace contract, look up its listing
// in the marketplace data and:
//   1. Set real_owner = listing.seller (the rightful pre-listing owner)
//   2. Attach the decorated listing object to record.listing
//
// If no listing is found (shouldn't normally happen — the NFT is sitting at a
// marketplace contract but no active listing references it), we flag it.

function mergeMarketplaceListings(records, marketplaces, priceData) {
    const t0 = Date.now();
    const all = [
        ...marketplaces.bbl,
        ...marketplaces.atrium,
        ...marketplaces.boost,
    ];
    // Index by token_id (string)
    const listingByTokenId = {};
    for (const l of all) {
        if (l.token_id != null) {
            const key = String(l.token_id);
            // If same token already has a listing, keep the first one we encountered.
            // Only warn when it's a genuine CROSS-marketplace conflict (e.g. BBL vs
            // Atrium) — a duplicate within the same marketplace is just noise and is
            // de-duped silently.
            if (listingByTokenId[key]) {
                const existing = listingByTokenId[key];
                if (existing.marketplace !== l.marketplace) {
                    console.warn(`  ⚠ NFT #${key} listed on BOTH ${existing.marketplace} and ${l.marketplace} — keeping ${existing.marketplace}`);
                }
                continue;
            }
            listingByTokenId[key] = l;
        }
    }
    let matched = 0, unmatched = 0;
    for (const r of records) {
        const isMarketplaceOwned = r.bbl_listed || r.atrium_listed || r.boost_listed;
        if (!isMarketplaceOwned) continue;
        const listing = listingByTokenId[String(r.id)];
        if (listing) {
            r.listing = decorateListing(listing, priceData);
            r.real_owner = listing.seller;
            matched++;
        } else {
            // NFT sits at a marketplace contract but no active listing references it.
            // Could be a stale state, just-settled auction, or contract upgrade in progress.
            r.listing = { marketplace_owner_no_listing: true, marketplace_addr: r.owner };
            unmatched++;
        }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`  ✓ Merged ${matched} listings to records (${unmatched} marketplace-owned NFTs without active listing) in ${elapsed}s`);
    return records;
}

// -----------------------------------------------------------------------------
// AGGREGATE
// -----------------------------------------------------------------------------

function aggregate(records, daodaoStakers, enterpriseStakers, marketplaces, backing, priceData) {
    const total = records.length;
    let broken = 0, unbroken = 0;
    const counts = {
        unminted: 0,
        treasury_held: 0,
        dao_wallet_8ywv_held: 0,
        enterprise_staked: 0,
        enterprise_dao_broken: 0,
        daodao_staked: 0,
        daodao_pending_claim: 0,   // unstaked, in 7-day claim queue — counted separately from daodao_staked
        bbl_listed: 0,
        atrium_listed: 0,
        boost_listed: 0,
        user_held: 0,
    };
    // Broken sub-classifications (Rev B.1) — informational, NOT mutually exclusive with `counts`.
    // These count broken-NFTs-within-a-bucket. Useful insight: people who broke their NFT to
    // claim ampLUNA but kept it for VP / collection still appear in their staking bucket;
    // they retain the NFT and voting power, only future rewards are forfeited.
    const brokenSubCounts = {
        daodao_staked_broken: 0,    // Staked on DAODAO AND broken (user broke then re-staked for VP)
        user_held_broken: 0,        // Held in individual wallet AND broken (user broke and kept)
    };
    let enterpriseUnattributed = 0; // ⊂ enterprise_staked — staker not enumerable (abandoned contract)
    const perOwnerCounts = {};       // raw owner → count
    const perRealOwnerCounts = {};   // resolved owner → count
    const perOwnerBroken = {};
    const uniqueRealOwners = new Set();

    for (const r of records) {
        if (r.broken) broken++; else unbroken++;
        for (const k of Object.keys(counts)) {
            if (r[k]) counts[k]++;
        }
        // Broken sub-classifications (Rev B.1)
        if (r.broken && r.daodao_staked) brokenSubCounts.daodao_staked_broken++;
        if (r.broken && r.user_held)     brokenSubCounts.user_held_broken++;
        if (r.enterprise_unattributed)   enterpriseUnattributed++;
        if (r.owner) {
            perOwnerCounts[r.owner] = (perOwnerCounts[r.owner] || 0) + 1;
            if (r.broken) perOwnerBroken[r.owner] = (perOwnerBroken[r.owner] || 0) + 1;
        }
        if (r.real_owner) {
            perRealOwnerCounts[r.real_owner] = (perRealOwnerCounts[r.real_owner] || 0) + 1;
            uniqueRealOwners.add(r.real_owner);
        }
    }

    // DAO membership = DAODAO governance stakers ONLY. The Enterprise NFT-staking
    // contract is abandoned: holding/staking there does NOT make you a DAO member.
    // (`unique_holders` below remains the broader "anyone holding an NFT" figure.)
    const daoMembersCount = daodaoStakers.length;
    // Retained for reference: unique non-custody real owners (≈ all individual holders).
    const excludedFromMembers = new Set([
        DAO_MAIN_WALLET,
        DAODAO_STAKING_CONTRACT,
        DAO_TREASURY_CONTRACT,
        ENTERPRISE_NFT_STAKING,
        DAO_WALLET_8YWV,
        BBL_MARKETPLACE,
        ATRIUM_MARKETPLACE,
        BOOST_MARKETPLACE,
    ]);
    const nonCustodyHolders = [...uniqueRealOwners].filter(o => !excludedFromMembers.has(o));

    // Marketplace stats: floor value / count per marketplace
    const marketplaceStats = {};
    for (const mkName of ['bbl', 'atrium', 'boost']) {
        const listings = marketplaces[mkName] || [];
        const decoratedListings = records.filter(r => r.listing && r.listing.marketplace?.toLowerCase() === mkName).map(r => r.listing);
        // Floor by token symbol (since different listings may use different payment tokens)
        const byToken = {};
        for (const l of decoratedListings) {
            const sym = l.price_token_symbol || l.denom || 'unknown';
            if (!byToken[sym]) byToken[sym] = { count: 0, total: 0, min: Infinity, total_usd: 0 };
            byToken[sym].count++;
            if (l.price_amount != null) {
                byToken[sym].total += l.price_amount;
                byToken[sym].min = Math.min(byToken[sym].min, l.price_amount);
            }
            if (l.price_usd != null) byToken[sym].total_usd += l.price_usd;
        }
        // Clean up infinities for empty buckets
        for (const sym of Object.keys(byToken)) {
            if (byToken[sym].min === Infinity) byToken[sym].min = null;
        }
        marketplaceStats[mkName] = {
            count: listings.length,
            count_resolved: decoratedListings.length,
            by_token: byToken,
        };
    }

    // Backing summary (collection-wide)
    const backingSummary = backing ? {
        ampluna_balance:    backing.ampluna_balance,
        per_nft_ampluna:    backing.per_nft_ampluna_share,
        unbroken_count:     unbroken,
        ampluna_usd:        priceData.ampluna_usd,
        treasury_value_usd: priceData.ampluna_usd != null ? +(backing.ampluna_balance * priceData.ampluna_usd).toFixed(2) : null,
        per_nft_value_usd:  priceData.ampluna_usd != null ? +(backing.per_nft_ampluna_share * priceData.ampluna_usd).toFixed(4) : null,
    } : null;

    return {
        // Aggregate counts (drive the top tiles)
        total_tokens: total,
        broken_count: broken,
        unbroken_count: unbroken,
        // New canonical classification counts
        ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k + '_count', v])),
        // Broken sub-classifications (Rev B.1) — within-bucket broken counts
        // These are subsets of their parent bucket, not new buckets:
        //   daodao_staked_broken ⊂ daodao_staked   (broken-then-staked-for-VP)
        //   user_held_broken     ⊂ user_held       (broken-and-kept)
        // Insight: breaking an NFT only forfeits FUTURE rewards. Owner keeps the NFT
        // and any VP from it. Some users claim then re-stake or just hold.
        ...Object.fromEntries(Object.entries(brokenSubCounts).map(([k, v]) => [k + '_count', v])),
        // Backward-compat aliases for current dashboard JS
        unminted_count: counts.unminted,
        minted_count: total - counts.unminted,
        dao_held_count: counts.unminted, // alias kept for old code
        user_liquid_count: counts.user_held, // Rev B.1 — clearer name (same value as user_held_count)
        // (note: old "enterprise_staked_count" semantics changed — was treasury_held, now real Enterprise stakes)
        // The Rev 2 page migration will use the new names directly.

        unique_holders: uniqueRealOwners.size,
        dao_members_count: daoMembersCount,
        non_custody_holders_count: nonCustodyHolders.length,
        enterprise_unattributed_count: enterpriseUnattributed,

        // Useful breakdowns
        per_owner_counts: perOwnerCounts,
        per_real_owner_counts: perRealOwnerCounts,
        per_owner_broken: perOwnerBroken,

        // Backing & yield (collection-wide)
        backing: backingSummary,

        // Marketplace stats
        marketplaces: marketplaceStats,
    };
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'aDAO-nft-inventory/2.2',
                'Accept':        'application/vnd.github.v3+json',
                'Content-Type':  'application/json',
            },
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
                catch { resolve({ status: res.statusCode, data: {} }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
    const existing = await githubApiRequest('GET', apiPath);
    const sha = existing.data?.sha;
    const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
    };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
        console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(1)} KB)`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// DAODAO PENDING-CLAIM TRACKING (Rev B.3)
// -----------------------------------------------------------------------------
// The DAODAO staking contract physically holds `daodao_staked_count` NFTs (cw721
// custody), but only `total_power_at_height` of them are ACTIVELY staked (= the
// number DAODAO's own UI shows). The difference is NFTs that were unstaked but
// not yet claimed — they sit in the 7-day claim queue, or sit there indefinitely
// if the owner forgets to claim ("forgotten claims").
//
//   custody (daodao_staked_count)  −  total_power  =  pending claims   [CHAIN TRUTH]
//
// We track those forward by watching unstake / claim_nfts events (LCD tx-search),
// persisting state in data/v2/pending-claims.json. Every run we reconcile the
// tracked list against the chain-truth count above. The COUNT is always derived
// live from chain (never wrong); per-wallet attribution is best-effort from the
// event log. If they disagree we still render the chain count and flag the drift
// — graceful degradation, honest data over false positives. No historical
// backfill (public LCDs prune): seeded once, then tracks itself forward.

function buildTxSearchUrl(base, contract, action, limit, page) {
    // publicnode HONORS the `page` param (1-indexed) but IGNORES pagination.offset — so the old
    // offset-based ASC paging silently returned the same node-dependent slice every "page" and
    // missed recent unstakes. We now page explicitly and NEWEST-FIRST, so the latest txs are
    // reliably on page 1. Still no `tx.height>` term (publicnode rejects ranges); height filtering
    // stays client-side in fetchDaodaoTxs.
    const q = `wasm._contract_address='${contract}' AND wasm.action='${action}'`;
    return `${base}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(q)}` +
           `&order_by=ORDER_BY_DESC&page=${page}&limit=${limit}`;
}

// unstake: token_ids come straight from the execute message.
function parseUnstakeTxs(txResponses) {
    const out = [];
    for (const r of txResponses || []) {
        for (const m of r?.tx?.body?.messages || []) {
            const ids = m?.msg?.unstake?.token_ids;
            if (!Array.isArray(ids)) continue;
            out.push({ kind: 'unstake', height: Number(r.height), time: r.timestamp, address: m.sender, token_ids: ids.map(Number) });
        }
    }
    return out;
}

// claim_nfts: message is empty {}. Returned tokens live in transfer_nft events
// where the staking contract is the SENDER. Parsing those makes removal
// token-precise (this is what correctly resolves re-unstaked tokens like 1319).
function parseClaimTxs(txResponses, nftContract, stakingContract) {
    const out = [];
    for (const r of txResponses || []) {
        const claimant = r?.tx?.body?.messages?.[0]?.sender || null;
        const tokenIds = [];
        for (const ev of r?.events || []) {
            if (ev.type !== 'wasm') continue;
            const a = {};
            for (const kv of ev.attributes || []) a[kv.key] = kv.value;
            if (a._contract_address === nftContract && a.action === 'transfer_nft' &&
                a.sender === stakingContract && a.token_id != null) {
                tokenIds.push(Number(a.token_id));
            }
        }
        if (tokenIds.length) out.push({ kind: 'claim', height: Number(r.height), time: r.timestamp, address: claimant, token_ids: tokenIds });
    }
    return out;
}

// PURE reducer: fold new unstake/claim events onto prior state, in true block
// order (a token can be unstaked, claimed, then unstaked again — only the last
// event decides whether it's currently queued). Returns { block, updatedState }.
// No IO — kept pure so it can be unit-tested against real data.
function applyPendingEvents(priorState, unstakeTxResponses, claimTxResponses, opts) {
    const { custodyCount, totalPower, tipHeight, scanFailed = false, now = Date.now() } = opts;
    const byToken = new Map((priorState.entries || []).map(e => [Number(e.token_id), e]));
    let maxHeight = priorState.lastScannedHeight || 0;

    const events = [
        ...parseUnstakeTxs(unstakeTxResponses || []),
        ...parseClaimTxs(claimTxResponses || [], ADAO_NFT_CONTRACT, DAODAO_STAKING_CONTRACT),
    ].sort((a, b) => a.height - b.height);

    for (const ev of events) {
        if (ev.kind === 'unstake') {
            const releaseAt = new Date(Date.parse(ev.time) + UNSTAKE_WINDOW_MS).toISOString();
            for (const tid of ev.token_ids) byToken.set(tid, { token_id: tid, address: ev.address, unstaked_at: ev.time, release_at: releaseAt });
        } else {
            for (const tid of ev.token_ids) byToken.delete(tid);
        }
        if (ev.height > maxHeight) maxHeight = ev.height;
    }

    const entries = [...byToken.values()].sort((a, b) => a.token_id - b.token_id);
    // Advance the scan height only if the scan succeeded (else we'd skip events next run).
    const newLastScanned = scanFailed ? (priorState.lastScannedHeight || 0) : Math.max(maxHeight, tipHeight || 0);
    const updatedState = { lastScannedHeight: newLastScanned, entries };

    const inWindow = [], claimable = [];
    for (const e of entries) (Date.parse(e.release_at) <= now ? claimable : inWindow).push(e);

    let count, reconciled;
    if (totalPower == null) {           // chain-truth query failed → best-effort
        count = entries.length; reconciled = null;
    } else {
        count = custodyCount - totalPower;          // authoritative
        reconciled = entries.length === count;
    }

    const block = {
        count, tracked: entries.length, reconciled,
        active_staked: totalPower, custody: custodyCount,
        unstake_window_seconds: UNSTAKE_WINDOW_SECONDS,
        in_window: inWindow, claimable,
    };
    return { block, updatedState };
}

// Fetch all matching txs for an action above minHeight (paginated, oldest-first).
// Returns tx_responses array, or null if both LCDs fail.
async function fetchDaodaoTxs(action, minHeight) {
    const LIMIT = 100, MAX_PAGES = 10;
    const tryBase = async (base) => {
        const all = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const url = buildTxSearchUrl(base, DAODAO_STAKING_CONTRACT, action, LIMIT, page);
            const resp = await fetchJson(url, `daodao ${action} p${page}`);
            const batch = resp?.tx_responses || [];
            if (!batch.length) break;
            all.push(...batch);
            // newest-first: once a page dips to/below what we've already folded in, we've covered the new region
            const pageMin = Math.min(...batch.map(r => Number(r.height)));
            if (pageMin <= Number(minHeight)) break;
            if (batch.length < LIMIT) break;
        }
        // Height filtering is client-side (the LCD won't accept a tx.height range in
        // the query). Keep only txs strictly newer than what we've already folded in.
        return all.filter(r => Number(r.height) > Number(minHeight));
    };
    try { return await tryBase(TERRA_LCD_PRIMARY); }
    catch (e1) {
        try { return await tryBase(TERRA_LCD_FALLBACK); }
        catch (e2) { console.warn(`  ⚠ DAODAO ${action} tx-search failed on both LCDs: ${e2.message}`); return null; }
    }
}

// Read persisted pending-claim state from the data repo (public raw URL).
async function loadPendingState() {
    const state = await tryFetchJson(PENDING_CLAIMS_RAW_URL, 'pending-claims state');
    if (state && Array.isArray(state.entries) && Number.isFinite(state.lastScannedHeight)) {
        return { lastScannedHeight: state.lastScannedHeight, entries: state.entries };
    }
    // No state yet (or unreadable) → replay from genesis (events paginate;
    // replaying all unstakes+claims reconstructs the exact current pending set).
    return { lastScannedHeight: 0, entries: [] };
}

// IO wrapper: query total_power, fetch forward events, fold via applyPendingEvents,
// and emit operator warnings. Caller persists updatedState in the publish phase.
async function computePendingClaims(custodyCount, priorState) {
    const powerRes  = await queryContractSafe(DAODAO_STAKING_CONTRACT, { total_power_at_height: {} }, 'daodao total_power');
    const totalPower = powerRes?.power  != null ? Number(powerRes.power)  : null;
    const tipHeight  = powerRes?.height != null ? Number(powerRes.height) : priorState.lastScannedHeight;

    const unstakeTxs = await fetchDaodaoTxs('unstake',    priorState.lastScannedHeight);
    const claimTxs   = await fetchDaodaoTxs('claim_nfts', priorState.lastScannedHeight);
    const scanFailed = (unstakeTxs === null || claimTxs === null);

    const { block, updatedState } = applyPendingEvents(
        priorState, unstakeTxs || [], claimTxs || [],
        { custodyCount, totalPower, tipHeight, scanFailed },
    );

    if (totalPower == null) {
        console.warn('  ⚠ total_power_at_height failed — pending count is best-effort (tracked), not chain-verified');
    } else if (scanFailed) {
        console.warn('  ⚠ pending-claim tx-search failed this run — per-wallet detail may be stale (count is chain-truth)');
    } else if (!block.reconciled) {
        console.warn(`  ⚠ pending-claim DRIFT: chain says ${block.count}, tracked ${block.tracked} — missed event or NFT sent directly to contract`);
    }
    return { block, updatedState };
}

// -----------------------------------------------------------------------------
// Rev C: tiered-mode helpers (base load, scope derivation, merge)
// -----------------------------------------------------------------------------

// Load the last full inventory's records from the data repo. Hot/warm runs merge
// fresh in-scope records onto this base so the published nfts.json is always a
// complete 10k picture. Returns null if unreadable (caller falls back to full scan).
async function loadBaseRecords() {
    const doc = await tryFetchJson(NFTS_RAW_URL, 'base nfts.json');
    if (doc && Array.isArray(doc.records) && doc.records.length > 0) return doc.records;
    return null;
}

// Load the persisted hot-set token-ID list (rebuilt every full run). Returns an
// array of string IDs, or null if unreadable.
async function loadHotSet() {
    const doc = await tryFetchJson(HOT_SET_RAW_URL, 'hot-set.json');
    if (doc && Array.isArray(doc.token_ids) && doc.token_ids.length > 0) {
        return doc.token_ids.map(String);
    }
    return null;
}

// Hot set = everything NOT in pure DAO custody and NOT staked → user-held +
// marketplace-owned. Plus any pending-claim token_ids (recently unstaked, may be
// landing in a user wallet this window). Derived from a full record set.
function deriveHotSet(records, pendingBlock) {
    const stable = new Set(STABLE_DAO_OWNERS);
    const staking = new Set(STAKING_OWNERS);
    const ids = new Set();
    for (const r of records) {
        if (r.id == null) continue;
        if (stable.has(r.owner) || staking.has(r.owner)) continue; // cold or warm
        ids.add(String(r.id)); // user-held or marketplace-owned → hot
    }
    for (const e of (pendingBlock?.claimable || [])) {
        if (e.token_id != null) ids.add(String(e.token_id));
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
}

// Warm set = hot set ∪ staked NFTs (DAODAO + Enterprise). Staked NFTs rarely move
// intra-day, so they refresh daily rather than every 15 min.
function deriveWarmSet(records, pendingBlock) {
    const staking = new Set(STAKING_OWNERS);
    const ids = new Set(deriveHotSet(records, pendingBlock));
    for (const r of records) {
        if (r.id != null && staking.has(r.owner)) ids.add(String(r.id));
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
}

// Overlay freshly-fetched records onto the base set (by token id). Returns a new
// complete record array: fresh where re-fetched, base otherwise.
function mergeRecords(baseRecords, freshRecords) {
    const byId = new Map(baseRecords.map(r => [String(r.id), r]));
    for (const r of freshRecords) {
        if (r.id != null) byId.set(String(r.id), r);
    }
    return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function captureSnapshot() {
    const startedAt = new Date();
    const epoch = currentEpoch();
    const dateKey = todayUtcDate();
    console.log(`🚀 NFT Inventory Cron Rev B — ${startedAt.toISOString()} (epoch ${epoch}, mode: ${RUN_MODE})`);
    console.log();

    // ── Phase 1+2: per-NFT info — scope depends on RUN_MODE ─────────────────
    // full → enumerate + fetch all 10k. hot/warm → fetch only the in-scope subset
    // and merge it onto the last full inventory (base). If the base or hot-set is
    // unreadable, we fall back to a full scan so output is never incomplete.
    let records, captureRate, effectiveMode = RUN_MODE;
    if (RUN_MODE === 'hot' || RUN_MODE === 'warm') {
        const base = await loadBaseRecords();
        if (!base) {
            console.warn(`  ⚠ ${RUN_MODE} mode but base nfts.json unreadable — falling back to FULL scan`);
            effectiveMode = 'full';
        } else {
            // Scope: hot uses the persisted hot-set; warm derives hot ∪ staked from base.
            let scopeIds = null;
            if (RUN_MODE === 'hot') {
                scopeIds = await loadHotSet();
                if (!scopeIds) {
                    console.warn('  ⚠ hot-set.json unreadable — deriving hot set from base this run');
                    scopeIds = deriveHotSet(base, null);
                }
            } else {
                scopeIds = deriveWarmSet(base, null);
            }
            console.log(`📦 ${RUN_MODE} scope: re-fetching ${scopeIds.length} of ${base.length} NFTs (rest carried from last full run)`);
            const fresh = await fetchAllNftInfo(scopeIds);
            captureRate = scopeIds.length > 0 ? fresh.length / scopeIds.length : 1;
            records = mergeRecords(base, fresh);
            console.log(`  ✓ merged → ${records.length} total records`);
            console.log();
        }
    }
    if (effectiveMode === 'full') {
        // ── Phase 1: enumerate token IDs ────────────────────────────────────
        const tokenIds = await enumerateAllTokens();
        const numTokensData = await queryContractSafe(ADAO_NFT_CONTRACT, { num_tokens: {} }, 'num_tokens');
        const declaredCount = numTokensData?.count ?? null;
        if (declaredCount != null && tokenIds.length !== declaredCount) {
            console.warn(`  ⚠ Enumerated ${tokenIds.length} but contract reports ${declaredCount}`);
        }
        console.log();
        // ── Phase 2: per-NFT info ────────────────────────────────────────────
        records = await fetchAllNftInfo(tokenIds);
        captureRate = tokenIds.length > 0 ? records.length / tokenIds.length : 0;
        console.log();
    }

    // ── Phases 3-5: parallel data fetches (independent systems) ─────────────
    console.log('🔀 Phases 3-7: parallel data fetches...');
    const [enterpriseStakers, marketplaces, daodaoStakers, priceData] = await Promise.all([
        fetchEnterpriseStakers(),
        fetchMarketplaces(),
        fetchDaodaoStakers(),
        fetchPriceData(),
    ]);
    console.log();

    // ── Compute unbroken count (needed for Phase 6) ─────────────────────────
    const unbrokenCount = records.filter(r => !r.broken).length;

    // ── Phase 6: backing data (needs unbroken count) ────────────────────────
    const backing = await fetchBackingData(unbrokenCount);
    console.log();

    // ── Merge marketplace listings into records ─────────────────────────────
    console.log('🔗 Merging marketplace listings into records...');
    mergeMarketplaceListings(records, marketplaces, priceData);
    console.log();

    // ── DAODAO pending-claim reconciliation (BEFORE staker resolution + aggregate) ──
    // Flag pending tokens first so they carry daodao_staked=false and aren't mistaken
    // for unresolved active stakes by the resolver below.
    console.log('🔁 Reconciling DAODAO pending claims...');
    const daodaoCustodyCount = records.filter(r => r.daodao_staked).length;  // all DAODAO custody (pre-flag)
    const priorPendingState = await loadPendingState();
    const pending = await computePendingClaims(daodaoCustodyCount, priorPendingState);
    console.log(`  Pending claims:      ${pending.block.count} chain / ${pending.block.tracked} tracked / reconciled: ${pending.block.reconciled}`);
    if (pending.block.reconciled === false) {
        console.log(`  ℹ Tracker behind by ${pending.block.count - pending.block.tracked} (chain ${pending.block.count} vs tracked ${pending.block.tracked}) — those stay on the contract until the unstake tracker catches up`);
    }
    if (pending.block.claimable.length) {
        console.log(`  Claimable now:       token ${pending.block.claimable.map(e => e.token_id).join(', ')}`);
    }
    applyPendingClaimFlags(records, pending.block);   // Change 2: flag + daodao_staked=false + real_owner=unstaker
    console.log();

    // ── Resolve staked NFTs → real staker (full/warm only; hot carries from base) ──
    // In hot mode the staked tokens aren't re-fetched (they're outside the hot set),
    // so their already-resolved real_owner is carried forward from the last full/warm run.
    const stakerErrors = [];      // hard: query failed / Enterprise truncation → status partial
    const stakerWarnings = [];    // soft: unresolved stragglers (abandoned Enterprise, tracker lag) → status ok
    if (effectiveMode === 'full' || effectiveMode === 'warm') {
        console.log('🧩 Resolving staked NFTs → real staker...');
        const [ddRes, entRes] = await Promise.all([
            resolveDaodaoStakerTokens(daodaoStakers),
            resolveEnterpriseStakerTokens(enterpriseStakers),
        ]);
        applyStakerResolution(records, ddRes.map, entRes.map, stakerWarnings);  // unresolved → warnings (not status-flipping)
        stakerErrors.push(...ddRes.errors, ...entRes.errors);                   // query_failed / truncated → errors
        stakerWarnings.push(...ddRes.warnings, ...entRes.warnings);
        console.log();
    } else {
        console.log('  ⏭ hot mode: staked real_owner carried from base (no staker re-resolution)');
        console.log();
    }

    // ── Aggregate (after staker + pending resolution, so summary is consistent) ──
    console.log('📊 Aggregating...');
    const summary = aggregate(records, daodaoStakers, enterpriseStakers, marketplaces, backing, priceData);
    summary.daodao_pending_claim = pending.block;
    console.log(`  Unminted (DAO):      ${summary.unminted_count.toLocaleString()}`);
    console.log(`  Treasury (broken):   ${summary.treasury_held_count.toLocaleString()}`);
    console.log(`  DAO wallet 8ywv:     ${summary.dao_wallet_8ywv_held_count.toLocaleString()} (broken, small DAO custody)`);
    console.log(`  Enterprise staked:   ${summary.enterprise_staked_count.toLocaleString()} (real user stakes; ${summary.enterprise_unattributed_count} legacy/unattributed)`);
    console.log(`  Enterprise DAO:      ${summary.enterprise_dao_broken_count.toLocaleString()} (DAO-controlled broken)`);
    console.log(`  DAODAO staked:       ${summary.daodao_staked_count.toLocaleString()} (of which ${summary.daodao_staked_broken_count} broken, kept for VP)`);
    console.log(`  DAODAO pending claim:${summary.daodao_pending_claim_count.toLocaleString()} (unstaked, in 7-day queue)`);
    console.log(`  BBL listed:          ${summary.bbl_listed_count.toLocaleString()}`);
    console.log(`  Atrium listed:       ${summary.atrium_listed_count.toLocaleString()}`);
    console.log(`  Boost listed:        ${summary.boost_listed_count.toLocaleString()}`);
    console.log(`  User-liquid:         ${summary.user_liquid_count.toLocaleString()} (of which ${summary.user_held_broken_count} broken, kept individually)`);
    console.log(`  Broken (total):      ${summary.broken_count.toLocaleString()}`);
    console.log(`  Unbroken (total):    ${summary.unbroken_count.toLocaleString()}`);
    console.log(`  Unique real owners:  ${summary.unique_holders.toLocaleString()}`);
    console.log(`  DAO members:         ${summary.dao_members_count.toLocaleString()} (DAODAO governance stakers)`);
    console.log(`  Non-custody holders: ${summary.non_custody_holders_count.toLocaleString()} (anyone holding an NFT)`);
    if (stakerErrors.length) {
        console.warn(`  ⚠ Staker resolution errors: ${stakerErrors.length} (status → partial; see summary.staker_resolution)`);
    }
    if (stakerWarnings.length) {
        console.log(`  ℹ Staker resolution warnings: ${stakerWarnings.length} (indexer/members lag — status stays ok)`);
    }
    if (summary.backing) {
        console.log(`  Treasury ampLUNA:    ${summary.backing.ampluna_balance.toFixed(2)}`);
        console.log(`  Per-NFT share:       ${summary.backing.per_nft_ampluna.toFixed(4)} ampLUNA`);
        if (summary.backing.treasury_value_usd != null) {
            console.log(`  Treasury value:      $${summary.backing.treasury_value_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        }
    }
    // Sanity: sum of all classification counts should equal total tokens
    const classifiedSum = (
        summary.unminted_count + summary.treasury_held_count + summary.dao_wallet_8ywv_held_count +
        summary.enterprise_staked_count + summary.enterprise_dao_broken_count +
        summary.daodao_staked_count + summary.daodao_pending_claim_count +
        summary.bbl_listed_count + summary.atrium_listed_count +
        summary.boost_listed_count + summary.user_held_count
    );
    if (classifiedSum !== summary.total_tokens) {
        console.warn(`  ⚠ Classification sum (${classifiedSum}) ≠ total tokens (${summary.total_tokens}) — overlap or gap`);
    } else {
        console.log(`  ✓ Classification sums correctly to ${summary.total_tokens}`);
    }
    console.log();

    // ── Assemble output documents ───────────────────────────────────────────
    const status = (captureRate >= 0.99 && stakerErrors.length === 0) ? 'ok' : 'partial';
    const contracts = {
        nft:                       ADAO_NFT_CONTRACT,
        dao_main_wallet:           DAO_MAIN_WALLET,
        daodao_staking:            DAODAO_STAKING_CONTRACT,
        dao_treasury:              DAO_TREASURY_CONTRACT,
        dao_wallet_8ywv:           DAO_WALLET_8YWV,
        enterprise_nft_staking:    ENTERPRISE_NFT_STAKING,
        bbl_marketplace:           BBL_MARKETPLACE,
        atrium_marketplace:        ATRIUM_MARKETPLACE,
        boost_marketplace:         BOOST_MARKETPLACE,
        ampluna_cw20:              AMPLUNA_CW20,
    };
    const nftsDoc = {
        schemaVersion: 2,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        contracts,
        total_tokens: records.length,
        capture_rate: captureRate,
        records,
    };
    const summaryDoc = {
        schemaVersion: 2,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch,
        contracts,
        ...summary,
        daodao_stakers: daodaoStakers,
        enterprise_stakers: enterpriseStakers,
        staker_resolution: {
            mode: effectiveMode,
            resolved_this_run: effectiveMode === 'full' || effectiveMode === 'warm',
            error_count: stakerErrors.length,
            warning_count: stakerWarnings.length,
            errors: stakerErrors.slice(0, 100),       // capped; full set is in logs
            warnings: stakerWarnings.slice(0, 100),
        },
        listing_resolver: {
            warning_count: (marketplaces.listingWarnings || []).length,
            warnings: (marketplaces.listingWarnings || []).slice(0, 100),
        },
    };
    const heartbeatDoc = {
        schemaVersion: 2,
        cron: 'nft-inventory',
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        runId: `nft-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        runMode: effectiveMode,
        currentEpoch: epoch,
        status,
        stats: {
            total_tokens: records.length,
            capture_rate: captureRate,
            unminted: summary.unminted_count,
            broken: summary.broken_count,
            unbroken: summary.unbroken_count,
            treasury_held: summary.treasury_held_count,
            dao_wallet_8ywv_held: summary.dao_wallet_8ywv_held_count, // Rev B.1 — was missing from heartbeat
            enterprise_staked: summary.enterprise_staked_count,
            enterprise_dao_broken: summary.enterprise_dao_broken_count,
            daodao_staked: summary.daodao_staked_count,
            daodao_staked_broken: summary.daodao_staked_broken_count, // Rev B.1 — broken-but-staked-on-DAODAO (kept for VP)
            bbl_listed: summary.bbl_listed_count,
            atrium_listed: summary.atrium_listed_count,
            boost_listed: summary.boost_listed_count,
            user_held: summary.user_held_count,
            user_liquid: summary.user_liquid_count,           // Rev B.1 — clearer alias for user_held
            user_held_broken: summary.user_held_broken_count, // Rev B.1 — broken-and-held-by-user (kept for collection/VP)
            unique_holders: summary.unique_holders,
            ampluna_balance: summary.backing?.ampluna_balance ?? null,
            per_nft_ampluna: summary.backing?.per_nft_ampluna ?? null,
            daodao_pending_claim: pending.block.count,
            daodao_pending_claim_records: summary.daodao_pending_claim_count,
            staker_resolution_errors: stakerErrors.length,
            staker_resolution_warnings: stakerWarnings.length,
            listing_resolver_warnings: (marketplaces.listingWarnings || []).length,
            enterprise_unattributed: summary.enterprise_unattributed_count,
            daodao_pending_reconciled: pending.block.reconciled,
        },
        next_expected_run_at: new Date(startedAt.getTime() + (
            effectiveMode === 'hot'  ? 15 * 60 * 1000 :
            effectiveMode === 'warm' ? 24 * 60 * 60 * 1000 :
                                       7 * 24 * 60 * 60 * 1000
        )).toISOString(),
    };
    // Daily snapshot — overwrites today's file each run; final write of the day "wins"
    // and represents the day-end state. Subsequent runs see the previous day's snapshot
    // as reference for movement / yield-delta tracking.
    const dailyDoc = {
        schemaVersion: 1,
        date: dateKey,
        capturedAt: startedAt.toISOString(),
        // Subset of summary suitable for daily timeline (full summary is also at
        // data/summary.json, but daily snapshot is the time-anchored archive).
        epoch,
        total_tokens: records.length,
        broken_count: summary.broken_count,
        unbroken_count: summary.unbroken_count,
        unminted_count: summary.unminted_count,
        treasury_held_count: summary.treasury_held_count,
        dao_wallet_8ywv_held_count: summary.dao_wallet_8ywv_held_count, // Rev B.1
        enterprise_staked_count: summary.enterprise_staked_count,
        enterprise_dao_broken_count: summary.enterprise_dao_broken_count,
        daodao_staked_count: summary.daodao_staked_count,
        daodao_staked_broken_count: summary.daodao_staked_broken_count, // Rev B.1
        bbl_listed_count: summary.bbl_listed_count,
        atrium_listed_count: summary.atrium_listed_count,
        boost_listed_count: summary.boost_listed_count,
        user_held_count: summary.user_held_count,
        user_held_broken_count: summary.user_held_broken_count, // Rev B.1
        backing: summary.backing,
        marketplaces: summary.marketplaces,
    };

    // Hot-set membership — rebuilt on FULL runs only (the full reconcile is the source
    // of truth for which tokens are user-held/marketplace vs stable DAO custody). The
    // hot/warm runs read this file to scope their per-NFT fetches.
    const hotSetIds = deriveHotSet(records, pending.block);
    const hotSetDoc = {
        schemaVersion: 1,
        rebuiltAt: startedAt.toISOString(),
        rebuiltByMode: effectiveMode,
        note: 'Token IDs the hot (15-min) path polls: user-held + marketplace-owned + pending-claim. Rebuilt on full runs; warm derives hot ∪ staked at runtime.',
        count: hotSetIds.length,
        token_ids: hotSetIds,
    };

    // ── Publish / save ──────────────────────────────────────────────────────
    if (GITHUB_TOKEN) {
        console.log('📤 Publishing to GitHub...');
        await pushToGithub(`${OUTPUT_PATH}/nfts.json`,      JSON.stringify(nftsDoc),                 `nft inventory — ${records.length} NFTs (${effectiveMode} run)`);
        await pushToGithub(`${OUTPUT_PATH}/summary.json`,   JSON.stringify(summaryDoc, null, 2),     `nft summary — ${summary.broken_count} broken / ${summary.bbl_listed_count + summary.atrium_listed_count + summary.boost_listed_count} listed`);
        await pushToGithub(`${OUTPUT_PATH}/heartbeat.json`, JSON.stringify(heartbeatDoc, null, 2),   `📍 nft-inventory heartbeat — ${effectiveMode}/${status}`);
        await pushToGithub(`${OUTPUT_PATH}/daily/${dateKey}.json`, JSON.stringify(dailyDoc, null, 2), `daily snapshot — ${dateKey}`);
        await pushToGithub(PENDING_CLAIMS_PATH, JSON.stringify(pending.updatedState, null, 2), `pending-claims — ${pending.block.count} pending${pending.block.reconciled === false ? ' (DRIFT)' : ''}`);
        if (effectiveMode === 'full') {
            await pushToGithub(HOT_SET_PATH, JSON.stringify(hotSetDoc, null, 2), `hot-set rebuild — ${hotSetIds.length} tokens`);
        }
    } else {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('nfts.json', JSON.stringify(nftsDoc));
        fs.writeFileSync('summary.json', JSON.stringify(summaryDoc, null, 2));
        fs.writeFileSync('heartbeat.json', JSON.stringify(heartbeatDoc, null, 2));
        fs.writeFileSync(`daily-${dateKey}.json`, JSON.stringify(dailyDoc, null, 2));
        fs.writeFileSync('pending-claims.json', JSON.stringify(pending.updatedState, null, 2));
        if (effectiveMode === 'full') fs.writeFileSync('hot-set.json', JSON.stringify(hotSetDoc, null, 2));
        console.log(`  Saved locally: nfts.json (${(JSON.stringify(nftsDoc).length / 1024).toFixed(1)} KB), summary.json, heartbeat.json, daily-${dateKey}.json${effectiveMode === 'full' ? ', hot-set.json' : ''}`);
    }

    const elapsed = (Date.now() - startedAt.getTime()) / 1000;
    console.log(`\n✅ Done (${elapsed.toFixed(1)}s)`);
}

// -----------------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------------

if (require.main === module) {
    captureSnapshot().catch(e => {
        console.error(`❌ FATAL: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
    });
}

module.exports = {
    captureSnapshot,
    // Phase exports for testing
    enumerateAllTokens,
    fetchAllNftInfo,
    fetchEnterpriseStakers,
    fetchMarketplaces,
    fetchDaodaoStakers,
    fetchBackingData,
    fetchPriceData,
    aggregate,
    // Pending-claim tracking (Rev B.3)
    parseUnstakeTxs,
    parseClaimTxs,
    applyPendingEvents,
    computePendingClaims,
    loadPendingState,
    // Tier-mode helpers (Rev C)
    deriveHotSet,
    deriveWarmSet,
    mergeRecords,
    // Constants (might be useful for tests / sanity checks)
    ADAO_NFT_CONTRACT,
    DAO_MAIN_WALLET,
    DAO_TREASURY_CONTRACT,
    DAODAO_STAKING_CONTRACT,
    ENTERPRISE_NFT_STAKING,
    BBL_MARKETPLACE,
    ATRIUM_MARKETPLACE,
    BOOST_MARKETPLACE,
    AMPLUNA_CW20,
};
