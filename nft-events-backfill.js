#!/usr/bin/env node
'use strict';
/**
 * nft-events-backfill.js — ONE-TIME sweep (brief items 0 + 4): reconstruct
 *
 *   1. broken-at.json       — break timestamp for every broken NFT, from the NFT
 *                             contract's `break_nft` executions. Fixes the live
 *                             mis-classification where pre-break sales render in
 *                             the Broken tier (explorer classifies by sale_ts vs
 *                             broken_at once this lands).
 *   2. listing-history.json — listing lifecycle per marketplace listing: created
 *                             (price, denom, seller, ts) → terminal outcome
 *                             (sold | delisted | active | unknown), with the
 *                             close timestamp. BBL price changes are cancel+
 *                             recreate on-chain, so each auction_id is naturally
 *                             one price segment.
 *
 * Event sources (verified against live txs 2026-06-11):
 *   breaks      : wasm.action='break_nft'      AND wasm._contract_address=<NFT>
 *                 attrs: token_id, rewards (redeemed), user_share
 *   BBL creates : wasm.action='create_auction' AND wasm.nft_contract=<NFT>
 *                 attrs: auction_id, auction_type, denom, reserve, seller, token_id
 *   Atrium/Boost creates: no direct probe hit for their create action — recovered
 *                 via the cw721 escrow leg instead: wasm.action='send_nft' AND
 *                 wasm.recipient=<MARKETPLACE>. The marketplace's own wasm event
 *                 in the same tx is captured verbatim (self-discovering attrs).
 *
 * Terminal outcomes are DERIVED (no cancel-event name needed):
 *   sold     — a sales-enriched row matches (marketplace + listing id, or same
 *              token's exit tx)                          → to_ts = sale time
 *   delisted — provenance shows the token leaving the marketplace after the
 *              create with no matching sale              → to_ts = exit transfer
 *   active   — token still escrowed at the marketplace, listing still live
 *   unknown  — none of the above resolved (logged, counted)
 *
 * Reuses the proven resilient pager + event flattener from bbl-sales-backfill.js.
 * Reads current inputs from the local repo checkout (data/v2/*). Append-only
 * outputs with shrink guards. RUN_MODE=sample prints, writes nothing.
 */

const fs = require('fs');
const https = require('https');
const { fetchAllTxs, eventsOf } = require('./bbl-sales-backfill.js');

// ─── config ──────────────────────────────────────────────────────────────────
const ADAO_NFT = process.env.NFT_CONTRACT || 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const BBL      = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const ATRIUM   = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj';
const BOOST    = process.env.BOOST_MARKETPLACE || 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at'; // launch-nft v1.4.0
const MKT_NAME = { [BBL]: 'BBL', [ATRIUM]: 'Atrium', [BOOST]: 'Boost' };

const RUN_MODE   = (process.env.RUN_MODE || 'sample').toLowerCase();   // sample | full
const TARGET     = (process.env.TARGET || 'both').toLowerCase();       // both | breaks | listings
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const DATA_DIR        = process.env.DATA_DIR || 'data/v2';
const BROKEN_AT_PATH  = `${DATA_DIR}/broken-at.json`;
const LISTING_HISTORY_PATH = `${DATA_DIR}/listing-history.json`;
const NFTS_PATH       = `${DATA_DIR}/nfts.json`;
const SALES_ENRICHED_PATH = `${DATA_DIR}/sales-enriched.json`;
const PROVENANCE_PATH = `${DATA_DIR}/nft-provenance.json`;

// ─── queries ─────────────────────────────────────────────────────────────────
const BREAK_QUERY      = [`wasm.action='break_nft'`,      `wasm._contract_address='${ADAO_NFT}'`];
const BBL_CREATE_QUERY = [`wasm.action='create_auction'`, `wasm.nft_contract='${ADAO_NFT}'`];
const sendNftQuery = (mkt) => [`wasm.action='send_nft'`, `wasm.recipient='${mkt}'`, `wasm._contract_address='${ADAO_NFT}'`];

// ─── parsers (unit-tested against real txs) ──────────────────────────────────

