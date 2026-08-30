'use strict';

// =============================================================================
// api/_lib/google-identity.js — the SERVER-SIDE Google identity rail (PIN-1b, WO-1282)
// -----------------------------------------------------------------------------
// WHAT THIS IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR.
//
// On the Seeker / dApp-Store artifact the WALLET IS THE IDENTITY, and that is
// unchanged and unweakened by everything in this file. A Google Play player has no
// wallet, so the Play artifact needs one — and exactly one — other way to key a save
// and an entitlement. This file is that way, and it exists ONLY for the Play/AAB
// artifact (owner ruling 2026-08-30).
//
// ⛔ THE RAW GOOGLE `sub` NEVER BECOMES A PLAYER ID. It is HMAC'd server-side into
//    `play-<64 lowercase hex>` and only the HMAC is ever stored, logged or returned.
//    Storing the bare `sub` would repeat the retired Firebase-UID mistake (a 28-char
//    provider-owned string used as a save key, which the client could assert and which
//    could never satisfy any shape check the value rails apply).
//
// ⛔ AND THE CLIENT NEVER PICKS ITS OWN ID. The derivation input is the `sub` claim of
//    a Google ID token whose SIGNATURE this file verifies against Google's JWKS. The
//    client learns its player id from the /api/auth/google-session response; it cannot
//    forge one, because it does not hold GOOGLE_IDENTITY_KEY.
//
// DORMANT BY DEFAULT. Like the rest of the Play rail (see _lib/google-play-purchases.js
// and purchases/google-play-binding.js), nothing here does anything until
// GOOGLE_IDENTITY_ENABLED=true AND the keys/audiences are configured. A half-configured
// deployment FAILS CLOSED with a stable code — it never falls back to a weaker rail.
//
// ZERO NEW DEPENDENCIES. RS256 verification uses Node 18's built-in crypto: JWKS keys
// are imported via createPublicKey({ format: 'jwk' }) and checked with
// crypto.verify('RSA-SHA256', ...). `jose` / `google-auth-library` are deliberately not
// added — a money-adjacent auth path with fewer moving parts is the point.
//
// Env vars (ALL required before the rail can issue anything):
//   GOOGLE_IDENTITY_ENABLED        'true' to arm the rail. Default OFF.
//   GOOGLE_IDENTITY_KEY            HMAC-SHA256 key used to derive the play- id.
//                                  ⛔ ROTATING THIS RE-KEYS EVERY PLAYER — see the
//                                     re-key guard in auth/google-session.js. Permanent.
//   GOOGLE_IDENTITY_AUDIENCES      comma-separated OAuth client id allowlist (`aud`).
// Optional:
//   GOOGLE_IDENTITY_KEY_PREVIOUS   the key being rotated AWAY from, so the re-key guard
//                                  can see the id a player used to have.
//   GOOGLE_IDENTITY_JWKS_URL       JWKS override (tests / staging). Defaults to Google.
// =============================================================================

const crypto = require('crypto');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Google ID tokens are RS256. An allowlist of ONE, because the classic JWT break is
// accepting whatever `alg` the attacker put in the header ("none", or HS256 verified
// against the public key as if it were a shared secret).
const ALLOWED_ALGS = new Set(['RS256']);

// Clock skew tolerance between Google's clock and the function's. Small on purpose:
// it widens the window in which an already-expired token stays usable.
const CLOCK_SKEW_SECONDS = 60;

// JWKS cache. Module scope, so a warm serverless instance reuses it and a cold one pays
// one fetch. Never cached longer than this regardless of what the response says.
const JWKS_MAX_TTL_SECONDS = 3600;
const JWKS_MIN_TTL_SECONDS = 60;
let jwksCache = { keys: null, fetchedAtMs: 0, ttlSeconds: 0, url: '' };

/** Stable machine codes. Same discipline as wallet-auth.AuthCode: a code names a CLASS
 *  of failure and never reveals a subject, a token, or what the server knows. */
