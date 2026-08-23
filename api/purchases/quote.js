'use strict';

// =============================================================================
// POST /api/purchases/quote — WO-1158. THE SERVER DECIDES THE NUMBER.
// -----------------------------------------------------------------------------
// A pack is priced in USD and PAID in SKR, so the SKR amount depends on the rate
// at the moment of purchase. Before this endpoint the CLIENT resolved that rate
// and the SERVER checked the transfer against a hardcoded constant.
//
// ⛔ A CLIENT-RESOLVED PRICE AND A SERVER-PINNED CONSTANT CANNOT BOTH BE RIGHT.
// The moment the market moves the client sends N and the server expects M, and
// /verify runs AFTER settlement — so the purchase fails with the money already
// gone and nothing granted. The trigger is a market move, which is not a deploy,
// so nobody is watching when it fires.
//
// TWO MODES, ONE ENDPOINT:
//
//   LIST  { playerId, network }         → every sold SKU's exact SKR amount and
//                                         USD anchor, for the shelf. NO DB rows,
//                                         NO quote ids — it binds nothing. It
//                                         exists so the CARD can print an exact
//                                         SKR figure without the client ever
//                                         doing arithmetic (§5).
//
//   QUOTE { playerId, network, sku }    → ONE binding, single-use, expiring quote
//                                         persisted to purchase_quotes. This is
//                                         the artefact /verify checks the chain
//                                         against. The client transfers exactly
//                                         `amountBaseUnits` and nothing else.
//
// The canaries are neither: their amount is a PROTOCOL CONSTANT (proof-of-rail,
// not a sale), so they answer `pinned: true` with no quote id and no rate. That
// is the "canary SKUs still work unchanged" acceptance criterion, in code.
//
// ⛔ THE ORACLE FAILS CLOSED. Rate unavailable → 503 with a worded reason, never
// a stale value and never the catalog figure. Charging a made-up number is worse
// than refusing to sell.
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { AuthCode, authenticateGranting, WALLET_MAX_BODY_BYTES } = require('../_lib/wallet-auth');
const { applyCors, newRef, quietFail, readBodyExact } = require('../_lib/http');
const { logAuthReject, logApiEvent } = require('../_lib/audit');
const { buildQuoteBody, fetchSkrUsdRate, isPinnedSku, pinnedSkus, purchaseContract,
    quotableSkus, usdAnchor, walletAllowed, QUOTE_TTL_SECONDS } = require('../_lib/purchase-catalog');

// Worded, player-readable refusals. Quiet ≠ mute: a refusal on the money path
// must say WHY, or the player is left staring at a dead button (§3).
const RATE_UNAVAILABLE_MESSAGE =
    'We could not read a live SKR price just now, so we will not quote one. ' +
    'Nothing has been charged. Try again in a moment.';
const SKU_UNAVAILABLE_MESSAGE =
    'That pack is not on sale on this network right now. Nothing has been charged.';

function quoteRef() { return crypto.randomBytes(16).toString('hex'); }

/** The wire shape of one priced row. Same field names in both modes on purpose. */
function wireQuote(body, extra) {
    return Object.assign({
        sku: body.sku,
        network: body.network,
        currency: body.currency,
        amountBaseUnits: body.amountBaseUnits,   // STRING — the exact integer to transfer
        skrAmount: body.skrAmount,               // whole SKR, for display only
        decimals: body.decimals,
        mint: body.mint,
        recipient: body.recipient,
        recipientAta: body.recipientAta,
        usdAnchor: body.usdAnchor,
        rate: body.rate,
        rateSource: body.rateSource,
        pinned: false,
    }, extra || {});
}

