'use strict';

// =============================================================================
// POST /api/wallet/rpc — the ALLOW-LISTED Solana JSON-RPC proxy for the WEB build.
// -----------------------------------------------------------------------------
// WHY THIS EXISTS. The SDK's browser wallet bridge
// (Packages/com.solana.unity_sdk/Runtime/Plugins/SolanaWalletAdapterWebGL/
// SolanaWalletAdapterWebGL.jslib:57-84, read 2026-09-22) is base64-in / base64-out
// and SIGNS BUT NEVER SUBMITS. Submission, the recipient-ATA existence check and the
// blockhash are therefore OURS — and a browser cannot call a public Solana RPC
// directly, which api/wallet/skr-balance.js already records in its own header
// ("Browser CORS cannot hit public Solana RPC reliably"). Without this file the web
// build has no pay path at all: WebGLWalletProvider.SendPayment returned a hardcoded
// Failure and the Jupiter swap arm had nowhere to submit.
//
// ⛔ WHAT MAKES THIS SAFE TO EXPOSE: it is an ALLOW-LIST, not a pass-through. Five
// methods, each with its OWN parameter validator, and the OPTIONS OBJECT IS SERVER-
// AUTHORED on every one of them — whatever the caller sends for encoding /
// commitment / skipPreflight is DISCARDED. A general proxy would hand any page on
// the internet our paid RPC quota and let a caller set `skipPreflight:true`, which is
// precisely the flag that makes "nothing was charged" stop being true
// (SolanaWalletProvider.SubmitSignedTransaction keeps it false for that reason; this file keeps it
// false for the same one). There is deliberately no way to add a method from the
// request.
//
// ⛔ NO PRICE, NO RECIPIENT AND NO ENTITLEMENT PASSES THROUGH HERE. This route is a
// TRANSPORT. The four purchase invariants live where they always did: the persisted
// quote is the only price (api/purchases/quote.js), the contract is rebuilt from the
// row (api/_lib/purchase-catalog.js contractFromQuoteRow), /verify reads no amount
// from a body, and the treasury is env-only. A caller who submits a transaction
// through this proxy still gets NOTHING until api/purchases/verify.js reads finalized
// chain data and matches that contract exactly. Nothing here may ever grow an
// opinion about any of that.
//
// THE UPSTREAM URL IS `mainnetRpcUrl()` FROM _lib/skr-staking — the same env the
// balance proxy already reads (SOLANA_MAINNET_RPC_URL). Re-reading the env name here
// would be a second copy of one fact, which is the failure CLAUDE.md sec.2/sec.5/
// sec.16 each describe in their own words. A consequence worth stating out loud:
// THIS PROXY IS MAINNET-ONLY BY CONSTRUCTION. The C# caller must refuse a non-mainnet
// network itself rather than quietly submitting a devnet-shaped transaction here.
//
// LOGGING: the method name, the ref, and — for sendTransaction — the SIGNATURE the
// node returned. Never the base64 body, never a full param array. A signed
// transaction in a log line is a payload anyone downstream can replay verbatim.
//
// ASCII only. CommonJS, to match every sibling under api/.
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { reserveIpBudget } = require('../_lib/ip-budget');
const { hashIp } = require('../_lib/audit');
const { mainnetRpcUrl } = require('../_lib/skr-staking');

// A JSON-RPC envelope for one of the five methods is small. 16 KiB is the cap the
// WO-1947 lane-B rail uses; the largest legitimate body here is a ~1.6 KB base64
// transaction, so this is two orders of headroom and still bounded.
const MAX_BODY_BYTES = 16 * 1024;

// The Solana packet limit is 1232 bytes on the wire, i.e. ~1644 base64 characters.
// 4096 leaves room for a future limit change without becoming an unbounded field.
const MAX_TX_BASE64_CHARS = 4096;

// getSignatureStatuses takes a list; one caller polls ONE signature. The cap stops
// this becoming a bulk chain-scanning endpoint on our quota.
const MAX_SIGNATURES_PER_CALL = 5;

// Fixed-window IP budget. One purchase is ~4 calls (blockhash, getAccountInfo,
// sendTransaction) plus a handful of status polls, so 60/minute is several
// purchases' worth of headroom and still a bound.
const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 60;

// Base58, Bitcoin alphabet (no 0 O I l). A Solana address is 32-44 chars; a
// signature is 64 bytes and encodes to 86-88.
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// The commitment every read on this rail uses. 'confirmed' matches
// SolanaWalletProvider.SubmitSignedTransaction's preflightCommitment and
// ConfirmTransaction's accepted statuses (:1221-1223), so the web path and the
// Android path judge the chain by the same clock.
const COMMITMENT = 'confirmed';

