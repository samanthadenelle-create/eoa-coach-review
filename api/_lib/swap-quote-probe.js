'use strict';

// =============================================================================
// api/_lib/swap-quote-probe.js — synthetic health probe for the SKR swap rail
// -----------------------------------------------------------------------------
// WO-1902. WHY THIS EXISTS, in one paragraph:
//
// The game's ONE revenue rail is a SKR pack purchase. When a player's SKR
// balance is short, Assets/_Modules/Web3/JupiterSwapService.cs asks Jupiter for
// an ExactOut quote and the wallet prompt only opens if that quote returns. On
// 2026-09-20 the hardcoded v6 aggregator host stopped resolving; UnityWebRequest
// surfaced the DNS failure as the useless string "Unknown Error", the purchase
// stopped, and NOTHING on the server said so. The Command Center could only show
// the SHAPE of the damage after the fact — 45 quotes issued, 3 consumed, 34
// expired unpaid — which reads exactly like "players changed their mind".
// Evidence: docs/proof/wo1901/trace-and-probe-2026-09-20.md.
//
// A funnel can only ever report a dependency that ALREADY died, from the
// footprints of players who already gave up. This probe asks the dependency
// itself, on a schedule, so a dead swap rail is NAMED within minutes.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────
// A NON-200, AN UNPARSEABLE BODY, A WRONG PAIR OR A TIMEOUT IS NEVER "FINE" AND
// NEVER A ZERO. It is ok:false with the error text, the same fail-loud contract
// api/_lib/applixir-reporting.js uses (a dead ad read prints COULD NOT READ,
// never $0.00). A health check that degrades to a plausible-looking number is
// worse than no health check, because it manufactures confidence.
//
// ⚠ A 200 IS NOT ENOUGH. Jupiter answers some refusals with HTTP 200 carrying an
// error object, so `ok` additionally requires: the body parsed, `outAmount`
// names the SKR mint we asked for, and `inAmount` is a finite number. Anything
// else is a DOWN with the reason attached.
//
// ⚠ NODE WRAPS DNS FAILURE AS TypeError('fetch failed') AND THAT STRING IS
// USELESS ON A CARD — it is the server-side twin of the "Unknown Error" that
// cost this rail its revenue in the first place. `err.cause.code` carries the
// real ENOTFOUND/ECONNREFUSED, so the cause is unwrapped and reported.
//
// Never throws. Callers: api/admin/stats.js (?view=command, live, read-only)
// and api/cron/swap-quote-probe.js (every 15 min, persists one row).
// Files under api/_lib/ are NOT routed by Vercel (leading underscore).
// =============================================================================

// The probed pair. Repointed to the lite-api v1 host that WO-1901 proved live
// on 2026-09-20 (HTTP 200, inAmount 19198375, access-control-allow-origin: *).
// This must stay the SAME host family the client calls — a probe against a
// different endpoint than the game uses proves nothing about the game.
const QUOTE_HOST = 'https://lite-api.jup.ag';
const QUOTE_PATH = '/swap/v1/quote';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';

// 1000 SKR at 9 decimals. ExactOut: "what does 1000 SKR cost in USDC", which is
// the exact question the client asks when a wallet is short for a pack.
const PROBE_OUT_AMOUNT = '1000000000';
const PROBE_OUT_SKR = 1000;
const SLIPPAGE_BPS = 50;

const USDC_DECIMALS = 6;
const DEFAULT_TIMEOUT_MS = 6000;

const EVENT_NAME = 'swap_quote_probe';

function probeUrl() {
    return QUOTE_HOST + QUOTE_PATH
        + '?inputMint=' + USDC_MINT
        + '&outputMint=' + SKR_MINT
        + '&amount=' + PROBE_OUT_AMOUNT
        + '&swapMode=ExactOut'
        + '&slippageBps=' + SLIPPAGE_BPS;
}

// Unwraps Node's fetch error onion. `TypeError: fetch failed` on its own names
// nothing; the cause carries ENOTFOUND / ECONNREFUSED / ECONNRESET, which is the
// difference between "the host is gone" (this incident) and "we were throttled".
function describeThrow(err, timeoutMs) {
    if (err && err.name === 'AbortError') return 'timeout after ' + timeoutMs + 'ms';
    const cause = err && err.cause;
    const code = cause && cause.code ? String(cause.code) : '';
    const causeMsg = cause && cause.message ? String(cause.message) : '';
    const top = err && err.message ? String(err.message) : String(err);
    if (code && causeMsg) return code + ': ' + causeMsg;
    if (code) return code + ': ' + top;
    if (causeMsg) return top + ': ' + causeMsg;
    return top;
}

