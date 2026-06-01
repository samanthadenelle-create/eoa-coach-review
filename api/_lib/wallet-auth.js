// =============================================================================
// api/_lib/wallet-auth.js — shared wallet-signature auth helpers (WO-120 §D)
// -----------------------------------------------------------------------------
// Challenge–response auth so a public wallet address alone can no longer
// overwrite/read another player's save. Used by:
//   • api/auth/nonce.js  — issues a one-time nonce (issueNonce)
//   • api/game/save.js   — verifies a signature + burns the nonce (verifyAndConsume)
//   • api/game/load.js   — same verify path (read protection)
//
// WALLET SCHEME (ASSUMPTION — FLAGGED): Solana / ed25519.
//   The entire client is Solana (WalletService exposes a base58 address as the
//   on-chain identity = player_id; tower-swap logs Solana tx signatures; Solana
//   Pay). So we verify an ed25519 signature with tweetnacl over the base58-
//   decoded wallet public key. If the chain were ever EVM, replace verifySignature
//   with an ecrecover check — the nonce table + flow are scheme-agnostic.
//
// DEPENDENCIES (add to the Vercel project's package.json — see DB_SETUP.md §1):
//   npm install tweetnacl bs58
// Both are tiny, dependency-light, and the de-facto standard for Solana message
// verification server-side.
//
// MESSAGE FORMAT (canonical — the client MUST sign the identical bytes):
//   `dotr-save:v1:<wallet>:<nonce>:<sha256-hex-of-payload-bytes>`
//   UTF-8 encoded. Binding the payload hash means a captured signature can't be
//   replayed against a DIFFERENT save body, and binding the nonce means it can't
//   be replayed at all (single-use). For a GET (load) there is no body, so the
//   payload-hash segment is the literal string "load".
// =============================================================================

const crypto = require('crypto');

// Lazy-require the crypto libs so a missing dependency surfaces as a clear 500
// at call time (with a helpful message) rather than a module-load crash that
// takes down unrelated routes.
let nacl = null;
let bs58 = null;
function loadCrypto() {
    if (nacl && bs58) return;
    // eslint-disable-next-line global-require
    nacl = require('tweetnacl');
    // eslint-disable-next-line global-require
    bs58 = require('bs58');
    // bs58 v6 exports under .default when require'd from CJS in some setups.
    if (bs58 && typeof bs58.decode !== 'function' && bs58.default) bs58 = bs58.default;
}

// How long an issued nonce stays valid. Short by design (challenge → sign →
// send happens in one user action).
const NONCE_TTL_SECONDS = 300; // 5 minutes

/**
 * The canonical message the client signs and the server reconstructs.
 * @param {string} wallet       base58 wallet address (the claimed identity)
 * @param {string} nonce        the issued one-time nonce
 * @param {Buffer|null} payload  raw request body bytes (null/empty for GET/load)
 * @returns {string} the exact UTF-8 message both sides hash a signature over
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
    // 32 random bytes → URL-safe base64. Unpredictable, collision-proof for our
    // volume, and safe to put in a header/query string.
    const nonce = crypto.randomBytes(32).toString('base64url');

    // Best-effort prune of this wallet's stale/used challenges so the table
    // doesn't grow unbounded. Cheap (indexed on wallet); ignore failures.
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

/**
 * Verify an ed25519 signature over buildSignedMessage(wallet, nonce, payload).
 * Pure crypto — does NOT touch the DB.
 * @returns {boolean} true iff the signature is valid for the wallet pubkey
 */
function verifySignature(wallet, nonce, payload, signatureBase58) {
    loadCrypto();
    try {
        const message = Buffer.from(buildSignedMessage(wallet, nonce, payload), 'utf8');
        const pubkey = bs58.decode(wallet);           // 32-byte ed25519 pubkey
        const sig = bs58.decode(signatureBase58);     // 64-byte signature
        if (pubkey.length !== 32 || sig.length !== 64) return false;
        return nacl.sign.detached.verify(
            new Uint8Array(message),
            new Uint8Array(sig),
            new Uint8Array(pubkey),
        );
    } catch (_) {
        return false; // malformed base58 / wrong lengths → auth fail, never throw
    }
}

/**
 * Full auth gate for the save/load path: pull the wallet/nonce/signature from
 * headers, verify the signature, then ATOMICALLY consume the nonce (so it can
 * never be replayed). All failures collapse to a single { ok:false, reason }.
 *
 * Header contract (client sets these — see GameStateService):
 *   X-Wallet     base58 wallet address (must equal the payload's playerId)
 *   X-Nonce      the nonce issued by GET /api/auth/nonce
 *   X-Signature  base58 ed25519 signature over buildSignedMessage(...)
 *
 * @param {Function} sql       neon(...) client
 * @param {object}  headers    req.headers (lower-cased by Node)
 * @param {Buffer|null} payload raw body bytes (null for GET/load)
 * @param {string}  claimedPlayerId  the playerId the request is acting on
 * @returns {Promise<{ok:boolean, wallet?:string, reason?:string}>}
 */
async function verifyAndConsume(sql, headers, payload, claimedPlayerId) {
    const wallet = headers['x-wallet'];
    const nonce = headers['x-nonce'];
    const signature = headers['x-signature'];

    if (!wallet || !nonce || !signature) {
        return { ok: false, reason: 'missing_auth_headers' };
    }

    // The signed wallet MUST be the player whose save is being touched.
    if (claimedPlayerId != null && String(claimedPlayerId) !== String(wallet)) {
        return { ok: false, reason: 'wallet_player_mismatch' };
    }

    // 1. Cryptographic check (cheap, no DB) — reject bad signatures first.
    if (!verifySignature(wallet, nonce, payload, signature)) {
        return { ok: false, reason: 'bad_signature' };
    }

    // 2. Atomically burn the nonce. The WHERE clause enforces: exists, issued to
    //    THIS wallet, not yet used, not expired. Zero rows ⇒ replay/expired/forged.
    const consumed = await sql`
        UPDATE auth_nonces
        SET used = TRUE
        WHERE nonce = ${nonce}
          AND wallet = ${wallet}
          AND used = FALSE
          AND expires_at > NOW()
        RETURNING nonce
    `;
    if (consumed.length === 0) {
        return { ok: false, reason: 'nonce_invalid_or_used' };
    }

    return { ok: true, wallet };
}

module.exports = {
    NONCE_TTL_SECONDS,
    buildSignedMessage,
    issueNonce,
    verifySignature,
    verifyAndConsume,
};
