// =============================================================================
// api/_lib/maintenance.js - the OPERATOR KILL SWITCHES (WO-1243).
// -----------------------------------------------------------------------------
// Six toggles the owner flips by hand when she decides an area must stop:
//     farming | raiding | arena | dungeons | store | server
// `server` is the whole game; the other five are one area each.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE IS THE CONTROL AND THE CLIENT GATE IS ONLY THE COURTESY
// -----------------------------------------------------------------------------
// Owner ruling 2026-08-27, verbatim: "mine allows if we see someone finds a hack,
// we seal that area and patch". That makes this an EXPLOIT CONTAINMENT control,
// not a maintenance-window nicety, and it changes who the gate has to stop.
//
// A person exploiting the game is by definition running a client that does what
// they want. A toggle only the client consults is a CLOSED sign on an unlocked
// door: honest players stop, the attacker walks through, and the containment
// achieves the exact opposite of its purpose - it clears the area of witnesses.
//
// So the seal is enforced HERE, at the endpoints where the exploited action
// actually lands and where the client has no vote. The Unity-side gate
// (DeNelle.Core.Ops.MaintenanceCatalog) and the rolling banner stay, because a
// player who taps a closed area deserves to know why - but they are the
// courtesy layer. This file is the control.
//
// -----------------------------------------------------------------------------
// FAIL-OPEN. DELIBERATELY. DO NOT "CORRECT" IT.
// -----------------------------------------------------------------------------
// An unreachable database, a query timeout, a missing table or a malformed row
// leaves EVERY area ON. Owner-confirmed 2026-08-27, verbatim:
//     "correct cause i cannot help if server is unreachable"
// The argument is about CAPABILITY, not blast radius: with the DB down she
// cannot flip a toggle or author a message anyway, so closing the game buys
// nothing and costs every player their session.
//
// !! THIS IS THE OPPOSITE OF THE WO-1223 DUNGEON-PORTAL RULING, ON PURPOSE.
// There, absence must not GRANT access to content, so it fails CLOSED. Here,
// absence must not DENY access to the whole game, so it fails OPEN. Correctness
// versus availability. The two systems are NOT to be unified.
//
// THE SHARP EDGE, STATED HONESTLY: if an exploit is running AND the database is
// unreachable, the exploit continues. That is the accepted trade, not a bug -
// there is no seal she could have applied in that window anyway.
//
// -----------------------------------------------------------------------------
// PRIVACY (the game is live and takes real money as of 2026-08-27)
// -----------------------------------------------------------------------------
// A refusal record must answer "who, and when", or containment leaves no way to
// assess damage afterwards. It must NOT store a wallet, an email or a real name.
// So the record carries a SALTED FINGERPRINT of the identity (12 hex chars) -
// enough to say "the same account was refused 40 times in a minute", not enough
// to re-identify anyone. Raw identities never enter this file's rows.
//
// -----------------------------------------------------------------------------
// CACHE POLICY: a 5-second in-lambda memo, and NOTHING on the device.
// -----------------------------------------------------------------------------
// The owner ruled NO DEVICE CACHE (every client check is live). That ruling is
// about the device. A warm serverless instance memoising the table for 5 seconds
// is a different thing: it bounds the CONTROL layer's lag at 5 s while stopping
// one lambda from re-querying Neon on every request in a burst. The exposure
// window of the actual seal is therefore ~5 s, regardless of how slowly the
// courtesy banner catches up on the client.
//
// CommonJS, no dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

const crypto = require('crypto');
const { logApiEvent } = require('./audit');

// -----------------------------------------------------------------------------
// THE DOMAIN. Six ids, and there is no seventh. Any other string passed to
// isClosed/enforce is a CALLER BUG and resolves OPEN (fail-open) plus a loud log.
// Kept in sync by hand with DeNelle.Core.Ops.MaintenanceArea on the client and
// with the CHECK constraint on maintenance_toggles in api/schema.sql.
// -----------------------------------------------------------------------------
const AREA_FARMING = 'farming';
const AREA_RAIDING = 'raiding';
const AREA_ARENA = 'arena';
const AREA_DUNGEONS = 'dungeons';
const AREA_STORE = 'store';
const AREA_SERVER = 'server';

