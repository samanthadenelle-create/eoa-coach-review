// =============================================================================
// api/_lib/wallet-auth.js — the auth gate for /api/game/save + /api/game/load
// -----------------------------------------------------------------------------
// THREE RAILS (two until 2026-08-30), chosen by the SHAPE OF THE PLAYER ID being
// touched — never by what headers the caller happens to send:
//
//   WALLET RAIL  playerId matches ^[1-9A-HJ-NP-Za-km-z]{32,44}$ (base58 Solana
//                address). Requires X-Wallet + X-Nonce + X-Signature: an ed25519
//                signature over the exact canonical message, plus a single-use,
//                5-minute, wallet-bound nonce that is atomically burned. This is
//                the REAL-VALUE rail and its verification is UNCHANGED and
//                UNWEAKENED by the guest work below.
//
//   GUEST RAIL   playerId matches ^guest-local-[0-9a-f]{64}$ — the id the Unity
//                client already mints (GameStateService.EnsureAccount:
//                "guest-local-" + sha256(deviceId + salt)). Requires X-Guest-Id
//                to equal that playerId, and nothing else. See the honesty note
//                on verifyGuest: this is BEARER-TOKEN trust, deliberately and
//                explicitly second-class.
//
//   PLAY RAIL    playerId matches ^play-[0-9a-f]{64}$ — added 2026-08-30 (WO-1282
//                PIN-1b) so a GOOGLE PLAY player, who has no wallet, can key a save
//                and an entitlement. The id is HMAC-SHA256(GOOGLE_IDENTITY_KEY,
//                google_sub) computed SERVER-SIDE from a Google-signed ID token; the
//                client cannot mint one. Requires X-Session, issued only by
//                api/auth/google-session.js. DORMANT unless GOOGLE_IDENTITY_ENABLED.
//                ⛔ THE WALLET REMAINS THE SOLE IDENTITY ON THE SEEKER/APK ARTIFACT
//                   (owner ruling 2026-08-30). This rail is for the Play/AAB artifact
//                   only, and nothing above it is weakened by its existence.
//
// The three id shapes are lexically DISJOINT (a guest id is 76 chars and a play- id
// 69, both containing '-' and hex '0', all of which fail base58; the two prefixes
// differ), so no value can ever be routed to the wrong rail, and no guest header can
// influence a wallet-keyed or play-keyed row.
//
// ── A THIRD RULE, ADDED 2026-08-18 (and the one the shape-disjointness above does
//    NOT give you for free) ──────────────────────────────────────────────────────
// Disjoint shapes stop a guest from touching a WALLET-KEYED row. They do NOT stop a
// guest from being handed value keyed to its OWN id — and since the client MINTS
// that id, an attacker mints as many "players" as they like. So:
//
//   ⛔ ROUTES THAT GRANT VALUE CALL authenticateGranting(), NOT authenticate().
//      authenticate()          = "prove you are you" — a guest can.  (save/load/…)
//      authenticateGranting()  = "prove you may be PAID" — a guest never can.
//
// See the corrected honesty note on verifyGuest for the exploit this closed.
//
// EVERY failure returns a STABLE MACHINE CODE (AuthCode). Before this, all nine
// distinct ways to fail collapsed into one opaque 401 with a prose "reason" sent
// to the PLAYER and nothing kept server-side — you could not tell no-header from
// bad-signature from replayed-nonce from expired-nonce. Now the code goes in the
// (minimal) response and the full context goes in the db (_lib/audit.js).
//
// MESSAGE FORMAT (canonical — the client MUST sign the identical bytes):
//   `dotr-save:v1:<wallet>:<nonce>:<sha256-hex-of-payload-bytes>`
//   UTF-8. Binding the payload hash stops a captured signature being replayed
//   against a DIFFERENT body; binding the nonce stops it being replayed at all.
//   A GET (load) has no body, so the payload segment is the literal "load".
//
// DEPENDENCIES: tweetnacl + bs58 (both in package.json).
// =============================================================================

const crypto = require('crypto');

// Lazy-require the crypto libs so a missing dependency surfaces as a clear coded
// failure at call time rather than a module-load crash that takes down unrelated
// routes.
let nacl = null;
let bs58 = null;
let cryptoLoadError = null;
function loadCrypto() {
    if (nacl && bs58) return true;
    try {
        // eslint-disable-next-line global-require
        nacl = require('tweetnacl');
        // eslint-disable-next-line global-require
        bs58 = require('bs58');
        // bs58 v6 exports under .default when require'd from CJS in some setups.
        if (bs58 && typeof bs58.decode !== 'function' && bs58.default) bs58 = bs58.default;
        return !!(nacl && bs58 && typeof bs58.decode === 'function');
    } catch (err) {
        cryptoLoadError = err && err.message ? err.message : String(err);
        return false;
    }
}

// How long an issued nonce stays valid. Short by design (challenge → sign → send
// happens inside one user action).
const NONCE_TTL_SECONDS = 300; // 5 minutes

