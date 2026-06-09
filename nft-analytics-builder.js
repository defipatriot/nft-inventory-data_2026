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
    let salesArr = sales.sales || sales;
    // optional Boost sales — settlements on BoostDAO that the BBL settle-sweep can't see.
    // Already date/buyer/tx-joined to provenance; LUNA/bLUNA re-priced via oracle in priceSale,
    // USDC at par, SOLID/ampLUNA via their stored Boost USD (to_usd_boost).
    try {
        const boost = readJson(`${COLL_DIR}/boost-sales.json`);
        const bArr = boost.sales || boost;
        salesArr = salesArr.concat(bArr);
        console.log(`  merged ${bArr.length} Boost sales (other-marketplace settlements)`);
    } catch (e) { if (e.code !== 'ENOENT') throw new Error(`boost-sales.json present but unreadable (corrupt?) — refusing to silently drop Boost sales: ${e.message}`); }
    // optional Atrium sales — buy_nft settlements on the Atrium marketplace.
    try {
        const atrium = readJson(`${COLL_DIR}/atrium-sales.json`);
        const aArr = atrium.sales || atrium;
        salesArr = salesArr.concat(aArr);
        console.log(`  merged ${aArr.length} Atrium sales`);
    } catch (e) { if (e.code !== 'ENOENT') throw new Error(`atrium-sales.json present but unreadable (corrupt?) — refusing to silently drop Atrium sales: ${e.message}`); }
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
    } catch (e) { if (e.code !== 'ENOENT') throw new Error(`bluna-usd-daily.json present but unreadable (corrupt?): ${e.message}`); }
    return { salesDoc: sales, sales: salesArr, prov, daily, spot, oracleSpan: [dates[0], dates[dates.length - 1]], blunaDaily, blunaSpot, blunaSpan };
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
    } else if (s.denom_symbol === 'LUNA') {
        px = lPx; spot = lunaSpot; src = 'luna-oracle';
        lunaEq = amt;
    } else if (s.denom_symbol === 'USDC' || s.denom_symbol === 'SOLID') {
        // dollar-pegged stables priced at par (SOLID ≈ $1; replace with an oracle if volume grows).
        // Not LUNA, so excluded from luna_equiv_total.
        px = 1; spot = 1; src = s.denom_symbol === 'USDC' ? 'usdc-par' : 'solid-par'; lunaEq = 0;
    } else {
        // SOLID / ampLUNA / other exotic Boost denoms — no oracle, use Boost's recorded USD.
        const tb = Number(s.to_usd_boost) || 0;
        px = amt > 0 ? tb / amt : 0; spot = px; src = 'boost-to-usd'; lunaEq = 0;
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
    for (const s of enriched) { const d = s.denom_symbol; (denom[d] = denom[d] || { count: 0, tokens: 0, luna_equiv: 0, notional_usd: 0, value_today_usd: 0 }); denom[d].count++; denom[d].tokens += s.amount || 0; denom[d].luna_equiv += s.luna_equiv || 0; denom[d].notional_usd += s.notional_usd || 0; denom[d].value_today_usd += s.value_today_usd || 0; }
    for (const d in denom) { denom[d].tokens = round(denom[d].tokens, 4); denom[d].luna_equiv = round(denom[d].luna_equiv, 2); denom[d].notional_usd = round(denom[d].notional_usd, 2); denom[d].value_today_usd = round(denom[d].value_today_usd, 2); }
    const volumeTokens = Object.fromEntries(Object.entries(denom).map(([d, v]) => [d, v.tokens]));

    // royalties (residual leg). Royalties accrue to the treasury AS TOKENS (held, not sold), so the
    // honest figure is per-denom token totals. USD is context only: "when earned" (at-sale) overstates
    // (LUNA has since fallen), "today" reflects current value of the still-held tokens. aDAO recipients
    // = royalty wallet + DAO main (both "to DAO"). Boost sales carry no royalty data (royalty_fee null).
    const roy = {};
    for (const s of enriched) {
        if (s.royalty_fee == null) continue;
        const rNative = Number(s.royalty_fee) / 1e6;                         // royalty in the sale's own token
        const d = s.denom_symbol;
        const rEarned = s.price_usd_at_sale != null ? rNative * s.price_usd_at_sale : 0;
        const rToday  = rNative * (s.denom_spot_usd || 0);
        const r = s.royalty_recipient || 'unknown';
        const rec = (roy[r] = roy[r] || { tokens: {}, usd_when_earned: 0, usd_today: 0 });
        rec.tokens[d] = (rec.tokens[d] || 0) + rNative;
        rec.usd_when_earned += rEarned; rec.usd_today += rToday;
    }
    const royaltyByRecipient = Object.entries(roy).map(([r, v]) => ({
        recipient: r, is_dao: DAO_ROYALTY_RECIPIENTS.has(r),
        tokens: Object.fromEntries(Object.entries(v.tokens).map(([d, t]) => [d, round(t, 4)])),
        usd_when_earned: round(v.usd_when_earned, 2), usd_today: round(v.usd_today, 2),
    })).sort((a, b) => b.usd_when_earned - a.usd_when_earned);
    // DAO royalty TOKENS (the headline), summed per denom across DAO recipients
    const daoRoyaltyTokens = {};
    for (const r of royaltyByRecipient) if (r.is_dao) for (const d in r.tokens) daoRoyaltyTokens[d] = round((daoRoyaltyTokens[d] || 0) + r.tokens[d], 4);
    const daoUsdWhenEarned = round(royaltyByRecipient.filter(r => r.is_dao).reduce((x, r) => x + r.usd_when_earned, 0), 2);
    const daoUsdToday       = round(royaltyByRecipient.filter(r => r.is_dao).reduce((x, r) => x + r.usd_today, 0), 2);

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
            tokens: volumeTokens,                         // HEADLINE 1: all-time volume — TOKENS (what actually changed hands)
            usd_at_sale: round(notional, 2),              // HEADLINE 2: all-time volume — USD at time of each sale (what buyers paid)
            value_today_usd: round(today, 2),             // secondary context: current market value of that volume (BBL-style; misleading as LUNA fell)
            luna_equiv_total: round(lunaTot, 2),          // LUNA-equivalent size (LUNA + bLUNA×ratio; excludes USDC/SOLID)
            spot_luna_usd: spot,
            note: 'tokens = raw per-denom amounts traded. usd_at_sale = sum(amount * token-USD on sale date) — a realized market price. value_today = amount * current spot (context only).',
        },
        denom_split: denom,
        royalties: {
            to_dao_tokens: daoRoyaltyTokens,              // HEADLINE 3: royalties — TOKENS accrued to treasury (held, not sold)
            to_dao_usd_when_earned: daoUsdWhenEarned,     // context only — USD value at the moments earned (unrealized; LUNA has since fallen)
            to_dao_usd_today: daoUsdToday,                // context only — current USD value of those still-held tokens
            by_recipient: royaltyByRecipient,
            note: 'Royalties accrue to the treasury as tokens and are not sold, so token totals are the real figure. USD is shown for context only and was never realized. Boost sales carry no royalty data.',
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

// F5 (oracle staleness): pull the current LUNA/bLUNA USD from the network-and-prices cron so sales
// dated AFTER our static oracle's last entry aren't priced at a stale months-old last-known value.
// Best-effort — any failure resolves to nulls and we fall back to the static oracle unchanged.
function fetchLivePrices() {
    const url = process.env.NETWORK_PRICES_URL || 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'aDAO-analytics/1.0' } }, r => {
            let b = ''; r.on('data', c => b += c); r.on('end', () => {
                try {
                    const j = JSON.parse(b);
                    const luna = Number(j?.luna_market?.usd_price);
                    const bluna = Number(j?.token_prices?.bLUNA?.final_price_usd);
                    resolve({ luna: Number.isFinite(luna) ? luna : null, bluna: Number.isFinite(bluna) ? bluna : null });
                } catch { resolve({ luna: null, bluna: null }); }
            });
        }).on('error', () => resolve({ luna: null, bluna: null }));
    });
}

