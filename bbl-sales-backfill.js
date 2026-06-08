#!/usr/bin/env node
/**
 * bbl-sales-backfill.js — one-time sweeper to reconstruct the full BBL sales
 * history for the aDAO NFT collection from on-chain tx-search.
 *
 * KEY INSIGHT (confirmed from real settle events back to Apr 2024): the BBL
 * `settle` wasm event is a COMPLETE, self-contained sale record —
 *   { auction_id, nft_contract, token_id, denom, amount (gross), seller }
 * and the same tx's `transfer_nft` event (sender = BBL) gives the buyer, while
 * the cw20/native transfer legs (from = BBL) give the fee split. So one query —
 * settle events for the aDAO NFT — yields every sale with full detail. No join.
 *
 * Denom is per-sale: early sales settled in native LUNA (uluna); BBL later moved
 * to bLUNA (forced bond). We read denom from each settle, never assume.
 *
 * MODES (env RUN_MODE):
 *   sample (default) — first page only; dump raw + parsed; write nothing.
 *   full             — sweep all; write data/v2/sales-history.json (raw, no USD).
 *
 * USD-at-date (CoinGecko historical) + royalty/marketplace labeling confidence +
 * forward-tracking in the hot run are SEPARATE later passes. This records the
 * durable on-chain facts only.
 */
'use strict';
const https = require('https');

// ─── Config ─────────────────────────────────────────────────────────────────
const BBL_CONTRACT  = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const ADAO_NFT      = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const BBL_FEE_WALLET = 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75'; // BBL marketplace fee (2%), constant across collections
const LCD_PRIMARY   = 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK  = 'https://terra-rest.publicnode.com';
const HTTP_TIMEOUT  = 20000;
const PAGE_LIMIT    = 100;
const MAX_PAGES     = 50;

const RUN_MODE      = (process.env.RUN_MODE || 'sample').toLowerCase();
const SAMPLE_N      = Number(process.env.SAMPLE_N || 6);
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH   = 'data/v2';
const SALES_PATH    = `${OUTPUT_PATH}/sales-history.json`;

// cw20 contract → symbol (USD pass maps symbol → historical price). Extend as needed.
const DENOM_SYMBOLS = {
    'uluna': 'LUNA',
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': 'bLUNA',   // confirmed from tx FF976203…
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': 'ampLUNA',
};
const symbolFor = (d) => DENOM_SYMBOLS[d] || d;

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = HTTP_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-bbl-backfill/2.0' } }, (res) => {
            let body = ''; res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); } }
                else reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 140)}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
}
async function lcdGet(path, label) {
    try { return await httpGet(LCD_PRIMARY + path); }
    catch (e1) { try { return await httpGet(LCD_FALLBACK + path); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } }
}

// ─── tx-search (query= form, NO tx.height range; paginate) ──────────────────────
function txSearchPath(conditions, offset) {
    const q = conditions.join(' AND ');
    return `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(q)}&order_by=ORDER_BY_ASC&pagination.limit=${PAGE_LIMIT}&pagination.offset=${offset}`;
}
async function fetchAllTxs(conditions, label) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await lcdGet(txSearchPath(conditions, page * PAGE_LIMIT), `${label} p${page}`);
        const batch = resp?.tx_responses || [];
        out.push(...batch);
        process.stdout.write(`\r  ${label}: ${out.length} txs   `);
        if (batch.length < PAGE_LIMIT) break;
        if (page === MAX_PAGES - 1) console.warn(`\n  ⚠ ${label} hit page cap (${MAX_PAGES})`);
    }
    process.stdout.write('\n');
    return out;
}

// ─── event helpers ──────────────────────────────────────────────────────────────
function eventsOf(tx) {
    const out = [];
    if (Array.isArray(tx?.logs)) for (const l of tx.logs) for (const e of (l.events || [])) {
        out.push({ type: e.type, a: Object.fromEntries((e.attributes || []).map(x => [x.key, x.value])) });
    }
    if (out.length === 0 && Array.isArray(tx?.events)) for (const e of tx.events) {
        out.push({ type: e.type, a: Object.fromEntries((e.attributes || []).map(x => [x.key, x.value])) });
    }
    return out;
}