const AREAS = [AREA_FARMING, AREA_RAIDING, AREA_ARENA, AREA_DUNGEONS, AREA_STORE, AREA_SERVER];

/** Stable machine code the client branches on. Never prose, never a secret. */
const MAINTENANCE_CODE = 'AREA_UNDER_MAINTENANCE';

/** Event name for a server-side refusal row (analytics_events.event_name). */
const REFUSAL_EVENT = 'maintenance_refusal';

/** Event name for a save that arrived while an area was sealed. See noteSealedActivity. */
const SEALED_ACTIVITY_EVENT = 'maintenance_sealed_activity';

/**
 * Not a secret. It only stops the stored fingerprint from being a plain digest
 * of a wallet address, which would be trivially reversible by anyone holding a
 * list of addresses. Same reasoning as _lib/audit.js IP_SALT.
 */
const IDENTITY_SALT = 'dotr-maintenance-id:v1:9c4f2a';

/** How long one warm lambda may reuse a read of the table. See the header. */
const MEMO_TTL_MS = 5000;

/** A query that has not answered in this long is treated as unreachable => OPEN. */
const QUERY_TIMEOUT_MS = 2500;

// Module-scope memo. Lives only as long as the warm instance; a cold start reads
// through. `at` of 0 means "never read".
let s_memo = null;
let s_memoAt = 0;

/**
 * Salted fingerprint of a player identity. NEVER returns the identity itself.
 * @param {string|null} identity player id / wallet / guest id - whatever the caller has
 * @returns {string|null} 12 hex chars, or null when there was nothing to fingerprint
 */
function fingerprint(identity) {
    try {
        const s = identity == null ? '' : String(identity);
        if (!s) return null;
        return crypto.createHash('sha256').update(s + IDENTITY_SALT).digest('hex').slice(0, 12);
    } catch (_) {
        return null;
    }
}

/** True when `area` is one of the six. */
function isKnownArea(area) {
    return typeof area === 'string' && AREAS.indexOf(area) >= 0;
}

/**
 * Read every toggle row. NEVER throws, NEVER rejects.
 *
 * @param {Function} sql neon(...) client, or null
 * @returns {Promise<{ok: boolean, rows: object, reason: string}>}
 *   ok=false means the table could not be read => the caller must FAIL OPEN.
 *   rows is a map areaId -> { closed: boolean, message: string|null, updatedAt, updatedBy }
 */
