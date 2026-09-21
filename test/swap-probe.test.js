'use strict';

// =============================================================================
// Oracle for api/_lib/swap-quote-probe.js — WO-1902.
// -----------------------------------------------------------------------------
// THE ONE THING THIS SUITE EXISTS TO PIN: a dead swap dependency must come back
// as ok:false WITH A REASON, and must NEVER come back as a number, a zero or a
// blank. That is the exact failure this probe was built for — the v6 host went
// dead, the client rendered it as "Unknown Error", and the only revenue rail in
// the game was silently shut.
//
// Every case mocks fetch. Nothing here touches the network or the database.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    probeJupiterQuote, probeUrl, summarize,
    SKR_MINT, USDC_MINT, EVENT_NAME,
} = require('../api/_lib/swap-quote-probe');

const NOW = new Date('2026-09-20T18:00:00Z');

// A body shaped like the real lite-api v1 answer proven on 2026-09-20:
// HTTP 200, inAmount 19198375 (19.198375 USDC for 1000 SKR).
function liveBody(over) {
    return Object.assign({
        inputMint: USDC_MINT,
        outputMint: SKR_MINT,
        inAmount: '19198375',
        outAmount: '1000000000',
        swapMode: 'ExactOut',
        slippageBps: 50,
    }, over || {});
}

function okFetch(body, status) {
    return async () => ({
        ok: (status || 200) < 400,
        status: status || 200,
        text: async () => JSON.stringify(body),
    });
}

test('the probed URL is the ExactOut pair the client asks for, on the live host', () => {
    const u = probeUrl();
    assert.ok(u.startsWith('https://lite-api.jup.ag/swap/v1/quote?'), u);
    assert.ok(u.includes('inputMint=' + USDC_MINT));
    assert.ok(u.includes('outputMint=' + SKR_MINT));
    assert.ok(u.includes('amount=1000000000'));
    assert.ok(u.includes('swapMode=ExactOut'));
    assert.ok(u.includes('slippageBps=50'));
    // The dead host must never creep back in.
    assert.ok(!u.includes('quote-api.jup.ag'), 'the retired v6 host must not be probed');
    assert.ok(!u.includes('/v6/'), 'the retired v6 path must not be probed');
});

test('the persisted event name is stable — the history query joins on it', () => {
    assert.equal(EVENT_NAME, 'swap_quote_probe');
});

test('HTTP 200 with a v1 body is ok, and in_amount is parsed to USDC', async () => {
    let seenUrl = null;
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: async (url, init) => {
            seenUrl = String(url);
            assert.equal(init.method, 'GET');
            return { ok: true, status: 200, text: async () => JSON.stringify(liveBody()) };
        },
    });
    assert.equal(seenUrl, probeUrl());
    assert.equal(r.ok, true);
    assert.equal(r.http, 200);
    // 19198375 base units at 6 decimals.
    assert.equal(r.in_amount_usdc, 19.198375);
    assert.equal(r.error, null);
    assert.equal(r.checked_at, '2026-09-20T18:00:00.000Z');
    assert.equal(typeof r.latency_ms, 'number');
    assert.match(summarize(r), /^Jupiter quote: OK 19\.20 USDC\/1000 SKR$/);
});

test('DNS FAILURE — the incident itself — is ok:false and NAMES ENOTFOUND', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: async () => {
            throw Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND quote-api.jup.ag' },
            });
        },
    });
    assert.equal(r.ok, false);
    assert.equal(r.in_amount_usdc, null, 'a dead host must never yield a number');
    assert.equal(r.http, null);
    assert.match(r.error, /ENOTFOUND/);
    // "fetch failed" on its own is the server-side twin of "Unknown Error".
    assert.notEqual(r.error, 'fetch failed');
    assert.match(summarize(r), /^Jupiter quote: DOWN - /);
});

test('HTTP 400 is ok:false, keeps the status, and carries the body text', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: async () => ({
            ok: false,
            status: 400,
            text: async () => '{"errorCode":"NOT_SUPPORTED","error":"fee not supported"}',
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.http, 400);
    assert.equal(r.in_amount_usdc, null);
    assert.match(r.error, /HTTP 400/);
    assert.match(r.error, /NOT_SUPPORTED/);
});

test('a TIMEOUT is ok:false and says it timed out', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        timeoutMs: 10,
        fetch: (url, init) => new Promise((resolve, reject) => {
            // Reject the way fetch does when its signal aborts.
            init.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            });
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.in_amount_usdc, null);
    assert.equal(r.error, 'timeout after 10ms');
});

test('HTTP 200 carrying an ERROR OBJECT is a refusal, never a success', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: okFetch({ errorCode: 'ROUTE_NOT_FOUND', error: 'no route' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.http, 200);
    assert.equal(r.in_amount_usdc, null);
    assert.match(r.error, /ROUTE_NOT_FOUND/);
});

test('HTTP 200 with an unparseable body is ok:false, not an empty success', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: async () => ({ ok: true, status: 200, text: async () => '<html>504</html>' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.in_amount_usdc, null);
    assert.match(r.error, /did not parse/);
});

test('a 200 for the WRONG PAIR proves the host is alive and the SKR rail nothing', async () => {
    const r = await probeJupiterQuote({
        now: NOW,
        fetch: okFetch(liveBody({ outputMint: 'So11111111111111111111111111111111111111112' })),
    });
    assert.equal(r.ok, false);
    assert.equal(r.in_amount_usdc, null);
    assert.match(r.error, /not SKR/);
});

test('a 200 whose inAmount is missing or zero is ok:false, NEVER a $0 quote', async () => {
    for (const bad of [undefined, null, '', '0', 'abc']) {
        const r = await probeJupiterQuote({ now: NOW, fetch: okFetch(liveBody({ inAmount: bad })) });
        assert.equal(r.ok, false, 'inAmount ' + JSON.stringify(bad) + ' must not be ok');
        assert.equal(r.in_amount_usdc, null, 'a bad inAmount must never render as a price');
        assert.ok(r.error, 'a failure must always carry a reason');
    }
});

test('a runtime with no fetch is unread, and issues no call', async () => {
    // ⚠ NOT `fetch: null` — that falls through to globalThis.fetch and would
    // make this suite hit the real network. A non-function value forces the
    // same branch offline.
    const r2 = await probeJupiterQuote({ now: NOW, fetch: 'not a function' });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /fetch_unavailable/);
    assert.equal(r2.in_amount_usdc, null);
});

test('the probe NEVER throws, whatever fetch does', async () => {
    for (const boom of [
        async () => { throw new Error('plain'); },
        async () => ({ ok: true, status: 200, text: async () => { throw new Error('body gone'); } }),
        async () => null,
    ]) {
        const r = await probeJupiterQuote({ now: NOW, fetch: boom });
        assert.equal(r.ok, false);
        assert.equal(r.in_amount_usdc, null);
        assert.ok(r.error);
    }
});

test('summarize never invents a price for a failed probe', () => {
    assert.equal(summarize(null), 'Jupiter quote: NOT CHECKED');
    assert.equal(summarize({ ok: false, error: null }), 'Jupiter quote: DOWN - no reason recorded');
    assert.ok(!summarize({ ok: false, error: 'ENOTFOUND' }).includes('USDC'));
});
