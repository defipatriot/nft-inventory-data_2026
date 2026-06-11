#!/usr/bin/env node
/**
 * nft-forward-incremental.js — cheap "since last block" updater for the aDAO NFT history.
 *
 * The full backfill did the heavy lifting. This only fetches NEW transactions since the highest block
 * already in our data, parses them with the SAME validated parsers (required from the sweepers), and
 * merges. ~10–50 tx/day on a single contract → seconds per run. Meant to run every few hours.
 *
 * Robustness: idempotent (merge dedupes by tx_hash:token_id, so overlap/re-runs are harmless) and
 * backstopped by the WEEKLY full sweep (nft-forward-update.yml) which is the source of truth and
 * self-heals anything an incremental run might miss. We fetch newest-first (ORDER_BY_DESC) and stop
 * once we page below the watermark — NOT a `tx.height>=` range filter (that 400s on publicnode).
 *
 * Updates in place: data/v2[/<coll>]/{nft-provenance,sales-history,atrium-sales}.json (writes local
 * AND pushes). Boost + analytics run as separate workflow steps after this (they read the local files).
 *
 * Env: NFT_CONTRACT/COLLECTION (default aDAO); LCD_PRIMARY/FALLBACK; FWD_* tuning; GITHUB_TOKEN/REPO/BRANCH.
 */
'use strict';
const https = require('https');
const fs = require('fs');
const prov = require('./nft-provenance-backfill.js');   // parseTransfers, buildProvenance, summarize, phaseFor
const bbl  = require('./bbl-sales-backfill.js');         // buildSales, summarize
const atr  = require('./atrium-sales-backfill.js');      // buildSales

const ADAO_NFT      = process.env.NFT_CONTRACT || 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const COLLECTION    = (process.env.COLLECTION || 'adao').toLowerCase();
const COLL_DIR      = COLLECTION === 'adao' ? 'data/v2' : `data/v2/${COLLECTION}`;
const LCD_PRIMARY   = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK  = process.env.LCD_FALLBACK || LCD_PRIMARY;
const PAGE_LIMIT    = 100;
const OVERLAP       = +(process.env.FWD_OVERLAP || 2000);   // re-scan a little below the watermark; dedupe absorbs it
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const PROV_Q = [`wasm._contract_address='${ADAO_NFT}'`, `wasm.action='transfer_nft'`];
const BBL_Q  = [`wasm.action='settle'`,   `wasm.nft_contract='${ADAO_NFT}'`];
const ATR_Q  = [`wasm.action='buy_nft'`,  `wasm.nft_contract='${ADAO_NFT}'`];

// Forward fill for the events backfill (2026-06-11): keep broken-at.json and
// listing-history.json current. Reuses the SAME tested parsers + outcome logic
// as the one-time backfill — one implementation, two callers, no drift.
const evb = require('./nft-events-backfill.js'); // parseBreakTx, parseBblCreateTx, parseEscrowCreateTx, deriveOutcomes
const BBL_MKT    = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const ATRIUM_MKT = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj';
const BOOST_MKT  = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at';
const BREAK_Q      = [`wasm.action='break_nft'`,      `wasm._contract_address='${ADAO_NFT}'`];
const CREATE_Q     = [`wasm.action='create_auction'`, `wasm.nft_contract='${ADAO_NFT}'`];
const ESCROW_ATR_Q = [`wasm.action='send_nft'`, `wasm.recipient='${ATRIUM_MKT}'`, `wasm._contract_address='${ADAO_NFT}'`];
const ESCROW_BST_Q = [`wasm.action='send_nft'`, `wasm.recipient='${BOOST_MKT}'`,  `wasm._contract_address='${ADAO_NFT}'`];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'aDAO-fwd-incremental/1.0' }, timeout: 30000 }, (res) => {
            let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error(`HTTP ${res.statusCode}`)); } });
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}
async function lcdGet(p, label) { try { return await httpGet(LCD_PRIMARY + p); } catch (e) { try { return await httpGet(LCD_FALLBACK + p); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } } }
const descPath = (c, page) => `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(c.join(' AND '))}&order_by=ORDER_BY_DESC&page=${page}&limit=${PAGE_LIMIT}`;