function isBase58Address(v) {
    return typeof v === 'string' && BASE58_ADDRESS_RE.test(v);
}

/**
 * ⛔ THE ALLOW-LIST. THIS IS THE ONLY LIST OF RPC METHOD NAMES IN THE PROJECT.
 *
 * Each entry's `params` function returns the params array WE will send upstream —
 * built from scratch, never the caller's array passed along. That is what makes the
 * "server-authored options" claim above structurally true instead of a comment: a
 * field the builder does not write cannot reach the node.
 *
 * Returning null means "refuse"; the handler answers BAD_PARAMS and spends nothing.
 */
const ALLOWED_METHODS = {
    // The blockhash a client-built transaction is signed against. No caller input
    // is used at all.
    getLatestBlockhash: function () {
        return [{ commitment: COMMITMENT }];
    },

    // The recipient-ATA existence check (SolanaWalletProvider.cs:707-712 does the
    // same read through the SDK). base64 encoding is forced: a jsonParsed response
    // is larger and nothing on this rail reads it.
    getAccountInfo: function (params) {
        const address = params[0];
        if (!isBase58Address(address)) return null;
        return [address, { encoding: 'base64', commitment: COMMITMENT }];
    },

    // The SKR balance of one token account.
    getTokenAccountBalance: function (params) {
        const address = params[0];
        if (!isBase58Address(address)) return null;
        return [address, { commitment: COMMITMENT }];
    },

    // Submission. skipPreflight is FORCED FALSE: preflight failing is what makes
    // "nothing was charged" honest when a swap or a transfer cannot succeed.
    sendTransaction: function (params) {
        const wire = params[0];
        if (typeof wire !== 'string') return null;
        if (wire.length === 0 || wire.length > MAX_TX_BASE64_CHARS) return null;
        if (!BASE64_RE.test(wire)) return null;
        return [wire, {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: COMMITMENT,
            maxRetries: 3,
        }];
    },

    // Confirmation polling. searchTransactionHistory is forced FALSE — the true
    // form is the expensive one and a just-submitted signature is never in history.
    getSignatureStatuses: function (params) {
        const sigs = params[0];
        if (!Array.isArray(sigs)) return null;
        if (sigs.length === 0 || sigs.length > MAX_SIGNATURES_PER_CALL) return null;
        for (const s of sigs) {
            if (typeof s !== 'string' || !BASE58_SIGNATURE_RE.test(s)) return null;
        }
        return [sigs, { searchTransactionHistory: false }];
    },
};

const ALLOWED_METHOD_NAMES = Object.keys(ALLOWED_METHODS);

