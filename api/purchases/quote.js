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
//   LIST  { network, playerId? }        → every sold SKU's exact SKR amount and
//                                         USD anchor, for the shelf. NO DB rows,
//                                         NO quote ids — it binds nothing. It
//                                         exists so the CARD can print an exact
//                                         SKR figure without the client ever
//                                         doing arithmetic (§5).
//
//     ⛔ LIST IS PUBLIC AND UNAUTHENTICATED (WO-1190). A shelf shows prices;
//     eligibility is checked at the till. Before this, LIST demanded a proven
//     wallet — so merely OPENING the store minted a backend session from a wallet
//     signature, for a read that binds nothing and charges nothing. It also ran
//     every candidate through walletAllowed(), so with MAINNET_SALES_ENABLED off
//     a non-owner got an EMPTY array and every card read "Price unavailable".
//
//     What LIST returns now is the PUBLIC LADDER: what anyone could buy. Each row
//     carries an ADVISORY `sellable` + `sellableReason` computed against the
//     CLAIMED (unproven) playerId, so the card can print the price and disable the
//     buy control with a WORDED reason instead of going blank.
//
//     ⛔ THE ADVISORY GRANTS NOTHING. Forging playerId here flips a client-side
//     button and reaches no further: walletAllowed / MAINNET_SALES_ENABLED / the
//     canary's stricter gate are UNCHANGED and still enforced on the BINDING quote
//     below (and again at /verify), where the identity is PROVEN. Loosening the
//     list must never loosen what can be sold.
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
// Shown ON the card, beside a real price, when this viewer cannot buy that row.
// ⛔ Never a blank shelf, never a bare "Price unavailable", never colour alone.
const SALES_CLOSED_MESSAGE =
    'Purchases are not open on this network yet. You can browse; buying unlocks when sales go live.';
const CANARY_NOT_SELLABLE_MESSAGE =
    'This is a rail test, not a pack for sale.';
const SHORTFALL_DISCOUNT_BPS = 2000;
const DISCOUNT_WINDOW_DAYS = 7;
const SHORTFALL_REASON_HINT = 'repair_shortfall';
const SHORTFALL_REASON_SERVER = 'repair_shortfall';

function quoteRef() { return crypto.randomBytes(16).toString('hex'); }

/**
 * DISPLAY-ONLY sellability for one shelf row.
 *
 * ⛔ ADVISORY, NOT AUTHORIZATION. It is computed from the CLAIMED playerId on an
 * unauthenticated LIST, so it is only ever good enough to word a disabled button.
 * The authority is walletAllowed() on the BINDING quote (below, after
 * authenticateGranting) and again at /verify. This function calls the SAME
 * walletAllowed, so the shelf's wording cannot drift from the real gate — but it
 * can never widen it, because it issues nothing.
 *
 * @returns {string|null} null when sellable; otherwise a player-readable reason.
 */
function sellableReasonFor(network, sku, wallet, pinned) {
    if (walletAllowed(network, sku, wallet)) return null;
    return pinned ? CANARY_NOT_SELLABLE_MESSAGE : SALES_CLOSED_MESSAGE;
}