// Fetch every tx with height >= watermark, newest-first, stopping once a page dips below it.
async function fetchSince(conds, watermark, label) {
    const RETRIES = +(process.env.FWD_RETRIES || 12), DELAY = +(process.env.FWD_PROBE_DELAY || 150), MAXP = +(process.env.FWD_MAX_PAGES || 15);
    const found = new Map(); let globalMax = 0, stop = 'page-cap';
    for (let page = 1; page <= MAXP; page++) {
        let best = null;
        for (let a = 0; a < RETRIES; a++) {
            let resp; try { resp = await lcdGet(descPath(conds, page), `${label} p${page}.${a}`); } catch { await sleep(DELAY); continue; }
            const batch = resp?.tx_responses || [];
            if (!batch.length) { if (a >= 2) { best = best || { batch: [], maxH: 0, minH: Infinity }; break; } await sleep(DELAY); continue; }
            const maxH = Math.max(...batch.map(t => Number(t.height)));
            if (!best || maxH > best.maxH) best = { batch, maxH, minH: Math.min(...batch.map(t => Number(t.height))) };
            if (a >= 2) break;                          // a few probes to dodge a stale backend, then take the freshest
            await sleep(DELAY);
        }
        if (!best || !best.batch.length) { stop = page === 1 ? 'empty' : 'reached-watermark'; break; }
        for (const tx of best.batch) { const h = Number(tx.height); if (h > globalMax) globalMax = h; if (h >= watermark) found.set(tx.txhash, tx); }
        if (best.minH <= watermark) { stop = 'reached-watermark'; break; }
    }
    console.log(`  ${label}: ${found.size} candidate txs ≥ block ${watermark} (max seen ${globalMax}, ${stop})`);
    return [...found.values()];
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// ── merges (mirror the sweepers' build logic; weekly full sweep is the source of truth) ──
function mergeProvenance(existing, newTxs) {
    const fresh = prov.buildProvenance(newTxs);                 // {events, tokens} for the new txs (classified)
    const all = [];
    for (const t of Object.values(existing.tokens || {})) all.push(...t.events);
    const before = all.length;
    all.push(...fresh.events);
    const seen = new Set();
    const events = all.filter(e => { const k = `${e.tx_hash}:${e.token_id}`; if (seen.has(k)) return false; seen.add(k); return true; })
                      .sort((a, b) => a.block - b.block || String(a.token_id).localeCompare(String(b.token_id)));
    const tokens = {};
    for (const e of events) { (tokens[e.token_id] = tokens[e.token_id] || { token_id: e.token_id, events: [] }).events.push(e); }
    for (const t of Object.values(tokens)) {
        const first = t.events[0]; const ph = prov.phaseFor(first.timestamp);
        t.mint = { date: first.timestamp, first_owner: first.to, from: first.from, phase: ph ? ph.id : 'unknown', phase_name: ph ? ph.name : null, mint_price_luna: ph ? ph.mint_luna : null, tx_hash: first.tx_hash, block: first.block };
        t.hand_changes = t.events.length; t.sale_count = t.events.filter(e => e.type === 'sale').length; t.current_owner = t.events[t.events.length - 1].to;
    }
    return { tokens, summary: prov.summarize(tokens), added: events.length - before };
}

function mergeSales(existing, newRecords) {
    const map = new Map();
    for (const s of [...(existing.sales || []), ...newRecords]) map.set(`${s.tx_hash}:${s.token_id}`, s);
    const merged = [...map.values()].sort((a, b) => a.block - b.block || String(a.token_id).localeCompare(String(b.token_id)));
    const per = {}; for (const s of merged) { const n = (per[s.token_id] || 0) + 1; per[s.token_id] = n; s.sale_number = n; }
    return merged;
}

// ── GitHub publish ──
function ghReq(method, path, payload) {
    return new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = https.request({ hostname: 'api.github.com', path, method, headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-fwd-incremental/1.0', 'Accept': 'application/vnd.github+json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
            (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b || '{}')); else if (res.statusCode === 404) resolve(null); else reject(new Error(`GitHub ${res.statusCode}: ${b.slice(0, 160)}`)); }); });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}
async function publish(relPath, json, msg) {
    fs.writeFileSync(relPath, json);                            // local — so Boost/analytics steps read it fresh
    if (!GITHUB_TOKEN) return;
    const apiPath = `/repos/${GITHUB_REPO}/contents/${relPath}`;
    const existing = await ghReq('GET', `${apiPath}?ref=${GITHUB_BRANCH}`).catch(() => null);
    await ghReq('PUT', apiPath, { message: msg, branch: GITHUB_BRANCH, content: Buffer.from(json).toString('base64'), ...(existing?.sha ? { sha: existing.sha } : {}) });
    console.log(`  ✅ pushed ${relPath}`);
}