// WO-1157. A SESSION is a short-lived bearer token issued FROM one burned nonce, so a
// purchase prompts the wallet ONCE (the transfer) instead of three times (connect, a
// per-request auth signature, the transfer).
//
// ⛔ WHY THIS IS SHORT AND WHY IT MUST STAY SHORT. A per-request signature is bound to
// that exact request body and therefore cannot be replayed against a different one. A
// bearer token CAN, until it expires. That is a genuine security reduction, taken
// deliberately to remove a prompt the player should never have seen -- and it is only
// acceptable while the window is small. Do NOT raise this for convenience, and do NOT
// turn it into a permanent login: the whole justification is the size of the window.
const SESSION_TTL_SECONDS = 900; // 15 minutes

// ── Identity shapes ──────────────────────────────────────────────────────────
// The wallet regex is deliberately IDENTICAL to the one api/auth/nonce.js applies
// and to the client's GameStateService.IsCloudIdentityShaped — three copies of
// one rule is how a player gets a nonce they can never spend.
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Mirrors the client EXACTLY: GuestWalletPrefix ("guest-local-") + Sha256Hex(...)
// = 12 + 64 chars, lowercase hex.
const GUEST_RE = /^guest-local-[0-9a-f]{64}$/;
// ── A THIRD SHAPE, ADDED 2026-08-30 (WO-1282 PIN-1b): the GOOGLE PLAY rail. ──
// "play-" + HMAC-SHA256(GOOGLE_IDENTITY_KEY, google_sub) as 64 lowercase hex.
//
// ⛔ THE CLIENT CANNOT MINT ONE. Unlike a guest id (which the device computes and is
//    therefore worth a bearer token and nothing more), this id is derived SERVER-SIDE
//    in _lib/google-identity.derivePlayerId from the `sub` of a Google ID token whose
//    RS256 signature was verified against Google's JWKS. Without GOOGLE_IDENTITY_KEY
//    the value cannot be computed, so an attacker cannot mint players — which is the
//    single property that lets this rail stand next to the wallet on a GRANTING route.
//
// ⛔ AND IT IS LEXICALLY DISJOINT FROM BOTH EXISTING SHAPES, by construction:
//    * fails WALLET_RE — 69 chars (>44), and contains '-' and '0', none of them base58.
//    * fails GUEST_RE  — different literal prefix.
//    Re-checked against both regexes at source on 2026-08-30, and api/auth/google-session.js
//    additionally refuses to issue a session for any derived id that fails PLAY_RE.
//    Disjointness is what stops a Play id being routed to the guest rail's bearer-token
//    trust, or a wallet-keyed row being reachable from this one.
const PLAY_RE = /^play-[0-9a-f]{64}$/;

function isWalletId(id) { return typeof id === 'string' && WALLET_RE.test(id); }
function isGuestId(id) { return typeof id === 'string' && GUEST_RE.test(id); }
function isPlayId(id) { return typeof id === 'string' && PLAY_RE.test(id); }

/**
 * "May an id of this SHAPE ever be handed real value?"
 *
 * The one place the answer lives, so a value-granting route and an entitlement read
 * cannot drift apart (they did: sku-entitlement-read.js hardcoded isWalletId, which is
 * exactly how a Play player would have read an empty entitlement list forever).
 *
 * ⛔ A GUEST IS NEVER IN THIS SET. A guest id is SELF-ASSERTED by the client; a wallet
 *    id is proven by an ed25519 signature and a play- id is proven by a Google-signed
 *    token plus a server-only HMAC key. Proven-by-somebody-else is the membership rule.
 */
function isProvenValueId(id) { return isWalletId(id) || isPlayId(id); }

