// =============================================================================
// api/auth/nonce.js — Vercel Serverless Function (the wallet-rail challenge)
// -----------------------------------------------------------------------------
// Issues a single-use, 5-minute nonce bound to a wallet. The client fetches one
// BEFORE a save/load, signs a message embedding it (see
// _lib/wallet-auth.buildSignedMessage), and presents the signature on the
// save/load call, which verifies it and BURNS the nonce.
//
//   GET /api/auth/nonce?wallet=<base58>
//   200 { success:true, ok:true, nonce, expiresAt, ttlSeconds }
//   400 { ok:false, code:'AUTH_WALLET_MALFORMED', ref }
//
// Issuing a nonce is intentionally UNAUTHENTICATED — the nonce alone grants
// nothing; it is only useful to whoever holds the wallet's PRIVATE key. Leaking
// one is harmless.
//
// GUESTS DO NOT COME HERE. The guest rail carries no signature and needs no
// challenge (see _lib/wallet-auth.verifyGuest); asking this endpoint for a nonce
// with a guest id returns AUTH_WALLET_MALFORMED, which is correct and legible.
//
// CHANGED 2026-08-02: CORS + preflight (this had none, so the WebGL build's
// nonce fetch was blocked by the browser before the function ever ran — the
// wallet rail was unreachable from the web build no matter what the client did),
// and structured codes + audit rows instead of prose errors.
//
// Status codes: 200 | 400 | 500 (project constraint).
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { AuthCode, issueNonce, isWalletId, isGuestId } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail } = require('../_lib/http');
const { logAuthReject } = require('../_lib/audit');

module.exports = async (req, res) => {
    if (applyCors(req, res, 'GET, OPTIONS')) return;

    const ref = newRef();

    if (req.method !== 'GET') {
        return quietFail(res, 400, AuthCode.METHOD_NOT_ALLOWED, ref);
    }

    const wallet = req.query && req.query.wallet != null ? String(req.query.wallet).trim() : '';

    // Same base58 rule as the verifier and as the client's IsCloudIdentityShaped —
    // minting a nonce for an id that can never satisfy the verifier only
    // manufactures a confusing 401 one step later.
    if (!isWalletId(wallet)) {
        let sql = null;
        try { sql = neon(process.env.DATABASE_URL); } catch (_) { /* log to console only */ }
        await logAuthReject(sql, req, {
            code: AuthCode.WALLET_MALFORMED, ref, identity: wallet || null, mode: 'wallet',
            detail: { len: wallet.length, looksLikeGuest: isGuestId(wallet) },
        });
        return quietFail(res, 400, AuthCode.WALLET_MALFORMED, ref);
    }

    try {
        const sql = neon(process.env.DATABASE_URL);
        const { nonce, expiresAt, ttlSeconds } = await issueNonce(sql, wallet);
        return res.status(200).json({ ok: true, success: true, nonce, expiresAt, ttlSeconds });
    } catch (err) {
        console.error('[auth/nonce] DB error:', err);
        return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }
};
