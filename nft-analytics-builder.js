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
    // optional bLUNA(boneLUNA) USD oracle — prices bLUNA sales at their own market value
    let blunaDaily = null, blunaSpot = null, blunaSpan = null;
    try {
        const bo = readJson(`${DATA_DIR}/bluna-usd-daily.json`);
        blunaDaily = bo.daily || bo;
        const bd = Object.keys(blunaDaily).sort();
        blunaSpot = blunaDaily[bd[bd.length - 1]];
        blunaSpan = [bd[0], bd[bd.length - 1]];
    } catch { /* fall back to flat BLUNA_RATE */ }
    return { salesDoc: sales, sales: sales.sales || sales, prov, daily, spot, oracleSpan: [dates[0], dates[dates.length - 1]], blunaDaily, blunaSpot, blunaSpan };
}

// nearest-on-or-before price for a date (handles gaps)
function priceOn(daily, date) {
    if (daily[date] != null) return daily[date];
    let best = null;
    for (const d in daily) if (d <= date && (best === null || d > best)) best = d;
    return best ? daily[best] : null;
}

// Build a monthly-median bLUNA/LUNA ratio curve from the (clean) overlap points, interpolated
// across gaps and clamped to a sane LSD band. boneLUNA's CoinGecko USD is illiquid/stale on
// sparse dates, but the *ratio* where data exists is a clean monotonic accrual (≈1.16→1.76),
// so we apply ratio(date) × reliable LUNA-USD(date) rather than trusting raw bLUNA prints.
function buildBlunaRatio(blunaDaily, lunaDaily) {
    if (!blunaDaily) return null;
    const byM = {};
    for (const d in blunaDaily) { const l = priceOn(lunaDaily, d); if (!l) continue; const m = d.slice(0, 7); (byM[m] = byM[m] || []).push(blunaDaily[d] / l); }
    const anchors = Object.keys(byM).sort().map(m => { const a = byM[m].sort((x, y) => x - y); return { date: m + '-15', ratio: Math.min(2.0, Math.max(1.0, a[Math.floor(a.length / 2)])) }; });
    if (!anchors.length) return null;
    const latest = anchors[anchors.length - 1].ratio;
    const ratioOn = (date) => {
        if (date <= anchors[0].date) return anchors[0].ratio;
        if (date >= anchors[anchors.length - 1].date) return latest;
        for (let i = 1; i < anchors.length; i++) {
            if (date <= anchors[i].date) { const a = anchors[i - 1], b = anchors[i]; const t = (new Date(date) - new Date(a.date)) / (new Date(b.date) - new Date(a.date)); return a.ratio + (b.ratio - a.ratio) * t; }
        }
        return latest;
    };
    return { ratioOn, latest, anchors, span: [anchors[0].date, anchors[anchors.length - 1].date] };
}

// Price one sale denom-aware. bLUNA = ratio(date) × LUNA-USD(date) via the curve above;
// if no bLUNA data at all, fall back to flat BLUNA_RATE.
function priceSale(s, lunaDaily, lunaSpot, blunaRatio) {
    const date = dayOf(s.timestamp);
    const amt = Number(s.gross_amount) / 1e6;
    const lPx = priceOn(lunaDaily, date);
    const isBluna = s.denom_symbol === 'bLUNA';
    let px, spot, src, lunaEq;
    if (isBluna && blunaRatio) {
        const r = blunaRatio.ratioOn(date);
        px = lPx != null ? lPx * r : null; spot = lunaSpot * blunaRatio.latest; src = 'bluna-ratio-curve';
        lunaEq = amt * r;
    } else if (isBluna) {
        px = lPx != null ? lPx * BLUNA_RATE : null; spot = lunaSpot * BLUNA_RATE; src = 'bluna-flat-rate';
        lunaEq = amt * BLUNA_RATE;
    } else {
        px = lPx; spot = lunaSpot; src = 'luna-oracle';
        lunaEq = amt;
    }
    return {
        amount: amt,
        price_usd_at_sale: px,
        price_source: src,
        notional_usd: px != null ? amt * px : null,
        value_today_usd: amt * spot,
        denom_spot_usd: spot,
        luna_equiv: lunaEq,
    };
}