// ── Stable failure codes ─────────────────────────────────────────────────────
// Non-secret by construction: a code names a CLASS of failure and never reveals
// which wallet, which nonce, or what the server knows about either.
const AuthCode = {
    PLAYER_ID_MISSING:      'PLAYER_ID_MISSING',        // no playerId in body/query at all
    PLAYER_ID_BAD_SHAPE:    'PLAYER_ID_BAD_SHAPE',      // neither a base58 wallet nor a guest-local id

    WALLET_HEADERS_MISSING: 'AUTH_HEADERS_MISSING',     // wallet rail, but X-Wallet/X-Nonce/X-Signature absent
    WALLET_MALFORMED:       'AUTH_WALLET_MALFORMED',    // X-Wallet is not a base58 32–44 address
    WALLET_MISMATCH:        'AUTH_WALLET_MISMATCH',     // X-Wallet != the playerId being touched
    BAD_SIGNATURE:          'AUTH_BAD_SIGNATURE',       // ed25519 verify failed over the canonical message
    CRYPTO_UNAVAILABLE:     'AUTH_CRYPTO_UNAVAILABLE',  // tweetnacl/bs58 missing on the deployment

    NONCE_UNKNOWN:          'AUTH_NONCE_UNKNOWN',       // no such nonce row (never issued, or already swept)
    NONCE_WRONG_WALLET:     'AUTH_NONCE_WRONG_WALLET',  // nonce exists but was issued to another wallet
    NONCE_REPLAYED:         'AUTH_NONCE_REPLAYED',      // nonce exists, already burned  ← the replay case
    NONCE_EXPIRED:          'AUTH_NONCE_EXPIRED',       // nonce exists, past its 5-minute TTL

    SESSION_UNKNOWN:        'AUTH_SESSION_UNKNOWN',     // no such session row (never issued, revoked, or swept)
    SESSION_EXPIRED:        'AUTH_SESSION_EXPIRED',     // session exists, past its TTL -- client re-signs ONCE
    SESSION_WRONG_WALLET:   'AUTH_SESSION_WRONG_WALLET',// session is valid but issued to a DIFFERENT wallet
    SESSION_MALFORMED:      'AUTH_SESSION_MALFORMED',   // X-Session is not a plausible token

    GUEST_HEADER_MISSING:   'GUEST_HEADER_MISSING',     // guest rail, no X-Guest-Id
    GUEST_MISMATCH:         'GUEST_MISMATCH',           // X-Guest-Id != the guest playerId
    GUEST_RATE_LIMITED:     'GUEST_RATE_LIMITED',       // guest exceeded its window budget
    GUEST_DISABLED:         'GUEST_DISABLED',           // guest rail switched off by env
    WALLET_REQUIRED:        'AUTH_WALLET_REQUIRED',     // an UNPROVEN rail authenticated, but this route GRANTS VALUE

    GOOGLE_DISABLED:        'GOOGLE_IDENTITY_DISABLED', // play- id presented while the Play rail is switched off

    PAYLOAD_TOO_LARGE:      'PAYLOAD_TOO_LARGE',
    BAD_PAYLOAD:            'BAD_PAYLOAD',
    METHOD_NOT_ALLOWED:     'METHOD_NOT_ALLOWED',
    SERVER_ERROR:           'SERVER_ERROR',
};

// ── Guest rail policy ────────────────────────────────────────────────────────
// A guest is UNVERIFIED by definition, so it gets a budget instead of trust.
// Window is per guest id and shared by save+load (a bounded total, not two
// budgets to spend). Generous enough that no honest tester ever sees it: the
// client's own MinSyncDelay is 8s ⇒ ~7 syncs/minute at full tilt.
const GUEST_WINDOW_SECONDS = 60;
const GUEST_MAX_PER_WINDOW = 30;
// Hard ceiling on a guest save body. The wallet rail gets more room because it
// is a proven identity; a guest is a stranger with a device hash.
const GUEST_MAX_BODY_BYTES  = 256 * 1024;
const WALLET_MAX_BODY_BYTES = 1024 * 1024;

// The Google Play identity rail's arm switch. Deliberately NOT a second copy of the
// env read: _lib/google-identity.js owns that rule (default OFF, explicit 'true' to
// arm), and duplicating it here is precisely how two halves of one switch drift apart.
// google-identity.js requires nothing from this file, so there is no require cycle.
const { identityEnabled: googleIdentityEnabled } = require('./google-identity');

/** Guests can be switched off entirely with GUEST_SAVE_ENABLED=false (no redeploy of logic). */
function guestEnabled() {
    const v = process.env.GUEST_SAVE_ENABLED;
    if (v == null || v === '') return true;             // default ON
    return !/^(0|false|off|no)$/i.test(String(v).trim());
}

/**
 * The canonical message the client signs and the server reconstructs.
 * @param {string} wallet        base58 wallet address (the claimed identity)
 * @param {string} nonce         the issued one-time nonce
 * @param {Buffer|null} payload  raw request body bytes (null/empty for GET/load)
 * @returns {string} the exact UTF-8 message both sides sign/verify
 */
function buildSignedMessage(wallet, nonce, payload) {
    let payloadTag;
    if (payload && payload.length > 0) {
        payloadTag = crypto.createHash('sha256').update(payload).digest('hex');
    } else {
        payloadTag = 'load';
    }
    return `dotr-save:v1:${wallet}:${nonce}:${payloadTag}`;
}

/**
 * Issue a fresh single-use nonce for a wallet and persist it.
 * @param {Function} sql   a neon(...) tagged-template client
 * @param {string} wallet  base58 wallet address the nonce is bound to
 * @returns {Promise<{nonce:string, expiresAt:string, ttlSeconds:number}>}
 */
async function issueNonce(sql, wallet) {
    // 32 random bytes → URL-safe base64. Unpredictable, collision-proof at our
    // volume, safe in a header or query string.
    const nonce = crypto.randomBytes(32).toString('base64url');

    // Best-effort prune of this wallet's stale/used challenges so the table does
    // not grow unbounded between cron sweeps. Cheap (indexed on wallet).
    try {
        await sql`
            DELETE FROM auth_nonces
            WHERE wallet = ${wallet} AND (used = TRUE OR expires_at < NOW())
        `;
    } catch (_) { /* non-fatal housekeeping */ }

    const rows = await sql`
        INSERT INTO auth_nonces (nonce, wallet, expires_at)
        VALUES (
            ${nonce},
            ${wallet},
            NOW() + (${NONCE_TTL_SECONDS} * INTERVAL '1 second')
        )
        RETURNING nonce, expires_at
    `;

    return {
        nonce: rows[0].nonce,
        expiresAt: rows[0].expires_at,
        ttlSeconds: NONCE_TTL_SECONDS,
    };
}

