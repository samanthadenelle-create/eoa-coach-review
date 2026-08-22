'use strict';

// MON-1147 — authenticated, server-authoritative SKR purchase verification.
const { neon } = require('@neondatabase/serverless');
const { AuthCode, authenticateGranting, WALLET_MAX_BODY_BYTES } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { logAuthReject, logApiEvent } = require('../_lib/audit');
const { purchaseContract } = require('../_lib/purchase-catalog');

const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

function rpcUrl(network) {
    if (network !== 'devnet') return null;
    return String(process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || '').trim() || null;
}

async function readFinalizedTransfer(url, signature, wallet, contract) {
    let payload;
    try {
        const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
                params: [signature, { commitment: 'finalized', encoding: 'jsonParsed',
                    maxSupportedTransactionVersion: 0 }] }),
        });
        if (!response.ok) return { state: 'pending', reason: 'rpc_unavailable' };
        payload = await response.json();
    } catch (_) { return { state: 'pending', reason: 'rpc_unavailable' }; }

    if (!payload || payload.error) return { state: 'pending', reason: 'rpc_unavailable' };
    const tx = payload.result;
    if (!tx) return { state: 'pending', reason: 'not_finalized' };
    if (!tx.meta || tx.meta.err) return { state: 'rejected', reason: 'transaction_failed' };

    const message = tx.transaction && tx.transaction.message;
    const keys = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
    const signers = keys.filter(k => k && typeof k === 'object' && k.signer === true)
        .map(k => String(k.pubkey || ''));
    if (!signers.includes(wallet)) return { state: 'rejected', reason: 'wrong_signer' };

    const instructions = message && Array.isArray(message.instructions) ? message.instructions : [];
    const matches = instructions.filter(ix => {
        const parsed = ix && ix.parsed;
        const info = parsed && parsed.info;
        const tokenAmount = info && info.tokenAmount;
        return ix.program === 'spl-token' && parsed.type === 'transferChecked' && info && tokenAmount &&
            String(info.authority || '') === wallet &&
            String(info.destination || '') === contract.recipientAta &&
            String(info.mint || '') === contract.mint &&
            Number(tokenAmount.decimals) === contract.decimals &&
            String(tokenAmount.amount || '') === String(contract.amountBaseUnits);
    });
    return matches.length === 1
        ? { state: 'verified', slot: Number(tx.slot) || null }
        : { state: 'rejected', reason: 'transfer_contract_mismatch' };
}

function entitlementResponse(row, signature, sku) {
    return { success: true, state: row.status, sku,
        txSignature: signature, currency: row.currency,
        amountLamports: Number(row.expected_lamports), chainSlot: row.chain_slot,
        entitlementId: row.entitlement_id == null ? undefined : String(row.entitlement_id) };
}

function entitlementMatches(row, playerId, sku, network) {
    return !!row && row.wallet === playerId && row.sku === sku && row.network === network;
}

async function handler(req, res) {
    if (applyCors(req, res, 'POST, OPTIONS')) return;
    const ref = newRef();
    if (req.method !== 'POST') return quietFail(res, 400, AuthCode.METHOD_NOT_ALLOWED, ref);

    let rawBody;
    try { rawBody = (await readBodyExact(req, WALLET_MAX_BODY_BYTES)).buffer; }
    catch (_) { return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref); }
    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); }
    catch (_) { return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref); }

    const playerId = String(body.playerId || '').trim();
    const signature = String(body.txSignature || '').trim();
    const sku = String(body.sku || '').trim();
    const network = String(body.network || '').trim().toLowerCase();
    if (!playerId || !TX_SIG_RE.test(signature) || !sku || network !== 'devnet')
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);

    const contract = purchaseContract(network, sku);
    const url = rpcUrl(network);
    if (!contract || !url) return quietFail(res, 503, AuthCode.SERVER_ERROR, ref);

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

    const existing = await sql`
        SELECT entitlement_id, wallet, sku, network, status, currency, expected_lamports, chain_slot
        FROM purchase_entitlements WHERE tx_signature = ${signature} LIMIT 1`;
    if (existing.length) {
        const row = existing[0];
        if (!entitlementMatches(row, playerId, sku, network))
            return quietFail(res, 409, AuthCode.BAD_PAYLOAD, ref);
        return res.status(200).json(entitlementResponse(row, signature, sku));
    }

    const chain = await readFinalizedTransfer(url, signature, playerId, contract);
    if (chain.state === 'pending') {
        await logApiEvent(sql, playerId, 'purchase_verification_pending',
            { ref, sku, network, reason: chain.reason });
        return res.status(202).json({ success: true, state: 'pending', sku, txSignature: signature });
    }
    if (chain.state !== 'verified') {
        await logApiEvent(sql, playerId, 'purchase_verification_rejected',
            { ref, sku, network, reason: chain.reason });
        return res.status(400).json({ success: false, state: 'rejected', code: chain.reason, ref });
    }

    const inserted = await sql`
        INSERT INTO purchase_entitlements
            (tx_signature, wallet, sku, rail, network, currency, expected_lamports,
             observed_lamports, recipient, observed_recipient, chain_slot, status, verified_at)
        VALUES (${signature}, ${playerId}, ${sku}, 'solana', ${network}, ${contract.currency},
                ${contract.amountBaseUnits}, ${contract.amountBaseUnits}, ${contract.recipient},
                ${contract.recipientAta}, ${chain.slot}, 'verified', NOW())
        ON CONFLICT (tx_signature) DO NOTHING RETURNING entitlement_id`;
    // A wallet retry and the original request can verify the same finalized
    // signature concurrently. The UNIQUE constraint is the authority; losing
    // that harmless race must read back the winner, not tell an honest client
    // its already-recorded payment is a conflict.
    if (!inserted.length) {
        const raced = await sql`
            SELECT entitlement_id, wallet, sku, network, status, currency,
                   expected_lamports, chain_slot
            FROM purchase_entitlements WHERE tx_signature = ${signature} LIMIT 1`;
        if (!raced.length || !entitlementMatches(raced[0], playerId, sku, network))
            return quietFail(res, 409, AuthCode.BAD_PAYLOAD, ref);
        return res.status(200).json(entitlementResponse(raced[0], signature, sku));
    }

    await logApiEvent(sql, playerId, 'purchase_entitlement_created', { ref, sku, network });
    return res.status(200).json({ success: true, state: 'verified', sku,
        txSignature: signature, currency: contract.currency,
        amountLamports: contract.amountBaseUnits, chainSlot: chain.slot,
        entitlementId: String(inserted[0].entitlement_id) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { readFinalizedTransfer, rpcUrl, entitlementMatches, entitlementResponse };
