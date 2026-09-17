'use strict';

// =============================================================================
// api/_lib/purchase-fulfilment.js — WO-1797. THE ONE WRITER OF status='fulfilled'.
// -----------------------------------------------------------------------------
// ⛔ EXACTLY ONE `UPDATE purchase_entitlements SET status='fulfilled'` MAY EXIST
//    IN THIS TREE, AND IT IS BELOW. Before WO-1797 that statement lived inline in
//    api/purchases/fulfill.js and was the Solana rail's only door; the Pi rail
//    needed a second door (api/pi/fulfill.js — Pi identities are not on the
//    granting allowlist, see that file's header), and a second door with a
//    COPY of the transition is the duplicated state CLAUDE.md §16 names. Two
//    callers, one statement.
//
// WHAT `fulfilled` MEANS, AND WHAT IT MUST KEEP MEANING (WO-1797 §3.1):
//   `verified`  = the money moved and the server recorded the entitlement.
//   `fulfilled` = A CLIENT ACKNOWLEDGED THAT IT PERSISTED THE GRANT.
// The server cannot know the second fact on its own, so NOTHING here may flip a
// row without a client ack. A server-side auto-flip would make the column lie on
// every rail and destroy the only paid-versus-delivered detector the project has
// (api/admin/db.js:356-360 prints that column as truth to the owner).
//
// The transition is CONDITIONAL and REPLAY-SAFE:
//   · `WHERE status = 'verified'` — a replay updates zero rows,
//   · `fulfilled_at = COALESCE(fulfilled_at, NOW())` — the timestamp never moves,
//   · `RETURNING` decides whether the audit row is written, so a replay does NOT
//     emit a second `purchase_entitlement_fulfilled` event.
// =============================================================================

const { logApiEvent } = require('./audit');

/**
 * Flip ONE already-read entitlement row from `verified` to `fulfilled`.
 *
 * No silent failures (CLAUDE.md §12): every outcome is named in the return value,
 * and a DB throw propagates to the caller, which audits and answers 500. The
 * caller owns identity/ownership checks — this function only owns the transition.
 *
 * @param {Function} sql      neon tagged-template client
 * @param {object}   row      the entitlement row: { entitlement_id, sku, status }
 * @param {string}   playerId subject the audit row is attributed to
 * @param {string}   ref      request ref, carried into the audit payload
 * @returns {Promise<{flipped:boolean, state:string, reason?:string}>}
 *          flipped=true  → this call performed the transition (audit row written)
 *          flipped=false → nothing was written; `reason` says why
 *                          ('already_fulfilled' | 'not_verified' | 'raced')
 */
async function markEntitlementFulfilled(sql, row, playerId, ref) {
    const status = String((row && row.status) || '');
    if (status === 'fulfilled') return { flipped: false, state: 'fulfilled', reason: 'already_fulfilled' };
    if (status !== 'verified') return { flipped: false, state: status || 'unknown', reason: 'not_verified' };

    const updated = await sql`
        UPDATE purchase_entitlements
           SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, NOW()),
               updated_at = NOW()
         WHERE entitlement_id = ${row.entitlement_id} AND status = 'verified'
        RETURNING entitlement_id`;

    // Lost a harmless race with a concurrent ack: the row IS fulfilled, and the
    // winner already wrote the audit event. Reporting the end state (not an error)
    // keeps a duplicated ack idempotent for the client.
    if (!updated.length) return { flipped: false, state: 'fulfilled', reason: 'raced' };

    await logApiEvent(sql, playerId, 'purchase_entitlement_fulfilled',
        { ref, sku: row.sku, entitlementId: String(row.entitlement_id) });
    return { flipped: true, state: 'fulfilled' };
}

module.exports = { markEntitlementFulfilled };