const SESSION_RE = /^[A-Za-z0-9_-]{40,90}$/;

/**
 * Issue a session token for a wallet whose signature has ALREADY been verified and
 * whose nonce has ALREADY been burned. WO-1157.
 *
 * ⛔ THIS FUNCTION DOES NOT AUTHENTICATE ANYTHING. It mints a credential. The caller is
 * responsible for having proven wallet ownership first -- call it only after a
 * successful verifyWallet(). Calling it on an unproven wallet hands out that wallet's
 * identity, which is the one mistake here that matters.
 *
 * WO-1282 PIN-1b: `subject` may now also be a `play-<64hex>` id, minted ONLY by
 * api/auth/google-session.js after it verified a Google-signed ID token. The rule above
 * is unchanged and applies identically: this function mints, it never proves. The
 * optional `identityKind` records WHICH proof stood behind the mint, defaulting to
 * 'wallet' so api/auth/session.js needs no edit and behaves byte-identically.
 *
 * @param {string} subject       the PROVEN identity (base58 wallet, or a play- id)
 * @param {string} identityKind  'wallet' | 'google' — audit only; never an authorization input
 */
async function issueSession(sql, wallet, identityKind) {
    const kind = identityKind === 'google' ? 'google' : 'wallet';
    const token = crypto.randomBytes(32).toString('base64url');

    // Housekeeping: drop this wallet's dead sessions so the table cannot grow unbounded.
    // Non-fatal -- a failed prune must never block a login.
    try {
        await sql`DELETE FROM auth_sessions WHERE wallet = ${wallet} AND (revoked = TRUE OR expires_at < NOW())`;
    } catch (_) { /* housekeeping only */ }

    const rows = await sql`
        INSERT INTO auth_sessions (token, wallet, identity_kind, expires_at)
        VALUES (${token}, ${wallet}, ${kind}, NOW() + (${SESSION_TTL_SECONDS} * INTERVAL '1 second'))
        RETURNING token, expires_at
    `;
    return { token: rows[0].token, expiresAt: rows[0].expires_at, ttlSeconds: SESSION_TTL_SECONDS };
}

/**
 * Verify a bearer session token and bind it to the player being acted on.
 *
 * Distinguishes UNKNOWN from EXPIRED on purpose: expired is a normal, recoverable state
 * the client answers by re-signing once, while unknown means revoked/never-issued and
 * should not be retried in a loop.
 */
async function verifySession(sql, token, claimedPlayerId) {
    if (!token || !SESSION_RE.test(String(token))) {
        return { ok: false, code: AuthCode.SESSION_MALFORMED, detail: { len: String(token || '').length } };
    }
    let rows;
    try {
        rows = await sql`
            SELECT wallet, revoked, (expires_at < NOW()) AS expired
            FROM auth_sessions WHERE token = ${token} LIMIT 1
        `;
    } catch (e) {
        return { ok: false, code: AuthCode.SESSION_UNKNOWN, detail: { query_failed: true } };
    }
    if (!rows || rows.length === 0) {
        return { ok: false, code: AuthCode.SESSION_UNKNOWN, detail: { swept_or_never_issued: true } };
    }
    const row = rows[0];
    if (row.revoked === true) return { ok: false, code: AuthCode.SESSION_UNKNOWN, detail: { revoked: true } };
    if (row.expired === true) return { ok: false, code: AuthCode.SESSION_EXPIRED, detail: {} };

    // ⛔ THE CHECK THAT KEEPS A SESSION FROM BECOMING A SKELETON KEY: a token proves WHICH
    // wallet, and that wallet must still be the player being acted on. Without this, any
    // valid session could act for any player id -- the same invariant verifyWallet enforces
    // via WALLET_MISMATCH, and it must not be weaker just because the proof arrived as a
    // token instead of a signature.
    if (claimedPlayerId != null && String(claimedPlayerId) !== String(row.wallet)) {
        return { ok: false, code: AuthCode.SESSION_WRONG_WALLET, detail: {} };
    }
    return { ok: true, wallet: String(row.wallet) };
}

/**
 * Verify an ed25519 signature over buildSignedMessage(wallet, nonce, payload).
 * Pure crypto — does NOT touch the DB.
 * @returns {{ok:boolean, code?:string}} ok, or the precise reason it failed.
 */
