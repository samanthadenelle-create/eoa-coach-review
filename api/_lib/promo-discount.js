'use strict';

// =============================================================================
// api/_lib/promo-discount.js - WO-1833. A PROMO CODE THAT CARRIES A DISCOUNT.
// -----------------------------------------------------------------------------
// Owner, 2026-09-17, verbatim: "if i set up promocode spotlight30 as a promo code
// can you make it make everything 30% off?"
//
// Before this file every promo code was a ONE-TIME GRANT: promo_codes holds
// reward_crystals / reward_coins / reward_pack_sku and nothing else
// (api/schema.sql, table 3). There was no discount-percent concept anywhere in the
// promo rail, and the only discounts in the game were the storewide sale
// (_lib/store-sale.js) and the per-wallet shortfall apology (purchases/quote.js).
//
// -----------------------------------------------------------------------------
// ⛔ THE WINDOW IS A FIXED CALENDAR EVENT, NOT A PER-PLAYER 48-HOUR TIMER.
// -----------------------------------------------------------------------------
// The owner first said "48 hours" and then CORRECTED it to "flat 12:00 - 11:59
// CST". That correction is a real behaviour difference and it is the reason this
// file computes NO durations at all:
//
//   * the window is AUTHORED ONCE, as two absolute TIMESTAMPTZ values on the
//     promo_codes row (discount_starts_at, discount_ends_at);
//   * every redeemer shares the SAME end time;
//   * a player who redeems late gets WHAT IS LEFT of the window, never a fresh 48h.
//
// ⛔ SO NOTHING HERE EVER ADDS HOURS TO A REDEMPTION TIME. `redeemed_at + N hours`
//    is the shape that was ruled out. "12:00 - 11:59 CST" is 36h read one way and
//    48h read another, which is exactly why the duration is the OPERATOR'S AUTHORED
//    FACT and not an arithmetic constant in code.
//
// -----------------------------------------------------------------------------
// ⛔ AND THERE IS NO `player_discounts` TABLE. THE LEDGER ALREADY HOLDS THE FACT.
// -----------------------------------------------------------------------------
// Because the window is fixed, "which discount does this player hold right now" is
// a PURE FUNCTION of two rows that already exist - their promo_redemptions row and
// the promo_codes row it references. A second table recording the same thing would
// be:
//
//   1. duplicated state, the failure CLAUDE.md §2/§5/§8/§16 each record a scar
//      from - and this one would sit on the money path; and
//   2. A SECOND WRITE. api/promo/redeem.js:470-479 records, from a measured probe,
//      that two statements on the Neon HTTP driver are TWO TRANSACTIONS. An upsert
//      after the atomic claim could therefore grant the code and silently lose the
//      discount, and a burned promo code has no un-burn.
//
// The derived read cannot drift, cannot be half-written, and needs NO CLEANUP JOB:
// `discount_ends_at > NOW()` is evaluated at read time, so an expired promo simply
// stops matching. It is served by the existing idx_promo_redemptions_player
// (api/schema.sql:559-560).
//
// FAIL-TO-NO-DISCOUNT. An unreadable table, a missing column on an unmigrated
// database, a junk value or a closed window all resolve to "no personal discount",
// which charges the ORDINARY price. The same direction _lib/store-sale.js fails in,
// and for the same reason: a failure on the money path may never invent a price.
//
// CommonJS. Files under api/_lib/ are NOT routed by Vercel (leading underscore),
// so this is a library, never an endpoint.
// =============================================================================

const { clampDiscountBps, PROMO_REASON, saleLabel } = require('./store-sale');

/**
 * Postgres SQLSTATE for "undefined column" — raised by every statement that names
 * a column migration 0028 has not added yet.
 *
 * ⚠ api/_lib/ops.js:91 declares the same literal. That is NOT the duplicated-state
 * failure CLAUDE.md §2/§5 warn about: a SQLSTATE is a constant defined by Postgres,
 * not by this project, so it cannot drift out from under either copy. It is
 * exported here so api/promo/redeem.js can use it without requiring the ADMIN ops
 * library (and its dependency tree) into the player-facing redeem path.
 */