function enrich(sales, lunaDaily, lunaSpot, blunaRatio, prov) {
    const tokens = prov.tokens || {};
    const out = [];
    for (const s of sales) {
        const p = priceSale(s, lunaDaily, lunaSpot, blunaRatio);
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
            amount: round(p.amount, 6),
            luna_equiv: p.luna_equiv != null ? round(p.luna_equiv, 6) : null,
            price_usd_at_sale: p.price_usd_at_sale,
            price_source: p.price_source,
            notional_usd: p.notional_usd != null ? round(p.notional_usd, 4) : null,
            value_today_usd: round(p.value_today_usd, 4),
            denom_spot_usd: p.denom_spot_usd,
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
    for (const s of enriched) { const d = s.denom_symbol; (denom[d] = denom[d] || { count: 0, luna_equiv: 0, notional_usd: 0, value_today_usd: 0 }); denom[d].count++; denom[d].luna_equiv += s.luna_equiv || 0; denom[d].notional_usd += s.notional_usd || 0; denom[d].value_today_usd += s.value_today_usd || 0; }
    for (const d in denom) { denom[d].luna_equiv = round(denom[d].luna_equiv, 2); denom[d].notional_usd = round(denom[d].notional_usd, 2); denom[d].value_today_usd = round(denom[d].value_today_usd, 2); }

    // royalties (residual leg), priced denom-aware. aDAO recipients = royalty wallet + DAO main (both "to DAO")
    const roy = {}; let royNotional = 0;
    for (const s of enriched) {
        if (s.royalty_fee == null) continue;
        const rNative = Number(s.royalty_fee) / 1e6;                         // royalty in the sale's own token
        const rNotional = s.price_usd_at_sale != null ? rNative * s.price_usd_at_sale : 0;
        const rToday = rNative * (s.denom_spot_usd || 0);
        const r = s.royalty_recipient || 'unknown';
        (roy[r] = roy[r] || { notional_usd: 0, value_today_usd: 0 });
        roy[r].notional_usd += rNotional; roy[r].value_today_usd += rToday;
        royNotional += rNotional;
    }
    const royaltyByRecipient = Object.entries(roy).map(([r, v]) => ({
        recipient: r, is_dao: DAO_ROYALTY_RECIPIENTS.has(r), notional_usd: round(v.notional_usd, 2), value_today_usd: round(v.value_today_usd, 2),
    })).sort((a, b) => b.notional_usd - a.notional_usd);

    // monthly time series (notional + count)
    const monthly = {};
    for (const s of enriched) { const m = dayOf(s.timestamp).slice(0, 7); (monthly[m] = monthly[m] || { count: 0, notional_usd: 0, luna_equiv: 0 }); monthly[m].count++; monthly[m].notional_usd += s.notional_usd || 0; monthly[m].luna_equiv += s.luna_equiv || 0; }
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

    const blunaSources = new Set(enriched.filter(s => s.denom_symbol === 'bLUNA').map(s => s.price_source));
    const BLUNA_PRICING = blunaSources.has('bluna-ratio-curve')
        ? { mode: 'bluna-ratio-curve', note: 'bLUNA = monotonic monthly-median bLUNA/LUNA ratio (from boneLUNA CoinGecko, gap-interpolated, clamped 1.0–2.0) × LUNA-USD on sale date' }
        : { mode: 'flat-rate', rate: BLUNA_RATE, note: 'no bluna-usd-daily.json found — used flat BLUNA_RATE × LUNA' };

    return {
        volume: {
            sales_count: n,
            luna_equiv_total: round(lunaTot, 2),
            notional_usd_at_sale: round(notional, 2),     // headline: what buyers actually paid, in USD-of-the-day
            value_today_usd: round(today, 2),             // reproduces BBL all-time-volume (per-denom amount * spot)
            spot_luna_usd: spot,
            note: 'notional = sum(amount * token-USD on sale date, per denom); value_today = sum(amount * denom spot). They differ because LUNA/bLUNA were worth more historically.',
        },
        denom_split: denom,
        royalties: {
            to_dao_notional_usd: round(royaltyByRecipient.filter(r => r.is_dao).reduce((x, r) => x + r.notional_usd, 0), 2),
            to_dao_value_today_usd: round(royaltyByRecipient.filter(r => r.is_dao).reduce((x, r) => x + r.value_today_usd, 0), 2),
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
        bluna_pricing: BLUNA_PRICING,
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
    const { sales, prov, daily, spot, oracleSpan, blunaDaily, blunaSpot, blunaSpan } = loadInputs();
    console.log(`  loaded ${sales.length} sales, ${Object.keys(prov.tokens || {}).length} provenance tokens, LUNA oracle ${oracleSpan[0]}→${oracleSpan[1]} (spot $${spot})`);
    const blunaRatio = buildBlunaRatio(blunaDaily, daily);
    console.log(blunaRatio ? `  bLUNA ratio curve: ${blunaRatio.anchors.length} monthly anchors ${blunaRatio.span[0]}→${blunaRatio.span[1]}, latest ${blunaRatio.latest.toFixed(3)}` : `  bLUNA: no oracle → flat rate ${BLUNA_RATE}`);
    const enriched = enrich(sales, daily, spot, blunaRatio, prov);
    const priced = enriched.filter(s => s.notional_usd != null).length;
    console.log(`  priced ${priced}/${enriched.length} sales`);
    const roll = rollups(enriched, spot, oracleSpan);
    if (blunaRatio) roll.bluna_ratio_curve = { latest: round(blunaRatio.latest, 4), span: blunaRatio.span, anchors: blunaRatio.anchors.map(a => ({ month: a.date.slice(0, 7), ratio: round(a.ratio, 3) })) };
    console.log(`  notional(at-sale)=$${roll.volume.notional_usd_at_sale} | value-today=$${roll.volume.value_today_usd} | LUNA-equiv=${roll.volume.luna_equiv_total} | bLUNA: ${roll.bluna_pricing.mode}`);

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
module.exports = { enrich, rollups, priceOn, priceSale, buildBlunaRatio, loadInputs };
