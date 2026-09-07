// =============================================================================
// api/auth/session.js — Vercel Serverless Function (WO-1157: one prompt, not three)
// -----------------------------------------------------------------------------
// Exchanges ONE proven wallet signature for a short-lived bearer session, so the
// player is asked to sign once per window instead of once per backend call.
//
//   POST /api/auth/session          headers: X-Wallet, X-Nonce, X-Signature
//   200 { success:true, ok:true, token, expiresAt, ttlSeconds }
//   401 { ok:false, code:'AUTH_...', ref }
//
// THE PROBLEM THIS SOLVES, in the owner's words during the live mainnet canary:
// "i had to verify with wallet 3 times… cant it roll into one transaction like
// every other site?" It can. The three prompts were (1) MWA connect, (2) an auth
// signature per backend call, (3) the transfer. Only (3) should ever be seen.
//
// ⭐ (3) IS DELIBERATELY KEPT. A payment that does not ask is a payment you cannot
// refuse, and this rail moves real money. The sites being compared against do the
// same: they cache the SESSION, never the purchase consent. Anyone "improving"
// this by suppressing the transfer prompt has misread the ticket.
//
// ⛔ THIS ENDPOINT MINTS AN IDENTITY, SO IT PROVES ONE FIRST. It runs the SAME
// verifyWallet() every protected route runs — real signature, real nonce burn — and
// only then issues. It is not a login shortcut; it is the existing proof, cached.
//
// ⛔ AND IT NEVER TRUSTS THE CLIENT'S IDEA OF WHO IT IS. The session is bound to the
// wallet the SIGNATURE proved, never to a wallet named in the body. Those are the
// same value on the happy path and very different ones under attack.
//
// Status codes: 200 | 400 | 401 | 500 (project constraint).
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { AuthCode, verifyWallet, issueSession, renewSession, isWalletId } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail } = require('../_lib/http');
const { logAuthReject, logApiEvent } = require('../_lib/audit');