// Parse ONE settle tx into a full sale record (or null if it isn't an aDAO settle).
function parseSettleTx(tx) {
    const evs = eventsOf(tx);
    const settle = evs.find(e => e.type === 'wasm' && e.a.action === 'settle' && e.a.nft_contract === ADAO_NFT);
    if (!settle) return null;

    const denom = settle.a.denom;
    const gross = settle.a.amount;
    const seller = settle.a.seller;
    const token_id = settle.a.token_id;

    // buyer = recipient of the NFT (transfer_nft sent by BBL) in this same tx
    const tnft = evs.find(e => e.type === 'wasm' && e.a.action === 'transfer_nft' && e.a.sender === BBL_CONTRACT);
    const buyer = tnft ? tnft.a.recipient : null;

    // payout legs out of BBL: cw20 (wasm action=transfer, from=BBL) and/or native (transfer sender=BBL)
    const cw20 = evs.filter(e => e.type === 'wasm' && e.a.action === 'transfer' && e.a.from === BBL_CONTRACT && e.a.to && e.a.amount)
                    .map(e => ({ to: e.a.to, amount: e.a.amount, denom: e.a._contract_address }));
    const native = evs.filter(e => e.type === 'transfer' && e.a.sender === BBL_CONTRACT && e.a.recipient && e.a.amount)
                    .map(e => { const m = /^(\d+)([a-z][\w/]*)$/.exec(e.a.amount || ''); return m ? { to: e.a.recipient, amount: m[1], denom: m[2] } : null; })
                    .filter(Boolean);
    const legs = [...cw20, ...native].filter(l => l.denom === denom); // only legs in the sale denom

    // Seller net + marketplace fee are read from their known recipients; royalty is
    // the RESIDUAL (gross − seller_net − marketplace). This structurally ignores any
    // extra legs in the tx (e.g. refunds to outbid bidders), which would otherwise be
    // mislabeled as a giant royalty.
    let seller_net = null, marketplace_fee = null;
    for (const l of legs) {
        if (l.to === seller) seller_net = l.amount;
        else if (l.to === BBL_FEE_WALLET) marketplace_fee = l.amount;
    }
    let royalty_fee = null, royalty_recipient = null;
    if (seller_net != null) {
        royalty_fee = String(Number(gross) - Number(seller_net) - Number(marketplace_fee || 0));
        const rl = legs.find(l => l.to !== seller && l.to !== BBL_FEE_WALLET && l.amount === royalty_fee);
        royalty_recipient = rl ? rl.to : null;
    }

    return {
        tx_hash: tx.txhash,
        block: Number(tx.height),
        timestamp: tx.timestamp,                 // ISO UTC
        auction_id: settle.a.auction_id,
        token_id,
        seller,
        buyer,
        denom,
        denom_symbol: symbolFor(denom),
        gross_amount: gross,
        seller_net,
        marketplace_fee,
        royalty_fee,
        royalty_recipient,
        // USD-at-date, sale_number, spread → added by later passes / below
    };
}