function verifySignatureDetailed(wallet, nonce, payload, signatureBase58) {
    if (!loadCrypto()) {
        return { ok: false, code: AuthCode.CRYPTO_UNAVAILABLE, detail: { require: cryptoLoadError } };
    }
    try {
        const message = Buffer.from(buildSignedMessage(wallet, nonce, payload), 'utf8');
        const pubkey = bs58.decode(wallet);           // 32-byte ed25519 pubkey
        const sig = bs58.decode(signatureBase58);     // 64-byte signature
        if (pubkey.length !== 32 || sig.length !== 64) {
            return { ok: false, code: AuthCode.BAD_SIGNATURE, detail: { pubkeyLen: pubkey.length, sigLen: sig.length } };
        }
        const ok = nacl.sign.detached.verify(
            new Uint8Array(message),
            new Uint8Array(sig),
            new Uint8Array(pubkey),
        );
        return ok ? { ok: true } : { ok: false, code: AuthCode.BAD_SIGNATURE, detail: { verified: false } };
    } catch (err) {
        // malformed base58 / wrong lengths → auth fail, never throw
        return { ok: false, code: AuthCode.BAD_SIGNATURE, detail: { threw: true } };
    }
}

/** Back-compat boolean wrapper (unchanged semantics for any existing caller). */
function verifySignature(wallet, nonce, payload, signatureBase58) {
    return verifySignatureDetailed(wallet, nonce, payload, signatureBase58).ok === true;
}

/**
 * Burn a nonce ATOMICALLY, and — only when that fails — spend one extra read to
 * say WHY. The happy path is still exactly one UPDATE; the diagnostic SELECT is
 * paid for solely by failures, which is the whole point of making them legible.
 *
 * The UPDATE remains the sole authority (exists ∧ this wallet ∧ unused ∧
 * unexpired). The classify step never grants access, it only labels the refusal.
 *
 * @returns {Promise<{ok:boolean, code?:string, detail?:object}>}
 */
async function consumeNonce(sql, nonce, wallet) {
    const consumed = await sql`
        UPDATE auth_nonces
        SET used = TRUE
        WHERE nonce = ${nonce}
          AND wallet = ${wallet}
          AND used = FALSE
          AND expires_at > NOW()
        RETURNING nonce
    `;
    if (consumed.length > 0) return { ok: true };

    // Zero rows — classify. Any of: never issued, issued to someone else, already
    // spent (REPLAY), or expired.
    let rows = [];
    try {
        rows = await sql`
            SELECT wallet, used,
                   (expires_at <= NOW())                              AS expired,
                   EXTRACT(EPOCH FROM (NOW() - created_at))::int      AS age_seconds
            FROM auth_nonces
            WHERE nonce = ${nonce}
            LIMIT 1
        `;
    } catch (_) { /* classification is best-effort; fall through to UNKNOWN */ }

    if (!rows || rows.length === 0) {
        // Not in the table at all. Note the ambiguity honestly: the cleanup cron
        // deletes used/expired nonces, so a very old replay can also land here.
        return { ok: false, code: AuthCode.NONCE_UNKNOWN, detail: { swept_or_never_issued: true } };
    }
    const row = rows[0];
    if (String(row.wallet) !== String(wallet)) {
        return { ok: false, code: AuthCode.NONCE_WRONG_WALLET, detail: { ageSeconds: row.age_seconds } };
    }
    if (row.used === true) {
        return { ok: false, code: AuthCode.NONCE_REPLAYED, detail: { ageSeconds: row.age_seconds } };
    }
    if (row.expired === true) {
        return { ok: false, code: AuthCode.NONCE_EXPIRED, detail: { ageSeconds: row.age_seconds, ttl: NONCE_TTL_SECONDS } };
    }
    // Should be unreachable (the UPDATE's predicate is the conjunction of the
    // three above) — keep a distinct label rather than lying about the cause.
    return { ok: false, code: AuthCode.NONCE_UNKNOWN, detail: { unclassified: true } };
}

/**
 * Full WALLET-rail gate: headers → signature → atomic nonce burn.
 * UNCHANGED in strictness from the original verifyAndConsume; only the failure
 * labels got precise.
 *
 * Header contract:
 *   X-Wallet     base58 wallet address (must equal the playerId being touched)
 *   X-Nonce      the nonce issued by GET /api/auth/nonce
 *   X-Signature  base58 ed25519 signature over buildSignedMessage(...)
 *
 * @returns {Promise<{ok:boolean, wallet?:string, code?:string, detail?:object}>}
 */