// One tx can carry several break_nft msgs — return ALL break events in it.
function parseBreakTx(tx) {
    const evs = eventsOf(tx);
    const sender = evs.find(e => e.type === 'message' && e.a.sender)?.a.sender || null;
    const out = [];
    for (const e of evs) {
        if (e.type === 'wasm' && e.a.action === 'break_nft' && e.a._contract_address === ADAO_NFT && e.a.token_id != null) {
            out.push({
                token_id: String(e.a.token_id),
                broken_at: tx.timestamp,
                height: Number(tx.height),
                tx_hash: tx.txhash,
                breaker: sender,
                rewards_redeemed: e.a.rewards != null ? String(e.a.rewards) : null,
            });
        }
    }
    return out;
}

// BBL create_auction — all creates in the tx.
function parseBblCreateTx(tx) {
    const evs = eventsOf(tx);
    const out = [];
    for (const e of evs) {
        if (e.type === 'wasm' && e.a.action === 'create_auction' && e.a._contract_address === BBL && e.a.nft_contract === ADAO_NFT && e.a.token_id != null) {
            out.push({
                marketplace: 'BBL',
                listing_ref: String(e.a.auction_id),
                token_id: String(e.a.token_id),
                seller: e.a.seller || null,
                price_raw: e.a.reserve != null ? String(e.a.reserve) : null,
                denom: e.a.denom || null,
                listing_type: e.a.auction_type || null,
                created_at: tx.timestamp,
                height: Number(tx.height),
                tx_hash: tx.txhash,
            });
        }
    }
    return out;
}

// Atrium/Boost escrow leg — the cw721 send_nft into the marketplace, paired with
// the marketplace's own wasm event by token_id (bulk lists put several listings
// in ONE tx — verified live: Atrium "Bulk list" memo). The payment denom isn't in
// Atrium's list_nft event, so we also decode the embedded base64 send_nft msg
// ({price, payment:{Cw20:{contract_addr}}}) from the tx body.
function decodeEscrowMsgs(tx) {
    // token_id → decoded inner msg from tx.body.messages
    const map = {};
    const msgs = tx?.tx?.body?.messages || tx?.body?.messages || [];
    for (const m of msgs) {
        const sn = m?.msg?.send_nft;
        if (!sn || sn.token_id == null || !sn.msg) continue;
        try { map[String(sn.token_id)] = JSON.parse(Buffer.from(sn.msg, 'base64').toString('utf8')); } catch { /* opaque payload */ }
    }
    return map;
}
function denomFromPayment(payment) {
    if (!payment) return null;
    if (payment.Cw20?.contract_addr) return `cw20:${payment.Cw20.contract_addr}`;
    if (payment.cw20?.contract_addr) return `cw20:${payment.cw20.contract_addr}`;
    if (payment.Native?.denom) return payment.Native.denom;
    if (payment.native?.denom) return payment.native.denom;
    if (typeof payment === 'string') return payment;
    return null;
}
function parseEscrowCreateTx(tx, mktAddr) {
    const evs = eventsOf(tx);
    const out = [];
    const mktEvents = evs.filter(e => e.type === 'wasm' && e.a._contract_address === mktAddr);
    const inner = decodeEscrowMsgs(tx);
    for (const e of evs) {
        if (e.type === 'wasm' && e.a.action === 'send_nft' && e.a._contract_address === ADAO_NFT && e.a.recipient === mktAddr && e.a.token_id != null) {
            const tid = String(e.a.token_id);
            // pair by token_id first (bulk-safe), then msg_index, then first
            const m = mktEvents.find(x => String(x.a.token_id) === tid)
                   || mktEvents.find(x => x.a.msg_index != null && x.a.msg_index === e.a.msg_index)
                   || mktEvents[0] || { a: {} };
            const dec = inner[tid] || null;   // decoded {price, payment, ...} or {create_auction:{...}}
            const decBody = dec?.create_auction || dec || {};
            const id    = m.a.listing_id ?? m.a.id ?? m.a.auction_id ?? null;
            const price = m.a.price ?? m.a.reserve ?? m.a.amount ?? decBody.price ?? decBody.reserve_price ?? null;
            const denom = m.a.denom ?? denomFromPayment(decBody.payment) ?? decBody.denom ?? null;
            out.push({
                marketplace: MKT_NAME[mktAddr] || mktAddr,
                listing_ref: id != null ? String(id) : `h${tx.height}:${tid}`,   // synthetic ref if not emitted
                token_id: tid,
                seller: e.a.sender || null,
                price_raw: price != null ? String(price) : null,
                denom: denom || null,
                listing_type: m.a.action || 'listing',
                created_at: tx.timestamp,
                height: Number(tx.height),
                tx_hash: tx.txhash,
                mkt_event_attrs: m.a && Object.keys(m.a).length ? m.a : null,   // the PAIRED event, verbatim
            });
        }
    }
    return out;
}

