// =============================================================================
// api/_lib/tunables.js - PROD-022, the REMOTE KNOBS the Pi crash loop is bisected
// with. Read side, validation, and the one writer.
// -----------------------------------------------------------------------------
// Owner ruling 2026-09-02, verbatim:
//   "make the testing as robust as possible with as many solutions as
//    possible... all we really have to do is just flip a flag and possibly
//    redeploy"
//
// A WebGL rebuild costs about thirty minutes. PROD-022 is a P0 crash loop that
// reproduces inside Pi Browser on the owner's iPhone and NOWHERE else - desktop
// Chrome ran the identical build for 62 minutes. So every candidate mitigation
// ships in ONE build behind its OWN key, all defaulting to today's behaviour,
// and the bisect is flag flips against this table.
//
// -----------------------------------------------------------------------------
// ⛔ THIS FILE HOLDS NO DEFAULTS, AND THAT IS THE DESIGN.
// -----------------------------------------------------------------------------
// The defaults live in the BUILD, in DeNelle.Core.Ops.RemoteTunables.Registry,
// and they are the values the shipping code hardcoded before PROD-022 touched
// it. This table carries OVERRIDES ONLY. An empty table therefore means "today's
// behaviour", and there is exactly one place a default can be read - which is the
// duplicated-state failure CLAUDE.md sections 2, 5 and 16 keep warning about.
//
// The KEY LIST below is duplicated (client registry / this file / the operator
// CLI), and it is duplicated ON PURPOSE and only as an ALLOWLIST: a typo'd key
// must be REFUSED at write time rather than accepted and silently ignored by
// every client forever. It is a spell-check, never a source of truth.
//
// -----------------------------------------------------------------------------
// FAIL-TO-DEFAULT. Not fail-open, not fail-closed - nothing here is a seal.
// An unreachable table, a query timeout, a malformed row: readTunables answers
// ok=false, the endpoint reports readOk:false, and every client resolves every
// knob to its shipping default. There is no state in which a failure here can
// make the game behave differently from the build that shipped.
//
// CACHE POLICY mirrors api/_lib/maintenance.js: a short in-lambda memo so one
// warm instance does not re-query Neon per request in a burst. The knobs are
// flipped by a human during a bisect, so a few seconds of lag is invisible.
//
// CommonJS, no dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

/**
 * ALLOWLIST, kept in step BY HAND with DeNelle.Core.Ops.RemoteTunables.Registry
 * and with tools/client-tunables.mjs. It exists so a mistyped key is refused at
 * the moment it is written instead of being accepted and quietly ignored by every
 * client for the rest of the incident.
 *
 * `kind` is checked at write time for the same reason: '2' in a bool is a typo,
 * and the client would fall back to the default and log a bad-value line rather
 * than doing what the operator meant.
 */
const TUNABLE_KEYS = [
    { key: 'pi.eagerStructureWarm', kind: 'bool' },
    { key: 'pi.awaitInitBeforeFirstLoad', kind: 'bool' },
    { key: 'pi.disableRemoteStructureArt', kind: 'bool' },
    { key: 'assets.maxConcurrentRequests', kind: 'int' },
    { key: 'pi.requestTimeoutSeconds', kind: 'int' },
    { key: 'assets.maxRequestAttempts', kind: 'int' },
    { key: 'visuals.missLogCap', kind: 'int' },
    { key: 'trace.assetVerbosity', kind: 'int' },
];

/** How long one warm lambda may reuse a read of the table. */
const MEMO_TTL_MS = 5000;

/** A query that has not answered in this long is treated as unreachable. */
const QUERY_TIMEOUT_MS = 2500;

/** Values are short. Anything longer is not a knob. */
const VALUE_MAX_LEN = 32;

let s_memo = null;
let s_memoAt = 0;

/** The spec for one key, or null when the key is not one of ours. */
function specFor(key) {
    if (typeof key !== 'string') return null;
    for (const spec of TUNABLE_KEYS) {
        if (spec.key === key) return spec;
    }
    return null;
}

/** True when `key` is an allowlisted knob. */
function isKnownKey(key) {
    return specFor(key) !== null;
}

/**
 * Validate a value against its key's kind. Returns the NORMALIZED string to
 * store ('0'/'1' for bools, a canonical decimal for ints), or null when the
 * value is unusable.
 */