async function verifyWallet(sql, headers, payload, claimedPlayerId) {
    const wallet = headers['x-wallet'];
    const nonce = headers['x-nonce'];
    const signature = headers['x-signature'];

    // ── WO-1157: the session rail, tried FIRST when offered ──────────────────────────
    // A valid session is proof of the same fact the signature proves -- that this caller
    // holds the wallet's key -- established once, minutes ago, from a burned nonce.
    //
    // ⛔ ADDITIVE AND FAIL-CLOSED. A session that is malformed, unknown, revoked, expired
    // or issued to another wallet does NOT authenticate; it falls through to the signature
    // path below, which either proves the caller or refuses. There is no branch here that
    // reaches `ok` without one of the two proofs, and the old path is untouched, so nothing
    // is forced to migrate.
    const sessionToken = headers['x-session'];
    if (sessionToken) {
        const ses = await verifySession(sql, sessionToken, claimedPlayerId);
        if (ses.ok) return { ok: true, wallet: ses.wallet, mode: 'wallet', via: 'session' };

        // A WRONG-WALLET token is not a stale credential, it is a token being used against
        // an identity it was never issued for. Refuse outright rather than letting the
        // caller retry with headers for the wallet it actually wants.
        if (ses.code === AuthCode.SESSION_WRONG_WALLET) {
            return { ok: false, code: ses.code, detail: ses.detail };
        }
        // Otherwise fall through: an expired session is an ordinary, recoverable state and
        // the caller may well have sent signature headers alongside it.
        if (!wallet || !nonce || !signature) {
            return { ok: false, code: ses.code, detail: ses.detail };
        }
    }

    if (!wallet || !nonce || !signature) {
        return {
            ok: false,
            code: AuthCode.WALLET_HEADERS_MISSING,
            detail: { wallet: !!wallet, nonce: !!nonce, signature: !!signature },
        };
    }

    if (!isWalletId(wallet)) {
        return { ok: false, code: AuthCode.WALLET_MALFORMED, detail: { len: String(wallet).length } };
    }

    // The signing wallet MUST be the player whose save is being touched.
    if (claimedPlayerId != null && String(claimedPlayerId) !== String(wallet)) {
        return { ok: false, code: AuthCode.WALLET_MISMATCH, detail: { claimedLen: String(claimedPlayerId).length } };
    }

    // 1. Cryptographic check (cheap, no DB) — reject bad signatures before we
    //    touch the nonce table. A bad signature deliberately does NOT burn the
    //    nonce: burning it would let anyone holding a leaked nonce grief the
    //    owner's own sync by spending it with garbage.
    const sig = verifySignatureDetailed(wallet, nonce, payload, signature);
    if (!sig.ok) return { ok: false, code: sig.code, detail: sig.detail };

    // 2. Atomically burn the nonce (single-use, replay-proof).
    const burn = await consumeNonce(sql, nonce, wallet);
    if (!burn.ok) return { ok: false, code: burn.code, detail: burn.detail };

    return { ok: true, wallet: wallet, mode: 'wallet' };
}

/**
 * BACK-COMPAT shim for the original boolean-ish contract
 * ({ok, wallet, reason}). Kept so nothing outside this lane breaks; new code
 * should call authenticate().
 */
async function verifyAndConsume(sql, headers, payload, claimedPlayerId) {
    const r = await verifyWallet(sql, headers, payload, claimedPlayerId);
    return r.ok ? { ok: true, wallet: r.wallet } : { ok: false, reason: r.code, code: r.code, detail: r.detail };
}

/**
 * GUEST-rail gate.
 *
 * ── HONESTY NOTE (read this before trusting anything here) ───────────────────
 * This is BEARER-TOKEN trust, not proof of identity. The only secret is the guest
 * id itself: sha256(deviceUniqueIdentifier + salt), a 256-bit value the device
 * keeps and nobody else can guess. Whoever presents it gets that row — exactly
 * like an unguessable URL. It cannot be revoked, it cannot be transferred to a
 * new device, and it is worth precisely one throwaway tester save.
 *
 * What that buys, and what it must NEVER buy, is enforced structurally, not by
 * convention: a guest id can never satisfy the wallet regex, so it can never key
 * a wallet row, and the wallet rail never consults a guest header.
 *
 * ⚠ CORRECTED 2026-08-18 — the sentence that used to end this paragraph was FALSE
 * and is why an exploit survived a security audit. It read:
 *     "Real-value paths (leaderboard, entitlements, anything on-chain) key off the
 *      wallet and are untouched by this function."
 * They were NOT all untouched. /api/promo/redeem and /api/referral/claim both call
 * authenticate(), which routes a guest-shaped id straight to THIS function — so a
 * self-asserted, unsigned, unlimited-to-mint bearer id was reaching two endpoints
 * that hand out crystals. Because the id is minted by the CLIENT
 * (GameStateService.EnsureAccount: sha256(deviceId + salt)), an attacker chooses it:
 * every fresh 64-hex string is a brand-new "player", which burns a code's
 * max_redemptions (redeem.js counts ROWS) and walks straight past per_player_limit
 * (which counts rows keyed by that same chosen id). Sybil-by-construction.
 * The honest statement of the rule, now ENFORCED instead of asserted:
 *   ⛔ A GUEST MAY NEVER AUTHENTICATE A REQUEST THAT GRANTS VALUE.
 * Value-granting routes call authenticateGranting() (below), not authenticate().
 * Do not "simplify" them back — the distinction IS the fix.
 *
 * @returns {Promise<{ok:boolean, guestId?:string, code?:string, detail?:object}>}
 */
