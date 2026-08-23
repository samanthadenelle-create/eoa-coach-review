'use strict';

// MON-1147 — authenticated, server-authoritative SKR purchase verification.
// WO-1158 — and the number it verifies against is now THE ONE THE SERVER QUOTED.
//
// ⛔ THE CHANGE THIS FILE CARRIES: for a real pack there is no constant to check.
// The amount is whatever the SERVER quoted at purchase time (purchase_quotes),
// looked up by the quote id the client presents. The client transfers exactly
// that; it does no arithmetic and it is authoritative for nothing.
//
// The two CANARIES are the deliberate exception and are untouched: their amount
// IS a protocol constant (a proof-of-rail, not a sale), so they still verify
// against api/_lib/purchase-catalog's pinned row, need no quote, and consult no
// rate. A live mainnet canary purchase succeeded against exactly those numbers.
const { neon } = require('@neondatabase/serverless');
const { AuthCode, authenticateGranting, WALLET_MAX_BODY_BYTES } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { logAuthReject, logApiEvent } = require('../_lib/audit');
const { purchaseContract, walletAllowed, isPinnedSku, contractFromQuoteRow,
    quoteValidAtPayment } = require('../_lib/purchase-catalog');

const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const QUOTE_REF_RE = /^[0-9a-f]{32}$/;

// Worded refusals. A money-path refusal that says only "rejected" sends the
// player to support and the next seat to the source. Each of these names the one
// thing that went wrong and states plainly whether anything was charged.
const QUOTE_MESSAGES = {
    quote_required:
        'This pack needs a fresh price from the server before it can be bought. ' +
        'Nothing has been charged. Reopen the store to get one.',
    quote_unknown:
        'We do not recognise that price quote. Nothing has been granted. ' +
        'Reopen the store for a fresh one.',
    quote_not_yours:
        'That price quote belongs to a different wallet, pack or network. Nothing has been granted.',
    quote_already_used:
        'That price quote has already been used for another payment. ' +
        'Reopen the store for a fresh one.',
    quote_expired:
        'The price quote had expired by the time this payment settled, so it was not ' +
        'granted automatically. The payment IS recorded and is queued for review — ' +
        'do not pay again.',
};

function rpcUrl(network) {
    if (network === 'devnet')
        return String(process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || '').trim() || null;
    if (network === 'mainnet-beta')
        return String(process.env.SOLANA_MAINNET_RPC_URL || '').trim() || null;
    return null;
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
    // ⚠ blockTime is WHEN THE PLAYER ACTUALLY PAID, and it is the only honest
    // clock for judging a quote's expiry. See QUOTE_SETTLEMENT_GRACE_SECONDS.
    const blockTimeMs = Number.isFinite(Number(tx.blockTime)) && Number(tx.blockTime) > 0
        ? Number(tx.blockTime) * 1000 : null;
    return matches.length === 1
        ? { state: 'verified', slot: Number(tx.slot) || null, blockTimeMs }
        : { state: 'rejected', reason: 'transfer_contract_mismatch' };
}

function entitlementResponse(row, signature, sku) {
    return { success: true, state: row.status, sku,
        txSignature: signature, network: row.network, currency: row.currency,
        amountLamports: Number(row.expected_lamports), chainSlot: row.chain_slot,
        entitlementId: row.entitlement_id == null ? undefined : String(row.entitlement_id) };
}

function entitlementMatches(row, playerId, sku, network) {
    return !!row && row.wallet === playerId && row.sku === sku && row.network === network;
}

/**
 * Is this persisted quote row usable for THIS request, before we look at chain?
 *
 * Pure on purpose — every refusal below is a case in test/purchases.verify.test.js
 * and none of them needs a database to prove.
 *
 * ⛔ EXPIRY IS NOT JUDGED HERE. It needs the transaction's blockTime, which we do
 * not have yet, and judging it by wall-clock would refuse an honest player whose
 * money has already moved. See evaluatePaidQuote.
 *
 * @returns {{ok:true}|{ok:false, code:string}}
 */
