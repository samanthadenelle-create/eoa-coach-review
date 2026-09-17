'use strict';

// MON-1147 fulfillment acknowledgement. Verification proves payment; this
// separate authenticated transition records that the client persisted the
// entitlement. It is replay-safe and never creates or grants an entitlement.
const { neon } = require('@neondatabase/serverless');
const { AuthCode, authenticateGranting, WALLET_MAX_BODY_BYTES } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { logAuthReject } = require('../_lib/audit');
const { walletAllowed } = require('../_lib/purchase-catalog');
const { markEntitlementFulfilled } = require('../_lib/purchase-fulfilment');
const pi = require('../_lib/pi-payments');

// ⛔ SOLANA'S SIGNATURE SHAPE. base58 (no 0 O I l), 80-90 chars. DO NOT RELAX IT
//    to accommodate another rail: a widened alphabet here is a real hole on the
//    rail that carries ed25519-signed grants. Rails get their OWN validator —
//    see signatureOk() below (WO-1797 §3.2.2).
const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

// The networks this route will read a row for. `pi` is ACCEPTED at the payload
// layer (WO-1797 §3.2.1) so a Pi ack is refused by the AUTH gate with a truthful
// code instead of by a shape check that hides the real reason — but note that
// authenticateGranting's allowlist (api/_lib/wallet-auth.js:862-869) has no `pi`
// mode, so the Pi rail's live door is POST /api/pi/fulfill, not this route.
const NETWORKS = Object.freeze(['devnet', 'mainnet-beta', 'pi']);

/** Signature validation PER RAIL, chosen explicitly — never one widened regex. */
function signatureOk(network, signature) {
    if (network === 'pi') return pi.TXID_RE.test(signature);
    return TX_SIG_RE.test(signature);
}

function matches(row, playerId, sku, network) {
    return !!row && row.wallet === playerId && row.sku === sku && row.network === network;
}

async function handler(req, res) {
    if (applyCors(req, res, 'POST, OPTIONS')) return;
    const ref = newRef();
    if (req.method !== 'POST') return quietFail(res, 400, AuthCode.METHOD_NOT_ALLOWED, ref);

    let rawBody, body;
    try {
        rawBody = (await readBodyExact(req, WALLET_MAX_BODY_BYTES)).buffer;
        body = JSON.parse(rawBody.toString('utf8'));
    } catch (_) { return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref); }

    const playerId = String(body.playerId || '').trim();
    const signature = String(body.txSignature || '').trim();
    const sku = String(body.sku || '').trim();
    const network = String(body.network || 'devnet').trim().toLowerCase();
    if (!playerId || !sku || !NETWORKS.includes(network) || !signatureOk(network, signature))
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);
    if (!walletAllowed(network, sku, playerId))
        return quietFail(res, 403, AuthCode.BAD_PAYLOAD, ref);

    let sql;
    try { sql = neon(process.env.DATABASE_URL); }
    catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }

    let auth;
    try { auth = await authenticateGranting(sql, req, rawBody, playerId); }
    catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
    if (!auth.ok) {
        await logAuthReject(sql, req, { code: auth.code, ref, identity: auth.identity,
            mode: auth.mode, detail: auth.detail });
        return quietFail(res, 401, auth.code, ref);
    }

    const rows = await sql`
        SELECT entitlement_id, wallet, sku, network, status
        FROM purchase_entitlements WHERE tx_signature = ${signature} LIMIT 1`;
    if (!rows.length) return quietFail(res, 404, AuthCode.BAD_PAYLOAD, ref);
    if (!matches(rows[0], playerId, sku, network))
        return quietFail(res, 409, AuthCode.BAD_PAYLOAD, ref);

    // THE transition lives in api/_lib/purchase-fulfilment.js — one statement,
    // two callers (this route and api/pi/fulfill.js). See that file's header.
    try { await markEntitlementFulfilled(sql, rows[0], playerId, ref); }
    catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }

    return res.status(200).json({ success: true, state: 'fulfilled', sku,
        network, txSignature: signature, entitlementId: String(rows[0].entitlement_id) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { matches, signatureOk, NETWORKS, TX_SIG_RE };