const GoogleIdentityCode = {
    DISABLED:            'GOOGLE_IDENTITY_DISABLED',      // rail not armed by env
    UNCONFIGURED:        'GOOGLE_IDENTITY_UNCONFIGURED',  // armed but key/audience missing
    TOKEN_MISSING:       'GOOGLE_TOKEN_MISSING',
    TOKEN_MALFORMED:     'GOOGLE_TOKEN_MALFORMED',        // not three base64url segments / bad JSON
    TOKEN_ALG_REFUSED:   'GOOGLE_TOKEN_ALG_REFUSED',      // header alg is not RS256
    TOKEN_KEY_UNKNOWN:   'GOOGLE_TOKEN_KEY_UNKNOWN',      // kid not in Google's JWKS
    TOKEN_BAD_SIGNATURE: 'GOOGLE_TOKEN_BAD_SIGNATURE',
    TOKEN_BAD_ISSUER:    'GOOGLE_TOKEN_BAD_ISSUER',
    TOKEN_BAD_AUDIENCE:  'GOOGLE_TOKEN_BAD_AUDIENCE',     // aud not in our allowlist
    TOKEN_EXPIRED:       'GOOGLE_TOKEN_EXPIRED',
    TOKEN_NOT_YET_VALID: 'GOOGLE_TOKEN_NOT_YET_VALID',    // iat/nbf in the future beyond skew
    TOKEN_NO_SUBJECT:    'GOOGLE_TOKEN_NO_SUBJECT',
    JWKS_UNAVAILABLE:    'GOOGLE_JWKS_UNAVAILABLE',       // could not reach/parse Google's keys
};

/** Armed only by an explicit 'true' — same shape as GOOGLE_PLAY_BILLING_ENABLED. */
function identityEnabled(env) {
    const e = env || process.env;
    return String(e.GOOGLE_IDENTITY_ENABLED || '').trim().toLowerCase() === 'true';
}

/** The audience allowlist. Empty means UNCONFIGURED and the rail refuses — never "allow any". */
function allowedAudiences(env) {
    const e = env || process.env;
    return String(e.GOOGLE_IDENTITY_AUDIENCES || '')
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
}

/**
 * Is the rail armed AND fully configured? Returns a coded refusal otherwise, so a
 * half-set-up deployment is legible instead of mysteriously 401-ing every player.
 */
function identityConfiguration(env) {
    const e = env || process.env;
    if (!identityEnabled(e)) return { ok: false, code: GoogleIdentityCode.DISABLED };
    if (!String(e.GOOGLE_IDENTITY_KEY || '').trim()) return { ok: false, code: GoogleIdentityCode.UNCONFIGURED };
    if (allowedAudiences(e).length === 0) return { ok: false, code: GoogleIdentityCode.UNCONFIGURED };
    return { ok: true };
}

/**
 * THE DERIVATION. 'play-' + HMAC-SHA256(key, sub) as 64 lowercase hex.
 *
 * Deterministic, so the same Google account always resolves to the same player id and
 * no alias table is needed; irreversible, so the Google subject cannot be recovered
 * from a save key; and keyed, so nobody without GOOGLE_IDENTITY_KEY can compute one.
 *
 * @param {string} subject  the VERIFIED `sub` claim — never a client-supplied string
 * @param {string} key      GOOGLE_IDENTITY_KEY (or the PREVIOUS key, for the re-key guard)
 */
function derivePlayerId(subject, key) {
    const sub = String(subject == null ? '' : subject).trim();
    const k = String(key == null ? '' : key);
    if (!sub) throw Object.assign(new Error('google_subject_missing'), { code: GoogleIdentityCode.TOKEN_NO_SUBJECT });
    if (!k) throw Object.assign(new Error('google_identity_unconfigured'), { code: GoogleIdentityCode.UNCONFIGURED });
    return 'play-' + crypto.createHmac('sha256', k).update(sub, 'utf8').digest('hex');
}