function buildSales(settleTxs) {
    const sales = settleTxs.map(parseSettleTx).filter(Boolean);
    // de-dupe by tx+token, sort by block (then assign per-token sale_number)
    const seen = new Set();
    const deduped = sales.filter(s => { const k = `${s.tx_hash}:${s.token_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    deduped.sort((a, b) => a.block - b.block || String(a.token_id).localeCompare(String(b.token_id)));
    const perToken = {};
    for (const s of deduped) { const n = (perToken[s.token_id] || 0) + 1; perToken[s.token_id] = n; s.sale_number = n; }
    return deduped;
}

function summarize(sales) {
    const denomBreakdown = {}, royaltyWallets = {}, feeWallets = {};
    let firstSaleCount = 0;
    for (const s of sales) {
        denomBreakdown[s.denom_symbol] = (denomBreakdown[s.denom_symbol] || 0) + 1;
        if (s.royalty_recipient) royaltyWallets[s.royalty_recipient] = (royaltyWallets[s.royalty_recipient] || 0) + 1;
        if (s.marketplace_fee != null) feeWallets[BBL_FEE_WALLET] = (feeWallets[BBL_FEE_WALLET] || 0) + 1;
        if (s.sale_number === 1) firstSaleCount++;
    }
    return { denomBreakdown, royaltyWallets, firstSaleCount };
}

// ─── GitHub publish ──────────────────────────────────────────────────────────────
function ghReq(method, path, payload) {
    return new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = https.request({ hostname: 'api.github.com', path, method, headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-bbl-backfill/2.0', 'Accept': 'application/vnd.github+json',
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
const SETTLE_QUERY = [`wasm.action='settle'`, `wasm.nft_contract='${ADAO_NFT}'`];

async function main() {
    const t0 = Date.now();
    console.log(`🧹 BBL sales backfill (settle-centric) — mode: ${RUN_MODE} — ${new Date().toISOString()}\n`);

    if (RUN_MODE === 'sample') {
        console.log(`🔎 SAMPLE: first page of aDAO settles…`);
        let resp;
        try { resp = await lcdGet(txSearchPath(SETTLE_QUERY, 0), 'settles'); }
        catch (e) { console.error(`  ✗ targeted settle query failed: ${e.message}`); console.error('  (will need all-settles + client filter fallback)'); return; }
        const txs = resp?.tx_responses || [];
        console.log(`  total aDAO settles reported: ${resp?.total ?? '(n/a)'} | got ${txs.length} this page\n`);

        console.log(`── RAW wasm/transfer events of first ${SAMPLE_N} (confirm shape) ──`);
        for (const tx of txs.slice(0, SAMPLE_N)) {
            console.log(`\n  ${tx.txhash} @${tx.timestamp}`);
            for (const e of eventsOf(tx)) if (e.type === 'wasm' || e.type === 'transfer')
                console.log(`    [${e.type}] ${JSON.stringify(e.a).slice(0, 200)}`);
        }
        console.log(`\n── PARSED sales ──`);
        const sales = buildSales(txs);
        for (const s of sales.slice(0, SAMPLE_N)) console.log('  ' + JSON.stringify(s));
        const sum = summarize(sales);
        console.log(`\n  parsed ${sales.length} aDAO sales (first page)`);
        console.log(`  denom breakdown:`, JSON.stringify(sum.denomBreakdown));
        console.log(`  royalty recipient wallets:`, JSON.stringify(sum.royaltyWallets));
        console.log(`\n✅ sample done (${((Date.now() - t0) / 1000).toFixed(1)}s). Nothing written. Set RUN_MODE=full to sweep + publish.`);
        return;
    }

    // FULL
    console.log('📥 Fetching all aDAO settles…');
    const txs = await fetchAllTxs(SETTLE_QUERY, 'settles');
    const sales = buildSales(txs);
    const sum = summarize(sales);

    console.log(`\n📊 ${sales.length} aDAO BBL sales reconstructed`);
    console.log(`   denom breakdown:`, JSON.stringify(sum.denomBreakdown));
    console.log(`   royalty wallets:`, JSON.stringify(sum.royaltyWallets));
    console.log(`   first-time sales (sale_number=1):`, sum.firstSaleCount);
    if (sales.length) {
        console.log(`   earliest: #${sales[0].token_id} @ ${sales[0].timestamp}`);
        console.log(`   latest:   #${sales[sales.length - 1].token_id} @ ${sales[sales.length - 1].timestamp}`);
    }

    const doc = {
        schemaVersion: 1, builtAt: new Date().toISOString(),
        source: 'bbl-sales-backfill.js (settle events, aDAO)',
        marketplace: 'BBL', nft_contract: ADAO_NFT, bbl_fee_wallet: BBL_FEE_WALLET,
        note: 'Raw on-chain BBL sale record from settle events. USD-at-date + sale spread are separate later passes. sale_number is BBL-only sequence; sale_number=1 is the earliest BBL sale (= mint if mints ran on BBL).',
        denom_breakdown: sum.denomBreakdown,
        royalty_wallets: sum.royaltyWallets,
        count: sales.length, sales,
    };
    if (GITHUB_TOKEN) { console.log('\n📤 Publishing…'); await pushToGithub(SALES_PATH, JSON.stringify(doc, null, 1), `BBL sales backfill — ${sales.length} sales`); }
    else { require('fs').writeFileSync('sales-history.json', JSON.stringify(doc, null, 1)); console.log('\n⚠️  GITHUB_TOKEN not set — wrote sales-history.json locally'); }
    console.log(`\n✅ full sweep done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ FATAL: ${e.message}`); console.error(e.stack); process.exit(1); });
module.exports = { parseSettleTx, buildSales, summarize, eventsOf };
