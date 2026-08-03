// =============================================================================
// api/_lib/audit.js — the LOUD half of "quiet for the player, loud in the db"
// -----------------------------------------------------------------------------
// Every auth/guard rejection writes ONE analytics_events row and ONE runtime-log
// line, both carrying the same short `ref` the player-facing response returned.
// That is the whole point: before this, a 401 from /api/game/save was a dead end
// — the body said {"error":"Unauthorized","reason":"..."} to the PLAYER (loud in
// exactly the wrong place) and the server kept no record at all, so "cloud save
// is broken" could not be told apart from no-header / bad-signature / replayed
// nonce / expired nonce / wrong wallet. Now every one of those is a distinct
// code sitting in a row you can query.
//
// WHY analytics_events AND NOT A NEW TABLE: the row shape already fits
// (player_id, event_name, properties JSONB, client_ts, received_at), it is
// already swept by api/admin/cleanup.js, and api/admin/db.js already reads it —
// so the read path (view=authrejects, added in the same change) is a query, not
// a migration. save.js's existing logReject() used this same table for
// 'save_sanity_reject'; this generalises that instead of forking it.
//
// PRIVACY: the caller IP is never stored raw — it is salted-SHA256'd to a short
// prefix, which is enough to see "one device is hammering the guest rail" and not
// enough to re-identify anyone. Payloads/bodies are NEVER logged; only shapes,
// lengths and codes.
//
// FAILURE POLICY: audit logging must NEVER fail a request or throw. Every call
// is wrapped; a DB error degrades to the console line alone.
// =============================================================================

const crypto = require('crypto');

// Not a secret — it only stops the stored hash from being a plain unsalted IP
// digest (the same reasoning as the client's guest-id salt).
const IP_SALT = 'dotr-audit-ip:v1:5b21e0';

const AUTH_REJECT_EVENT = 'api_auth_reject';

/** Short salted hash of the caller IP — enough to correlate abuse, not to identify. */
function hashIp(req) {
    try {
        const fwd = (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
        const first = String(fwd).split(',')[0].trim();
        if (!first) return null;
        return crypto.createHash('sha256').update(first + IP_SALT).digest('hex').slice(0, 12);
    } catch (_) {
        return null;
    }
}

/**
 * Record a rejected request. Never throws.
 *
 * @param {Function} sql        neon(...) client (may be null — then console only)
 * @param {object}   req        the request (for path/method/ip)
 * @param {object}   info
 * @param {string}   info.code      stable machine code (wallet-auth.AuthCode)
 * @param {string}   info.ref       correlation ref returned to the client
 * @param {string}  [info.identity] the player id / wallet / guest id in play
 * @param {string}  [info.mode]     'wallet' | 'guest' | 'none'
 * @param {object}  [info.detail]   extra non-secret diagnostics (shapes, ages, lengths)
 */
async function logAuthReject(sql, req, info) {
    const code = (info && info.code) || 'UNKNOWN';
    const ref = (info && info.ref) || '-';
    const identity = (info && info.identity) || null;
    const mode = (info && info.mode) || 'none';
    const path = (req && (req.url || (req.query && req.query.__path))) || '?';
    const method = (req && req.method) || '?';

    // 1) Runtime log — readable via get_runtime_logs WITHOUT DATABASE_URL. This is
    //    the fallback read path when the DB write itself is what is broken.
    try {
        console.error(
            `[auth_reject] code=${code} ref=${ref} mode=${mode} method=${method} path=${String(path).split('?')[0]} ` +
            `id=${identity ? String(identity).slice(0, 12) + '…(' + String(identity).length + ')' : 'none'} ` +
            `detail=${safeJson(info && info.detail)}`
        );
    } catch (_) { /* logging must never break the request */ }

    // 2) The durable row.
    if (!sql) return;
    try {
        const properties = {
            code: code,
            ref: ref,
            mode: mode,
            method: method,
            path: String(path).split('?')[0],
            identityLen: identity ? String(identity).length : 0,
            ipHash: hashIp(req),
            detail: (info && info.detail) || {},
        };
        await sql`
            INSERT INTO analytics_events (player_id, event_name, properties, client_ts)
            VALUES (
                ${identity != null ? String(identity) : 'anonymous'},
                ${AUTH_REJECT_EVENT},
                ${JSON.stringify(properties)}::jsonb,
                ${Date.now()}
            )
        `;
    } catch (err) {
        // A failed audit insert is itself worth one console line, and nothing more.
        try { console.warn('[auth_reject] audit insert failed:', err.message); } catch (_) { /* noop */ }
    }
}

/**
 * Record a non-auth server-side event (accepted-but-notable), e.g. the save
 * sanity guards stripping fields. Same table, caller-chosen event name.
 * Never throws.
 */
async function logApiEvent(sql, identity, eventName, properties) {
    try { console.log(`[api_event] ${eventName} id=${identity ? String(identity).slice(0, 12) : 'anon'} ${safeJson(properties)}`); }
    catch (_) { /* noop */ }
    if (!sql) return;
    try {
        await sql`
            INSERT INTO analytics_events (player_id, event_name, properties, client_ts)
            VALUES (
                ${identity != null ? String(identity) : 'anonymous'},
                ${String(eventName)},
                ${JSON.stringify(properties || {})}::jsonb,
                ${Date.now()}
            )
        `;
    } catch (err) {
        try { console.warn('[api_event] insert failed:', err.message); } catch (_) { /* noop */ }
    }
}

function safeJson(o) {
    try { return JSON.stringify(o || {}).slice(0, 600); } catch (_) { return '{}'; }
}

module.exports = {
    AUTH_REJECT_EVENT,
    hashIp,
    logAuthReject,
    logApiEvent,
};