function evaluateQuoteRow(row, playerId, sku, network, signature) {
    if (!row) return { ok: false, code: 'quote_unknown' };
    if (String(row.wallet) !== playerId || String(row.sku) !== sku ||
        String(row.network) !== network)
        return { ok: false, code: 'quote_not_yours' };
    // SINGLE-USE. A quote already spent on a DIFFERENT signature is refused; the
    // SAME signature is an idempotent retry of the very payment it was issued for.
    if (row.consumed_tx && String(row.consumed_tx) !== signature)
        return { ok: false, code: 'quote_already_used' };
    if (!contractFromQuoteRow(row)) return { ok: false, code: 'quote_unknown' };
    return { ok: true };
}

/**
 * Was the quote still live at the moment the money actually moved?
 * @param row       the persisted quote
 * @param paidAtMs  the transaction's blockTime in ms, or null when the RPC omits it
 * @param nowMs     fallback clock when blockTime is unavailable
 */
function evaluatePaidQuote(row, paidAtMs, nowMs) {
    const expiresAtMs = new Date(row.expires_at).getTime();
    const paid = Number.isFinite(paidAtMs) && paidAtMs > 0 ? paidAtMs : nowMs;
    return quoteValidAtPayment(expiresAtMs, paid)
        ? { ok: true } : { ok: false, code: 'quote_expired' };
}

