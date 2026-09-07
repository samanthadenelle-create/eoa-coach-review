// =============================================================================
// api/_lib/ip-budget.js — the project's ONE per-caller-IP fixed-window budget.
// -----------------------------------------------------------------------------
// EXTRACTED FROM api/promo/redeem.js (WO-1456), where it was born as WO-1440's
// guest-promo gate. It moved here unchanged in behaviour the moment a SECOND
// route needed it, because the alternative — a second limiter with its own table,
// its own window and its own refusal code — is duplicated state, and duplicated
// state in this repo is exactly what produced the stale WO-number block and the
// retired dependency table. One implementation, one table, one code.
//
// THE TABLE IS `promo_ip_budget` AND THE NAME IS NOW A MILD LIE. That is
// deliberate and it is the cheaper lie: renaming a live table (schema.sql +
// migration + the admin clawback queries in api/admin/db.js) to serve a rate
// limiter would cost more than the confusion it removes. Its `code` column is
// read here as a generic SCOPE key — 'FIRSTWATCH' for the promo rail,
// 'AUTH_NONCE' for the wallet challenge — and the PRIMARY KEY (ip_hash, code)
// already gives each scope its own independent budget, which is the property a
// shared limiter needs.
//
// ip_hash is audit.hashIp(req): sha256(ip + IP_SALT) truncated to 12 hex. ONE
// hashing rule project-wide, so the abuse signal stays joinable with the
// auth-reject rows. A raw IP is never stored.
//
// FIXED window, not sliding: the budget refills in one step `windowSeconds`
// after the CURRENT window's first reservation, rather than trickling back. Said
// plainly because the two differ at the boundary.
//
// CommonJS, zero dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

'use strict';

/**
 * Reserve one unit of this (IP, scope) budget, atomically, in a SINGLE UPSERT —
 * the same shape wallet-auth.touchGuestRate uses, for the same reason: two
 * statements would race exactly where it matters.
 *
 * ⛔ `failClosed` IS THE ONLY BEHAVIOURAL KNOB, AND IT IS THE IMPORTANT ONE.
 *    It decides what an UNREADABLE budget table (or an unattributable caller)
 *    means, and the two rails need opposite answers:
 *
 *      failClosed:true  — the promo rail. This is the last non-forgeable gate in
 *        front of a PAYOUT, so "we could not check" must resolve to "do not pay".
 *        A caller who suppresses its IP would otherwise hold an unlimited budget.
 *        The refusal does not consume the code, so the player retries once fixed.
 *
 *      failClosed:false — the nonce rail. That route guards a challenge that
 *        GRANTS NOTHING (a nonce is useless without the wallet's private key), so
 *        an unreadable table must never take the whole wallet login offline.
 *        Availability there, correctness there — the same split api/admin/ops.js
 *        draws against _lib/maintenance.js.
 *
 *    Both directions log LOUDLY: a degraded abuse gate that says nothing is how a
 *    limiter silently stops limiting.
 *
 * ⚠ PRECISELY WHAT IS COUNTED: the unit is spent by any attempt that has ALREADY
 *   CLEARED every cheaper gate and is about to be served. Callers place the call
 *   accordingly — a malformed request must never cost a household anything. An
 *   attempt that is itself over the limit DOES still increment (the UPSERT
 *   reserves, then judges), so a caller being refused stays refused rather than
 *   being let back in by trying less often.
 *
 * @param {function} sql          Neon tagged-template client.
 * @param {string}   ipHash       audit.hashIp(req) — '' when unresolvable.
 * @param {string}   scope        Budget key: a promo code, or a route token.
 * @param {{windowSeconds:number, maxPerWindow:number, failClosed?:boolean, label?:string}} opts
 * @returns {Promise<{ok:boolean, error?:string, grants?:number, degraded?:boolean}>}
 */
async function reserveIpBudget(sql, ipHash, scope, opts) {
    const windowSeconds = Number(opts && opts.windowSeconds);
    const maxPerWindow = Number(opts && opts.maxPerWindow);
    const failClosed = !(opts && opts.failClosed === false);
    const label = (opts && opts.label) || scope;

    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 ||
        !Number.isFinite(maxPerWindow) || maxPerWindow <= 0) {
        // A misconfigured limiter is a bug in the CALLER, not in the caller's
        // caller. Never silently behave as "no limit".
        throw new Error('[ip-budget] windowSeconds and maxPerWindow are required and must be positive');
    }

    if (!ipHash) {
        if (failClosed) {
            console.error(`[ip-budget:${label}] REFUSED — no resolvable caller IP, and this rail fails closed.`);
            return { ok: false, error: 'RATE_LIMITED', degraded: true };
        }
        console.warn(`[ip-budget:${label}] no resolvable caller IP — allowing (fail-open rail).`);
        return { ok: true, degraded: true };
    }

    try {
        const rows = await sql`
            INSERT INTO promo_ip_budget (ip_hash, code, window_started_at, grants, total_grants, last_grant_at)
            VALUES (${ipHash}, ${scope}, NOW(), 1, 1, NOW())
            ON CONFLICT (ip_hash, code) DO UPDATE SET
                window_started_at = CASE
                    WHEN promo_ip_budget.window_started_at < NOW() - (${windowSeconds} * INTERVAL '1 second')
                    THEN NOW() ELSE promo_ip_budget.window_started_at END,
                grants = CASE
                    WHEN promo_ip_budget.window_started_at < NOW() - (${windowSeconds} * INTERVAL '1 second')
                    THEN 1 ELSE promo_ip_budget.grants + 1 END,
                total_grants = promo_ip_budget.total_grants + 1,
                last_grant_at = NOW()
            RETURNING grants, total_grants
        `;
        const grants = rows && rows[0] ? Number(rows[0].grants) : 1;
        if (grants > maxPerWindow) {
            return { ok: false, error: 'RATE_LIMITED', grants: grants };
        }
        return { ok: true, grants: grants };
    } catch (err) {
        // LOUD in both directions: this is the abuse gate itself failing.
        const cause = ' Apply api/migrations/20260906_0019_promo_guest_redeem_ip_budget.sql. Cause: ' +
                      (err && err.message);
        if (failClosed) {
            console.error(`[ip-budget:${label}] BUDGET UNAVAILABLE — refusing (fail-closed).` + cause);
            return { ok: false, error: 'REWARD_UNAVAILABLE', degraded: true };
        }
        console.error(`[ip-budget:${label}] BUDGET UNAVAILABLE — allowing UNLIMITED (fail-open).` + cause);
        return { ok: true, degraded: true };
    }
}

module.exports = { reserveIpBudget };