async function readToggles(sql) {
    const now = Date.now();
    if (s_memo && (now - s_memoAt) < MEMO_TTL_MS) {
        return s_memo;
    }

    if (!sql) {
        // No database handle at all. Fail OPEN and say so - this is the branch a
        // misconfigured DATABASE_URL lands on, and it must never look like "all clear".
        const miss = { ok: false, rows: {}, reason: 'NO_SQL_HANDLE' };
        try { console.warn('[maintenance] no sql handle - every area resolves OPEN (fail-open ruling 2026-08-27)'); }
        catch (_) { /* logging must never break a request */ }
        return miss;
    }

    let rows = null;
    try {
        // The timeout is the whole point of the race: a hung Neon socket must
        // resolve to OPEN in bounded time, not hold the request until the
        // platform kills it. A hang and an outage are the same answer here.
        rows = await Promise.race([
            sql`SELECT area_id, closed, message, updated_at, updated_by FROM maintenance_toggles`,
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error('maintenance query timeout')), QUERY_TIMEOUT_MS)),
        ]);
    } catch (err) {
        const out = { ok: false, rows: {}, reason: 'QUERY_FAILED' };
        try {
            console.warn('[maintenance] table unreadable (' + (err && err.message) +
                         ') - every area resolves OPEN (fail-open ruling 2026-08-27)');
        } catch (_) { /* noop */ }
        // NOT memoised. A failure must be retried on the next request, or one
        // blip would hold the game open for the whole warm life of the instance.
        return out;
    }

    // ⚠ SHAPE-CHECK THE RESULT BEFORE WALKING IT. Found by the WO-1243 oracle:
    // a driver that answers with a STRING instead of a row array is perfectly
    // iterable in JavaScript - `for (const r of 'not an array')` walks characters,
    // every one of them fails the area test, and the function returned
    // { ok: true, rows: {} }. That is the right OUTCOME (nothing sealed, fail-open)
    // reached by the wrong ROUTE, and the route is what matters: ok:true means
    // "the table was read and nothing is sealed", which is a claim we cannot make.
    // The endpoint would then tell every client readOk:true, the operator tool
    // would print an all-clear, and a seal she had applied would look absent
    // instead of unreadable. Malformed is an OUTAGE and must say so.
    const rowList = Array.isArray(rows) ? rows
        : (rows && Array.isArray(rows.rows) ? rows.rows : null);
    if (rowList === null) {
        try { console.warn('[maintenance] query returned a non-array result - fail-open, reported as unreadable'); }
        catch (_) { /* noop */ }
        return { ok: false, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    const map = {};
    let malformed = 0;
    try {
        for (const r of rowList) {
            const id = r && r.area_id != null ? String(r.area_id) : '';
            if (!isKnownArea(id)) { malformed++; continue; }
            map[id] = {
                closed: r.closed === true,
                message: r.message != null && String(r.message).length > 0 ? String(r.message) : null,
                updatedAt: r.updated_at != null ? String(r.updated_at) : null,
                updatedBy: r.updated_by != null ? String(r.updated_by) : null,
            };
        }
    } catch (err) {
        // A row shape we cannot walk is the "malformed table" case in the ruling.
        try { console.warn('[maintenance] malformed rows (' + (err && err.message) + ') - fail-open'); }
        catch (_) { /* noop */ }
        return { ok: false, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    if (malformed > 0) {
        try { console.warn('[maintenance] ignored ' + malformed + ' row(s) naming an unknown area'); }
        catch (_) { /* noop */ }
        // A table where NOTHING parsed is not "nothing is sealed" - it is a table we
        // could not read. Same distinction as the shape check above: fail-open on the
        // ANSWER, honest on the CONFIDENCE. A few stray rows alongside good ones are
        // survivable and are only logged.
        if (Object.keys(map).length === 0) {
            return { ok: false, rows: {}, reason: 'MALFORMED_ROWS' };
        }
    }

    const good = { ok: true, rows: map, reason: 'OK' };
    s_memo = good;
    s_memoAt = now;
    return good;
}

/**
 * Is `area` sealed right now?
 *
 * ⛔ A read failure answers FALSE. That is the fail-open ruling and it is the one
 * a future seat will break. It is asserted by the Unity oracle
 * (MaintenanceTogglesRegression case [fail-open]) and by test/maintenance.test.js.
 *
 * `server` closes everything: when the server row is closed, EVERY area answers
 * true, including areas whose own row says open.
 *
 * @returns {Promise<{closed: boolean, by: string|null, message: string|null, readOk: boolean}>}
 */
async function isClosed(sql, area) {
    const state = await readToggles(sql);
    if (!state.ok) {
        return { closed: false, by: null, message: null, readOk: false };
    }

    if (!isKnownArea(area)) {
        try { console.warn('[maintenance] isClosed called with unknown area "' + area + '" - OPEN'); }
        catch (_) { /* noop */ }
        return { closed: false, by: null, message: null, readOk: true };
    }

    // `server` first and unconditionally - a full maintenance window outranks
    // every per-area row, including one that says the area is fine.
    const serverRow = state.rows[AREA_SERVER];
    if (serverRow && serverRow.closed) {
        return { closed: true, by: AREA_SERVER, message: serverRow.message, readOk: true };
    }

    const row = state.rows[area];
    if (row && row.closed) {
        return { closed: true, by: area, message: row.message, readOk: true };
    }

    // No row for this area is OPEN. ⛔ Deliberate, and the inverse of WO-1223:
    // api/schema.sql seeds with ON CONFLICT DO NOTHING, which does not back-fill
    // an already-provisioned database (that trap shut two dungeons in production
    // this week). Under fail-open a missing row costs nothing at all.
    return { closed: false, by: null, message: null, readOk: true };
}

/**
 * Record ONE refusal. Never throws.
 *
 * "Who and when" is the point: containment without a record leaves no way to
 * assess damage after the fact. `who` is a SALTED FINGERPRINT, never the raw
 * identity - see the privacy note in the header.
 */
async function recordRefusal(sql, req, area, closedBy, identity, ref) {
    const who = fingerprint(identity);
    const path = (req && (req.url || '')) || '?';
    try {
        console.warn('[maintenance] REFUSED area=' + area + ' closedBy=' + closedBy +
                     ' who=' + (who || 'anon') + ' ref=' + (ref || '-') +
                     ' path=' + String(path).split('?')[0] + ' at=' + new Date().toISOString());
    } catch (_) { /* noop */ }

    await logApiEvent(sql, who || 'anonymous', REFUSAL_EVENT, {
        area: area,
        closedBy: closedBy,
        ref: ref || null,
        path: String(path).split('?')[0],
        method: (req && req.method) || '?',
        at: new Date().toISOString(),
    });
}

/**
 * Note that an area's activity reached the server while that area was SEALED.
 *
 * ⚠ THIS IS A RECORD, NOT A CONTROL, and the distinction is the finding.
 * farming / raiding / dungeons are simulated entirely on the client and reach
 * the backend only inside the opaque save blob - there is NO per-action endpoint
 * to refuse. So for those three the only server-side lever is the `server`
 * toggle (which refuses the save outright), and this call is what makes the gap
 * visible instead of silent: it stamps a row saying activity kept arriving while
 * the seal was up, which is exactly the evidence "did the client gate hold?"
 * needs. See the WO-1243 report.
 */
async function noteSealedActivity(sql, req, areas, identity, ref) {
    if (!areas || !areas.length) return;
    const who = fingerprint(identity);
    try {
        console.warn('[maintenance] SEALED_ACTIVITY areas=' + areas.join(',') +
                     ' who=' + (who || 'anon') + ' ref=' + (ref || '-') +
                     ' at=' + new Date().toISOString());
    } catch (_) { /* noop */ }
    await logApiEvent(sql, who || 'anonymous', SEALED_ACTIVITY_EVENT, {
        areas: areas,
        ref: ref || null,
        path: String((req && req.url) || '?').split('?')[0],
        at: new Date().toISOString(),
    });
}

/**
 * The one-line guard an endpoint calls. Returns TRUE when it has already
 * answered the request and the caller must return immediately.
 *
 * The body is deliberately the house `quietFail` shape plus the operator's
 * authored message, because the client renders that message in the banner and
 * the player is owed the reason. Nothing else is disclosed.
 */
async function enforce(sql, req, res, area, identity, ref) {
    const verdict = await isClosed(sql, area);
    if (!verdict.closed) return false;

    await recordRefusal(sql, req, area, verdict.by, identity, ref);

    // 503 is the honest status: the area exists and will come back.
    res.status(503).json({
        ok: false,
        code: MAINTENANCE_CODE,
        ref: ref || null,
        area: area,
        closedBy: verdict.by,
        message: verdict.message,
    });
    return true;
}

/** Test hook: drop the warm-instance memo so a test can drive consecutive states. */
function _resetMemo() {
    s_memo = null;
    s_memoAt = 0;
}

module.exports = {
    AREAS,
    AREA_FARMING,
    AREA_RAIDING,
    AREA_ARENA,
    AREA_DUNGEONS,
    AREA_STORE,
    AREA_SERVER,
    MAINTENANCE_CODE,
    REFUSAL_EVENT,
    SEALED_ACTIVITY_EVENT,
    MEMO_TTL_MS,
    QUERY_TIMEOUT_MS,
    fingerprint,
    isKnownArea,
    readToggles,
    isClosed,
    recordRefusal,
    noteSealedActivity,
    enforce,
    _resetMemo,
};
