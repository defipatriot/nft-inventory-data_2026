#!/usr/bin/env node
/**
 * nft-provenance-backfill.js — one-time sweeper that reconstructs the full
 * change-of-hands history of every aDAO NFT from the NFT contract's transfer_nft
 * events. This is the ORDERING SPINE: per token, transfers in block order; the
 * FIRST is the initial distribution (mint/claim), the rest are sales/transfers.
 *
 * Pairs with bbl-sales-backfill.js: where a transfer happened inside a tx that
 * also has a BBL `settle`, this is a SALE (we tag it; price comes from the settle
 * sweep, joined later by tx_hash). Otherwise it's a plain transfer/claim.
 *
 * Mints are NOT in the settle data (Phase 1b/2a predate BBL settle; distributions
 * used claim/candy-machine), so the FIRST transfer per token — its date + first
 * owner — is the authoritative mint record. Mint PRICE is assigned by phase from
 * release-history.html (rough but honest); exact-per-tx is a later refinement.
 *
 * MODES (env RUN_MODE): sample (default, first page, no write) | full (write
 * data/v2/nft-provenance.json).
 *
 * Same tx-search rules as the rest: query= form, NO tx.height range, paginate.
 */
'use strict';
const https = require('https');

const ADAO_NFT     = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const BBL_CONTRACT = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const DAODAO_STK   = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';
const ENT_STK      = 'terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv';
const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || LCD_PRIMARY; // default: retry same node, never mix indexes mid-pagination
const PAGE_LIMIT   = 100, MAX_PAGES = 200;

const RUN_MODE     = (process.env.RUN_MODE || 'sample').toLowerCase();
const SAMPLE_N     = Number(process.env.SAMPLE_N || 8);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH= process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH  = 'data/v2';
const PROV_PATH    = `${OUTPUT_PATH}/nft-provenance.json`;

// Mint phases from release-history.html (date window → price). Rough by design.
const PHASES = [
    { id: 'phase0',  name: 'GoA Claim',          from: '2023-12-12', to: '2024-01-12', mint_luna: 0   },
    { id: 'phase1b', name: 'DAO Staker Mint',     from: '2024-02-20', to: '2024-02-27', mint_luna: 50  },
    { id: 'phase2a', name: 'Terra NFT Communities',from:'2024-02-28', to: '2024-03-12', mint_luna: 75  },
    { id: 'phase2b', name: 'Alliance Stakers/Open',from:'2024-06-01', to: '2024-06-06', mint_luna: 114 },
];
function phaseFor(dateStr) {
    const d = dateStr.slice(0, 10);
    for (const p of PHASES) if (d >= p.from && d <= p.to) return p;
    return null;
}