async function verifyGuest(sql, headers, claimedPlayerId) {
    if (!guestEnabled()) {
        return { ok: false, code: AuthCode.GUEST_DISABLED, detail: {} };
    }

    const given = headers['x-guest-id'];
    if (!given) {
        return { ok: false, code: AuthCode.GUEST_HEADER_MISSING, detail: {} };
    }
    if (!isGuestId(given)) {
        return { ok: false, code: AuthCode.GUEST_MISMATCH, detail: { shape: 'header_not_guest_shaped', len: String(given).length } };
    }
    if (String(given) !== String(claimedPlayerId)) {
        return { ok: false, code: AuthCode.GUEST_MISMATCH, detail: { shape: 'header_ne_playerid' } };
    }

    const rate = await touchGuestRate(sql, given);
    if (!rate.ok) return { ok: false, code: rate.code, detail: rate.detail };

    return { ok: true, guestId: given, mode: 'guest', hits: rate.hits };
}

/**
 * Sliding-window counter for one guest id, in a single atomic UPSERT.
 *
 * FAIL-OPEN, DELIBERATELY: if guest_rate_limit is missing (schema not applied
 * yet) the rate check is skipped and the fact is reported, rather than 500-ing
 * every guest save on a deploy-order mistake. Rate limiting is abuse control on a
 * zero-value rail — it is not the thing keeping anyone's money safe, so a missing
 * table must degrade, not deny. (The wallet rail has no such escape hatch.)
 */
async function touchGuestRate(sql, guestId) {
    try {
        const rows = await sql`
            INSERT INTO guest_rate_limit (guest_id, window_started_at, hits, last_seen, total_hits)
            VALUES (${guestId}, NOW(), 1, NOW(), 1)
            ON CONFLICT (guest_id) DO UPDATE SET
                window_started_at = CASE
                    WHEN guest_rate_limit.window_started_at < NOW() - (${GUEST_WINDOW_SECONDS} * INTERVAL '1 second')
                    THEN NOW() ELSE guest_rate_limit.window_started_at END,
                hits = CASE
                    WHEN guest_rate_limit.window_started_at < NOW() - (${GUEST_WINDOW_SECONDS} * INTERVAL '1 second')
                    THEN 1 ELSE guest_rate_limit.hits + 1 END,
                last_seen = NOW(),
                total_hits = guest_rate_limit.total_hits + 1
            RETURNING hits, total_hits
        `;
        const hits = rows && rows[0] ? Number(rows[0].hits) : 1;
        if (hits > GUEST_MAX_PER_WINDOW) {
            return {
                ok: false,
                code: AuthCode.GUEST_RATE_LIMITED,
                detail: { hits: hits, max: GUEST_MAX_PER_WINDOW, windowSeconds: GUEST_WINDOW_SECONDS },
            };
        }
        return { ok: true, hits: hits };
    } catch (err) {
        console.warn('[wallet-auth] guest rate table unavailable — allowing (fail-open):', err.message);
        return { ok: true, hits: -1, degraded: true };
    }
}

/**
 * THE ONE ENTRY POINT save.js/load.js call.
 *
 * Routes by the SHAPE of the player id being acted on, so the caller cannot pick
 * the weaker rail for a wallet-keyed row: a base58 id ALWAYS demands a signature.
 *
 * @param {Function} sql              neon(...) client
 * @param {object}   req              the request (headers, method, url)
 * @param {Buffer|null} payload       raw body bytes (null for GET)
 * @param {string}   claimedPlayerId  the id the request acts on
 * @returns {Promise<{ok:boolean, mode:string, identity?:string, code?:string, detail?:object}>}
 */
async function authenticate(sql, req, payload, claimedPlayerId) {
    const headers = req.headers || {};

    if (claimedPlayerId == null || String(claimedPlayerId).trim() === '') {
        return { ok: false, mode: 'none', code: AuthCode.PLAYER_ID_MISSING, detail: {} };
    }
    const id = String(claimedPlayerId).trim();

    if (isWalletId(id)) {
        const r = await verifyWallet(sql, headers, payload, id);
        return r.ok
            ? { ok: true, mode: 'wallet', identity: r.wallet }
            : { ok: false, mode: 'wallet', identity: id, code: r.code, detail: r.detail };
    }

    // GOOGLE PLAY RAIL (WO-1282 PIN-1b). A play- id is proven the same way a wallet
    // proves itself between signatures: by a session token this server issued. The
    // ONLY minting path is api/auth/google-session.js, which verifies a Google-signed
    // ID token first — so a session here is a proxy for that proof, exactly as a wallet
    // session is a proxy for an ed25519 signature. verifySession is UNCHANGED and
    // already binds the token to the subject being acted on (SESSION_WRONG_WALLET).
    if (isPlayId(id)) {
        if (!googleIdentityEnabled()) {
            // Fail CLOSED, and say which switch. Turning the rail off is an operator
            // kill switch, not a downgrade — there is deliberately no weaker fallback.
            return { ok: false, mode: 'google', identity: id, code: AuthCode.GOOGLE_DISABLED, detail: {} };
        }
        const token = headers['x-session'] != null ? String(headers['x-session']).trim() : '';
        const r = await verifySession(sql, token, id);
        return r.ok
            ? { ok: true, mode: 'google', identity: r.wallet }
            : { ok: false, mode: 'google', identity: id, code: r.code, detail: r.detail };
    }

    if (isGuestId(id)) {
        const r = await verifyGuest(sql, headers, id);
        return r.ok
            ? { ok: true, mode: 'guest', identity: r.guestId, degraded: true }
            : { ok: false, mode: 'guest', identity: id, code: r.code, detail: r.detail };
    }

    // Neither shape. This is the Firebase-UID case the client's RetireLegacyIdentity
    // describes (a 28-char UID that could never satisfy the wallet regex) and every
    // debug string — name it precisely instead of pretending the signature failed.
    return {
        ok: false,
        mode: 'none',
        identity: id,
        code: AuthCode.PLAYER_ID_BAD_SHAPE,
        detail: { len: id.length },
    };
}