function normalizeValue(key, raw) {
    const spec = specFor(key);
    if (!spec) return null;
    if (raw == null) return null;

    const s = String(raw).trim();
    if (!s || s.length > VALUE_MAX_LEN) return null;

    if (spec.kind === 'bool') {
        const low = s.toLowerCase();
        if (low === '1' || low === 'true' || low === 'on') return '1';
        if (low === '0' || low === 'false' || low === 'off') return '0';
        return null;
    }

    if (!/^-?\d{1,9}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return String(n);
}

/**
 * Read every knob row. NEVER throws, NEVER rejects.
 *
 * @param {Function} sql neon(...) client, or null
 * @returns {Promise<{ok: boolean, values: object, rows: object, reason: string}>}
 *   ok=false means the table could not be read. The client then resolves every
 *   knob to its SHIPPING DEFAULT, which is today's behaviour - so a failure here
 *   can never change how the game behaves.
 */
async function readTunables(sql) {
    const now = Date.now();
    if (s_memo && (now - s_memoAt) < MEMO_TTL_MS) {
        return s_memo;
    }

    if (!sql) {
        try {
            console.warn('[tunables] no sql handle - every knob resolves to its shipping default');
        } catch (_) { /* logging must never break a request */ }
        return { ok: false, values: {}, rows: {}, reason: 'NO_SQL_HANDLE' };
    }

    let rows = null;
    try {
        // The timeout is the whole point of the race: a hung Neon socket must
        // resolve in bounded time rather than hold the request until the platform
        // kills it. A hang and an outage are the same answer here.
        rows = await Promise.race([
            sql`SELECT key, value, updated_by, updated_at FROM client_tunables`,
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error('tunables query timeout')), QUERY_TIMEOUT_MS)),
        ]);
    } catch (err) {
        try {
            console.warn('[tunables] table unreadable (' + (err && err.message) +
                         ') - every knob resolves to its shipping default');
        } catch (_) { /* noop */ }
        // NOT memoised. One blip must not hold a stale answer for the warm life
        // of the instance - the same reasoning api/_lib/maintenance.js records.
        return { ok: false, values: {}, rows: {}, reason: 'QUERY_FAILED' };
    }

    // ⚠ SHAPE-CHECK BEFORE WALKING. A driver that answers with a STRING is
    // perfectly iterable in JavaScript and would walk characters, yielding
    // { ok: true, values: {} } - the right OUTCOME by the wrong ROUTE. ok:true
    // means "we read the table", which is a claim we could not make. This is the
    // identical trap api/_lib/maintenance.js documents; it is repeated because it
    // was found in production, not because it is theoretical.
    const rowList = Array.isArray(rows) ? rows
        : (rows && Array.isArray(rows.rows) ? rows.rows : null);
    if (rowList === null) {
        try { console.warn('[tunables] query returned a non-array result - reported as unreadable'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    const values = {};
    const meta = {};
    let ignored = 0;
    try {
        for (const r of rowList) {
            const key = r && r.key != null ? String(r.key) : '';
            if (!isKnownKey(key)) { ignored++; continue; }
            const value = r.value != null ? String(r.value) : '';
            values[key] = value;
            meta[key] = {
                value: value,
                updatedAt: r.updated_at != null ? String(r.updated_at) : null,
                updatedBy: r.updated_by != null ? String(r.updated_by) : null,
            };
        }
    } catch (err) {
        try { console.warn('[tunables] malformed rows (' + (err && err.message) + ')'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    if (ignored > 0) {
        // NOT an outage, and deliberately different from maintenance.js's
        // all-rows-malformed rule: an unrecognised key here is FORWARD
        // COMPATIBILITY (a newer build's knob), not corruption. An empty result
        // is the correct, expected resting state of this table, so it must never
        // be reported as unreadable.
        try { console.warn('[tunables] ignored ' + ignored + ' row(s) naming an unregistered key'); }
        catch (_) { /* noop */ }
    }

    const good = { ok: true, values: values, rows: meta, reason: 'OK' };
    s_memo = good;
    s_memoAt = now;
    return good;
}

/**
 * Set one knob. UPSERT, never "ON CONFLICT DO NOTHING" - a write that silently
 * did not land would send the owner chasing a build during an incident. Reads the
 * row BACK rather than trusting the statement.
 *
 * @throws when the key or value is not allowlisted, or the write returned no row.
 */
async function setTunable(sql, key, value, operator) {
    const spec = specFor(key);
    if (!spec) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const normalized = normalizeValue(key, value);
    if (normalized === null) {
        const err = new Error('BAD_TUNABLE_VALUE');
        err.code = 'BAD_TUNABLE_VALUE';
        throw err;
    }

    const rows = await sql`
        INSERT INTO client_tunables (key, value, updated_by, updated_at)
        VALUES (${key}, ${normalized}, ${operator}, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        RETURNING key, value, updated_by, updated_at`;
    if (!rows || !rows.length) {
        const err = new Error('WRITE_RETURNED_NO_ROW');
        err.code = 'WRITE_RETURNED_NO_ROW';
        throw err;
    }
    s_memo = null;
    s_memoAt = 0;
    return rows[0];
}

/**
 * Delete one knob's row, returning that knob to its SHIPPING DEFAULT.
 *
 * ⭐ CLEARING IS NOT "SETTING IT TO 0". Clearing removes the override entirely, so
 * the client answers whatever the build hardcodes - which for an int knob such as
 * pi.requestTimeoutSeconds is 20, not 0. This is the one-word way back to today's
 * behaviour and it is why the operator surface exposes it separately.
 *
 * @returns {Promise<{key: string, existed: boolean}>}
 */
async function clearTunable(sql, key) {
    if (!isKnownKey(key)) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const rows = await sql`DELETE FROM client_tunables WHERE key = ${key} RETURNING key`;
    s_memo = null;
    s_memoAt = 0;
    return { key: key, existed: !!(rows && rows.length) };
}

/** Test hook: drop the warm-instance memo so a test can drive consecutive states. */
function _resetMemo() {
    s_memo = null;
    s_memoAt = 0;
}

module.exports = {
    TUNABLE_KEYS,
    MEMO_TTL_MS,
    QUERY_TIMEOUT_MS,
    VALUE_MAX_LEN,
    specFor,
    isKnownKey,
    normalizeValue,
    readTunables,
    setTunable,
    clearTunable,
    _resetMemo,
};
