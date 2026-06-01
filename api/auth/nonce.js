// =============================================================================
// api/auth/nonce.js — Vercel Serverless Function (WO-120 §D security gate)
// -----------------------------------------------------------------------------
// Issues a single-use, short-TTL nonce bound to a wallet. The client fetches one
// of these BEFORE a save/load, signs a message embedding it (see
// _lib/wallet-auth.buildSignedMessage), and presents the signature on the
// save/load call. The save/load endpoint then verifies + burns the nonce.
//
// Client : Assets/_Modules/Core/State/GameStateService.cs (auth pre-step)
//   GET   /api/auth/nonce?wallet=<base58>
//   Reply : { success:true, nonce, expiresAt, ttlSeconds }
//
// Issuing a nonce is intentionally UNAUTHENTICATED — the nonce alone grants
// nothing; it is only useful to whoever holds the wallet's PRIVATE key (they
// must sign with it). So leaking a nonce is harmless.
//
// Driver: @neondatabase/serverless
// Status codes: 200 | 400 | 500   (project constraint)
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { issueNonce } = require('../_lib/wallet-auth');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(400).json({ error: 'Method not allowed' });
    }

    const wallet = req.query && req.query.wallet != null ? String(req.query.wallet).trim() : '';
    // Basic sanity on a Solana base58 address (32–44 chars, base58 alphabet).
    // Not a full curve check — verifySignature does the real work — just a guard
    // against empty/garbage so we don't mint nonces for obvious junk.
    if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
        return res.status(400).json({ error: 'Missing or malformed wallet' });
    }

    try {
        const sql = neon(process.env.DATABASE_URL);
        const { nonce, expiresAt, ttlSeconds } = await issueNonce(sql, wallet);
        return res.status(200).json({ success: true, nonce, expiresAt, ttlSeconds });
    } catch (err) {
        console.error('[auth/nonce] DB error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