function discountBpsForReason(reasonHint, discountedRecently) {
    return reasonHint === SHORTFALL_REASON_HINT && discountedRecently === false
        ? SHORTFALL_DISCOUNT_BPS : null;
}

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
        discountBps: body.discountBps,
        discountLabel: body.discountLabel,
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
    // Logged hint, never authorization. Forging it buys the same single-window
    // discount as a genuine shortfall and cannot summon another one.
    const reasonHint = String(body.reason || '').trim().toLowerCase();
    // ⛔ playerId is REQUIRED for a binding quote (it is who the quote is issued
    // to) and OPTIONAL for the public LIST — a browser has no wallet yet.
    if (network !== 'devnet' && network !== 'mainnet-beta')
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);
    if (sku && !playerId)
        return quietFail(res, 400, AuthCode.BAD_PAYLOAD, ref);
    if (sku && !walletAllowed(network, sku, playerId))
        return quietFail(res, 403, AuthCode.BAD_PAYLOAD, ref);

    let sql = null;
    try { sql = neon(process.env.DATABASE_URL); }
    catch (_) {
        // The public shelf must not go blank because the audit database is away —
        // LIST persists nothing and reads nothing from it. The money path still
        // fails closed: without sql there is no auth and no quote row.
        if (sku) return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);
    }

    // A quote is a commitment to a price, on the money path. It is issued to a
    // PROVEN wallet, never a claimed one — the same bar the grant path uses.
    //
    // ⛔ THE LIST DELIBERATELY SKIPS THIS (WO-1190) and NOTHING ELSE DOES. Browsing
    // is a read that binds nothing; requiring a proven wallet here is what made
    // opening the store pop a signature prompt. Every path that issues, grants or
    // persists remains behind authenticateGranting.
    if (sku) {
        let auth;
        try { auth = await authenticateGranting(sql, req, rawBody, playerId); }
        catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
        if (!auth.ok) {
            await logAuthReject(sql, req, { code: auth.code, ref, identity: auth.identity,
                mode: auth.mode, detail: auth.detail });
            return quietFail(res, 401, auth.code, ref);
        }
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
        if (sql && playerId)
            await logApiEvent(sql, playerId, 'purchase_quote_refused',
                { ref, sku: sku || null, network, reason: 'rate_unavailable' });
        return res.status(503).json({ ok: false, code: 'PURCHASE_RATE_UNAVAILABLE',
            message: RATE_UNAVAILABLE_MESSAGE, ref });
    }

    // ── LIST mode: display prices. Binds nothing, persists nothing. ──────────
    if (!sku) {
        const rows = [];
        // ⛔ THE SOLD LADDER IS LISTED UNFILTERED — this is the public ladder, what
        // ANYONE could buy. The walletAllowed() filter that used to sit here is now
        // an ADVISORY FIELD instead of a deletion, because deleting the row deleted
        // the price with it: with MAINNET_SALES_ENABLED off a non-owner received an
        // empty array and every card read "Price unavailable" with no badge and no
        // message. A shelf with no prices explains nothing; a priced card with a
        // disabled button and a sentence explains everything. Nothing is sellable
        // that was sellable before — see sellableReasonFor().
        for (const candidate of quotableSkus(network)) {
            const built = buildQuoteBody(network, candidate, rate);
            if (!built) continue;
            const reason = sellableReasonFor(network, candidate, playerId, false);
            rows.push(wireQuote(built, { quoteId: null, expiresAt: null,
                sellable: reason == null, sellableReason: reason }));
        }
        // ⚠ The canaries stay FILTERED, and that is not an oversight. A canary is a
        // proof-of-rail, not a sale, so it is NOT part of the public ladder — it
        // must not appear on a stranger's shelf as a 1-SKR "pack". It surfaces only
        // for a claimed wallet that already passes its own stricter gate, and the
        // binding quote re-checks that against a PROVEN wallet.
        for (const candidate of pinnedSkus(network)) {
            if (sellableReasonFor(network, candidate, playerId, true) != null) continue;
            const contract = purchaseContract(network, candidate);
            if (contract) rows.push(Object.assign(wirePinned(contract),
                { sellable: true, sellableReason: null }));
        }
        return res.status(200).json({ success: true, mode: 'list', network,
            rate: rate.usdPerSkr, rateSource: rate.source, prices: rows });
    }

    // ── QUOTE mode: one binding, single-use, expiring row. ───────────────────
    const wantsShortfallDiscount = reasonHint === SHORTFALL_REASON_HINT;
    let discountedRecently = true;
    if (wantsShortfallDiscount) {
        try {
            const prior = await sql`
                SELECT EXISTS (
                    SELECT 1 FROM purchase_quotes
                    WHERE wallet = ${playerId}
                      AND discount_bps IS NOT NULL
                      AND issued_at >= NOW() - (${DISCOUNT_WINDOW_DAYS} * INTERVAL '1 day')
                ) AS issued`;
            discountedRecently = !prior || !prior.length || prior[0].issued === true;
        } catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
    }
    let discountBps = discountBpsForReason(reasonHint, discountedRecently);
    let built = buildQuoteBody(network, sku, rate, discountBps);
    if (!built) {
        await logApiEvent(sql, playerId, 'purchase_quote_refused',
            { ref, sku, network, reason: 'contract_unavailable' });
        return res.status(503).json({ ok: false, code: 'PURCHASE_SKU_UNAVAILABLE',
            message: SKU_UNAVAILABLE_MESSAGE, ref });
    }

    const quoteId = quoteRef();
    let inserted;
    try {
        if (discountBps != null) {
            // Serializable predicate authority: simultaneous requests that both observe an empty
            // window cannot both commit. A serialization loser fails closed and may retry at the
            // ordinary price after the winner is visible.
            const discountedTx = await sql.transaction([sql`
                INSERT INTO purchase_quotes
                    (quote_ref, wallet, sku, network, currency, amount_base_units, decimals,
                     mint, recipient, recipient_ata, usd_anchor, usd_rate, rate_source,
                     discount_bps, discount_reason, expires_at)
                SELECT ${quoteId}, ${playerId}, ${sku}, ${network}, ${built.currency},
                       ${built.amountBaseUnits}, ${built.decimals}, ${built.mint},
                       ${built.recipient}, ${built.recipientAta}, ${built.usdAnchor},
                       ${built.rate}, ${built.rateSource}, ${discountBps},
                       ${SHORTFALL_REASON_SERVER},
                       NOW() + (${QUOTE_TTL_SECONDS} * INTERVAL '1 second')
                WHERE NOT EXISTS (
                    SELECT 1 FROM purchase_quotes
                    WHERE wallet = ${playerId}
                      AND discount_bps IS NOT NULL
                      AND issued_at >= NOW() - (${DISCOUNT_WINDOW_DAYS} * INTERVAL '1 day'))
                RETURNING quote_ref, expires_at`], { isolationLevel: 'Serializable' });
            inserted = discountedTx[0];
        }
        if (!inserted || !inserted.length) {
            // Already in-window or lost a concurrent race: issue an ordinary quote.
            discountBps = null;
            built = buildQuoteBody(network, sku, rate, null);
            inserted = await sql`
                INSERT INTO purchase_quotes
                    (quote_ref, wallet, sku, network, currency, amount_base_units, decimals,
                     mint, recipient, recipient_ata, usd_anchor, usd_rate, rate_source,
                     discount_bps, discount_reason, expires_at)
                VALUES (${quoteId}, ${playerId}, ${sku}, ${network}, ${built.currency},
                        ${built.amountBaseUnits}, ${built.decimals}, ${built.mint},
                        ${built.recipient}, ${built.recipientAta}, ${built.usdAnchor},
                        ${built.rate}, ${built.rateSource}, NULL, NULL,
                        NOW() + (${QUOTE_TTL_SECONDS} * INTERVAL '1 second'))
                RETURNING quote_ref, expires_at`;
        }
    } catch (_) { return quietFail(res, 500, AuthCode.SERVER_ERROR, ref); }
    if (!inserted || !inserted.length) return quietFail(res, 500, AuthCode.SERVER_ERROR, ref);

    // ⚠ Third-party rate source = a third-party dependency on the money path.
    // WHICH source and WHICH value backed this quote is logged here AND stored on
    // the row, so a disputed charge can be reconstructed months later.
    await logApiEvent(sql, playerId, 'purchase_quote_issued', { ref, sku, network,
        quoteId, amountBaseUnits: built.amountBaseUnits, usdAnchor: built.usdAnchor,
        rate: built.rate, rateSource: built.rateSource, discountBps: built.discountBps,
        discountReason: built.discountBps != null ? SHORTFALL_REASON_SERVER : null,
        reasonHint: reasonHint || null });

    return res.status(200).json({ success: true, mode: 'quote',
        quote: wireQuote(built, { quoteId,
            expiresAt: new Date(inserted[0].expires_at).toISOString() }) });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { wireQuote, wirePinned, RATE_UNAVAILABLE_MESSAGE, SKU_UNAVAILABLE_MESSAGE,
    SALES_CLOSED_MESSAGE, CANARY_NOT_SELLABLE_MESSAGE, sellableReasonFor,
    SHORTFALL_DISCOUNT_BPS, DISCOUNT_WINDOW_DAYS, SHORTFALL_REASON_HINT,
    discountBpsForReason };