// ─── outcome derivation ──────────────────────────────────────────────────────
const MKT_ADDR_BY_NAME = { BBL, Atrium: ATRIUM, Boost: BOOST };

function deriveOutcomes(listings, salesEnriched, provenance, currentNfts) {
    const sales = (salesEnriched && Array.isArray(salesEnriched.sales)) ? salesEnriched.sales : [];
    const salesByRef = new Map();      // "BBL:17746" → sale
    const salesByTx  = new Map();      // tx_hash → sale
    for (const s of sales) {
        if (s.marketplace && s.listing_id != null) salesByRef.set(`${s.marketplace}:${s.listing_id}`, s);
        if (s.tx_hash) salesByTx.set(s.tx_hash, s);
    }
    const provTokens = (provenance && provenance.tokens) || {};
    const liveByRef = new Set();       // currently-live listings "BBL:17746"
    const ownerById = new Map();
    for (const r of (currentNfts?.records || [])) {
        ownerById.set(String(r.id), r.owner);
        if (r.listing && r.listing.marketplace && r.listing.internal_id != null) {
            liveByRef.add(`${r.listing.marketplace}:${r.listing.internal_id}`);
        }
    }

    const counts = { sold: 0, delisted: 0, active: 0, unknown: 0 };
    const records = listings.map(L => {
        const refKey = `${L.marketplace}:${L.listing_ref}`;
        const mktAddr = MKT_ADDR_BY_NAME[L.marketplace];
        let outcome = 'unknown', to_ts = null, end_reason = 'unknown', sold_tx = null;

        const direct = salesByRef.get(refKey);
        // Find the token's first exit from the marketplace AFTER this create.
        const events = (provTokens[L.token_id]?.events) || [];
        const exit = events.find(ev => ev.from === mktAddr && Number(ev.block) > L.height);

        if (direct) {
            outcome = 'sold'; end_reason = 'sale'; to_ts = direct.timestamp; sold_tx = direct.tx_hash || null;
        } else if (exit && salesByTx.has(exit.tx_hash)) {
            const s = salesByTx.get(exit.tx_hash);
            outcome = 'sold'; end_reason = 'sale'; to_ts = s.timestamp; sold_tx = s.tx_hash;
        } else if (exit) {
            outcome = 'delisted'; end_reason = 'delist'; to_ts = exit.timestamp;
        } else if (liveByRef.has(refKey) || ownerById.get(L.token_id) === mktAddr) {
            outcome = 'active'; end_reason = 'still_listed';
        }
        counts[outcome]++;
        return {
            token_id: L.token_id,
            marketplace: L.marketplace,
            listing_ref: L.listing_ref,
            seller: L.seller,
            segments: [{
                price: L.price_raw, denom: L.denom,
                from_ts: L.created_at, from_height: L.height,
                to_ts, end_reason,
            }],
            listing_type: L.listing_type,
            outcome,
            ...(sold_tx ? { sold_tx } : {}),
            create_tx: L.tx_hash,
            ...(L.mkt_event_attrs ? { mkt_event_attrs: L.mkt_event_attrs } : {}),
        };
    });
    return { records, counts };
}

// ─── integrity ───────────────────────────────────────────────────────────────
function checkBreaks(entries, currentNfts) {
    const brokenSet = new Set((currentNfts?.records || []).filter(r => r.broken).map(r => String(r.id)));
    const haveBreak = new Set(Object.keys(entries));
    const missing = [...brokenSet].filter(t => !haveBreak.has(t));         // broken but no event found
    const extra   = [...haveBreak].filter(t => !brokenSet.has(t));        // event but not currently broken (should be 0 — can't unbreak)
    const issues = [];
    if (brokenSet.size && haveBreak.size < brokenSet.size * 0.9) {
        issues.push(`FATAL: only ${haveBreak.size} break events vs ${brokenSet.size} broken NFTs (<90%) — sweep incomplete`);
    }
    if (extra.length > 5) issues.push(`FATAL: ${extra.length} break events on currently-UNBROKEN tokens — parse or data error`);
    return { brokenSet, missing, extra, issues };
}

