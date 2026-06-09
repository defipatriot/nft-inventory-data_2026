#!/usr/bin/env node
/**
 * boost-sales-fetch.js — aDAO NFT sales settled on BoostDAO (not visible to the BBL settle-sweep).
 *
 * BoostDAO exposes a pre-indexed table (view_launch_prepared) via GraphQL with the price/denom/USD
 * per launch, but NO timestamp/buyer. We recover those by joining each done launch to the matching
 * "NFT left the Boost launch contract → buyer" event in our own provenance spine (nft-provenance.json).
 *
 * Idempotent: re-fetches ALL done aDAO launches each run and rebuilds boost-sales.json. Boost grows
 * slowly (≈30 to date), so a full re-fetch is trivial and self-healing — no watermark needed here.
 *
 * Output: data/v2[/<collection>]/boost-sales.json  (same record shape as sales-history.json, +launch_id,
 *         +to_usd_boost; royalty_fee/royalty_recipient null — Boost carries no royalty data).
 * The analytics builder merges this at build time (LUNA/bLUNA re-priced via oracle, USDC at par,
 * SOLID/ampLUNA via to_usd_boost).
 *
 * Env: NFT_CONTRACT, COLLECTION (default aDAO); GITHUB_TOKEN/REPO/BRANCH to publish (else writes local).
 *      BOOST_RAW_FILE=<path>  → skip GraphQL, read launches from a local JSON array (offline test).
 */
'use strict';
const https = require('https');
const fs = require('fs');

const ADAO_NFT      = process.env.NFT_CONTRACT || 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const COLLECTION    = (process.env.COLLECTION || 'adao').toLowerCase();
const BOOST_LAUNCH  = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at';
const BOOST_GQL     = 'https://api.boostdao.io/graphql';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH   = 'data/v2';
const COLL_DIR      = COLLECTION === 'adao' ? OUTPUT_PATH : `${OUTPUT_PATH}/${COLLECTION}`;
const BOOST_PATH    = `${COLL_DIR}/boost-sales.json`;
const PROV_PATH     = `${COLL_DIR}/nft-provenance.json`;

// to_id (what the seller received) → symbol. Matches the analytics builder's pricing branches.
const DENOM_SYMBOLS = {
    'uluna': 'LUNA',
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': 'bLUNA',
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': 'ampLUNA',
    'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst': 'SOLID',
};
const denomSymbol = (id) => DENOM_SYMBOLS[id] || (String(id).startsWith('ibc/') ? 'USDC' : 'UNKNOWN');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── GraphQL ───────────────────────────────────────────────────────────────────
const GQL = `query Launches($where: View_launch_preparedWhereInput, $orderBy: [View_launch_preparedOrderByWithRelationInput!], $take: Int, $skip: Int) {
  launches: view_launch_prepareds(where: $where, orderBy: $orderBy, take: $take, skip: $skip) {
    creator done launch_id cancelled to_id from_id from_collection_id from_nft_id
    launch_type from_amount to_amount from_usd to_usd discount real_collection_id
  }
  aggregateLaunch: aggregateView_launch_prepared(where: $where) { _count { _all } }
}`;
const WHERE = {
    launch_contract: { equals: BOOST_LAUNCH },
    AND: [{ OR: [{ done: { equals: true } }] }],
    real_collection_id: { equals: ADAO_NFT },
    discount: { gte: -0.001 },
    whitelist: { none: {} },
};
const ORDER_BY = [{ discount: { sort: 'desc', nulls: 'last' } }, { to_usd: { sort: 'asc', nulls: 'last' } }];

function gqlPost(variables) {
    const body = JSON.stringify({ operationName: 'Launches', query: GQL, variables });
    return new Promise((resolve, reject) => {
        const u = new URL(BOOST_GQL);
        const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: {
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'User-Agent': 'aDAO-boost-fetch/1.0', 'Content-Length': Buffer.byteLength(body),
        } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
            try { const j = JSON.parse(b); if (j.errors) return reject(new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 200))); resolve(j.data); }
            catch (e) { reject(new Error(`Boost GQL ${res.statusCode}: ${b.slice(0, 160)}`)); } }); });
        req.on('error', reject); req.write(body); req.end();
    });
}

async function fetchBoostLaunches() {
    if (process.env.BOOST_RAW_FILE) {
        const raw = JSON.parse(fs.readFileSync(process.env.BOOST_RAW_FILE, 'utf8'));
        console.log(`  (test) loaded ${raw.length} launches from ${process.env.BOOST_RAW_FILE}`);
        return raw;
    }
    const TAKE = 50; const all = new Map(); let total = null;
    for (let skip = 0, page = 1; page <= 20; skip += TAKE, page++) {
        let data;
        for (let r = 0; r < 5; r++) { try { data = await gqlPost({ where: WHERE, orderBy: ORDER_BY, take: TAKE, skip }); break; } catch (e) { if (r === 4) throw e; await sleep(400); } }
        const L = data.launches || [];
        total = data.aggregateLaunch?._count?._all ?? total;
        for (const x of L) all.set(x.launch_id, x);
        console.log(`  page ${page}: +${L.length} (have ${all.size}${total != null ? '/' + total : ''})`);
        if (!L.length || (total != null && all.size >= total)) break;
    }
    return [...all.values()];
}