function clip(s, n) {
    const str = String(s == null ? '' : s);
    // ASCII ellipsis on purpose: this text lands in the admin console, whose
    // served page is pinned 7-bit ASCII (test/command-center.test.js).
    return str.length > n ? str.slice(0, n) + '...' : str;
}

/**
 * Ask Jupiter for the synthetic ExactOut quote.
 *
 * @param {object} [opts]
 * @param {function} [opts.fetch]      injected for tests; defaults to globalThis.fetch
 * @param {Date|number} [opts.now]     injected for tests
 * @param {number} [opts.timeoutMs]    default 6000
 * @returns {Promise<{ok:boolean, http:number|null, in_amount_usdc:number|null,
 *                     latency_ms:number, checked_at:string, error:string|null}>}
 *          NEVER throws and NEVER returns a number it did not read.
 */
async function probeJupiterQuote(opts) {
    const options = opts || {};
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const checkedAt = (options.now instanceof Date ? options.now
        : (typeof options.now === 'number' ? new Date(options.now) : new Date())).toISOString();

    const fail = (error, http) => ({
        ok: false,
        http: http == null ? null : Number(http),
        in_amount_usdc: null,
        latency_ms: Date.now() - startedAt,
        checked_at: checkedAt,
        error: clip(error, 300),
    });

    if (typeof fetchImpl !== 'function') return fail('fetch_unavailable on this runtime', null);

    let ac = null;
    let timer = null;
    try {
        let signal;
        if (typeof AbortController === 'function') {
            ac = new AbortController();
            timer = setTimeout(function () { try { ac.abort(); } catch (_) { /* noop */ } }, timeoutMs);
            signal = ac.signal;
        }

        const res = await fetchImpl(probeUrl(), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: signal,
        });

        const http = Number(res && res.status);
        let text = '';
        try { text = await res.text(); } catch (_) { text = ''; }

        // ⛔ A NON-200 IS A DOWN, WITH THE BODY ATTACHED. The body is what told
        // WO-1901 that a platformFee quote POSTed to v1 /swap answers
        // NOT_SUPPORTED — a bare status code would have hidden that entirely.
        if (!res || !res.ok) {
            return fail('HTTP ' + (Number.isFinite(http) ? http : '?') + ': ' + clip(text, 200),
                Number.isFinite(http) ? http : null);
        }

        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
        if (!body || typeof body !== 'object') {
            return fail('HTTP 200 but the body did not parse as JSON: ' + clip(text, 200), http);
        }

        // A 200 carrying an error object is a refusal wearing a success suit.
        if (body.error || body.errorCode) {
            return fail('HTTP 200 refusal: ' + clip(body.errorCode || body.error, 200), http);
        }

        // The quote must be for the pair we asked about. A quote for a different
        // mint proves the host is alive and proves NOTHING about the SKR rail.
        if (body.outputMint && String(body.outputMint) !== SKR_MINT) {
            return fail('HTTP 200 but the quote is for outputMint ' + clip(body.outputMint, 60)
                + ', not SKR', http);
        }

        const inAmount = Number(body.inAmount);
        if (!Number.isFinite(inAmount) || inAmount <= 0) {
            return fail('HTTP 200 but inAmount is not a usable number: '
                + clip(body.inAmount, 60), http);
        }

        return {
            ok: true,
            http: http,
            in_amount_usdc: inAmount / Math.pow(10, USDC_DECIMALS),
            latency_ms: Date.now() - startedAt,
            checked_at: checkedAt,
            error: null,
        };
    } catch (err) {
        return fail(describeThrow(err, timeoutMs), null);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** One-line human summary — the exact sentence the Command Center card prints. */
function summarize(p) {
    if (!p) return 'Jupiter quote: NOT CHECKED';
    if (p.ok) {
        return 'Jupiter quote: OK ' + Number(p.in_amount_usdc).toFixed(2)
            + ' USDC/' + PROBE_OUT_SKR + ' SKR';
    }
    return 'Jupiter quote: DOWN - ' + (p.error || 'no reason recorded');
}

module.exports = {
    EVENT_NAME,
    PROBE_OUT_SKR,
    QUOTE_HOST,
    SKR_MINT,
    USDC_MINT,
    DEFAULT_TIMEOUT_MS,
    probeUrl,
    probeJupiterQuote,
    summarize,
};
