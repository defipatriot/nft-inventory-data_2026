/*
 * nft-analytics-builder.js — Phase 2 of the NFT history pipeline.
 *
 * Reads the committed seed files for a collection and produces market analytics:
 *   inputs  (data/v2[/<collection>]/):
 *     - sales-history.json      (settle-centric sales; raw amounts, no USD)
 *     - nft-provenance.json     (per-token transfer_nft spine)
 *   shared oracle (data/v2/):
 *     - luna-usd-daily.json      (date → USD per LUNA)
 *   outputs (same dir as the collection's seeds):
 *     - sales-enriched.json      (per-sale: USD-at-sale, value-today, hold, basis)
 *     - nft-analytics.json       (small rollup file the dashboard reads)
 *
 * USD methodology (the point of this build):
 *   notional_usd  = amount_luna_equiv * dailyLUNA[sale_date]   ← what they actually paid, in USD then
 *   value_today   = amount_luna_equiv * spotLUNA              ← reproduces BBL's all-time-volume method
 *   amount_luna_equiv = gross/1e6 * (denom==bLUNA ? blunaRate : 1)
 *
 * bLUNA(boneLUNA) is a LUNA LSD; its hub exchange-rate drifts ~1.0→1.15 over time.
 * Historical per-date rates need an on-chain hub query; until that source exists we
 * use a single configurable rate (BLUNA_RATE, default 1.0) and flag it in the output.
 *
 * Env: COLLECTION (default adao), DATA_DIR (default data/v2), BLUNA_RATE (default 1.0),
 *      GITHUB_TOKEN/GITHUB_REPO/GITHUB_BRANCH (push if token present, else write local).
 */
'use strict';
const fs = require('fs');
const https = require('https');

const COLLECTION  = (process.env.COLLECTION || 'adao').toLowerCase();
const DATA_DIR    = process.env.DATA_DIR || 'data/v2';
const COLL_DIR    = COLLECTION === 'adao' ? DATA_DIR : `${DATA_DIR}/${COLLECTION}`;
const BLUNA_RATE  = Number(process.env.BLUNA_RATE || 1.0);
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// aDAO royalty wallets: the dedicated royalty wallet AND the DAO main wallet
// (earliest sales routed royalties straight to the treasury before the royalty wallet existed).
const ROYALTY_WALLET = 'terra1g0mfrpswewteaf9ky4rlj09wh5njp6u9xxk94uszplw4qz2f9mzq3k27fm';
const DAO_MAIN       = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';
const DAO_ROYALTY_RECIPIENTS = new Set([ROYALTY_WALLET, DAO_MAIN]);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const dayOf = (ts) => String(ts).slice(0, 10);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function loadInputs() {
    const sales = readJson(`${COLL_DIR}/sales-history.json`);
    const prov  = readJson(`${COLL_DIR}/nft-provenance.json`);
    const oracle = readJson(`${DATA_DIR}/luna-usd-daily.json`);
    const daily = oracle.daily || oracle;
    const dates = Object.keys(daily).sort();
    const spot = daily[dates[dates.length - 1]];
    return { salesDoc: sales, sales: sales.sales || sales, prov, daily, spot, oracleSpan: [dates[0], dates[dates.length - 1]] };
}

// nearest-on-or-before price for a date (handles gaps)
function priceOn(daily, date) {
    if (daily[date] != null) return daily[date];
    let best = null;
    for (const d in daily) if (d <= date && (best === null || d > best)) best = d;
    return best ? daily[best] : null;
}

function lunaEquiv(sale) {
    const amt = Number(sale.gross_amount) / 1e6;
    return sale.denom_symbol === 'bLUNA' ? amt * BLUNA_RATE : amt;
}

function enrich(sales, daily, spot, prov) {
    const tokens = prov.tokens || {};
    const out = [];
    for (const s of sales) {
        const date = dayOf(s.timestamp);
        const px = priceOn(daily, date);
        const le = lunaEquiv(s);
        const notional = px != null ? le * px : null;
        // provenance join: the seller's acquisition (latest event before this sale where recipient===seller)
        let acquired_at = null, basis_kind = null;
        const t = tokens[s.token_id];
        if (t && Array.isArray(t.events)) {
            const prior = t.events.filter(e => e.block < s.block && e.to === s.seller).sort((a, b) => b.block - a.block)[0];
            if (prior) { acquired_at = prior.timestamp; basis_kind = prior.type; }
            else if (t.mint && t.mint.first_owner === s.seller) { acquired_at = t.mint.date; basis_kind = 'mint'; }
        }
        const hold_days = acquired_at ? round((new Date(s.timestamp) - new Date(acquired_at)) / 86400000, 1) : null;
        out.push({
            ...s,
            luna_equiv: round(le, 6),
            price_luna_usd: px,
            notional_usd: notional != null ? round(notional, 4) : null,
            value_today_usd: round(le * spot, 4),
            acquired_at, basis_kind, hold_days,
        });
    }
    return out;
}