function checkListings(records, salesEnriched, currentNfts) {
    const issues = [], warnings = [];
    const bblCreates = records.filter(r => r.marketplace === 'BBL');
    const bblSales = ((salesEnriched && salesEnriched.sales) || []).filter(s => s.marketplace === 'BBL').length;
    if (bblSales && bblCreates.length < bblSales * 0.95) {
        issues.push(`FATAL: ${bblCreates.length} BBL creates < ${bblSales} BBL sales — every sale needs a create; sweep incomplete`);
    }
    const createRefs = new Set(records.map(r => `${r.marketplace}:${r.listing_ref}`));
    for (const r of (currentNfts?.records || [])) {
        const l = r.listing;
        if (l && l.marketplace && l.internal_id != null && !createRefs.has(`${l.marketplace}:${l.internal_id}`)) {
            warnings.push({ reason: 'live_listing_missing_create', marketplace: l.marketplace, ref: String(l.internal_id), token_id: String(r.id) });
        }
    }
    return { issues, warnings };
}

// ─── publish (same contents-API pattern as the other backfills) ─────────────
function githubPut(path, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com', path, method: body ? 'PUT' : 'GET',
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-events-backfill/1.0', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, data: {} }); } }); });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}
async function pushToGithub(filepath, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${encodeURIComponent(filepath).replace(/%2F/g, '/')}`;
    const existing = await githubPut(apiPath, null);
    const sha = existing.data?.sha;
    const r = await githubPut(apiPath, { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    if (r.status === 200 || r.status === 201) { console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(1)} KB)`); return true; }
    console.error(`  ❌ Push failed (HTTP ${r.status}): ${r.data?.message || '<no message>'}`);
    return false;
}