async function main() {
    const t0 = Date.now();
    console.log(`⏩ NFT incremental forward update — ${COLLECTION} — ${new Date().toISOString()}`);

    // load current state (provenance required; sales/atrium optional)
    const provDoc = readJson(`${COLL_DIR}/nft-provenance.json`);
    let bblDoc = null, atrDoc = null;
    try { bblDoc = readJson(`${COLL_DIR}/sales-history.json`); } catch {}
    try { atrDoc = readJson(`${COLL_DIR}/atrium-sales.json`); } catch {}

    // watermark = highest block we already know about (across all sources)
    let watermark = 0;
    for (const t of Object.values(provDoc.tokens || {})) for (const e of t.events) if (e.block > watermark) watermark = e.block;
    for (const d of [bblDoc, atrDoc]) for (const s of (d?.sales || [])) if (s.block > watermark) watermark = s.block;
    const since = Math.max(0, watermark - OVERLAP);
    console.log(`  watermark block ${watermark} → fetching since ${since} (overlap ${OVERLAP})`);

    // fetch new txs per venue
    const [provTxs, bblTxs, atrTxs] = await Promise.all([
        fetchSince(PROV_Q, since, 'transfer_nft'),
        fetchSince(BBL_Q, since, 'bbl settle'),
        fetchSince(ATR_Q, since, 'atrium buy_nft'),
    ]);

    // provenance
    const mp = mergeProvenance(provDoc, provTxs);
    const provOut = { ...provDoc, builtAt: new Date().toISOString(), updatedBy: 'nft-forward-incremental.js', summary: mp.summary, tokens: mp.tokens };
    console.log(`  provenance: +${mp.added} events → ${mp.summary.distinct_tokens} tokens, ${mp.summary.total_hand_changes} hand-changes`);
    await publish(`${COLL_DIR}/nft-provenance.json`, JSON.stringify(provOut, null, 1), `incremental: provenance +${mp.added} events`);

    // BBL sales
    if (bblDoc) {
        const before = (bblDoc.sales || []).length;
        const merged = mergeSales(bblDoc, bbl.buildSales(bblTxs));
        const sum = bbl.summarize(merged);
        const out = { ...bblDoc, builtAt: new Date().toISOString(), updatedBy: 'nft-forward-incremental.js', denom_breakdown: sum.denomBreakdown, royalty_wallets: sum.royaltyWallets, count: merged.length, sales: merged };
        console.log(`  BBL sales: ${before} → ${merged.length} (+${merged.length - before})`);
        await publish(`${COLL_DIR}/sales-history.json`, JSON.stringify(out, null, 1), `incremental: BBL sales ${merged.length}`);
    }

    // Atrium sales
    if (atrDoc) {
        const before = (atrDoc.sales || []).length;
        const merged = mergeSales(atrDoc, atr.buildSales(atrTxs));
        const denom = merged.reduce((m, s) => { m[s.denom_symbol] = (m[s.denom_symbol] || 0) + 1; return m; }, {});
        const out = { ...atrDoc, builtAt: new Date().toISOString(), updatedBy: 'nft-forward-incremental.js', count: merged.length, denom_breakdown: denom, sales: merged };
        console.log(`  Atrium sales: ${before} → ${merged.length} (+${merged.length - before})`);
        await publish(`${COLL_DIR}/atrium-sales.json`, JSON.stringify(out, null, 1), `incremental: Atrium sales ${merged.length}`);
    }

    console.log(`✅ incremental done (${((Date.now() - t0) / 1000).toFixed(1)}s) — events forward-fill next`);

    // ── events forward-fill: broken-at.json + listing-history.json ──────────
    // Per-stream watermarks from the files' OWN max heights (not the provenance
    // watermark) so nothing between the backfill moment and the provenance
    // frontier can fall through. Skips cleanly if the backfill hasn't run yet.
    let baDoc = null, lhDoc = null;
    try { baDoc = readJson(`${COLL_DIR}/broken-at.json`); } catch {}
    try { lhDoc = readJson(`${COLL_DIR}/listing-history.json`); } catch {}

    if (baDoc) {
        let baWm = 0; for (const e of Object.values(baDoc.entries || {})) if (e.height > baWm) baWm = e.height;
        const txs = await fetchSince(BREAK_Q, Math.max(0, baWm - OVERLAP), 'break_nft');
        const fresh = txs.flatMap(tx => evb.parseBreakTx(tx)).filter(b => !baDoc.entries[b.token_id]);
        if (fresh.length) {
            for (const b of fresh.sort((a, c) => a.height - c.height)) if (!baDoc.entries[b.token_id]) baDoc.entries[b.token_id] = b;
            baDoc.count = Object.keys(baDoc.entries).length;
            baDoc.builtAt = new Date().toISOString(); baDoc.updatedBy = 'nft-forward-incremental.js';
            console.log(`  broken-at: +${fresh.length} new breaks → ${baDoc.count}`);
            await publish(`${COLL_DIR}/broken-at.json`, JSON.stringify(baDoc, null, 1), `incremental: broken-at +${fresh.length} → ${baDoc.count}`);
        } else console.log('  broken-at: no new breaks');
    } else console.log('  broken-at.json absent — events backfill not run yet, skipping forward-fill');

    if (lhDoc) {
        let lhWm = 0; for (const r of (lhDoc.records || [])) { const h = r.segments?.[0]?.from_height || 0; if (h > lhWm) lhWm = h; }
        const since2 = Math.max(0, lhWm - OVERLAP);
        const [cTxs, aTxs, bTxs] = await Promise.all([
            fetchSince(CREATE_Q, since2, 'bbl create_auction'),
            fetchSince(ESCROW_ATR_Q, since2, 'atrium escrow'),
            fetchSince(ESCROW_BST_Q, since2, 'boost escrow'),
        ]);
        const have = new Set(lhDoc.records.map(r => `${r.marketplace}:${r.listing_ref}`));
        const newCreates = [
            ...cTxs.flatMap(tx => evb.parseBblCreateTx(tx)),
            ...aTxs.flatMap(tx => evb.parseEscrowCreateTx(tx, ATRIUM_MKT)),
            ...bTxs.flatMap(tx => evb.parseEscrowCreateTx(tx, BOOST_MKT)),
        ].filter(L => !have.has(`${L.marketplace}:${L.listing_ref}`));

        // Re-derive outcomes for new creates AND existing 'active' records (so
        // active → sold/delisted closes as it happens). Sales context = the sale
        // files just merged above (auction_id / tx_hash / token_id / timestamp are
        // the only fields deriveOutcomes matches on).
        const combinedSales = { sales: [
            ...((bblDoc && bblDoc.sales) || []),
            ...((atrDoc && atrDoc.sales) || []).map(s => ({ ...s, marketplace: s.marketplace || 'Atrium' })),
            ...(() => { try { return (readJson(`${COLL_DIR}/boost-sales.json`).sales || []).map(s => ({ ...s, marketplace: s.marketplace || 'Boost' })); } catch { return []; } })(),
        ] };
        let currentNfts = null; try { currentNfts = readJson(`${COLL_DIR}/nfts.json`); } catch {}
        const activeAsListings = lhDoc.records.filter(r => r.outcome === 'active').map(r => ({
            marketplace: r.marketplace, listing_ref: r.listing_ref, token_id: r.token_id, seller: r.seller,
            price_raw: r.segments[0].price, denom: r.segments[0].denom, listing_type: r.listing_type,
            created_at: r.segments[0].from_ts, height: r.segments[0].from_height, tx_hash: r.create_tx,
        }));
        const { records: rederived, counts } = evb.deriveOutcomes([...activeAsListings, ...newCreates], combinedSales, provOut, currentNfts);
        const rederivedByKey = new Map(rederived.map(r => [`${r.marketplace}:${r.listing_ref}`, r]));
        let closed = 0;
        const records = lhDoc.records.map(r => {
            const upd = rederivedByKey.get(`${r.marketplace}:${r.listing_ref}`);
            if (upd && r.outcome === 'active' && upd.outcome !== 'active') closed++;
            return upd || r;                                  // refreshed actives replace in place
        });
        for (const L of newCreates) records.push(rederivedByKey.get(`${L.marketplace}:${L.listing_ref}`));
        if (newCreates.length || closed) {
            if (records.length < lhDoc.records.length) throw new Error('listing-history would shrink — aborting');
            const oc = {}; for (const r of records) oc[r.outcome] = (oc[r.outcome] || 0) + 1;
            const out = { ...lhDoc, builtAt: new Date().toISOString(), updatedBy: 'nft-forward-incremental.js', counts: oc, count: records.length, records };
            console.log(`  listing-history: +${newCreates.length} creates, ${closed} actives closed → ${records.length} (${JSON.stringify(oc)})`);
            await publish(`${COLL_DIR}/listing-history.json`, JSON.stringify(out, null, 1), `incremental: listings +${newCreates.length} new / ${closed} closed`);
        } else console.log('  listing-history: no new creates, no actives closed');
    } else console.log('  listing-history.json absent — events backfill not run yet, skipping forward-fill');

    console.log(`✅ forward-fill done (${((Date.now() - t0) / 1000).toFixed(1)}s total) — Boost + analytics run next`);
}

if (require.main === module) main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
module.exports = { mergeProvenance, mergeSales };