function rollups(enriched, spot, oracleSpan) {
    const sum = (a, f) => a.reduce((x, s) => x + (f(s) || 0), 0);
    const n = enriched.length;
    const notional = sum(enriched, s => s.notional_usd);
    const today = sum(enriched, s => s.value_today_usd);
    const lunaTot = sum(enriched, s => s.luna_equiv);

    // denom split
    const denom = {};
    for (const s of enriched) { const d = s.denom_symbol; (denom[d] = denom[d] || { count: 0, luna_equiv: 0, notional_usd: 0 }); denom[d].count++; denom[d].luna_equiv += s.luna_equiv; denom[d].notional_usd += s.notional_usd || 0; }
    for (const d in denom) { denom[d].luna_equiv = round(denom[d].luna_equiv, 2); denom[d].notional_usd = round(denom[d].notional_usd, 2); }

    // royalties (residual leg). aDAO recipients = royalty wallet + DAO main (both "to DAO")
    let royLunaTo = {}, royNotional = 0;
    for (const s of enriched) {
        if (s.royalty_fee == null) continue;
        const rle = Number(s.royalty_fee) / 1e6 * (s.denom_symbol === 'bLUNA' ? BLUNA_RATE : 1);
        const r = s.royalty_recipient || 'unknown';
        royLunaTo[r] = (royLunaTo[r] || 0) + rle;
        royNotional += s.price_luna_usd != null ? rle * s.price_luna_usd : 0;
    }
    const royaltyByRecipient = Object.entries(royLunaTo).map(([r, l]) => ({
        recipient: r, is_dao: DAO_ROYALTY_RECIPIENTS.has(r), luna_equiv: round(l, 2), value_today_usd: round(l * spot, 2),
    })).sort((a, b) => b.luna_equiv - a.luna_equiv);

    // monthly time series (notional + count)
    const monthly = {};
    for (const s of enriched) { const m = dayOf(s.timestamp).slice(0, 7); (monthly[m] = monthly[m] || { count: 0, notional_usd: 0, luna_equiv: 0 }); monthly[m].count++; monthly[m].notional_usd += s.notional_usd || 0; monthly[m].luna_equiv += s.luna_equiv; }
    const monthlySeries = Object.keys(monthly).sort().map(m => ({ month: m, count: monthly[m].count, notional_usd: round(monthly[m].notional_usd, 2), luna_equiv: round(monthly[m].luna_equiv, 2) }));

    // leaderboards
    const agg = (keyFn) => { const m = {}; for (const s of enriched) { const k = keyFn(s); (m[k] = m[k] || { count: 0, notional_usd: 0, luna_equiv: 0 }); m[k].count++; m[k].notional_usd += s.notional_usd || 0; m[k].luna_equiv += s.luna_equiv; } return Object.entries(m).map(([k, v]) => ({ address: k, count: v.count, notional_usd: round(v.notional_usd, 2), luna_equiv: round(v.luna_equiv, 2) })); };
    const topBuyers = agg(s => s.buyer).sort((a, b) => b.notional_usd - a.notional_usd).slice(0, 20);
    const topSellers = agg(s => s.seller).sort((a, b) => b.notional_usd - a.notional_usd).slice(0, 20);

    // most-traded tokens
    const byToken = {};
    for (const s of enriched) { (byToken[s.token_id] = byToken[s.token_id] || { sales: 0, notional_usd: 0 }); byToken[s.token_id].sales++; byToken[s.token_id].notional_usd += s.notional_usd || 0; }
    const mostTraded = Object.entries(byToken).map(([t, v]) => ({ token_id: t, sales: v.sales, notional_usd: round(v.notional_usd, 2) })).sort((a, b) => b.sales - a.sales || b.notional_usd - a.notional_usd).slice(0, 20);

    // sale-number distribution
    const saleNumDist = {};
    for (const s of enriched) { const k = s.sale_number || 1; saleNumDist[k] = (saleNumDist[k] || 0) + 1; }

    // realized flip P&L: consecutive sales of the same token (basis = prior sale notional)
    const bySorted = {};
    for (const s of enriched) (bySorted[s.token_id] = bySorted[s.token_id] || []).push(s);
    let flipRealized = 0; const flips = [];
    for (const tid in bySorted) {
        const arr = bySorted[tid].sort((a, b) => a.block - b.block);
        for (let i = 1; i < arr.length; i++) {
            const buy = arr[i - 1].notional_usd, sell = arr[i].notional_usd;
            if (buy == null || sell == null) continue;
            const pnl = sell - buy;
            flipRealized += pnl;
            flips.push({ token_id: tid, flipper: arr[i].seller, buy_usd: round(buy, 2), sell_usd: round(sell, 2), pnl_usd: round(pnl, 2), hold_days: arr[i].hold_days });
        }
    }
    flips.sort((a, b) => b.pnl_usd - a.pnl_usd);

    // hold-time (resales with a known basis)
    const holds = enriched.filter(s => s.hold_days != null).map(s => s.hold_days).sort((a, b) => a - b);
    const median = holds.length ? holds[Math.floor(holds.length / 2)] : null;

    // mint-cohort sale behavior (phase from provenance mint, attached during enrich? use sales' first appearance)
    const sorted = [...enriched].sort((a, b) => a.block - b.block);

    return {
        volume: {
            sales_count: n,
            luna_equiv_total: round(lunaTot, 2),
            notional_usd_at_sale: round(notional, 2),     // headline: what buyers actually paid, in USD-of-the-day
            value_today_usd: round(today, 2),             // reproduces BBL all-time-volume (luna_total * spot)
            spot_luna_usd: spot,
            note: 'notional = sum(amount * LUNA-USD on sale date); value_today = sum(amount * spot). They differ because LUNA was worth more historically.',
        },
        denom_split: denom,
        royalties: {
            to_dao_luna_equiv: round(royaltyByRecipient.filter(r => r.is_dao).reduce((x, r) => x + r.luna_equiv, 0), 2),
            notional_usd_at_sale: round(royNotional, 2),
            by_recipient: royaltyByRecipient,
        },
        leaderboards: { top_buyers: topBuyers, top_sellers: topSellers, most_traded_tokens: mostTraded },
        monthly: monthlySeries,
        sale_number_distribution: saleNumDist,
        flips: { realized_pnl_usd: round(flipRealized, 2), flip_count: flips.length, top_flips: flips.slice(0, 20) },
        hold_time_days: { resales_with_basis: holds.length, median, max: holds[holds.length - 1] || null },
        first_sale: sorted[0] ? { token_id: sorted[0].token_id, date: sorted[0].timestamp, notional_usd: sorted[0].notional_usd } : null,
        last_sale: sorted[n - 1] ? { token_id: sorted[n - 1].token_id, date: sorted[n - 1].timestamp, notional_usd: sorted[n - 1].notional_usd } : null,
        oracle_span: oracleSpan,
        bluna_rate_used: BLUNA_RATE,
        bluna_rate_note: 'flat rate — refine with historical boneLUNA hub exchange_rate later',
    };
}

