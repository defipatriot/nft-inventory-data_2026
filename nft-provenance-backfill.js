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

const ADAO_NFT     = process.env.NFT_CONTRACT || 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9'; // parameterized per collection
const COLLECTION   = (process.env.COLLECTION || 'adao').toLowerCase();
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
const PROV_PATH    = COLLECTION === 'adao' ? `${OUTPUT_PATH}/nft-provenance.json` : `${OUTPUT_PATH}/${COLLECTION}/nft-provenance.json`;

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
const KEEPALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
function httpGet(url, t = 20000) {
    return new Promise((res, rej) => {
        const r = https.get(url, { agent: KEEPALIVE_AGENT, headers: { Accept: 'application/json', Connection: 'keep-alive', 'User-Agent': 'aDAO-backfill/3.0' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}
async function lcdGet(p, label) { try { return await httpGet(LCD_PRIMARY + p); } catch (e) { try { return await httpGet(LCD_FALLBACK + p); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } } }
function txPath(conds, page) { return `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(conds.join(' AND '))}&order_by=ORDER_BY_ASC&page=${page}&limit=${PAGE_LIMIT}`; }
async function fetchAllTxs(conds, label, _get = lcdGet) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const RETRIES = +(process.env.PAGER_RETRIES||40), ROUNDS = +(process.env.PAGER_ROUNDS||2), ERR_BACKOFF = +(process.env.PAGER_ERR_BACKOFF||250), PROBE_DELAY = +(process.env.PAGER_PROBE_DELAY||40), CONTIG_DELTA = 250000, P1_STABLE = 12;
    const out = [], seen = new Set();
    const stats = { calls: 0, pages: 0, regress: 0, far: 0, dup: 0, empty: 0, error: 0, reprobe: 0 };
    let frontier = 0, globalMax = 0, stop = 'complete';
    const scan = (batch) => { let freshMin = Infinity, fresh = 0; for (const tx of batch) { const h = Number(tx.height); if (h > globalMax) globalMax = h; if (!seen.has(tx.txhash)) { fresh++; if (h < freshMin) freshMin = h; } } return { fresh, freshMin }; };
    const commit = (batch) => { let added = 0; for (const tx of batch) { const h = Number(tx.height); if (h > frontier) frontier = h; if (!seen.has(tx.txhash)) { seen.add(tx.txhash); out.push(tx); added++; } } stats.pages++; return added; };

    // page 1: deepest archive wins; early-break once the smallest start-height stabilizes
    let best1 = null, noImprove = 0, nonEmpty = 0;
    for (let a = 0; a < RETRIES; a++) {
        stats.calls++;
        let resp; try { resp = await _get(txPath(conds, 1), label + ' p1.' + a); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
        const batch = resp?.tx_responses || [];
        if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
        scan(batch); nonEmpty++;
        const minH = Math.min(...batch.map(t => Number(t.height)));
        if (!best1 || minH < best1.minH) { best1 = { batch, minH }; noImprove = 0; } else { noImprove++; }
        if (a % 8 === 7) console.log('  ' + label + ': probing page 1… best start-height=' + (best1 ? best1.minH : 'n/a') + ' (' + (a + 1) + ' probes)');
        if (nonEmpty >= 3 && noImprove >= P1_STABLE) break; // deepest start-height stable → stop probing
        await sleep(PROBE_DELAY);
    }
    if (!best1) throw new Error(label + ': page 1 unreachable after ' + RETRIES + ' tries');
    commit(best1.batch);
    console.log('  ' + label + ': page1 start-height=' + best1.minH + ' (' + out.length + ' txs, frontier=' + frontier + ')');

    // pages 2..N: accept the tightest forward continuation; never jump past data
    for (let page = 2; page < MAX_PAGES; page++) {
        const avg = out.length > 1 ? Math.max(1, (frontier - Number(out[0].height)) / (out.length - 1)) : 1;
        const TIGHT = Math.max(2000, 3 * avg), LOOSE = Math.max(50000, 10 * avg);
        let bestCand = null, rounds = 0;
        do {
            if (rounds > 0) stats.reprobe++;
            for (let a = 0; a < RETRIES; a++) {
                stats.calls++;
                let resp; try { resp = await _get(txPath(conds, page), label + ' p' + page + '.' + a); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
                const batch = resp?.tx_responses || [];
                if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
                const { fresh, freshMin } = scan(batch);
                if (fresh === 0) { stats.dup++; await sleep(PROBE_DELAY); continue; }
                if (freshMin < frontier) { stats.regress++; await sleep(PROBE_DELAY); continue; }
                if (freshMin - frontier > CONTIG_DELTA) { stats.far++; await sleep(PROBE_DELAY); continue; }
                if (!bestCand || freshMin < bestCand.freshMin) bestCand = { batch, freshMin };
                if (bestCand.freshMin - frontier <= TIGHT) break;
                await sleep(PROBE_DELAY);
            }
            rounds++;
        } while (frontier < globalMax && rounds < ROUNDS && (!bestCand || bestCand.freshMin - frontier > LOOSE));

        if (bestCand) {
            const added = commit(bestCand.batch);
            console.log('  ' + label + ': ' + out.length + ' txs (page ' + page + ', frontier=' + frontier + ', +' + added + ')');
            if (page === MAX_PAGES - 1) { stop = 'page-cap'; console.warn('  ⚠ ' + label + ' hit page cap (' + MAX_PAGES + ')'); }
            continue;
        }
        if (frontier >= globalMax) { stop = 'clean-end'; break; }
        stop = 'stuck@page' + page;
        console.warn('  ⚠ ' + label + ': STUCK at page ' + page + ' — frontier ' + frontier + ' < globalMax ' + globalMax);
        break;
    }
    out.sort((a, b) => Number(a.height) - Number(b.height) || (a.txhash < b.txhash ? -1 : 1));
    console.log('  ' + label + ': DONE — ' + out.length + ' txs | stop=' + stop + ' | pages=' + stats.pages + ' | calls=' + stats.calls + ' | reprobe=' + stats.reprobe + ' | regress=' + stats.regress + ' far=' + stats.far + ' dup=' + stats.dup + ' empty=' + stats.empty + ' error=' + stats.error);
    return out;
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
        collection: COLLECTION,
        note: 'Per-token change-of-hands history. First event per token = initial distribution; mint phase/price assigned by date from release-history.html (approximate). Sale events tagged where the tx also had a BBL settle — join sales-history.json by tx_hash for price/USD. Stakes use send_nft (different action) and are NOT in this transfer_nft spine; current stake status comes from nfts.json.',
        summary: sum, tokens,
    };
    if (GITHUB_TOKEN) { console.log('\n📤 Publishing…'); await pushToGithub(PROV_PATH, JSON.stringify(doc), `nft provenance — ${sum.distinct_tokens} tokens`); }
    else { require('fs').writeFileSync('nft-provenance.json', JSON.stringify(doc)); console.log('\n⚠️  GITHUB_TOKEN not set — wrote locally'); }
    console.log(`\n✅ full sweep done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (require.main === module) main().catch(e => { console.error(`❌ FATAL: ${e.message}`); console.error(e.stack); process.exit(1); });
module.exports = { parseTransfers, buildProvenance, summarize, classify, phaseFor, eventsOf, fetchAllTxs, txPath };