function b64urlToBuffer(segment) {
    return Buffer.from(String(segment).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJsonSegment(segment) {
    return JSON.parse(b64urlToBuffer(segment).toString('utf8'));
}

/** Parse cache lifetime out of a JWKS response, clamped hard at both ends. */
function jwksTtlFromResponse(response) {
    let ttl = JWKS_MAX_TTL_SECONDS;
    try {
        const cc = response && response.headers && typeof response.headers.get === 'function'
            ? String(response.headers.get('cache-control') || '') : '';
        const m = /max-age\s*=\s*(\d+)/i.exec(cc);
        if (m) ttl = Number(m[1]);
    } catch (_) { /* header parsing is best-effort; the clamp below is the authority */ }
    if (!Number.isFinite(ttl)) ttl = JWKS_MAX_TTL_SECONDS;
    return Math.max(JWKS_MIN_TTL_SECONDS, Math.min(JWKS_MAX_TTL_SECONDS, ttl));
}

/**
 * Fetch (and cache) Google's signing keys.
 * @param {object} options  { fetchFn, env, force } — `force` bypasses the cache exactly
 *                          once per unknown kid, which is how a key ROTATION heals itself.
 */
async function fetchJwks(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const url = String(env.GOOGLE_IDENTITY_JWKS_URL || '').trim() || GOOGLE_JWKS_URL;
    const now = Date.now();
    const fresh = jwksCache.keys && jwksCache.url === url &&
        (now - jwksCache.fetchedAtMs) < (jwksCache.ttlSeconds * 1000);
    if (fresh && !opts.force) return jwksCache.keys;

    const fetchFn = opts.fetchFn || fetch;
    let response;
    try {
        response = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (err) {
        // No silent catch (CLAUDE.md §12): the reason goes to the runtime log, a stable
        // code goes back to the caller, and NOTHING falls back to an unverified token.
        console.error('[google-identity] JWKS fetch threw:', err && err.message ? err.message : err);
        throw Object.assign(new Error('jwks_unavailable'), { code: GoogleIdentityCode.JWKS_UNAVAILABLE });
    }
    if (!response || !response.ok) {
        console.error('[google-identity] JWKS fetch rejected: status=', response ? response.status : 'none');
        throw Object.assign(new Error('jwks_unavailable'), { code: GoogleIdentityCode.JWKS_UNAVAILABLE });
    }
    let body;
    try { body = await response.json(); }
    catch (err) {
        console.error('[google-identity] JWKS body unparseable:', err && err.message ? err.message : err);
        throw Object.assign(new Error('jwks_unavailable'), { code: GoogleIdentityCode.JWKS_UNAVAILABLE });
    }
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
        console.error('[google-identity] JWKS body carried no keys');
        throw Object.assign(new Error('jwks_unavailable'), { code: GoogleIdentityCode.JWKS_UNAVAILABLE });
    }
    jwksCache = { keys: body.keys, fetchedAtMs: now, ttlSeconds: jwksTtlFromResponse(response), url: url };
    return jwksCache.keys;
}

function findJwk(keys, kid) {
    if (!Array.isArray(keys)) return null;
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k && String(k.kid) === String(kid) && String(k.kty) === 'RSA') return k;
    }
    return null;
}

function verifyRs256(signingInput, signature, jwk) {
    let key;
    try {
        key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (err) {
        console.error('[google-identity] JWK import failed:', err && err.message ? err.message : err);
        return false;
    }
    try {
        return crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key, signature) === true;
    } catch (err) {
        console.error('[google-identity] RS256 verify threw:', err && err.message ? err.message : err);
        return false;
    }
}

/**
 * Verify a Google ID token end to end and return its claims.
 *
 * Order matters and IS the security: SHAPE -> ALG -> KEY -> SIGNATURE -> ISS -> AUD ->
 * TIME -> SUB. Nothing in the payload is believed until the signature over it has
 * verified, which is why `aud`/`iss`/`exp` are checked AFTER verifyRs256, never before.
 *
 * @returns {Promise<{ok:true, subject:string, claims:object} | {ok:false, code:string, detail?:object}>}
 *          Never throws for a bad token — a refusal is a VALUE, so the caller can audit it.
 */