async function main() {
    console.log(`📊 NFT analytics builder — collection=${COLLECTION} dir=${COLL_DIR}`);
    let { sales, prov, daily, spot, oracleSpan, blunaDaily, blunaSpot, blunaSpan } = loadInputs();
    console.log(`  loaded ${sales.length} sales, ${Object.keys(prov.tokens || {}).length} provenance tokens, LUNA oracle ${oracleSpan[0]}→${oracleSpan[1]} (spot $${spot})`);
    // Extend the oracle(s) forward to "now" with the live price, so post-oracle sales price at a
    // current value instead of a stale last-known one. (Within-oracle dates keep their history.)
    const live = await fetchLivePrices();
    if (live.luna != null) {
        const today = new Date().toISOString().slice(0, 10);
        const fill = (dict, lastDate, val) => {
            if (val == null || !lastDate) return 0;
            let added = 0;
            for (let d = new Date(lastDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
                const k = d.toISOString().slice(0, 10);
                if (dict[k] == null) { dict[k] = val; added++; }
            }
            return added;
        };
        const la = fill(daily, oracleSpan[1], live.luna);
        spot = live.luna; oracleSpan = [oracleSpan[0], today];
        let ba = 0;
        if (blunaDaily && live.bluna != null) { ba = fill(blunaDaily, (blunaSpan && blunaSpan[1]) || oracleSpan[1], live.bluna); blunaSpot = live.bluna; }
        console.log(`  oracle extended to ${today} via live prices (LUNA $${live.luna}${live.bluna != null ? `, bLUNA $${live.bluna}` : ''}; +${la} LUNA / +${ba} bLUNA day(s))`);
    } else {
        console.log('  ⚠ live prices unavailable — static oracle only (recent sales may price stale)');
    }
    const blunaRatio = buildBlunaRatio(blunaDaily, daily);
    console.log(blunaRatio ? `  bLUNA ratio curve: ${blunaRatio.anchors.length} monthly anchors ${blunaRatio.span[0]}→${blunaRatio.span[1]}, latest ${blunaRatio.latest.toFixed(3)}` : `  bLUNA: no oracle → flat rate ${BLUNA_RATE}`);
    const enriched = enrich(sales, daily, spot, blunaRatio, prov);
    // sale_number is authoritative across ALL sources (BBL + Boost): re-derive by block order per token,
    // so a Boost sale of a token that also sold on BBL is numbered in true sequence (not per-sweep).
    { const byT = {}; for (const s of enriched) (byT[s.token_id] = byT[s.token_id] || []).push(s);
      for (const t in byT) byT[t].sort((a, b) => a.block - b.block).forEach((s, i) => { s.sale_number = i + 1; }); }
    const priced = enriched.filter(s => s.notional_usd != null).length;
    console.log(`  priced ${priced}/${enriched.length} sales`);
    const roll = rollups(enriched, spot, oracleSpan);
    if (blunaRatio) roll.bluna_ratio_curve = { latest: round(blunaRatio.latest, 4), span: blunaRatio.span, anchors: blunaRatio.anchors.map(a => ({ month: a.date.slice(0, 7), ratio: round(a.ratio, 3) })) };
    console.log(`  volume: usd-at-sale=$${roll.volume.usd_at_sale} | value-today=$${roll.volume.value_today_usd} | tokens=${JSON.stringify(roll.volume.tokens)}`);
    console.log(`  royalties to DAO: ${JSON.stringify(roll.royalties.to_dao_tokens)} (=$${roll.royalties.to_dao_usd_when_earned} when earned, $${roll.royalties.to_dao_usd_today} today) | bLUNA: ${roll.bluna_pricing.mode}`);

    const enrichedDoc = { schemaVersion: 1, collection: COLLECTION, builtAt: new Date().toISOString(), spot_luna_usd: spot, count: enriched.length, sales: enriched };
    const analyticsDoc = { schemaVersion: 1, collection: COLLECTION, builtAt: new Date().toISOString(), ...roll };

    if (GITHUB_TOKEN) {
        console.log('📤 Publishing…');
        await pushToGithub(`${COLL_DIR}/nft-analytics.json`, JSON.stringify(analyticsDoc, null, 1), `nft analytics — ${COLLECTION} — $${roll.volume.usd_at_sale} usd-at-sale`);
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
