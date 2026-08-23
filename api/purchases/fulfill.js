'use strict';

// MON-1147 fulfillment acknowledgement. Verification proves payment; this
// separate authenticated transition records that the client persisted the
// entitlement. It is replay-safe and never creates or grants an entitlement.
const { neon } = require('@neondatabase/serverless');
const { AuthCode, authenticateGranting, WALLET_MAX_BODY_BYTES } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { logAuthReject, logApiEvent } = require('../_lib/audit');
const { walletAllowed } = require('../_lib/purchase-catalog');

const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

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
    if (!playerId || !TX_SIG_RE.test(signature) || !sku ||
        (network !== 'devnet' && network !== 'mainnet-beta'))
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

    if (rows[0].status === 'verified') {
        await sql`
            UPDATE purchase_entitlements
               SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, NOW()),
                   updated_at = NOW()
             WHERE entitlement_id = ${rows[0].entitlement_id} AND status = 'verified'`;
        await logApiEvent(sql, playerId, 'purchase_entitlement_fulfilled', { ref, sku });
    }

    return res.status(200).json({ success: true, state: 'fulfilled', sku,
        network, txSignature: signature, entitlementId: String(rows[0].entitlement_id) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { matches };