const readLocal = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    console.log(`🧹 NFT events backfill — target=${TARGET} mode=${RUN_MODE} — ${new Date().toISOString()}`);

    const currentNfts   = readLocal(NFTS_PATH);
    const salesEnriched = readLocal(SALES_ENRICHED_PATH);
    const provenance    = readLocal(PROVENANCE_PATH);
    if (!currentNfts)   console.warn('  ⚠ nfts.json not readable locally — break/listing cross-checks limited');
    if (!salesEnriched) console.warn('  ⚠ sales-enriched.json not readable — sold outcomes will fall back to provenance');
    if (!provenance)    console.warn('  ⚠ nft-provenance.json not readable — delist timestamps unavailable');

    // ── 1. breaks ──
    if (TARGET === 'both' || TARGET === 'breaks') {
        console.log('\n📥 Sweeping break_nft events…');
        const txs = await fetchAllTxs(BREAK_QUERY, 'break_nft');
        const all = txs.flatMap(parseBreakTx);
        // one break per token, ever — keep the earliest if dupes appear
        const entries = {};
        let dupes = 0;
        for (const b of all.sort((a, c) => a.height - c.height)) {
            if (entries[b.token_id]) { dupes++; continue; }
            entries[b.token_id] = b;
        }
        const chk = checkBreaks(entries, currentNfts);
        console.log(`\n📊 ${Object.keys(entries).length} break events (${dupes} dupes ignored) | currently broken: ${chk.brokenSet.size}`);
        if (chk.missing.length) console.warn(`  ⚠ ${chk.missing.length} broken tokens WITHOUT a break event (first 10: ${chk.missing.slice(0, 10).join(', ')})`);
        if (chk.extra.length)   console.warn(`  ⚠ ${chk.extra.length} break events on currently-unbroken tokens (first 10: ${chk.extra.slice(0, 10).join(', ')})`);
        for (const i of chk.issues) console.error('  ❌ ' + i);
        if (chk.issues.length) { process.exit(1); }

        const doc = {
            schemaVersion: 1, builtAt: new Date().toISOString(),
            source: 'nft-events-backfill.js (break_nft events)',
            nft_contract: ADAO_NFT,
            note: 'Break timestamp per token. NFTs cannot unbreak, so this map only ever grows. Use sale.timestamp vs broken_at to classify a sale as pre/post-break.',
            count: Object.keys(entries).length,
            missing_break_event: chk.missing,        // broken on-chain but no event found (investigate if non-empty)
            entries,
        };
        if (RUN_MODE === 'full') {
            const prev = readLocal(BROKEN_AT_PATH);
            if (prev && prev.count > doc.count) { console.error(`❌ ABORT breaks: ${doc.count} < committed ${prev.count} — not publishing`); process.exit(1); }
            if (GITHUB_TOKEN) await pushToGithub(BROKEN_AT_PATH, JSON.stringify(doc, null, 1), `broken-at backfill — ${doc.count} break events`);
            else { fs.writeFileSync('broken-at.json', JSON.stringify(doc, null, 1)); console.log('  ⚠ no GITHUB_TOKEN — wrote broken-at.json locally'); }
        } else {
            console.log('  (sample mode — nothing written)');
        }
    }

    // ── 2. listings ──
    if (TARGET === 'both' || TARGET === 'listings') {
        console.log('\n📥 Sweeping listing creates…');
        const [bblTxs, atriumTxs, boostTxs] = [
            await fetchAllTxs(BBL_CREATE_QUERY, 'bbl create_auction'),
            await fetchAllTxs(sendNftQuery(ATRIUM), 'atrium escrow'),
            await fetchAllTxs(sendNftQuery(BOOST), 'boost escrow').catch(e => { console.warn('  ⚠ boost sweep failed: ' + e.message); return []; }),
        ];
        const listings = [
            ...bblTxs.flatMap(parseBblCreateTx),
            ...atriumTxs.flatMap(tx => parseEscrowCreateTx(tx, ATRIUM)),
            ...boostTxs.flatMap(tx => parseEscrowCreateTx(tx, BOOST)),
        ];
        console.log(`\n📊 creates: BBL ${listings.filter(l => l.marketplace === 'BBL').length}, Atrium ${listings.filter(l => l.marketplace === 'Atrium').length}, Boost ${listings.filter(l => l.marketplace === 'Boost').length}`);

        const { records, counts } = deriveOutcomes(listings, salesEnriched, provenance, currentNfts);
        console.log(`   outcomes: sold ${counts.sold} | delisted ${counts.delisted} | active ${counts.active} | unknown ${counts.unknown}`);
        const chk = checkListings(records, salesEnriched, currentNfts);
        if (chk.warnings.length) console.warn(`  ⚠ ${chk.warnings.length} live listings without a recovered create (likely the chain-sweep holes — recovered listings have no create tx): ${chk.warnings.slice(0, 6).map(w => w.ref).join(', ')}`);
        for (const i of chk.issues) console.error('  ❌ ' + i);
        if (chk.issues.length) { process.exit(1); }

        const doc = {
            schemaVersion: 1, builtAt: new Date().toISOString(),
            source: 'nft-events-backfill.js (create_auction + escrow send_nft; outcomes from sales-enriched + provenance)',
            nft_contract: ADAO_NFT,
            note: 'One record per marketplace listing. BBL price changes are cancel+recreate on-chain, so each auction_id is one price segment. Outcomes: sold (matched sale), delisted (token left the marketplace, no sale), active (still escrowed + live), unknown.',
            counts,
            live_listings_missing_create: chk.warnings,
            count: records.length,
            records,
        };
        if (RUN_MODE === 'full') {
            const prev = readLocal(LISTING_HISTORY_PATH);
            if (prev && prev.count > doc.count) { console.error(`❌ ABORT listings: ${doc.count} < committed ${prev.count} — not publishing`); process.exit(1); }
            if (GITHUB_TOKEN) await pushToGithub(LISTING_HISTORY_PATH, JSON.stringify(doc, null, 1), `listing-history backfill — ${records.length} listings (${counts.sold} sold / ${counts.delisted} delisted / ${counts.active} active)`);
            else { fs.writeFileSync('listing-history.json', JSON.stringify(doc, null, 1)); console.log('  ⚠ no GITHUB_TOKEN — wrote listing-history.json locally'); }
        } else {
            console.log('  (sample mode — nothing written)');
        }
    }

    console.log(`\n✅ done (${((Date.now() - t0) / 1000 / 60).toFixed(1)} min)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ FATAL: ${e.message}`); console.error(e.stack); process.exit(1); });
module.exports = { parseBreakTx, parseBblCreateTx, parseEscrowCreateTx, deriveOutcomes, checkBreaks, checkListings };