module.exports = async (req, res) => {
    if (applyCors(req, res, 'POST, OPTIONS')) return;

    const ref = newRef();

    if (req.method !== 'POST') {
        return quietFail(res, 400, AuthCode.METHOD_NOT_ALLOWED, ref);
    }

    const headers = req.headers || {};
    const wallet = headers['x-wallet'] != null ? String(headers['x-wallet']).trim() : '';

    if (!isWalletId(wallet)) {
        await logAuthReject(null, req, { code: AuthCode.WALLET_MALFORMED, ref, mode: 'wallet' });
        return quietFail(res, 400, AuthCode.WALLET_MALFORMED, ref);
    }

    // ⛔ EVERY 500 BELOW USED TO BE `catch (_)` WITH NO LOG (fixed 2026-08-24). CLAUDE.md §12:
    // "a catch that swallows without logging is forbidden". The cost was exact and immediate — on
    // 2026-08-24 this endpoint returned 500 on the owner's device, the client reported
    // "[BackendAuth] Session mint threw (500)", and the Vercel runtime entry for it was COMPLETELY
    // EMPTY. Three different failures (DB connect / verify / issue) all looked identical from the
    // outside, so the one thing needed to diagnose it — WHICH STEP — was the one thing discarded.
    // The reason string stays out of the RESPONSE (quietFail is deliberate: a 500 must not describe
    // the server's internals to a caller). It belongs in the log.
    let sql;
    try {
        sql = neon(process.env.DATABASE_URL);
    } catch (err) {
        console.error(`[auth/session] ref=${ref} step=db-connect FAILED:`, err && err.message ? err.message : err);
        return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }

    // ── RENEWAL, AND THE CAP ON IT (WO-1441) ─────────────────────────────────────────
    //
    // ⚠ READ THIS BEFORE CHANGING ANYTHING HERE: RENEWAL WAS ALREADY LIVE BEFORE THIS BLOCK
    // EXISTED, BY ACCIDENT RATHER THAN BY DESIGN. _lib/wallet-auth.verifyWallet tries the
    // session rail FIRST (its "WO-1157: the session rail, tried FIRST when offered" branch),
    // so a request presenting a VALID X-Session and no nonce already passed verification and
    // fell straight into issueSession below — i.e. this endpoint has always exchanged a good
    // session for a fresh one with no signature. Nobody wrote that down and nothing tested it.
    //
    // ⛔ WHICH MEANS THE FILE WAS ALREADY BREAKING ITS OWN RULE. wallet-auth's TTL comment
    // says a session must never "become a permanent login" — but an uncapped renewal is
    // exactly that: each renewal issued a token with a brand-new 15-minute clock, forever,
    // so a single signature could be walked forward indefinitely and a LEAKED token could be
    // too. The window was only ever 15 minutes for someone who did not renew.
    //
    // So this block does NOT add renewal. It puts the CEILING on the renewal that already
    // existed: renewSession refuses past SESSION_ABSOLUTE_TTL_SECONDS measured from the
    // ORIGINAL signature (signed_at, carried forward across rotations), and it revokes the
    // old token instead of leaving a growing family of live ones.
    //
    // ⛔ GATED ON THE ABSENCE OF A NONCE, NOT ON A CLIENT FLAG. A request carrying signature
    // material must always take the verifying path below; letting a caller ASSERT "renew"
    // would let it choose the cheaper check for itself, which is the shape of most auth
    // bypasses. A client can reach renewal only by having nothing else to offer.
    const sessionHeader = headers['x-session'] != null ? String(headers['x-session']).trim() : '';
    const nonceHeader   = headers['x-nonce']   != null ? String(headers['x-nonce']).trim()   : '';
    if (sessionHeader && !nonceHeader) {
        let renewed;
        try {
            renewed = await renewSession(sql, sessionHeader);
        } catch (err) {
            console.error(`[auth/session] ref=${ref} step=renew-session FAILED:`,
                err && err.message ? err.message : err);
            return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
        }

        if (renewed.ok) {
            // ⛔ The renewed session names the wallet the ORIGINAL SIGNATURE proved, never the
            // one in the header. Identical on the happy path, different under attack — the same
            // rule the mint path applies with auth.wallet below.
            if (renewed.wallet !== wallet) {
                await logAuthReject(sql, req, { code: AuthCode.SESSION_WRONG_WALLET, ref, identity: wallet, mode: 'wallet-renew' });
                return quietFail(res, 401, AuthCode.SESSION_WRONG_WALLET, ref);
            }

            try {
                await logApiEvent(sql, renewed.wallet, 'session_renewed', { ttlSeconds: renewed.ttlSeconds, ref });
            } catch (_) { /* audit is best-effort; never fail a good renewal on it */ }

            return res.status(200).json({
                success: true,
                ok: true,
                token: renewed.token,
                expiresAt: renewed.expiresAt,
                ttlSeconds: renewed.ttlSeconds,
                renewed: true,
            });
        }

        // ⛔ THE CAP IS THE ONE REFUSAL THAT MUST NOT FALL THROUGH. Everything below this
        // point would hand the request to verifyWallet, which accepts a still-valid session
        // and mints — precisely the uncapped behaviour this block exists to end. A chain past
        // its absolute life is REFUSED here and the player signs again.
        if (renewed.detail && renewed.detail.absolute_cap === true) {
            await logAuthReject(sql, req, { code: renewed.code, ref, identity: wallet, mode: 'wallet-renew-capped' });
            return quietFail(res, 401, renewed.code, ref);
        }

        // ⚠ EVERY OTHER REFUSAL FALLS THROUGH ON PURPOSE, AND THIS IS A DEPLOYMENT SAFETY
        // PROPERTY, NOT LAZINESS. renewSession reports query_failed when the `signed_at`
        // column is missing, and this schema is deployed separately from this code — a
        // database that has not had api/schema.sql applied yet would otherwise LOSE renewal
        // that works in production today, turning a hardening into an outage. Falling
        // through hands the request to the pre-existing verifyWallet session rail, which
        // behaves exactly as it does now. An unknown/expired/revoked token likewise ends in
        // the same refusal verifyWallet would have produced, so nothing is masked.
        console.warn(`[auth/session] ref=${ref} step=renew-session declined code=${renewed.code} ` +
            `detail=${JSON.stringify(renewed.detail || {})} - falling through to full verification`);
    }

    // ⛔ The nonce is burned by this call. That is correct and intended: a session is
    // issued FROM a single-use challenge, so obtaining one costs exactly the same proof
    // a single protected call used to cost. Sessions do NOT make nonces reusable.
    //
    // The payload is null: this request has no body to bind, so the signed message is the
    // 'load'-shaped one the client already builds for a bodyless call. Passing the wallet
    // as claimedPlayerId keeps the wallet-vs-player check in force here too.
    let auth;
    try {
        auth = await verifyWallet(sql, headers, null, wallet);
    } catch (err) {
        // ⚠ A THROW HERE IS USUALLY THE NONCE TABLE, NOT THE SIGNATURE. A bad signature returns
        // {ok:false} and lands on the 401 below; only an infrastructure fault reaches this catch.
        console.error(`[auth/session] ref=${ref} step=verify-wallet FAILED:`,
            err && err.message ? err.message : err);
        return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }

    if (!auth.ok) {
        await logAuthReject(sql, req, { code: auth.code, ref, identity: wallet, mode: 'wallet' });
        return quietFail(res, 401, auth.code, ref);
    }

    let session;
    try {
        // auth.wallet, NOT the header — the proven identity, not the claimed one.
        session = await issueSession(sql, auth.wallet);
    } catch (err) {
        // ⚠ PRIME SUSPECT: `auth_sessions` missing from the deployed schema. It is a WO-1157
        // addition, and this database is already known to be behind — /api/dungeon-status fails with
        // `relation "dungeon_status" does not exist`, another recent table. A Postgres 42P01 here
        // means the schema needs applying (psql "$DATABASE_URL" -f api/schema.sql), NOT a code fix.
        // The code is named in the log so that distinction is one read away instead of a guess.
        console.error(`[auth/session] ref=${ref} step=issue-session FAILED:`,
            err && err.code ? `[${err.code}] ` : '', err && err.message ? err.message : err);
        return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }

    try {
        await logApiEvent(sql, auth.wallet, 'session_issued', { ttlSeconds: session.ttlSeconds, ref });
    } catch (_) { /* audit is best-effort; never fail a good login on it */ }

    res.status(200).json({
        success: true,
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        ttlSeconds: session.ttlSeconds,
    });
};
