'use strict';

// =============================================================================
// api/_lib/store-sale.js - WO-1799. THE STOREWIDE SALE, AND IT IS SERVER-ONLY.
// -----------------------------------------------------------------------------
// Owner, 2026-09-16, verbatim: "can we run a 30% deal?"
//
// Before this file the ONLY discount in the game was the per-wallet SHORTFALL
// discount (2000 bps, once per 7 days, api/purchases/quote.js). There was no way
// to run a sale at all, and the shipped APK cannot be changed without a build.
//
// ⛔ SO THE SALE IS A SERVER NUMBER, READ ON THE RAIL THAT ALREADY EXISTS.
// Two rows on client_tunables (api/_lib/tunables.js), flipped with
// `node tools/client-tunables.mjs set store.saleBps 3000`, read HERE through the
// SAME readTunables helper api/client-tunables.js uses. No second reader, no
// second table, no deploy to start or stop a sale.
//
// -----------------------------------------------------------------------------
// ⛔ WHY THESE TWO KEYS ARE MARKED serverOnly AND NEVER REACH A PHONE.
// -----------------------------------------------------------------------------
// The client already computes NOTHING about price: PurchaseQuoteService.cs
// transports `discountBps` / `discountLabel` / `usdEffective` and formats them,
// and says so in its own doc comments. A sale percentage the client could read
// would be a SECOND opinion about money on a device we do not control - the exact
// duplicated-state failure CLAUDE.md §2/§5/§16 each record a scar from, arriving
// through the money door. So:
//   * the keys carry `serverOnly: true` on their TUNABLE_KEYS spec, which exempts
//     them from the build-registry join (no build reads them, by design);
//   * api/client-tunables.js OMITS them from the public payload;
//   * they get NO card in the Command Center, because that page's own boundary
//     notice says prices are never editable there and means it.
//
// -----------------------------------------------------------------------------
// ⚠ THE RAIL IS INT-ONLY, AND THAT DECIDES THE SHAPE OF BOTH ROWS.
// -----------------------------------------------------------------------------
// normalizeValue() in api/_lib/tunables.js accepts a bool or /^-?\d{1,9}$/ and
// NOTHING ELSE. Two consequences, both deliberate rather than worked around:
//
//   1. THERE IS NO `store.saleLabel` ROW. A string cannot be stored, so the label
//      is DERIVED here - `saleLabel(3000)` -> "30% off" - and served on the quote
//      exactly where the shortfall label already goes. One pattern, no operator
//      typo, and the client still performs no percentage arithmetic of its own.
//
//   2. THE END TIME IS EPOCH **MINUTES**, NOT SECONDS. Epoch seconds is ten
//      digits (~1.79e9) and the validator caps at nine, so a seconds value is
//      REFUSED at write time. Minutes is eight digits and fits with room to 2159.
//      It also fits a C# int, which matters if these rows ever do become readable.
//      ⛔ Do NOT widen the \d{1,9} rule to make seconds fit: that widens EVERY
//      key on the rail, and RemoteTunables parses ints on the client.
//
// FAIL-TO-NO-SALE. An unreadable table, a missing row, a junk value or an expired
// window all resolve to "no sale". A failure here can only ever charge the
// ORDINARY price - never a made-up one, and never a free pack.
//
// CommonJS, no dependencies beyond the tunables reader. Files under api/_lib/ are
// NOT routed by Vercel (leading underscore), so this is a library, never an
// endpoint.
// =============================================================================

const { readTunables } = require('./tunables');

/** The knob that turns a sale on. 0 (or absent) = no sale. */
const SALE_BPS_KEY = 'store.saleBps';
/** Optional auto-stop, in epoch MINUTES (see the header). 0/absent = no end. */
const SALE_ENDS_KEY = 'store.saleEndsAtEpochMin';

/**
 * ⛔ THE CEILING, AND IT IS A REFUSAL TO BE CLEVER. 7000 bps = 70% off. A fat
 * thumb typing 30000 must not hand the store away, and a NEGATIVE must not
 * silently become a surcharge, so both ends are clamped rather than trusted.
 * The clamp lives HERE, once, on the read - not at each call site.
 */
const SALE_MAX_BPS = 7000;

/** The value persisted in purchase_quotes.discount_reason for a sale. */
const SALE_REASON = 'sale';

