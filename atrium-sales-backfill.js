#!/usr/bin/env node
/**
 * atrium-sales-backfill.js — aDAO NFT sales on the Atrium marketplace.
 *
 * Atrium settles a sale with ONE self-contained `buy_nft` wasm event on the marketplace contract,
 * carrying price / seller / buyer / fee / royalty / token_id / nft_contract — analogous to BBL's
 * `settle`. We reuse the BBL sweeper's proven pager + eventsOf, and just swap in an Atrium parser.
 *
 * Payment denom = whatever the buyer paid `price` of into the marketplace (cw20 send, or native funds).
 * Output: data/v2[/<collection>]/atrium-sales.json — same record shape as sales-history/boost-sales,
 * merged by the analytics builder (LUNA→oracle, USDC/SOLID→par, others via hint where present).
 *
 * Env: NFT_CONTRACT, COLLECTION (default aDAO); RUN_MODE=sample|full; GITHUB_TOKEN/REPO/BRANCH.
 */
'use strict';
const https = require('https');
const { fetchAllTxs, eventsOf } = require('./bbl-sales-backfill.js');   // reuse the proven pager + event flattener

const ADAO_NFT      = process.env.NFT_CONTRACT || 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const COLLECTION    = (process.env.COLLECTION || 'adao').toLowerCase();
const ATRIUM        = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj';
const RUN_MODE      = (process.env.RUN_MODE || 'sample').toLowerCase();
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH   = 'data/v2';
const COLL_DIR      = COLLECTION === 'adao' ? OUTPUT_PATH : `${OUTPUT_PATH}/${COLLECTION}`;
const ATRIUM_PATH   = `${COLL_DIR}/atrium-sales.json`;

const DENOM_SYMBOLS = {
    'uluna': 'LUNA',
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': 'bLUNA',
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': 'ampLUNA',
    'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst': 'SOLID',
};
const symbolFor = (d) => DENOM_SYMBOLS[d] || (String(d).startsWith('ibc/') ? 'USDC' : (d || 'UNKNOWN'));

// Atrium tx-search: buy_nft events naming the aDAO contract.
const ATRIUM_QUERY = [`wasm.action='buy_nft'`, `wasm.nft_contract='${ADAO_NFT}'`];

// Parse one Atrium buy_nft tx → a sale record (or null).
function parseAtriumBuy(tx) {
    const evs = eventsOf(tx);
    const buy = evs.find(e => e.type === 'wasm' && e.a.action === 'buy_nft' && e.a.nft_contract === ADAO_NFT && e.a.token_id != null);
    if (!buy) return null;
    const a = buy.a;
    const price = a.price;

    // denom = what the buyer paid `price` of into the marketplace.
    let denom = null;
    const cw20 = evs.find(e => e.type === 'wasm' && e.a.action === 'send' && e.a.to === ATRIUM && e.a.amount === price && e.a._contract_address);
    if (cw20) denom = cw20.a._contract_address;                                  // cw20 (SOLID / bLUNA / ampLUNA)
    else {                                                                        // native (LUNA / USDC-ibc)
        const bank = evs.find(e => e.type === 'transfer' && e.a.recipient === ATRIUM && typeof e.a.amount === 'string' && e.a.amount.startsWith(String(price)));
        const m = bank && bank.a.amount.match(/^(\d+)(.+)$/);
        if (m) denom = m[2];
    }

    // royalty recipient (only when royalty > 0): the transfer of exactly `royalty` out of the marketplace.
    let royaltyRecipient = null;
    if (Number(a.royalty) > 0) {
        const rt = evs.find(e => e.type === 'wasm' && e.a.action === 'transfer' && e.a.from === ATRIUM && e.a.amount === a.royalty);
        royaltyRecipient = rt ? rt.a.to : null;
    }

    return {
        tx_hash: tx.txhash, block: Number(tx.height), timestamp: tx.timestamp,
        listing_id: a.listing_id != null ? Number(a.listing_id) : null,
        token_id: a.token_id,
        seller: a.seller, buyer: a.buyer,
        denom, denom_symbol: symbolFor(denom),
        gross_amount: String(price),
        seller_net: a.seller_receives != null ? String(a.seller_receives) : null,
        marketplace_fee: a.fee != null ? String(a.fee) : null,
        royalty_fee: Number(a.royalty) > 0 ? String(a.royalty) : null,           // null when 0 → builder skips it in royalties
        royalty_recipient: royaltyRecipient,
        marketplace: 'Atrium',
    };
}

