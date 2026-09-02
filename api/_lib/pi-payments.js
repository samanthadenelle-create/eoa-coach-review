'use strict';

// =============================================================================
// api/_lib/pi-payments.js — WO-1318. The Pi (U2A) money rail.
// -----------------------------------------------------------------------------
// ⛔ THIS IS A SECOND RAIL, NOT A SECOND STORE. It reuses, verbatim and by
// require(), everything the SKR rail already decided:
//
//   * the USD ANCHOR LADDER          -> purchase-catalog.usdAnchor(sku)
//   * the 24h-LOW rate policy         -> the same CoinGecko markets endpoint and
//                                        the same `low_24h` field, for pi-network
//   * FAIL-CLOSED pricing             -> rate unavailable => NO quote, ever a 503,
//                                        never a stale or invented number
//   * the QUOTE TABLE                 -> purchase_quotes (one row, single-use, TTL'd)
//   * the GRANT LEDGER                -> purchase_entitlements (rail = 'pi')
//
// The only genuinely new artefact is `pi_payments`, the rail's LIFECYCLE ledger —
// exactly the shape `google_play_purchases` already has for the Play rail. It is
// not an entitlement and it grants nothing; it records approve -> complete so a
// replayed callback can be recognised as a replay.
//
// ⛔ THE SECURITY INVARIANT, AND WHERE IT IS ENFORCED.
// The client NEVER sets the amount. `Pi.createPayment({ amount })` runs on the
// player's device, so the number in the Pi payment object is CLIENT-SUPPLIED and
// must be treated as hostile. The server:
//   1. computes the amount from the USD anchor and the live rate,
//   2. persists it against a quote id (purchase_quotes.amount_base_units),
//   3. re-reads the payment FROM PI at approve, and refuses to approve unless the
//      payment's amount equals the persisted one EXACTLY (integer compare in base
//      units — never a float ==),
//   4. re-checks the same thing at complete, because the money has moved by then
//      and a wrong grant cannot be taken back.
// A forged amount therefore never reaches `POST /v2/payments/:id/approve`, which
// is the only signature that can move a Pioneer's Pi.
//
// ⛔ THE API KEY. `PI_NETWORK_API_KEY` is server-only. It is read here, sent only
// in an `Authorization: Key ...` header to api.minepi.com, and is never returned,
// logged, echoed in an error, or written to a file. Every helper below that
// touches it returns a CODE, never the upstream body.
// =============================================================================

const { usdAnchor, QUOTE_TTL_SECONDS } = require('./purchase-catalog');

// ── What is sellable on the Pi rail ─────────────────────────────────────────
// ⭐ ONE SKU, DELIBERATELY (owner ruling, WO-1318). No purchase has ever
// completed in this game, so the rail is proven on a single pack rather than 28
// that could all fail identically. Widening this list is a product decision, not
// a refactor: every SKU here must also carry a USD anchor in purchase-catalog.
const PI_SKUS = Object.freeze(['hearth-spark']);

// The `network` value the Pi rail writes to purchase_quotes / purchase_entitlements.
// Pi has one production network from our side; testnet vs mainnet is a property of
// the API KEY and the Pi Browser, not of anything we choose per request.
const PI_NETWORK = 'pi';
const PI_CURRENCY = 'PI';
const PI_RAIL = 'pi';

// Pi/Stellar amounts carry 7 decimal places. Persisted as an INTEGER number of
// base units so no comparison on the money path is ever a float compare.
const PI_DECIMALS = 7;

// ⚠ ROUNDING — A PRICING DECISION, RECORDED HERE ON PURPOSE (WO-1318).
// The SKR rail rounds UP to a WHOLE SKR because an SPL transfer moves an integer
// number of base units and the client mirrors that integer verbatim. Pi's SDK
// takes a DECIMAL amount, so there is no such constraint, and ceil()-ing to a
// whole Pi at ~$0.09/Pi would add up to ~1.8% to a $4.99 pack for no technical
// reason at all.
//
// So the Pi rail keeps the DIRECTION of the SKR policy — always at least spot,
// never less — at a precision that costs the player nothing: CEIL TO 0.01 Pi
// (worst case ~$0.001 over). The 24h-LOW rate source is unchanged and is the
// owner's ruling verbatim ("just like with SKR we're gonna do the floor of 24
// hour window").
//
// ⛔ THIS IS THE ONE PLACE THE PI PRICE IS DECIDED. Changing it changes a price.
const PI_QUOTE_PRECISION = 2;                    // decimal places we ceil to
const PI_MEMO = 'Echoes of Elarion - Hearth Spark';