async function pushToGithub(path, content, message) {
    const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
    const headers = { 'User-Agent': 'aDAO-analytics-builder', 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };
    const get = () => new Promise((res) => { https.get(api + `?ref=${GITHUB_BRANCH}`, { headers }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b).sha); } catch { res(undefined); } }); }).on('error', () => res(undefined)); });
    const sha = await get();
    const body = JSON.stringify({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    return new Promise((res, rej) => {
        const req = https.request(api, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => (r.statusCode < 300 ? res(true) : rej(new Error(`GH ${r.statusCode} ${b.slice(0, 160)}`)))); });
        req.on('error', rej); req.end(body);
    });
}

async function main() {
    console.log(`📊 NFT analytics builder — collection=${COLLECTION} dir=${COLL_DIR}`);
    const { sales, prov, daily, spot, oracleSpan } = loadInputs();
    console.log(`  loaded ${sales.length} sales, ${Object.keys(prov.tokens || {}).length} provenance tokens, oracle ${oracleSpan[0]}→${oracleSpan[1]} (spot $${spot})`);
    const enriched = enrich(sales, daily, spot, prov);
    const priced = enriched.filter(s => s.notional_usd != null).length;
    console.log(`  priced ${priced}/${enriched.length} sales`);
    const roll = rollups(enriched, spot, oracleSpan);
    console.log(`  notional(at-sale)=$${roll.volume.notional_usd_at_sale} | value-today=$${roll.volume.value_today_usd} | LUNA-equiv=${roll.volume.luna_equiv_total}`);

    const enrichedDoc = { schemaVersion: 1, collection: COLLECTION, builtAt: new Date().toISOString(), spot_luna_usd: spot, count: enriched.length, sales: enriched };
    const analyticsDoc = { schemaVersion: 1, collection: COLLECTION, builtAt: new Date().toISOString(), ...roll };

    if (GITHUB_TOKEN) {
        console.log('📤 Publishing…');
        await pushToGithub(`${COLL_DIR}/nft-analytics.json`, JSON.stringify(analyticsDoc, null, 1), `nft analytics — ${COLLECTION} — $${roll.volume.notional_usd_at_sale} notional`);
        await pushToGithub(`${COLL_DIR}/sales-enriched.json`, JSON.stringify(enrichedDoc), `nft sales enriched — ${COLLECTION} — ${enriched.length} sales`);
        console.log('✅ pushed nft-analytics.json + sales-enriched.json');
    } else {
        fs.writeFileSync('nft-analytics.json', JSON.stringify(analyticsDoc, null, 1));
        fs.writeFileSync('sales-enriched.json', JSON.stringify(enrichedDoc));
        console.log('⚠️  GITHUB_TOKEN not set — wrote nft-analytics.json + sales-enriched.json locally');
    }
    return analyticsDoc;
}

if (require.main === module) main().catch(e => { console.error('❌', e.message); process.exit(1); });
module.exports = { enrich, rollups, priceOn, lunaEquiv, loadInputs };