function quoteRejection(res, code, ref) {
    return res.status(400).json({ success: false, state: 'rejected', code,
        message: QUOTE_MESSAGES[code] || undefined, ref });
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
    const quoteId = String(body.quoteId || '').trim();
    // ⛔ NOTE WHAT IS *NOT* READ FROM THE BODY: an amount. There is no
    // client-supplied price anywhere on this path, by construction. A client that
    // invents one has nowhere to put it.
    if (!playerId || !TX_SIG_RE.test(signature) || !sku ||
        (network !== 'devnet' && network !== 'mainnet-beta'))
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);

    // MON002 is a single-owner canary, not a public Mainnet launch. Enforce the
    // allowlist at the authenticated backend boundary; a client-side gate alone
    // would only hide the button and could be bypassed by a crafted request.
    if (!walletAllowed(network, sku, playerId))
        return quietFail(res, 403, AuthCode.BAD_PAYLOAD, ref);

    const url = rpcUrl(network);
    if (!url) return quietFail(res, 503, AuthCode.SERVER_ERROR, ref);

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

    // ── Resolve the contract: a pinned canary constant, or the issued quote. ──
    const pinned = isPinnedSku(network, sku);
    let contract = null;
    let quote = null;
    if (pinned) {
        contract = purchaseContract(network, sku);
        if (!contract) return quietFail(res, 503, AuthCode.SERVER_ERROR, ref);
    } else {
        if (!QUOTE_REF_RE.test(quoteId)) return quoteRejection(res, 'quote_required', ref);
        const rows = await sql`
            SELECT quote_ref, wallet, sku, network, currency, amount_base_units, decimals,
                   mint, recipient, recipient_ata, usd_anchor, usd_rate, rate_source,
                   expires_at, consumed_at, consumed_tx
            FROM purchase_quotes WHERE quote_ref = ${quoteId} LIMIT 1`;
        quote = rows.length ? rows[0] : null;
        const usable = evaluateQuoteRow(quote, playerId, sku, network, signature);
        if (!usable.ok) {
            await logApiEvent(sql, playerId, 'purchase_quote_refused',
                { ref, sku, network, quoteId, reason: usable.code });
            return quoteRejection(res, usable.code, ref);
        }
        contract = contractFromQuoteRow(quote);
    }

    const chain = await readFinalizedTransfer(url, signature, playerId, contract);
    if (chain.state === 'pending') {
        await logApiEvent(sql, playerId, 'purchase_verification_pending',
            { ref, sku, network, reason: chain.reason });
        return res.status(202).json({ success: true, state: 'pending', sku, network,
            currency: contract.currency, txSignature: signature });
    }
    if (chain.state !== 'verified') {
        // ⚠ THIS IS THE TAMPERED-AMOUNT REFUSAL. The chain was checked against the
        // amount the SERVER issued, so a client that transferred anything else
        // lands here as transfer_contract_mismatch and is granted nothing.
        await logApiEvent(sql, playerId, 'purchase_verification_rejected',
            { ref, sku, network, quoteId: quoteId || null, reason: chain.reason,
              expectedBaseUnits: String(contract.amountBaseUnits) });
        return res.status(400).json({ success: false, state: 'rejected', code: chain.reason, ref });
    }

    // ── Expiry, judged against the moment the player actually paid. ──────────
    if (quote) {
        const timely = evaluatePaidQuote(quote, chain.blockTimeMs, Date.now());
        if (!timely.ok) {
            // The transfer matched the quoted contract exactly; only the clock is
            // wrong. The money HAS moved, so this is recorded for review rather
            // than dropped on the floor — a lost payment is worse than a slow one.
            await sql`
                INSERT INTO purchase_entitlements
                    (tx_signature, wallet, sku, rail, network, currency, expected_lamports,
                     observed_lamports, recipient, observed_recipient, chain_slot, status,
                     verified_at, quote_ref, usd_anchor, usd_rate, rate_source)
                VALUES (${signature}, ${playerId}, ${sku}, 'solana', ${network}, ${contract.currency},
                        ${contract.amountBaseUnits}, ${contract.amountBaseUnits}, ${contract.recipient},
                        ${contract.recipientAta}, ${chain.slot}, 'manual_review', NOW(),
                        ${quote.quote_ref}, ${quote.usd_anchor}, ${quote.usd_rate}, ${quote.rate_source})
                ON CONFLICT (tx_signature) DO NOTHING`;
            await logApiEvent(sql, playerId, 'purchase_quote_expired_after_payment',
                { ref, sku, network, quoteId, blockTimeMs: chain.blockTimeMs,
                  expiresAt: quote.expires_at });
            return quoteRejection(res, 'quote_expired', ref);
        }

        // SINGLE-USE, enforced atomically. The pre-check above is the fast, worded
        // refusal; THIS is the authority — two concurrent verifies for different
        // signatures cannot both win, whatever they each read a moment earlier.
        const consumed = await sql`
            UPDATE purchase_quotes
               SET consumed_at = COALESCE(consumed_at, NOW()), consumed_tx = ${signature}
             WHERE quote_ref = ${quoteId}
               AND (consumed_tx IS NULL OR consumed_tx = ${signature})
            RETURNING quote_ref`;
        if (!consumed.length) {
            await logApiEvent(sql, playerId, 'purchase_quote_refused',
                { ref, sku, network, quoteId, reason: 'quote_already_used' });
            return quoteRejection(res, 'quote_already_used', ref);
        }
    }

    // The row records AMOUNT, RATE, RATE SOURCE and QUOTE ID — the owner's
    // requirement verbatim ("they buy for 3 skr at X price so thats what resolves
    // on db"), and what makes revenue reporting truthful rather than reconstructed.
    const inserted = await sql`
        INSERT INTO purchase_entitlements
            (tx_signature, wallet, sku, rail, network, currency, expected_lamports,
             observed_lamports, recipient, observed_recipient, chain_slot, status, verified_at,
             quote_ref, usd_anchor, usd_rate, rate_source)
        VALUES (${signature}, ${playerId}, ${sku}, 'solana', ${network}, ${contract.currency},
                ${contract.amountBaseUnits}, ${contract.amountBaseUnits}, ${contract.recipient},
                ${contract.recipientAta}, ${chain.slot}, 'verified', NOW(),
                ${quote ? quote.quote_ref : null}, ${quote ? quote.usd_anchor : null},
                ${quote ? quote.usd_rate : null}, ${quote ? quote.rate_source : 'server-pinned'})
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

    await logApiEvent(sql, playerId, 'purchase_entitlement_created', { ref, sku, network,
        quoteId: quoteId || null, amountBaseUnits: String(contract.amountBaseUnits),
        rate: quote ? quote.usd_rate : null, rateSource: quote ? quote.rate_source : 'server-pinned' });
    return res.status(200).json({ success: true, state: 'verified', sku,
        txSignature: signature, network, currency: contract.currency,
        amountLamports: Number(contract.amountBaseUnits), chainSlot: chain.slot,
        entitlementId: String(inserted[0].entitlement_id) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { readFinalizedTransfer, rpcUrl, entitlementMatches, entitlementResponse,
    evaluateQuoteRow, evaluatePaidQuote, QUOTE_MESSAGES, QUOTE_REF_RE };