/**
 * The sale's display copy, derived from the bps because the rail cannot store a
 * string. `3000` -> "30% off". The client formats this verbatim and does no
 * percentage arithmetic (PurchaseQuoteService.DiscountLabel says so).
 */
function saleLabel(bps) {
    return `${bps / 100}% off`;
}

function clampSaleBps(raw) {
    const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > SALE_MAX_BPS ? SALE_MAX_BPS : n;
}

/**
 * Pure: the sale in force right now, given a tunables `values` map.
 *
 * @param {object} values  key -> string, straight off readTunables().values
 * @param {number} nowMs   wall clock, injected so a test can drive expiry
 * @returns {{bps:number, endsAtMs:number|null, expired:boolean}} bps 0 = no sale
 */
function resolveSale(values, nowMs) {
    const map = values && typeof values === 'object' ? values : {};
    const bps = clampSaleBps(map[SALE_BPS_KEY]);
    const endsMin = Number.parseInt(String(map[SALE_ENDS_KEY] == null ? '' : map[SALE_ENDS_KEY]).trim(), 10);
    const endsAtMs = Number.isFinite(endsMin) && endsMin > 0 ? endsMin * 60_000 : null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    // ⚠ An end time IN THE PAST ends the sale, even with a live bps row. The
    // operator is not required to clear two rows to stop a sale on time, which is
    // the whole reason the second row exists.
    const expired = endsAtMs != null && now >= endsAtMs;
    return { bps: expired ? 0 : bps, endsAtMs, expired };
}

/**
 * ⛔ THE COMBINATION RULE, AND IT IS **MAX, NEVER ADDITIVE** (WO-1799).
 *
 * A player who qualifies for the once-per-7-days shortfall discount during a
 * storewide sale gets the BETTER of the two, not the sum. Two reasons, and the
 * second is the one that matters:
 *   * 2000 + 3000 bps is a 50% pack nobody authored, on every SKU at once;
 *   * the shortfall discount is a per-wallet APOLOGY for a bad moment, and a sale
 *     is a marketing decision. Stacking them lets a sale multiply a apology.
 *
 * ⚠ AND THE SALE WINS TIES. At equal bps the reason recorded is 'sale', which
 * keeps the player's once-per-7-days shortfall window UNSPENT - see the
 * discount_reason predicate in api/purchases/quote.js. Reporting a sale as a
 * shortfall would silently burn an entitlement the player never used.
 *
 * @param {number} saleBps       0 when no sale
 * @param {number|null} shortfallBps  the shortfall figure when this wallet is eligible, else null
 * @param {string} shortfallReason    the reason string persisted for a shortfall
 * @returns {{bps:number|null, reason:string|null}} bps null = no discount at all
 */
function resolveDiscount(saleBps, shortfallBps, shortfallReason) {
    const sale = Number.isFinite(saleBps) && saleBps > 0 ? saleBps : 0;
    const shortfall = Number.isFinite(shortfallBps) && shortfallBps > 0 ? shortfallBps : 0;
    if (sale <= 0 && shortfall <= 0) return { bps: null, reason: null };
    if (sale >= shortfall) return { bps: sale, reason: SALE_REASON };
    return { bps: shortfall, reason: shortfallReason };
}

/**
 * Read the live sale off the knob table. NEVER throws (readTunables never does).
 *
 * @param {Function|null} sql neon(...) client, or null
 * @param {number} [nowMs]
 * @returns {Promise<{bps:number, endsAtMs:number|null, expired:boolean, readOk:boolean}>}
 */
async function readStoreSale(sql, nowMs) {
    const state = await readTunables(sql);
    // ⚠ ok=false is "we could not read the table", which resolves to NO SALE -
    // the ordinary price. It is never resolved to a remembered sale: a sale that
    // outlives the operator's ability to see it is worse than no sale.
    const resolved = resolveSale(state && state.ok ? state.values : {}, nowMs);
    return Object.assign(resolved, { readOk: !!(state && state.ok) });
}

module.exports = {
    SALE_BPS_KEY,
    SALE_ENDS_KEY,
    SALE_MAX_BPS,
    SALE_REASON,
    saleLabel,
    clampSaleBps,
    resolveSale,
    resolveDiscount,
    readStoreSale,
};