const PG_UNDEFINED_COLUMN = '42703';

/**
 * Parse a TIMESTAMPTZ as the driver hands it back - a Date, or an ISO string,
 * depending on driver version and code path. Anything unparseable is null, which
 * every caller below reads as "no bound", NOT as "now".
 *
 * @returns {number|null} epoch ms
 */
function tsMs(raw) {
    if (raw == null) return null;
    if (raw instanceof Date) {
        const t = raw.getTime();
        return Number.isFinite(t) ? t : null;
    }
    const t = Date.parse(String(raw));
    return Number.isFinite(t) ? t : null;
}

/**
 * Does this promo_codes row carry a usable discount at all?
 *
 * ⚠ A MISSING PROPERTY IS NOT A ZERO. On a database that has not run migration
 * 0028 the column does not exist, so the row comes back WITHOUT the key and
 * `row.discount_bps` is `undefined`. That must read as "this code has no
 * discount" - the ordinary pre-WO-1833 behaviour - and never as a discount of 0
 * that some formatter prints as "0% off".
 *
 * The bps is CLAMPED on the read, through the ONE ceiling in store-sale.js. A fat
 * thumb typing 30000 into the operator console must not hand the store away, and
 * the clamp lives on the read so no call site can forget it.
 *
 * @returns {{bps:number, startsAtMs:number|null, endsAtMs:number|null}|null}
 */
function readDiscountSpec(row) {
    if (!row || typeof row !== 'object') return null;
    const bps = clampDiscountBps(row.discount_bps);
    if (bps <= 0) return null;
    return {
        bps: bps,
        startsAtMs: tsMs(row.discount_starts_at),
        endsAtMs: tsMs(row.discount_ends_at),
    };
}

/**
 * ⛔ THE REDEEM-TIME WINDOW GATE. Returns the EXISTING error code, on purpose.
 *
 * A code whose discount window has not opened yet, or has already closed, is
 * refused with `EXPIRED` - the identical answer api/promo/redeem.js:447-450
 * already gives an expired promo_codes.expires_at. It is COORDINATOR-DIRECTED
 * reuse rather than a semantic preference: "not yet started -> EXPIRED" is a
 * slightly odd word to a player, but the shipped APK maps a FIXED set of error
 * keys (PromoCodeService.MapErrorKey) and an unknown one lands on the calm
 * unknown-error line. Inventing a second code would need a client change that
 * cannot reach a published build.
 *
 * ⚠ A DISCOUNT-CARRYING CODE WITH NO END TIME IS REFUSED, not treated as forever.
 * A personal discount that no operator can stop is worse than one that never
 * started, and the refusal does NOT consume the code (redeem.js's own
 * refusal-is-retryable asymmetry), so authoring the missing end time fixes it for
 * a player still holding the code.
 *
 * @param {object} row  a promo_codes row
 * @param {number} nowMs
 * @returns {{ok:boolean, error:string|null, spec:object|null}}
 */
function resolveRedeemWindow(row, nowMs) {
    const spec = readDiscountSpec(row);
    if (!spec) return { ok: true, error: null, spec: null };   // not a discount code at all
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (spec.endsAtMs == null) return { ok: false, error: 'EXPIRED', spec: spec };
    if (spec.startsAtMs != null && now < spec.startsAtMs) return { ok: false, error: 'EXPIRED', spec: spec };
    if (now >= spec.endsAtMs) return { ok: false, error: 'EXPIRED', spec: spec };
    return { ok: true, error: null, spec: spec };
}