// ─── HTTP / tx-search ───────────────────────────────────────────────────────
function httpGet(url, t = 20000) {
    return new Promise((res, rej) => {
        const r = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'aDAO-provenance/1.0' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}
async function lcdGet(p, label) { try { return await httpGet(LCD_PRIMARY + p); } catch (e) { try { return await httpGet(LCD_FALLBACK + p); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } } }
function txPath(conds, offset) { return `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(conds.join(' AND '))}&order_by=ORDER_BY_ASC&pagination.limit=${PAGE_LIMIT}&pagination.offset=${offset}`; }
async function fetchAllTxs(conds, label, _get = lcdGet) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const OVERLAP = 20, RETRIES = 25, EMPTY_CONFIRM = 5, BACKOFF = 400;
    const heights = b => b.map(t => Number(t.height));
    const out = [], seen = new Set();
    let lastMaxHeight = 0, partialSeen = false;

    // page 0: keep the deepest-archive page (smallest min height) across probes
    let best = null;
    for (let a = 0; a < RETRIES; a++) {
        let r; try { r = await _get(txPath(conds, 0), `${label} p0.${a}`); } catch { await sleep(BACKOFF); continue; }
        const batch = r?.tx_responses || [];
        if (batch.length === 0) { await sleep(BACKOFF); continue; }
        const minH = Math.min(...heights(batch));
        if (!best || minH < best.minH) best = { batch, minH };
        await sleep(120);
    }
    if (!best) throw new Error(`${label}: could not fetch first page after ${RETRIES} tries (node pool unreachable?)`);
    for (const tx of best.batch) if (!seen.has(tx.txhash)) { seen.add(tx.txhash); out.push(tx); }
    lastMaxHeight = Math.max(...heights(best.batch));
    partialSeen = best.batch.length < PAGE_LIMIT;
    process.stdout.write(`\r  ${label}: ${out.length} txs (start h=${best.minH})   `);

    for (let pg = 1; pg < MAX_PAGES; pg++) {
        const offset = Math.max(0, out.length - OVERLAP);
        let accepted = null, emptyVotes = 0, endVotes = 0;
        for (let a = 0; a < RETRIES; a++) {
            let r; try { r = await _get(txPath(conds, offset), `${label} p${pg}.${a}`); } catch { await sleep(BACKOFF); continue; }
            const batch = r?.tx_responses || [];
            if (batch.length === 0) { if (++emptyVotes >= EMPTY_CONFIRM) { accepted = 'END'; break; } await sleep(BACKOFF); continue; }
            let overlap = 0, fresh = 0;
            for (const tx of batch) (seen.has(tx.txhash) ? overlap++ : fresh++);
            if (overlap === 0) { await sleep(BACKOFF); continue; }        // discontinuous → bad/recent-only node
            if (fresh === 0) { if (partialSeen) { if (++endVotes >= 2) { accepted = 'END'; break; } } await sleep(BACKOFF); continue; }
            accepted = batch; break;
        }
        if (accepted === 'END') break;
        if (!accepted) { console.warn(`\n  ⚠ ${label}: stuck at offset ${offset} after ${RETRIES} tries — coverage partial up to height ${lastMaxHeight}. RE-RUN to extend.`); break; }
        for (const tx of accepted) if (!seen.has(tx.txhash)) { seen.add(tx.txhash); out.push(tx); }
        lastMaxHeight = Math.max(lastMaxHeight, Math.max(...heights(accepted)));
        partialSeen = accepted.length < PAGE_LIMIT;
        process.stdout.write(`\r  ${label}: ${out.length} txs (h=${lastMaxHeight})   `);
        if (pg === MAX_PAGES - 1) console.warn(`\n  ⚠ ${label} hit page cap (${MAX_PAGES}); got ${out.length}`);
    }
    process.stdout.write('\n'); return out;
}

// ─── events ───────────────────────────────────────────────────────────────────
function eventsOf(tx) {
    const out = [];
    if (Array.isArray(tx?.logs)) for (const l of tx.logs) for (const e of (l.events || [])) out.push({ type: e.type, a: Object.fromEntries((e.attributes || []).map(x => [x.key, x.value])) });
    if (out.length === 0 && Array.isArray(tx?.events)) for (const e of tx.events) out.push({ type: e.type, a: Object.fromEntries((e.attributes || []).map(x => [x.key, x.value])) });
    return out;
}

// Classify a transfer's context from the tx it lives in.
function classify(evs, from, to) {
    const hasSettle = evs.some(e => e.type === 'wasm' && e.a.action === 'settle');
    if (hasSettle) return 'sale';
    if (to === DAODAO_STK || to === ENT_STK) return 'stake';
    if (from === DAODAO_STK || from === ENT_STK) return 'unstake_or_claim';
    if (from === BBL_CONTRACT) return 'marketplace_move';
    if (to === BBL_CONTRACT) return 'list';
    return 'transfer';
}

// Extract every aDAO transfer_nft in a tx → [{token_id, from, to, type}]
function parseTransfers(tx) {
    const evs = eventsOf(tx);
    const moves = evs.filter(e => e.type === 'wasm' && e.a._contract_address === ADAO_NFT && e.a.action === 'transfer_nft' && e.a.token_id != null);
    return moves.map(m => ({
        token_id: m.a.token_id,
        from: m.a.sender,
        to: m.a.recipient,
        type: classify(evs, m.a.sender, m.a.recipient),
        tx_hash: tx.txhash,
        block: Number(tx.height),
        timestamp: tx.timestamp,
    }));
}

// Build per-token ordered provenance from all transfer txs.
function buildProvenance(txs) {
    const all = [];
    for (const tx of txs) all.push(...parseTransfers(tx));
    // de-dupe (same token can only move once per tx) + sort by block
    const seen = new Set();
    const events = all.filter(e => { const k = `${e.tx_hash}:${e.token_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    events.sort((a, b) => a.block - b.block || String(a.token_id).localeCompare(String(b.token_id)));

    const tokens = {};
    for (const e of events) {
        if (!tokens[e.token_id]) tokens[e.token_id] = { token_id: e.token_id, events: [] };
        tokens[e.token_id].events.push(e);
    }
    // first transfer = initial distribution (mint/claim); tag phase + price
    for (const t of Object.values(tokens)) {
        const first = t.events[0];
        const ph = phaseFor(first.timestamp);
        t.mint = {
            date: first.timestamp, first_owner: first.to, from: first.from,
            phase: ph ? ph.id : 'unknown', phase_name: ph ? ph.name : null,
            mint_price_luna: ph ? ph.mint_luna : null, tx_hash: first.tx_hash, block: first.block,
        };
        t.hand_changes = t.events.length;
        t.sale_count = t.events.filter(e => e.type === 'sale').length;
        t.current_owner = t.events[t.events.length - 1].to;
    }
    return { events, tokens };
}

function summarize(tokens) {
    const phaseCounts = {}, typeCounts = {};
    let totalChanges = 0;
    for (const t of Object.values(tokens)) {
        phaseCounts[t.mint.phase] = (phaseCounts[t.mint.phase] || 0) + 1;
        totalChanges += t.hand_changes;
        for (const e of t.events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    return { distinct_tokens: Object.keys(tokens).length, total_hand_changes: totalChanges, phaseCounts, typeCounts };
}

// ─── GitHub ────────────────────────────────────────────────────────────────────
function ghReq(method, path, payload) {
    return new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = https.request({ hostname: 'api.github.com', path, method, headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-provenance/1.0', Accept: 'application/vnd.github+json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
            (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b || '{}')); else if (res.statusCode === 404) resolve(null); else reject(new Error(`GitHub ${res.statusCode}: ${b.slice(0, 160)}`)); }); });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}
async function pushToGithub(path, content, message) {
    const ap = `/repos/${GITHUB_REPO}/contents/${path}`;
    const ex = await ghReq('GET', `${ap}?ref=${GITHUB_BRANCH}`).catch(() => null);
    await ghReq('PUT', ap, { message, branch: GITHUB_BRANCH, content: Buffer.from(content).toString('base64'), ...(ex?.sha ? { sha: ex.sha } : {}) });
    console.log(`  ✅ ${path} (${(content.length / 1024).toFixed(1)} KB)`);
}

// ─── main ────────────────────────────────────────────────────────────────────────
const QUERY = [`wasm._contract_address='${ADAO_NFT}'`, `wasm.action='transfer_nft'`];

async function main() {
    const t0 = Date.now();
    console.log(`🧬 aDAO NFT provenance backfill — mode: ${RUN_MODE} — ${new Date().toISOString()}\n`);

    if (RUN_MODE === 'sample') {
        const resp = await lcdGet(txPath(QUERY, 0), 'transfers');
        const txs = resp?.tx_responses || [];
        console.log(`  total transfer_nft all-time: ${resp?.total ?? '(n/a)'} | got ${txs.length} this page\n`);
        const { tokens } = buildProvenance(txs);
        console.log(`── sample parsed moves (first ${SAMPLE_N}) ──`);
        const flat = Object.values(tokens).flatMap(t => t.events).sort((a, b) => a.block - b.block).slice(0, SAMPLE_N);
        for (const e of flat) console.log(`  #${e.token_id} ${e.timestamp} ${e.type} …${e.from.slice(-6)}→…${e.to.slice(-6)}`);
        console.log(`\n── per-token sample ──`);
        for (const t of Object.values(tokens).slice(0, SAMPLE_N)) console.log('  ' + JSON.stringify({ token: t.token_id, mint_phase: t.mint.phase, mint_date: t.mint.date, first_owner: '…' + t.mint.first_owner.slice(-6), hand_changes: t.hand_changes }));
        console.log(`\n  summary:`, JSON.stringify(summarize(tokens)));
        console.log(`\n✅ sample done (${((Date.now() - t0) / 1000).toFixed(1)}s). Nothing written.`);
        return;
    }

    console.log('📥 Fetching all aDAO transfer_nft events…');
    const txs = await fetchAllTxs(QUERY, 'transfers');
    const { tokens } = buildProvenance(txs);
    const sum = summarize(tokens);
    console.log(`\n📊 provenance reconstructed`);
    console.log(`   distinct tokens (≈ public circulation):`, sum.distinct_tokens);
    console.log(`   total hand-changes:`, sum.total_hand_changes);
    console.log(`   by mint phase:`, JSON.stringify(sum.phaseCounts));
    console.log(`   by move type:`, JSON.stringify(sum.typeCounts));

    const doc = {
        schemaVersion: 1, builtAt: new Date().toISOString(),
        source: 'nft-provenance-backfill.js (transfer_nft spine)',
        nft_contract: ADAO_NFT,
        note: 'Per-token change-of-hands history. First event per token = initial distribution; mint phase/price assigned by date from release-history.html (approximate). Sale events tagged where the tx also had a BBL settle — join sales-history.json by tx_hash for price/USD. Stakes use send_nft (different action) and are NOT in this transfer_nft spine; current stake status comes from nfts.json.',
        summary: sum, tokens,
    };
    if (GITHUB_TOKEN) { console.log('\n📤 Publishing…'); await pushToGithub(PROV_PATH, JSON.stringify(doc), `nft provenance — ${sum.distinct_tokens} tokens`); }
    else { require('fs').writeFileSync('nft-provenance.json', JSON.stringify(doc)); console.log('\n⚠️  GITHUB_TOKEN not set — wrote locally'); }
    console.log(`\n✅ full sweep done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ FATAL: ${e.message}`); console.error(e.stack); process.exit(1); });
module.exports = { parseTransfers, buildProvenance, summarize, classify, phaseFor, eventsOf, fetchAllTxs, txPath };