/** A canary's fixed contract, dressed in the same wire shape. No rate, no quote id. */
function wirePinned(contract) {
    return {
        sku: contract.sku,
        network: contract.network,
        currency: contract.currency,
        amountBaseUnits: String(contract.amountBaseUnits),
        skrAmount: Number(contract.amountBaseUnits) / Math.pow(10, contract.decimals),
        decimals: contract.decimals,
        mint: contract.mint,
        recipient: contract.recipient,
        recipientAta: contract.recipientAta,
        usdAnchor: usdAnchor(contract.sku),
        rate: null,
        rateSource: 'server-pinned',
        pinned: true,
        quoteId: null,
        expiresAt: null,
    };
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
    const network = String(body.network || '').trim().toLowerCase();
    const sku = String(body.sku || '').trim();          // absent ⇒ LIST mode
    if (!playerId || (network !== 'devnet' && network !== 'mainnet-beta'))
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);
    if (sku && !walletAllowed(network, sku, playerId))
        return quietFail(res, 403, AuthCode.BAD_PAYLOAD, ref);

    let sql;
    try { sql = neon(process.env.DATABASE_URL); }
    catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }

    // A quote is a commitment to a price, on the money path. It is issued to a
    // PROVEN wallet, never a claimed one — the same bar the grant path uses.
    let auth;
    try { auth = await authenticateGranting(sql, req, rawBody, playerId); }
    catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
    if (!auth.ok) {
        await logAuthReject(sql, req, { code: auth.code, ref, identity: auth.identity,
            mode: auth.mode, detail: auth.detail });
        return quietFail(res, 401, auth.code, ref);
    }

    // ── The canaries: a protocol constant, not a sale. No rate is consulted. ──
    if (sku && isPinnedSku(network, sku)) {
        const contract = purchaseContract(network, sku);
        if (!contract) return quietFail(res, 503, AuthCode.SERVER_ERROR, ref);
        return res.status(200).json({ success: true, mode: 'quote', quote: wirePinned(contract) });
    }

    if (sku && usdAnchor(sku) == null)
        return res.status(404).json({ ok: false, code: 'PURCHASE_SKU_UNAVAILABLE',
            message: SKU_UNAVAILABLE_MESSAGE, ref });

    // ── The rate. FAIL CLOSED. ───────────────────────────────────────────────
    const rate = await fetchSkrUsdRate();
    if (!rate) {
        await logApiEvent(sql, playerId, 'purchase_quote_refused',
            { ref, sku: sku || null, network, reason: 'rate_unavailable' });
        return res.status(503).json({ ok: false, code: 'PURCHASE_RATE_UNAVAILABLE',
            message: RATE_UNAVAILABLE_MESSAGE, ref });
    }

    // ── LIST mode: display prices. Binds nothing, persists nothing. ──────────
    if (!sku) {
        const rows = [];
        for (const candidate of quotableSkus(network)) {
            if (!walletAllowed(network, candidate, playerId)) continue;
            const built = buildQuoteBody(network, candidate, rate);
            if (built) rows.push(wireQuote(built, { quoteId: null, expiresAt: null }));
        }
        // The canaries still belong on the shelf, at their pinned amount.
        for (const candidate of pinnedSkus(network)) {
            if (!walletAllowed(network, candidate, playerId)) continue;
            const contract = purchaseContract(network, candidate);
            if (contract) rows.push(wirePinned(contract));
        }
        return res.status(200).json({ success: true, mode: 'list', network,
            rate: rate.usdPerSkr, rateSource: rate.source, prices: rows });
    }

    // ── QUOTE mode: one binding, single-use, expiring row. ───────────────────
    const built = buildQuoteBody(network, sku, rate);
    if (!built) {
        await logApiEvent(sql, playerId, 'purchase_quote_refused',
            { ref, sku, network, reason: 'contract_unavailable' });
        return res.status(503).json({ ok: false, code: 'PURCHASE_SKU_UNAVAILABLE',
            message: SKU_UNAVAILABLE_MESSAGE, ref });
    }

    const quoteId = quoteRef();
    let inserted;
    try {
        inserted = await sql`
            INSERT INTO purchase_quotes
                (quote_ref, wallet, sku, network, currency, amount_base_units, decimals,
                 mint, recipient, recipient_ata, usd_anchor, usd_rate, rate_source, expires_at)
            VALUES (${quoteId}, ${playerId}, ${sku}, ${network}, ${built.currency},
                    ${built.amountBaseUnits}, ${built.decimals}, ${built.mint},
                    ${built.recipient}, ${built.recipientAta}, ${built.usdAnchor},
                    ${built.rate}, ${built.rateSource},
                    NOW() + (${QUOTE_TTL_SECONDS} * INTERVAL '1 second'))
            RETURNING quote_ref, expires_at`;
    } catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
    if (!inserted || !inserted.length) return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);

    // ⚠ Third-party rate source = a third-party dependency on the money path.
    // WHICH source and WHICH value backed this quote is logged here AND stored on
    // the row, so a disputed charge can be reconstructed months later.
    await logApiEvent(sql, playerId, 'purchase_quote_issued', { ref, sku, network,
        quoteId, amountBaseUnits: built.amountBaseUnits, usdAnchor: built.usdAnchor,
        rate: built.rate, rateSource: built.rateSource });

    return res.status(200).json({ success: true, mode: 'quote',
        quote: wireQuote(built, { quoteId,
            expiresAt: new Date(inserted[0].expires_at).toISOString() }) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { wireQuote, wirePinned, RATE_UNAVAILABLE_MESSAGE, SKU_UNAVAILABLE_MESSAGE };