// ── The rate oracle — SERVER SIDE, CACHED, FAIL-CLOSED ──────────────────────
// Mirrors purchase-catalog.fetchSkrUsdRate line for line, against pi-network.
// ⛔ NO FALLBACK PRICE. Charging a wrong price is worse than not charging.
const RATE_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=pi-network';
const RATE_SOURCE = 'coingecko:pi-network:low_24h';
const RATE_CACHE_MS = 120_000;
const RATE_TIMEOUT_MS = 8_000;

let _rateCache = null;      // { usdPerPi, source, fetchedAtMs }
let _rateInFlight = null;

// ── Pi platform API ─────────────────────────────────────────────────────────
const PI_API_ROOT = 'https://api.minepi.com/v2';
const PI_TIMEOUT_MS = 10_000;

/**
 * The server-only Pi API key, or null.
 *
 * ⛔ NEVER RETURNED TO A CALLER THAT ANSWERS THE CLIENT, never logged, never in
 * an error string. `configured()` below is the only thing an endpoint should ask.
 */
function piApiKey() {
    const key = String(process.env.PI_NETWORK_API_KEY || '').trim();
    return key.length ? key : null;
}

/** Dormant-unless-configured, exactly like the Play rail's configurationReady. */
function configured() {
    return piApiKey() != null;
}

/**
 * Read the PI/USD rate, server side, cached, FAIL-CLOSED.
 *
 * Returns null when the market is unreachable or answers nonsense. There is
 * deliberately no stale fallback and no catalog fallback — the caller must refuse
 * the quote with a worded reason (PURCHASE_RATE_UNAVAILABLE, 503).
 */
async function fetchPiUsdRate(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (_rateCache && now - _rateCache.fetchedAtMs < RATE_CACHE_MS) return _rateCache;
    if (_rateInFlight) return _rateInFlight;

    _rateInFlight = (async () => {
        let controller = null;
        let timer = null;
        try {
            if (typeof AbortController === 'function') {
                controller = new AbortController();
                timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, RATE_TIMEOUT_MS);
            }
            const response = await fetch(RATE_URL, {
                headers: { Accept: 'application/json' },
                signal: controller ? controller.signal : undefined,
            });
            if (!response || !response.ok) return null;
            const rows = await response.json();
            if (!Array.isArray(rows) || rows.length === 0) return null;
            const low = Number(rows[0] && rows[0].low_24h);
            if (!Number.isFinite(low) || low <= 0) return null;
            _rateCache = { usdPerPi: low, source: RATE_SOURCE, fetchedAtMs: now };
            return _rateCache;
        } catch (_) {
            return null;      // fail closed — never a stale or invented price
        } finally {
            if (timer) clearTimeout(timer);
            _rateInFlight = null;
        }
    })();
    return _rateInFlight;
}

/** Test hook: drop the cached rate so a case can drive the fetch path. */
function _resetRateCache() { _rateCache = null; _rateInFlight = null; }

/**
 * The Pi amount for a USD price at a given rate.
 *
 * @returns {{amount:number, amountBaseUnits:string}|null}
 *          `amount` is what the client passes to Pi.createPayment (<= 2 dp);
 *          `amountBaseUnits` is the exact integer the server compares against.
 */
function quotePiAmount(usd, usdPerPi) {
    if (!(typeof usd === 'number' && Number.isFinite(usd) && usd > 0)) return null;
    if (!(typeof usdPerPi === 'number' && Number.isFinite(usdPerPi) && usdPerPi > 0)) return null;
    const scale = Math.pow(10, PI_QUOTE_PRECISION);
    const scaled = Math.ceil((usd / usdPerPi) * scale);
    if (!Number.isSafeInteger(scaled) || scaled <= 0) return null;
    const amount = scaled / scale;
    // Integer math for the persisted figure: a float multiply by 10^7 is not exact.
    const amountBaseUnits =
        (BigInt(scaled) * (10n ** BigInt(PI_DECIMALS - PI_QUOTE_PRECISION))).toString();
    return { amount, amountBaseUnits };
}