/**
 * THE ENTRY POINT EVERY VALUE-GRANTING ROUTE CALLS (added 2026-08-18).
 *
 * Identical to authenticate(), then ONE extra, deliberately blunt rule:
 *
 *   ⛔ the proven identity must be a WALLET. A guest is refused, always.
 *
 * WHY A SEPARATE FUNCTION AND NOT A FLAG ON authenticate(): the two questions are
 * genuinely different and must not share a default. authenticate() answers "is
 * this caller who they say they are, for their OWN row?" — a guest legitimately
 * passes that, and save/load/generate/tower-swap depend on it. This one answers
 * "may this caller be HANDED VALUE?" — and a self-asserted id can never earn a
 * yes, because the client picks it and an attacker is a client. A boolean
 * parameter would make the safe answer the one you have to remember to ask for;
 * a distinct name makes the grant path say out loud that it is a grant path.
 *
 * FAILS CLOSED: anything other than a fully verified wallet rail is a refusal.
 * The refusal is LOUD server-side (the caller audits AUTH_WALLET_REQUIRED with
 * the full context) and QUIET to the player (quietFail → a stable code + ref,
 * which the Unity client maps to its "we couldn't confirm your identity" line —
 * never a wall of JSON).
 *
 * @returns {Promise<{ok:boolean, mode:string, identity?:string, code?:string, detail?:object}>}
 */
async function authenticateGranting(sql, req, payload, claimedPlayerId) {
    const r = await authenticate(sql, req, payload, claimedPlayerId);
    if (!r.ok) return r;

    // Belt AND braces: require a mode on the ALLOWLIST **and** re-test that mode's id
    // shape, so a future edit to authenticate()'s routing cannot quietly open this door.
    //
    // ⛔ IT IS AN ALLOWLIST AND MUST STAY ONE. Widened 2026-08-30 (WO-1282 PIN-1b) from
    //    `mode === 'wallet'` to {wallet, google} — two entries, both PROVEN-BY-A-THIRD-PARTY
    //    identities. A future mode is refused by DEFAULT until someone adds it here on
    //    purpose; a denylist would have granted it by default, which is the whole reason
    //    the check is written this way. GUEST IS STILL REFUSED, and always will be: the
    //    client mints a guest id, so an attacker mints as many "players" as they like.
    const shapeCheck = GRANTING_MODES[String(r.mode || '')];
    if (typeof shapeCheck !== 'function' || !shapeCheck(String(r.identity || ''))) {
        return {
            ok: false,
            mode: r.mode,
            identity: r.identity,
            code: AuthCode.WALLET_REQUIRED,
            detail: { grantingRoute: true, provenMode: r.mode },
        };
    }
    return r;
}

/**
 * THE ALLOWLIST ITSELF: mode → the shape predicate that mode's identity must satisfy.
 *
 * Pairing the mode with its OWN shape check (rather than one generic "is it provable")
 * means a bug that routes a wallet id out of the google branch, or vice versa, is a
 * refusal rather than a grant.
 */
const GRANTING_MODES = {
    wallet: isWalletId,   // ed25519 signature over a single-use nonce
    google: isPlayId,     // Google-signed ID token + a server-only HMAC key
    // guest: ⛔ NEVER. See the honesty note on verifyGuest.
};

module.exports = {
    issueSession, verifySession, SESSION_TTL_SECONDS,
    NONCE_TTL_SECONDS,
    GUEST_WINDOW_SECONDS,
    GUEST_MAX_PER_WINDOW,
    GUEST_MAX_BODY_BYTES,
    WALLET_MAX_BODY_BYTES,
    AuthCode,
    WALLET_RE,
    GUEST_RE,
    PLAY_RE,
    isWalletId,
    isGuestId,
    isPlayId,
    isProvenValueId,
    guestEnabled,
    googleIdentityEnabled,
    buildSignedMessage,
    issueNonce,
    verifySignature,
    verifySignatureDetailed,
    consumeNonce,
    verifyWallet,
    verifyGuest,
    verifyAndConsume,   // back-compat
    authenticate,          // ← self-service routes (own row): save, load, generate, tower-swap
    authenticateGranting,  // ← ANY route that hands out value: promo redeem, referral claim
};