async function verifyIdToken(idToken, options) {
    const opts = options || {};
    const env = opts.env || process.env;

    const raw = idToken == null ? '' : String(idToken).trim();
    if (!raw) return { ok: false, code: GoogleIdentityCode.TOKEN_MISSING, detail: {} };

    const parts = raw.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_MALFORMED, detail: { segments: parts.length } };
    }

    let header, claims;
    try {
        header = decodeJsonSegment(parts[0]);
        claims = decodeJsonSegment(parts[1]);
    } catch (_) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_MALFORMED, detail: { json: false } };
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
        return { ok: false, code: GoogleIdentityCode.TOKEN_MALFORMED, detail: { object: false } };
    }

    // ⛔ THE ALG ALLOWLIST, BEFORE ANYTHING ELSE. "none" and an HS256 downgrade are the
    // two classic JWT forgeries and both die here.
    if (!ALLOWED_ALGS.has(String(header.alg || ''))) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_ALG_REFUSED, detail: { alg: String(header.alg || '') } };
    }
    const kid = String(header.kid || '');
    if (!kid) return { ok: false, code: GoogleIdentityCode.TOKEN_KEY_UNKNOWN, detail: { kid: false } };

    let keys;
    try { keys = await fetchJwks({ fetchFn: opts.fetchFn, env: env }); }
    catch (_) { return { ok: false, code: GoogleIdentityCode.JWKS_UNAVAILABLE, detail: {} }; }

    let jwk = findJwk(keys, kid);
    if (!jwk) {
        // Google rotates signing keys. ONE forced refetch (not a loop) turns a rotation
        // from an outage into a cache miss.
        try { keys = await fetchJwks({ fetchFn: opts.fetchFn, env: env, force: true }); }
        catch (_) { return { ok: false, code: GoogleIdentityCode.JWKS_UNAVAILABLE, detail: {} }; }
        jwk = findJwk(keys, kid);
    }
    if (!jwk) return { ok: false, code: GoogleIdentityCode.TOKEN_KEY_UNKNOWN, detail: {} };

    const signingInput = parts[0] + '.' + parts[1];
    let signature;
    try { signature = b64urlToBuffer(parts[2]); }
    catch (_) { return { ok: false, code: GoogleIdentityCode.TOKEN_MALFORMED, detail: { sig: false } }; }

    if (!verifyRs256(signingInput, signature, jwk)) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_BAD_SIGNATURE, detail: {} };
    }

    // ── Claims are only believable from here down. ────────────────────────────
    if (!GOOGLE_ISSUERS.has(String(claims.iss || ''))) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_BAD_ISSUER, detail: {} };
    }

    const audiences = allowedAudiences(env);
    if (audiences.length === 0) {
        return { ok: false, code: GoogleIdentityCode.UNCONFIGURED, detail: { audiences: 0 } };
    }
    // `aud` is a single string for Google ID tokens; the array form is legal per the
    // spec, so handle both rather than String()-ing an array into nonsense.
    const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
    let audOk = false;
    for (let i = 0; i < aud.length; i++) {
        if (audiences.indexOf(aud[i]) !== -1) { audOk = true; break; }
    }
    if (!audOk) return { ok: false, code: GoogleIdentityCode.TOKEN_BAD_AUDIENCE, detail: {} };

    const nowSec = Math.floor((opts.nowMs != null ? opts.nowMs : Date.now()) / 1000);
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp) || exp + CLOCK_SKEW_SECONDS <= nowSec) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_EXPIRED, detail: {} };
    }
    const notBefore = Number.isFinite(Number(claims.nbf)) ? Number(claims.nbf) : Number(claims.iat);
    if (Number.isFinite(notBefore) && notBefore - CLOCK_SKEW_SECONDS > nowSec) {
        return { ok: false, code: GoogleIdentityCode.TOKEN_NOT_YET_VALID, detail: {} };
    }

    const subject = String(claims.sub || '').trim();
    if (!subject) return { ok: false, code: GoogleIdentityCode.TOKEN_NO_SUBJECT, detail: {} };

    return { ok: true, subject: subject, claims: claims };
}

/** Test seam only — lets a unit test start from a cold cache. */
function _resetJwksCache() {
    jwksCache = { keys: null, fetchedAtMs: 0, ttlSeconds: 0, url: '' };
}

module.exports = {
    GoogleIdentityCode,
    GOOGLE_JWKS_URL,
    CLOCK_SKEW_SECONDS,
    identityEnabled,
    identityConfiguration,
    allowedAudiences,
    derivePlayerId,
    verifyIdToken,
    _test: { fetchJwks, findJwk, jwksTtlFromResponse, decodeJsonSegment, _resetJwksCache },
};