/**
 * Convert an amount as Pi reports it (a decimal number or a decimal string) into
 * the SAME integer base units the quote row holds.
 *
 * ⛔ STRING-PARSED, NOT FLOAT-MULTIPLIED. `54.73 * 1e7` is 547299999.9999999 on
 * some inputs, and this value decides whether we approve a payment.
 *
 * @returns {string|null} decimal integer string, or null when unparseable.
 */
function amountToBaseUnits(raw) {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(text)) return null;
    const [whole, frac = ''] = text.split('.');
    if (frac.length > PI_DECIMALS) {
        // More precision than Pi itself carries: refuse rather than round a price.
        if (!/^0+$/.test(frac.slice(PI_DECIMALS))) return null;
    }
    const padded = (frac + '0'.repeat(PI_DECIMALS)).slice(0, PI_DECIMALS);
    const units = BigInt(whole) * (10n ** BigInt(PI_DECIMALS)) + BigInt(padded || '0');
    return units.toString();
}

/** Base units back to the decimal the client and Pi speak in. */
function baseUnitsToAmount(baseUnits) {
    const text = String(baseUnits == null ? '' : baseUnits);
    if (!/^\d+$/.test(text)) return null;
    return Number(BigInt(text)) / Math.pow(10, PI_DECIMALS);
}

/** Is this SKU sellable on the Pi rail, and does it carry a USD anchor? */
function piSkuUsd(sku) {
    if (!PI_SKUS.includes(String(sku || ''))) return null;
    return usdAnchor(sku);
}

/**
 * The un-persisted body of a Pi quote. Pure given a rate — the caller persists it
 * and stamps the id/expiry, exactly as purchases/quote.js does for SKR.
 */
function buildPiQuoteBody(sku, rate) {
    const usd = piSkuUsd(sku);
    if (usd == null || !rate || !(rate.usdPerPi > 0)) return null;
    const amount = quotePiAmount(usd, rate.usdPerPi);
    if (!amount) return null;
    return {
        sku, network: PI_NETWORK, currency: PI_CURRENCY,
        amount: amount.amount,                  // what Pi.createPayment is given
        amountBaseUnits: amount.amountBaseUnits, // what the server compares
        decimals: PI_DECIMALS,
        usdAnchor: usd,
        memo: PI_MEMO,
        rate: rate.usdPerPi,
        rateSource: rate.source,
    };
}

// ── The Pi platform calls ───────────────────────────────────────────────────

/**
 * One server-to-server call to Pi.
 *
 * ⛔ The key goes ONLY into the Authorization header. `result.detail` carries a
 * short, non-secret upstream marker for the audit row — never the header, never
 * the raw body verbatim beyond a truncated status line.
 *
 * @returns {{ok:true, body:object}|{ok:false, status:number, code:string}}
 */