function buildSales(txs) {
    const sales = txs.map(parseAtriumBuy).filter(Boolean);
    const seen = new Set();
    const deduped = sales.filter(s => { const k = `${s.tx_hash}:${s.token_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    deduped.sort((a, b) => a.block - b.block || String(a.token_id).localeCompare(String(b.token_id)));
    const perToken = {};
    for (const s of deduped) { const n = (perToken[s.token_id] || 0) + 1; perToken[s.token_id] = n; s.sale_number = n; }
    return deduped;
}

function ghReq(method, path, payload) {
    return new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = https.request({ hostname: 'api.github.com', path, method, headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-atrium-backfill/1.0', 'Accept': 'application/vnd.github+json',
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

async function main() {
    const t0 = Date.now();
    const fs = require('fs');
    console.log(`🏛️  Atrium sales backfill — mode: ${RUN_MODE} — ${new Date().toISOString()}`);
    const txs = await fetchAllTxs(ATRIUM_QUERY, 'atrium buy_nft');
    const sales = buildSales(txs);
    const denomCount = sales.reduce((m, s) => { m[s.denom_symbol] = (m[s.denom_symbol] || 0) + 1; return m; }, {});
    console.log(`\n📊 ${sales.length} aDAO Atrium sales | denoms ${JSON.stringify(denomCount)}`);
    if (sales.length) { console.log(`   earliest #${sales[0].token_id} @ ${sales[0].timestamp}`); console.log(`   latest   #${sales[sales.length - 1].token_id} @ ${sales[sales.length - 1].timestamp}`); }

    const doc = {
        schemaVersion: 1, builtAt: new Date().toISOString(),
        source: 'atrium-sales-backfill.js (buy_nft events, aDAO)', marketplace: 'Atrium',
        nft_contract: ADAO_NFT, collection: COLLECTION, atrium_contract: ATRIUM,
        note: 'Self-contained buy_nft settle record. gross_amount in micro-units of denom. LUNA→oracle, USDC/SOLID→par, others priced in builder. royalty_fee null when the sale had no royalty.',
        count: sales.length, sales,
    };
    const json = JSON.stringify(doc, null, 1);
    if (RUN_MODE === 'sample') { console.log(`\n── SAMPLE (nothing written) ──`); sales.slice(0, 8).forEach(s => console.log('  ' + JSON.stringify(s))); return; }
    fs.writeFileSync('atrium-sales.json', json);
    try { fs.mkdirSync(COLL_DIR, { recursive: true }); fs.writeFileSync(ATRIUM_PATH, json); } catch {}
    // SAFETY GUARD — append-only; never overwrite committed Atrium sales with fewer.
    try {
        const prev = JSON.parse(fs.readFileSync(ATRIUM_PATH, 'utf8'));
        const prevCount = prev?.count ?? (prev?.sales || []).length ?? 0;
        if (prevCount > 0 && sales.length < prevCount) {
            console.error(`❌ ABORT: ${sales.length} Atrium sales < committed ${prevCount} — incomplete sweep, NOT publishing.`);
            process.exit(1);
        }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('  (shrink-guard: could not read prior file: ' + e.message + ')'); }
    if (GITHUB_TOKEN) { console.log('\n📤 Publishing…'); await pushToGithub(ATRIUM_PATH, json, `atrium sales — ${COLLECTION} — ${sales.length} sales`); }
    else console.log(`\n⚠️  GITHUB_TOKEN not set — wrote atrium-sales.json locally only`);
    console.log(`\n✅ done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
module.exports = { parseAtriumBuy, buildSales };