/**
 * The discount a player holds right now, out of every discount code they have
 * redeemed.
 *
 * ⛔ A SECOND DISCOUNT CODE WHILE ONE IS ACTIVE: BOTH STAND, THE LARGER IS USED.
 * Not "extend", not "replace", not "refuse" - with the derived design there is
 * nothing to replace. Each redemption is its own ledger row and each code owns its
 * own fixed window, so a second discount code is already legal and already
 * recorded. This picks the better one while both windows are live; when the better
 * one closes the other takes over by itself, with no write and no sweep.
 *
 * That is the simplest SAFE default because it adds no new state and no new
 * refusal path: nobody can lose a discount they were given, and no code is ever
 * consumed for nothing.
 *
 * ⚠ THIS COMPARISON IS A DIFFERENT AXIS FROM PROMO-vs-SALE. Here two PERSONAL
 * promos are compared. Whether a personal promo beats the STOREWIDE sale is the
 * owner's precedence ruling and lives in store-sale.resolveStorefrontDiscount.
 *
 * @param {Array<object>} rows  { code, discount_bps, discount_starts_at, discount_ends_at }
 * @param {number} nowMs
 * @returns {{bps:number, code:string|null, endsAtMs:number|null}|null}
 */
function pickActiveDiscount(rows, nowMs) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    let best = null;
    for (const row of rows) {
        const spec = readDiscountSpec(row);
        if (!spec || spec.endsAtMs == null) continue;
        if (spec.startsAtMs != null && now < spec.startsAtMs) continue;
        if (now >= spec.endsAtMs) continue;
        if (best == null || spec.bps > best.bps) {
            best = { bps: spec.bps, code: row.code == null ? null : String(row.code), endsAtMs: spec.endsAtMs };
        }
    }
    return best;
}

/** The player-readable copy, derived from the bps by the SAME helper the sale uses. */
function promoDiscountLabel(bps) {
    return saleLabel(bps);
}

/**
 * Read the player's active personal discount off the LEDGER JOIN.
 *
 * ⛔ NEVER THROWS, AND A FAILURE IS "NO DISCOUNT". Three things make that the only
 * safe direction: an unmigrated database raises 42703 (undefined column) here, the
 * public shelf must not go blank because the audit database is away
 * (purchases/quote.js:222-227), and a failure on the money path may only ever
 * charge the ORDINARY price - never an invented one. store-sale.readStoreSale fails
 * in the same direction for the same reason.
 *
 * ⚠ The filtering is done in SQL, not in JS, so the index does the work and only
 * live rows cross the wire; pickActiveDiscount then re-judges them against the
 * SAME clock the caller is using. The double check is deliberate - NOW() on the
 * database and Date.now() here are two clocks, and the JS one is the one the rest
 * of the request reasons with.
 *
 * @param {Function|null} sql  neon(...) tagged template, or null
 * @param {string} playerId
 * @param {number} [nowMs]
 * @returns {Promise<{bps:number, code:string|null, endsAtMs:number|null}|null>}
 */
async function readActivePromoDiscount(sql, playerId, nowMs) {
    const id = playerId == null ? '' : String(playerId).trim();
    if (!sql || !id) return null;
    let rows;
    try {
        rows = await sql`
            SELECT pr.code, pc.discount_bps, pc.discount_starts_at, pc.discount_ends_at
              FROM promo_redemptions AS pr
              JOIN promo_codes AS pc ON pc.code = pr.code
             WHERE pr.player_id = ${id}
               AND pc.discount_bps IS NOT NULL
               AND pc.discount_bps > 0
               AND pc.discount_ends_at IS NOT NULL
               AND pc.discount_ends_at > NOW()
               AND (pc.discount_starts_at IS NULL OR pc.discount_starts_at <= NOW())
             ORDER BY pc.discount_bps DESC
             LIMIT 8`;
    } catch (err) {
        try {
            console.warn('[promo-discount] could not read the active promo discount - ' +
                'charging the ORDINARY price. If this is 42703, run: node tools/run-migrations.mjs ' +
                '(api/migrations/20260917_0028_promo_discount_codes.sql). ' + (err && err.code ? err.code : ''));
        } catch (_) { /* logging must never break a read */ }
        return null;
    }
    return pickActiveDiscount(rows, nowMs);
}

module.exports = {
    PG_UNDEFINED_COLUMN,
    PROMO_REASON,
    pickActiveDiscount,
    promoDiscountLabel,
    readActivePromoDiscount,
    readDiscountSpec,
    resolveRedeemWindow,
    _tsMs: tsMs,
};