function makeHandler(deps) {
    deps = deps || {};
    const getSql = deps.getSql || (() => neon(process.env.DATABASE_URL));
    const doFetch = deps.fetchImpl || ((url, init) => fetch(url, init));
    const resolveRpcUrl = deps.rpcUrl || mainnetRpcUrl;

    return async function handler(req, res) {
        // CORS FIRST, before any method or shape check. WO-1947's whole RCA was nine
        // routes whose first line refused the preflight, so the real request was
        // never sent and a healthy server read as unreachable.
        if (applyCors(req, res, 'POST, OPTIONS')) return;

        const ref = newRef();

        if (req.method !== 'POST') {
            return quietFail(res, 400, 'METHOD_NOT_ALLOWED', ref);
        }

        let raw;
        try {
            raw = await readBodyExact(req, MAX_BODY_BYTES);
        } catch (err) {
            const code = err && err.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'BAD_BODY';
            console.warn('[wallet/rpc] ref=' + ref + ' body read failed: ' + code);
            return quietFail(res, 400, code, ref);
        }

        let body;
        try {
            body = JSON.parse(raw.buffer.toString('utf8'));
        } catch (_) {
            return quietFail(res, 400, 'BAD_BODY', ref);
        }
        if (!body || typeof body !== 'object') {
            return quietFail(res, 400, 'BAD_BODY', ref);
        }

        const method = typeof body.method === 'string' ? body.method : '';
        // hasOwnProperty, not `in`: `constructor` / `toString` must not resolve
        // through the prototype chain into a "known" method.
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_METHODS, method)) {
            console.warn('[wallet/rpc] ref=' + ref + ' REFUSED method not on the allow-list.');
            return quietFail(res, 400, 'METHOD_NOT_ALLOWED', ref);
        }

        const params = Array.isArray(body.params) ? body.params : [];
        const upstreamParams = ALLOWED_METHODS[method](params);
        if (upstreamParams === null) {
            console.warn('[wallet/rpc] ref=' + ref + ' REFUSED ' + method + ': bad params.');
            return quietFail(res, 400, 'BAD_PARAMS', ref);
        }

        // ⚠ EVERY FREE CHECK IS ABOVE THIS LINE. A malformed request must never cost
        // a household a unit of its budget — the placement rule WO-1440 wrote into
        // the promo route and WO-1456 into the nonce route.
        //
        // failClosed:false, on purpose and for the nonce rail's reason: an unreadable
        // budget table must not take the ONE revenue rail on web offline. The degraded
        // case logs loudly rather than limiting in silence.
        try {
            const spend = await reserveIpBudget(getSql(), hashIp(req), 'WALLET_RPC', {
                windowSeconds: IP_WINDOW_SECONDS,
                maxPerWindow: IP_MAX_PER_WINDOW,
                failClosed: false,
                label: 'wallet/rpc',
            });
            if (!spend.ok) {
                console.warn('[wallet/rpc] ref=' + ref + ' REFUSED ' + method +
                    ' - IP budget exhausted (grants=' + (spend.grants || '?') + ').');
                return quietFail(res, 429, 'RATE_LIMITED', ref);
            }
            if (spend.degraded) {
                console.warn('[wallet/rpc] ref=' + ref + ' budget DEGRADED - serving unlimited.');
            }
        } catch (err) {
            // The limiter is an availability-first gate here; a thrown limiter must
            // not become a dead pay path. Loud, never silent.
            console.warn('[wallet/rpc] ref=' + ref + ' budget THREW (' +
                (err && err.message ? err.message : 'unknown') + ') - serving anyway.');
        }

        const url = resolveRpcUrl();
        if (!url) {
            console.error('[wallet/rpc] ref=' + ref + ' SOLANA_MAINNET_RPC_URL is unset.');
            return quietFail(res, 503, 'RPC_UNAVAILABLE', ref);
        }

        let payload;
        try {
            const upstream = await doFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: method,
                    params: upstreamParams,
                }),
            });
            if (!upstream || !upstream.ok) {
                console.warn('[wallet/rpc] ref=' + ref + ' ' + method + ' upstream HTTP ' +
                    (upstream ? upstream.status : 'none'));
                return quietFail(res, 502, 'RPC_TRANSPORT', ref);
            }
            payload = await upstream.json();
        } catch (err) {
            console.warn('[wallet/rpc] ref=' + ref + ' ' + method + ' transport ' +
                (err && err.message ? err.message : 'unknown'));
            return quietFail(res, 502, 'RPC_TRANSPORT', ref);
        }

        if (!payload || typeof payload !== 'object') {
            return quietFail(res, 502, 'RPC_TRANSPORT', ref);
        }

        if (payload.error) {
            // The node's own refusal. Its code+message are DIAGNOSTIC and the client
            // needs them (a preflight failure reads very differently from a bad
            // blockhash), so they are forwarded — and nothing else is.
            const code = payload.error.code;
            const message = typeof payload.error.message === 'string'
                ? payload.error.message.slice(0, 400) : '';
            console.warn('[wallet/rpc] ref=' + ref + ' ' + method +
                ' rpc error code=' + String(code) + ' message=' + message);
            return res.status(502).json({
                ok: false,
                code: 'RPC_ERROR',
                error: { code: code, message: message },
                ref: ref,
            });
        }

        if (method === 'sendTransaction') {
            // The ONE field worth logging on this path, and the only one: the
            // signature is the idempotency key the whole purchase ledger is built on
            // (api/purchases/verify.js keys purchase_entitlements on tx_signature),
            // so a submission that later cannot be found must be traceable here. The
            // base64 is deliberately NOT logged.
            console.log('[wallet/rpc] ref=' + ref + ' sendTransaction accepted signature=' +
                String(payload.result));
        }

        return res.status(200).json({ ok: true, method: method, result: payload.result });
    };
}

module.exports = makeHandler();

// bodyParser:false AFTER the assignment above would be thrown away — api/game/save.js
// lost its config exactly that way (api/_lib/http.js:147-165). The config and the
// test seam are attached to the exported function, in this order, deliberately.
module.exports.config = { api: { bodyParser: false } };
module.exports._test = {
    makeHandler: makeHandler,
    ALLOWED_METHODS: ALLOWED_METHODS,
    ALLOWED_METHOD_NAMES: ALLOWED_METHOD_NAMES,
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    MAX_TX_BASE64_CHARS: MAX_TX_BASE64_CHARS,
    MAX_SIGNATURES_PER_CALL: MAX_SIGNATURES_PER_CALL,
    COMMITMENT: COMMITMENT,
};
