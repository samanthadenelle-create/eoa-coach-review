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
//   400 { ok:false, code:'RATE_LIMITED', ref }          ← WO-1456, per caller IP
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
const { logAuthReject, logApiEvent, hashIp } = require('../_lib/audit');
const { reserveIpBudget } = require('../_lib/ip-budget');

// ── THE IP BUDGET (WO-1456) ──────────────────────────────────────────────────
// This route had NO rate limit of any kind. Every call MINTS A ROW — cheap for
// an unauthenticated caller, a database write for Neon — so a loop here is a
// free way to grow `auth_nonces` without ever holding a private key.
//
// The limiter is the promo rail's (WO-1440), extracted to _lib/ip-budget.js. Not
// a second one: two limiters with two windows and two refusal codes is duplicated
// state, and the promo rail already solved the hard part (one atomic UPSERT, keyed
// on the one signal a client cannot choose).
//
// ⛔ WHY 120 PER HOUR, AND WHY NOT LOWER. The same shared-NAT reasoning the promo
// budget is written on — a household, a dorm, above all mobile CARRIER-GRADE NAT,
// which can put many unrelated players behind one address. A nonce is fetched once
// per save/load handshake, so an ordinary session spends a handful; 120/hour leaves
// room for a busy household and a retry storm while still turning an unbounded row
// mint into a bounded one. Erring high is deliberate: the thing being protected is
// a write, not a payout, and refusing a real player's nonce breaks their cloud save.
//
// ⛔ AND IT FAILS OPEN, the OPPOSITE of the promo rail. A nonce grants NOTHING —
// it is useless without the wallet's private key, and the file says so above. An
// unreadable budget table must therefore never take the entire wallet login
// offline. The promo rail guards a payout and fails closed; correctness there,
// availability here.
const NONCE_IP_WINDOW_SECONDS = 60 * 60;
const NONCE_IP_MAX_PER_WINDOW = 120;

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

        // ── IP BUDGET ───────────────────────────────────────────────────────
        // Placed HERE on purpose: AFTER the free shape check above, so a malformed
        // wallet can never spend a real household's budget, and immediately before
        // the row is minted, so only an attempt that was actually about to be served
        // costs a unit. (The same placement rule WO-1440 wrote into the promo route.)
        const ipHash = hashIp(req);
        const budget = await reserveIpBudget(sql, ipHash, 'AUTH_NONCE', {
            windowSeconds: NONCE_IP_WINDOW_SECONDS,
            maxPerWindow: NONCE_IP_MAX_PER_WINDOW,
            failClosed: false,
            label: 'auth/nonce',
        });
        if (!budget.ok) {
            await logApiEvent(sql, wallet, 'auth_nonce_ip_budget_refused', {
                ref: ref, ipHash: ipHash,
                grants: budget.grants ?? null,
                max: NONCE_IP_MAX_PER_WINDOW,
                windowSeconds: NONCE_IP_WINDOW_SECONDS,
            });
            // RATE_LIMITED is the promo rail's code, reused verbatim rather than a new
            // one. The BODY SHAPE is this route's own ({ok:false, code, ref}) and not
            // the promo rail's 200 + {success:false,error}, deliberately: the promo
            // shape exists because the published client branches on a JSON body for a
            // business outcome, whereas BackendRequestSigner.FetchNonceAsync treats any
            // non-2xx as "no nonce, abort" — which is exactly the right behaviour here
            // and keeps this file's three documented response shapes intact.
            return quietFail(res, 400, 'RATE_LIMITED', ref);
        }

        const { nonce, expiresAt, ttlSeconds } = await issueNonce(sql, wallet);
        return res.status(200).json({ ok: true, success: true, nonce, expiresAt, ttlSeconds });
    } catch (err) {
        console.error('[auth/nonce] DB error:', err);
        return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }
};