// ─── provenance join ─────────────────────────────────────────────────────────────
function buildBoostSales(launches, prov) {
    const tokens = prov.tokens || {};
    const byTok = {};
    for (const x of launches) (byTok[x.from_nft_id] = byTok[x.from_nft_id] || []).push(x);
    for (const k in byTok) byTok[k].sort((a, b) => a.launch_id - b.launch_id); // launch_id ≈ chronological

    const recs = [];
    for (const tok in byTok) {
        const ls = byTok[tok];
        const creators = new Set(ls.map(l => l.creator));
        const evs = (tokens[tok]?.events || []).filter(e => e.from === BOOST_LAUNCH).sort((a, b) => a.block - b.block);
        const buyerEvs = evs.filter(e => !creators.has(e.to));          // NFT → a real buyer = a settlement
        ls.forEach((ln, i) => {
            const s = buyerEvs[i] || buyerEvs[buyerEvs.length - 1] || evs[evs.length - 1] || null;
            recs.push({
                tx_hash: s?.tx_hash || null, block: s?.block || null, timestamp: s?.timestamp || null,
                launch_id: ln.launch_id, token_id: tok,
                seller: ln.creator, buyer: s?.to || null,
                denom: ln.to_id, denom_symbol: denomSymbol(ln.to_id),
                gross_amount: String(ln.to_amount),
                to_usd_boost: ln.to_usd, discount: ln.discount,
                royalty_fee: null, royalty_recipient: null,
                marketplace: 'Boost',
            });
        });
    }
    recs.sort((a, b) => (a.block || 0) - (b.block || 0));
    return recs;
}

// ─── GitHub publish (matches the sweepers) ─────────────────────────────────────────
function ghReq(method, path, payload) {
    return new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = https.request({ hostname: 'api.github.com', path, method, headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-boost-fetch/1.0', 'Accept': 'application/vnd.github+json',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b || '{}'));
            else if (res.statusCode === 404) resolve(null);
            else reject(new Error(`GitHub ${res.statusCode}: ${b.slice(0, 160)}`)); }); });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}
async function pushToGithub(path, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${path}`;
    const existing = await ghReq('GET', `${apiPath}?ref=${GITHUB_BRANCH}`).catch(() => null);
    await ghReq('PUT', apiPath, { message, branch: GITHUB_BRANCH, content: Buffer.from(content).toString('base64'), ...(existing?.sha ? { sha: existing.sha } : {}) });
    console.log(`  ✅ ${path} (${(content.length / 1024).toFixed(1)} KB)`);
}

// ─── main ────────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    console.log(`🚀 Boost sales fetch — collection=${COLLECTION} — ${new Date().toISOString()}`);
    const launches = await fetchBoostLaunches();
    console.log(`  ${launches.length} done aDAO Boost launches`);

    let prov;
    try { prov = JSON.parse(fs.readFileSync(PROV_PATH, 'utf8')); }
    catch (e) { throw new Error(`need ${PROV_PATH} for the date/buyer join — run provenance first (${e.message})`); }

    const sales = buildBoostSales(launches, prov);
    const undated = sales.filter(s => !s.block).length;
    const denomCount = sales.reduce((m, s) => { m[s.denom_symbol] = (m[s.denom_symbol] || 0) + 1; return m; }, {});
    console.log(`  built ${sales.length} Boost sales | denoms ${JSON.stringify(denomCount)} | undated ${undated}`);

    const doc = {
        schemaVersion: 2, builtAt: new Date().toISOString(),
        source: 'boost-sales-fetch.js — BoostDAO view_launch_prepared (done=true, real_collection_id=aDAO) joined to provenance settlement events for date/buyer/tx',
        marketplace: 'Boost', nft_contract: ADAO_NFT, collection: COLLECTION,
        note: 'gross_amount in micro-units of denom. LUNA/bLUNA re-priced via oracle in the analytics builder; USDC at par; SOLID/ampLUNA via to_usd_boost (Boost figure). No royalty data on Boost.',
        count: sales.length, sales,
    };
    const json = JSON.stringify(doc, null, 1);
    fs.writeFileSync('boost-sales.json', json);                 // always write local (builder reads it next)
    try { fs.mkdirSync(COLL_DIR, { recursive: true }); fs.writeFileSync(BOOST_PATH, json); } catch {}
    if (GITHUB_TOKEN) { console.log('📤 Publishing…'); await pushToGithub(BOOST_PATH, json, `boost sales — ${COLLECTION} — ${sales.length} launches`); }
    else console.log(`⚠️  GITHUB_TOKEN not set — wrote boost-sales.json locally only`);
    console.log(`✅ done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
module.exports = { buildBoostSales, denomSymbol, fetchBoostLaunches };