async function piCall(method, path, payload) {
    const key = piApiKey();
    if (!key) return { ok: false, status: 503, code: 'PI_NOT_CONFIGURED' };
    let controller = null;
    let timer = null;
    try {
        if (typeof AbortController === 'function') {
            controller = new AbortController();
            timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, PI_TIMEOUT_MS);
        }
        const response = await fetch(`${PI_API_ROOT}${path}`, {
            method,
            headers: Object.assign(
                { Accept: 'application/json', Authorization: `Key ${key}` },
                payload ? { 'Content-Type': 'application/json' } : {}),
            body: payload ? JSON.stringify(payload) : undefined,
            signal: controller ? controller.signal : undefined,
        });
        let body = null;
        try { body = await response.json(); } catch (_) { body = null; }
        if (!response.ok)
            return { ok: false, status: response.status, code: 'PI_UPSTREAM_' + response.status,
                body: body || null };
        return { ok: true, body: body || {} };
    } catch (_) {
        return { ok: false, status: 503, code: 'PI_UNREACHABLE' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const getPayment = (paymentId) => piCall('GET', `/payments/${encodeURIComponent(paymentId)}`, null);
const approvePayment = (paymentId) =>
    piCall('POST', `/payments/${encodeURIComponent(paymentId)}/approve`, {});
const completePayment = (paymentId, txid) =>
    piCall('POST', `/payments/${encodeURIComponent(paymentId)}/complete`, { txid });

// ── Validation: the payment Pi shows us vs the quote WE issued ──────────────

// Worded refusals. A money-path refusal that says only "rejected" sends the
// player to support and the next seat to the source.
const PI_MESSAGES = Object.freeze({
    PI_QUOTE_UNKNOWN:
        'We do not recognise that price quote. Nothing has been charged. ' +
        'Reopen the store for a fresh one.',
    PI_QUOTE_NOT_YOURS:
        'That price quote belongs to a different Pi account or pack. Nothing has been charged.',
    PI_QUOTE_ALREADY_USED:
        'That price quote has already been used for another payment. ' +
        'Reopen the store for a fresh one.',
    PI_QUOTE_EXPIRED:
        'That price had expired before the payment was made. Nothing has been charged. ' +
        'Reopen the store for a fresh price.',
    PI_AMOUNT_MISMATCH:
        'The payment amount does not match the price we quoted, so it was not approved. ' +
        'Nothing has been charged. Reopen the store and try again.',
    PI_MEMO_MISMATCH:
        'That payment was not created for this pack, so it was not approved. Nothing has been charged.',
    PI_PAYMENT_UNKNOWN:
        'Pi does not recognise that payment. Nothing has been charged.',
    PI_TXID_MISMATCH:
        'The transaction on that payment does not match the one reported. Nothing has been granted.',
    PI_NOT_CONFIGURED:
        'Pi purchases are not switched on right now. Nothing has been charged.',
    PI_UNREACHABLE:
        'We could not reach Pi just now. Nothing has been charged. Try again in a moment.',
    PURCHASE_RATE_UNAVAILABLE:
        'We could not read a live Pi price just now, so we will not quote one. ' +
        'Nothing has been charged. Try again in a moment.',
    PI_SKU_UNAVAILABLE:
        'That pack is not on sale on Pi right now. Nothing has been charged.',
    PI_TOKEN_REJECTED:
        'Pi could not confirm that sign-in. Nothing has been charged. Sign in again and retry.',
    PI_PAYMENT_CANCELLED:
        'That payment was cancelled, so nothing was charged.',
    // ⛔ THE ONE CODE THAT MEANS "YOUR MONEY MOVED AND WE DID NOT GRANT". It must
    // never be worded as a plain rejection: the remedy is a human, not a retry,
    // and the player must be told NOT to pay again.
    PI_MANUAL_REVIEW:
        'Your payment went through, but we could not match it to a purchase automatically. ' +
        'It IS recorded and queued for review - do NOT pay again. Quote the reference below.',
    PI_RECORD_FAILED:
        'Your payment went through, but we could not finish recording it just now. ' +
        'You have NOT been charged twice and nothing is lost - do not pay again. ' +
        'Try once more in a moment; if it keeps happening, quote the reference below.',
});

/**
 * Is this persisted quote row usable for THIS request, before Pi is consulted?
 * Pure on purpose — every refusal is a case in test/pi-payments.test.js.
 *
 * @param row       a purchase_quotes row (snake_case, as read back)
 * @param playerId  the 'pi-<uid>' subject the quote must belong to
 * @param sku       the pack
 * @param paymentId the payment claiming it (a quote is single-use PER PAYMENT;
 *                  the SAME payment re-presenting it is an idempotent retry)
 * @returns {{ok:true}|{ok:false, code:string}}
 */
function evaluatePiQuoteRow(row, playerId, sku, paymentId) {
    if (!row) return { ok: false, code: 'PI_QUOTE_UNKNOWN' };
    if (String(row.network) !== PI_NETWORK || String(row.currency) !== PI_CURRENCY)
        return { ok: false, code: 'PI_QUOTE_NOT_YOURS' };
    if (String(row.wallet) !== String(playerId) || String(row.sku) !== String(sku))
        return { ok: false, code: 'PI_QUOTE_NOT_YOURS' };
    if (row.consumed_tx && String(row.consumed_tx) !== String(paymentId))
        return { ok: false, code: 'PI_QUOTE_ALREADY_USED' };
    if (!/^\d+$/.test(String(row.amount_base_units || '')) ||
        String(row.amount_base_units) === '0')
        return { ok: false, code: 'PI_QUOTE_UNKNOWN' };
    return { ok: true };
}

/**
 * ⭐ THE AMOUNT GATE. This is the function that makes a forged client amount
 * harmless, and it runs BEFORE anything is approved.
 *
 * `payment` is what Pi reports for the payment the CLIENT created, so every field
 * in it is ultimately client-chosen. `row` is what the SERVER persisted. They must
 * agree on all four load-bearing facts, and the amount is compared as INTEGER base
 * units — never `54.73 === 54.73` on floats that arrived by different routes.
 *
 * @returns {{ok:true, toAddress:string|null}|{ok:false, code:string}}
 */
function validatePaymentAgainstQuote(payment, row, quoteId, playerId) {
    if (!payment || typeof payment !== 'object') return { ok: false, code: 'PI_PAYMENT_UNKNOWN' };
    const meta = payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {};

    // ⛔ THE AMOUNT. Anything but exact equality is refused and NOT approved.
    const observed = amountToBaseUnits(payment.amount);
    if (observed == null || observed !== String(row.amount_base_units))
        return { ok: false, code: 'PI_AMOUNT_MISMATCH' };

    // The quote this payment claims must be the quote we looked up.
    if (String(meta.quoteId || '') !== String(quoteId))
        return { ok: false, code: 'PI_QUOTE_NOT_YOURS' };
    if (String(meta.sku || '') !== String(row.sku))
        return { ok: false, code: 'PI_QUOTE_NOT_YOURS' };

    // ⭐ THE IDENTITY BINDING. `user_uid` is Pi's own statement of who is paying —
    // it cannot be set by the client. A quote minted against a claimed uid is
    // therefore only ever spendable BY THAT PIONEER, which is what keeps an
    // unauthenticated quote request from being an authorization hole.
    const paidBy = piPlayerId(payment.user_uid);
    if (!paidBy || paidBy !== String(playerId))
        return { ok: false, code: 'PI_QUOTE_NOT_YOURS' };

    if (String(payment.memo || '') !== PI_MEMO) return { ok: false, code: 'PI_MEMO_MISMATCH' };

    const toAddress = payment.to_address ? String(payment.to_address) : null;
    return { ok: true, toAddress };
}

/** Pi's uid, prefixed so it can never be mistaken for a proven wallet or play- id. */
function piPlayerId(uid) {
    const clean = String(uid == null ? '' : uid).trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) return null;
    return 'pi-' + clean;
}

/** The uid back out of a 'pi-<uid>' subject. */
function piUidOf(playerId) {
    const text = String(playerId || '');
    return text.startsWith('pi-') ? text.slice(3) : null;
}

/**
 * Confirm a Pi access token and learn WHO it belongs to, from Pi itself.
 *
 * This is the same trust boundary api/pi/verify.js already uses (GET /v2/me with
 * the PLAYER's bearer token — no API key involved). It is OPTIONAL on the quote
 * path and, when supplied, it upgrades the quote's subject from CLAIMED to PROVEN.
 *
 * @returns {{ok:true, uid:string, username:string|null}|{ok:false, code:string}}
 */
async function verifyPiAccessToken(accessToken) {
    const token = String(accessToken || '').trim();
    if (!token) return { ok: false, code: 'PI_TOKEN_MISSING' };
    let controller = null;
    let timer = null;
    try {
        if (typeof AbortController === 'function') {
            controller = new AbortController();
            timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, PI_TIMEOUT_MS);
        }
        const response = await fetch(`${PI_API_ROOT}/me`, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: controller ? controller.signal : undefined,
        });
        if (!response || !response.ok) return { ok: false, code: 'PI_TOKEN_REJECTED' };
        const me = await response.json();
        if (!me || !me.uid) return { ok: false, code: 'PI_TOKEN_REJECTED' };
        return { ok: true, uid: String(me.uid), username: me.username ? String(me.username) : null };
    } catch (_) {
        return { ok: false, code: 'PI_UNREACHABLE' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const TXID_RE = /^[A-Za-z0-9]{16,128}$/;
const QUOTE_REF_RE = /^[0-9a-f]{32}$/;

module.exports = {
    PI_SKUS, PI_NETWORK, PI_CURRENCY, PI_RAIL, PI_DECIMALS, PI_QUOTE_PRECISION, PI_MEMO,
    PI_MESSAGES, PI_API_ROOT, RATE_SOURCE, QUOTE_TTL_SECONDS,
    PAYMENT_ID_RE, TXID_RE, QUOTE_REF_RE,
    configured, fetchPiUsdRate, quotePiAmount, amountToBaseUnits, baseUnitsToAmount,
    piSkuUsd, buildPiQuoteBody, piCall, getPayment, approvePayment, completePayment,
    evaluatePiQuoteRow, validatePaymentAgainstQuote, verifyPiAccessToken, piPlayerId, piUidOf, _resetRateCache,
};
