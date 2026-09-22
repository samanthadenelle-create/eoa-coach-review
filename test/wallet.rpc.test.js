'use strict';

// =============================================================================
// test/wallet.rpc.test.js — the allow-listed Solana JSON-RPC proxy for web.
// -----------------------------------------------------------------------------
// WHAT THIS FILE IS DEFENDING. api/wallet/rpc.js is the only endpoint in this
// project that forwards a caller-named operation to a paid upstream service. Two
// properties make that safe, and both are silent when they break:
//
//   1. THE ALLOW-LIST IS THE ONLY METHOD LIST. A method the list does not name is
//      refused before the budget is spent and before any fetch happens.
//   2. THE OPTIONS OBJECT IS SERVER-AUTHORED. Whatever the caller sends for
//      encoding / commitment / skipPreflight / searchTransactionHistory is thrown
//      away. `skipPreflight:true` slipping through is the one that costs money:
//      preflight failing is what makes "nothing was charged" true on a swap or a
//      transfer that cannot succeed (SolanaWalletProvider.cs:1154 keeps it false
//      for the same reason).
//
// Both are asserted BEHAVIOURALLY — the upstream fetch is a double, and the tests
// read the body it was handed. A source grep for "skipPreflight" would have passed
// on a file that sends the caller's value.
//
// The route also enters test/api-cors-coverage.test.js and
// test/api-body-reader.test.js automatically (test/_api-route-scope.js enumerates
// the tree), so this file does NOT re-assert the preflight in isolation; it asserts
// the preflight ANSWER SHAPE for this route specifically, which those total suites
// deliberately do not pin.
//
//   node --test test/wallet.rpc.test.js
// ASCII only. CommonJS, to match every sibling under test/ and `npm test`.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = require('../api/wallet/rpc.js');
const T = route._test;

const RPC_URL = 'https://rpc.example.invalid/mainnet';
const ADDRESS = 'So11111111111111111111111111111111111111112';
// A base58-shaped account id, DELIBERATELY NOT THE LIVE TREASURY ATA. The proxy is a
// transport and validates SHAPE, not identity, so a real address buys this suite nothing
// and costs it something: WO-1956 deleted the client-side treasury constant because the
// address living in two places with no parity gate is what produces a paid-but-refused
// transfer, and SwapAsPaymentRegression's [treasury] pin scans for exactly these literals.
// A fixture carrying one is a copy waiting for that scan to widen.
const TREASURY_ATA = 'AtaFixture1111111111111111111111111111111111';
const SIGNATURE =
    '5Ug1NCZ8P2Vh4iC7kQ9mXxWpEoR3tYuD6aB2cF8gH1jKLmN4pQrS7tUvWxYz9AbCdEfGhJkLmNpQrStUvWxYz1Ab';

/** A budget table that always grants, unless told otherwise. */
function fakeSql(opts) {
    opts = opts || {};
    const calls = [];
    const fn = (a, ...rest) => {
        const tagged = Array.isArray(a) && Array.isArray(a.raw);
        const text = tagged ? a.join('?') : String(a);
        calls.push({ text: text, tagged: tagged });
        if (/promo_ip_budget/.test(text)) {
            if (opts.budgetError) return Promise.reject(opts.budgetError);
            const g = opts.grants == null ? 1 : opts.grants;
            return Promise.resolve([{ grants: g, total_grants: g }]);
        }
        return Promise.resolve([]);
    };
    fn.calls = calls;
    fn.budgetCalls = () => calls.filter((c) => /promo_ip_budget/.test(c.text));
    return fn;
}

/**
 * An upstream double. Records every call so a test can assert what was sent — and,
 * just as importantly, that NOTHING was sent on a refusal.
 */
function fakeFetch(reply) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: url, init: init, body: JSON.parse(init.body) });
        const r = typeof reply === 'function' ? reply(calls.length) : reply;
        if (r && r.throws) throw new Error('socket hang up');
        return {
            ok: r && r.ok === false ? false : true,
            status: (r && r.status) || 200,
            json: async () => (r && r.payload) || { jsonrpc: '2.0', id: 1, result: 'OK' },
        };
    };
    fn.calls = calls;
    return fn;
}

function makeRes() {
    const res = {
        statusCode: null, body: null, headers: {}, ended: false,
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        getHeader(k) { return this.headers[String(k).toLowerCase()]; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.ended = true; return this; },
        end(b) { this.ended = true; if (b !== undefined) this.body = b; return this; },
        send(b) { this.body = b; this.ended = true; return this; },
    };
    return res;
}

/**
 * A POST whose body is ALREADY PARSED and whose stream is SPENT — exactly how
 * Vercel's Node runtime hands a request over (test/api-body-reader.test.js:
 * `config.api.bodyParser:false` does not actually disable it there).
 */
function makeReq(body, headers) {
    const req = {
        method: 'POST',
        url: '/api/wallet/rpc',
        query: {},
        body: body,
        readableEnded: true,
        complete: true,
        headers: Object.assign({
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.7',
            origin: 'https://defenders-of-the-realm-v2-preview.vercel.app',
        }, headers || {}),
        on: () => req, once: () => req, removeListener: () => req, setEncoding: () => req,
    };
    return req;
}

async function run(body, opts) {
    opts = opts || {};
    const sql = opts.sql || fakeSql();
    const doFetch = opts.fetchImpl || fakeFetch(opts.reply);
    const handler = T.makeHandler({
        getSql: () => sql,
        fetchImpl: doFetch,
        rpcUrl: () => (opts.rpcUrl === undefined ? RPC_URL : opts.rpcUrl),
    });
    const res = makeRes();
    await handler(opts.req || makeReq(body), res);
    return { res: res, fetch: doFetch, sql: sql };
}

// =============================================================================
// 1. The allow-list is closed, and a refusal costs nothing
// =============================================================================

test('the allow-list names exactly the five methods the web pay path needs', () => {
    assert.deepEqual(T.ALLOWED_METHOD_NAMES.slice().sort(), [
        'getAccountInfo',
        'getLatestBlockhash',
        'getSignatureStatuses',
        'getTokenAccountBalance',
        'sendTransaction',
    ]);
});

test('a method off the list is refused, and NOTHING is forwarded upstream', async () => {
    for (const method of [
        'getProgramAccounts',      // the quota-burner
        'requestAirdrop',          // free money on devnet, nonsense on mainnet
        'simulateTransaction',
        'getBlock',
        'sendtransaction',         // case must not be a way past the list
        '',
    ]) {
        const r = await run({ method: method, params: [] });
        assert.equal(r.res.statusCode, 400, method + ' was not refused');
        assert.equal(r.res.body.ok, false);
        assert.equal(r.res.body.code, 'METHOD_NOT_ALLOWED');
        assert.equal(r.fetch.calls.length, 0, method + ' reached the upstream RPC');
    }
});

test('a prototype-chain name is not a method (hasOwnProperty, not `in`)', async () => {
    for (const method of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        const r = await run({ method: method, params: [] });
        assert.equal(r.res.statusCode, 400, method + ' resolved through the prototype');
        assert.equal(r.res.body.code, 'METHOD_NOT_ALLOWED');
        assert.equal(r.fetch.calls.length, 0);
    }
});

test('a refused method does not spend a unit of the IP budget', async () => {
    const sql = fakeSql();
    const r = await run({ method: 'getProgramAccounts', params: [] }, { sql: sql });
    assert.equal(r.res.statusCode, 400);
    assert.equal(sql.budgetCalls().length, 0,
        'a malformed request cost a household a unit - WO-1440 placement rule');
});

// =============================================================================
// 2. Per-method parameter validation
// =============================================================================

test('getAccountInfo demands a base58 address', async () => {
    for (const bad of [undefined, '', 'not base58 at all!!', '0OIl' + 'x'.repeat(30), 42, { a: 1 }]) {
        const r = await run({ method: 'getAccountInfo', params: [bad] });
        assert.equal(r.res.statusCode, 400, JSON.stringify(bad) + ' was accepted');
        assert.equal(r.res.body.code, 'BAD_PARAMS');
        assert.equal(r.fetch.calls.length, 0);
    }
    const ok = await run({ method: 'getAccountInfo', params: [TREASURY_ATA] });
    assert.equal(ok.res.statusCode, 200);
});

test('getSignatureStatuses caps the list and demands signature-shaped strings', async () => {
    const tooMany = new Array(T.MAX_SIGNATURES_PER_CALL + 1).fill(SIGNATURE);
    for (const bad of [[], tooMany, [ADDRESS], ['nope'], SIGNATURE, null]) {
        const r = await run({ method: 'getSignatureStatuses', params: [bad] });
        assert.equal(r.res.statusCode, 400, JSON.stringify(bad) + ' was accepted');
        assert.equal(r.fetch.calls.length, 0);
    }
    const ok = await run({ method: 'getSignatureStatuses', params: [[SIGNATURE]] });
    assert.equal(ok.res.statusCode, 200);
});

test('sendTransaction demands bounded base64', async () => {
    const tooLong = 'A'.repeat(T.MAX_TX_BASE64_CHARS + 1);
    for (const bad of ['', tooLong, 'not base64 ***', 12345, null, undefined]) {
        const r = await run({ method: 'sendTransaction', params: [bad] });
        assert.equal(r.res.statusCode, 400, String(bad).slice(0, 40) + ' was accepted');
        assert.equal(r.fetch.calls.length, 0);
    }
});

// =============================================================================
// 3. The options object is SERVER-AUTHORED — the property that costs money
// =============================================================================

test('a caller cannot set skipPreflight, and cannot reach the node with its own options', async () => {
    const r = await run({
        method: 'sendTransaction',
        params: ['AQABAgMEBQY=', {
            skipPreflight: true,               // the dangerous one
            preflightCommitment: 'processed',
            encoding: 'base58',
            maxRetries: 999,
            sigVerify: false,
        }],
    });
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.fetch.calls.length, 1);
    const sent = r.fetch.calls[0].body;
    assert.equal(sent.method, 'sendTransaction');
    assert.deepEqual(sent.params[1], {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: T.COMMITMENT,
        maxRetries: 3,
    });
    assert.equal(sent.params.length, 2, 'a caller-supplied extra param reached the node');
});

test('getSignatureStatuses never searches transaction history on the caller word', async () => {
    const r = await run({
        method: 'getSignatureStatuses',
        params: [[SIGNATURE], { searchTransactionHistory: true }],
    });
    assert.equal(r.res.statusCode, 200);
    assert.deepEqual(r.fetch.calls[0].body.params[1], { searchTransactionHistory: false });
});

test('getLatestBlockhash ignores caller params entirely', async () => {
    const r = await run({ method: 'getLatestBlockhash', params: [{ commitment: 'processed' }, 'junk'] });
    assert.equal(r.res.statusCode, 200);
    assert.deepEqual(r.fetch.calls[0].body.params, [{ commitment: T.COMMITMENT }]);
});

test('every forwarded call is a well-formed JSON-RPC 2.0 envelope to the configured url', async () => {
    const r = await run({ method: 'getAccountInfo', params: [TREASURY_ATA] });
    const call = r.fetch.calls[0];
    assert.equal(call.url, RPC_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.body.jsonrpc, '2.0');
    assert.equal(call.body.method, 'getAccountInfo');
    assert.deepEqual(call.body.params, [TREASURY_ATA, { encoding: 'base64', commitment: T.COMMITMENT }]);
});

// =============================================================================
// 4. Pass-through shape, and the failure shapes
// =============================================================================

test('a successful call returns { ok, method, result } with the node result verbatim', async () => {
    const result = { context: { slot: 371231234 }, value: { lamports: 2039280, owner: 'Tokenkeg' } };
    const r = await run({ method: 'getAccountInfo', params: [TREASURY_ATA] },
        { reply: { payload: { jsonrpc: '2.0', id: 1, result: result } } });
    assert.equal(r.res.statusCode, 200);
    assert.deepEqual(r.res.body, { ok: true, method: 'getAccountInfo', result: result });
});

test('a node-level JSON-RPC error is forwarded as RPC_ERROR with code + message, nothing else', async () => {
    const r = await run({ method: 'sendTransaction', params: ['AQABAgMEBQY='] }, {
        reply: {
            payload: {
                jsonrpc: '2.0', id: 1,
                error: {
                    code: -32002,
                    message: 'Transaction simulation failed: Blockhash not found',
                    data: { logs: ['should not be forwarded'], accounts: null },
                },
            },
        },
    });
    assert.equal(r.res.statusCode, 502);
    assert.equal(r.res.body.ok, false);
    assert.equal(r.res.body.code, 'RPC_ERROR');
    assert.equal(r.res.body.error.code, -32002);
    assert.match(r.res.body.error.message, /Blockhash not found/);
    assert.equal(r.res.body.error.data, undefined, 'node error data leaked to the caller');
    assert.ok(r.res.body.ref, 'no correlation ref');
});

test('an upstream HTTP failure and a transport throw both read RPC_TRANSPORT', async () => {
    const http = await run({ method: 'getLatestBlockhash', params: [] },
        { reply: { ok: false, status: 503 } });
    assert.equal(http.res.statusCode, 502);
    assert.equal(http.res.body.code, 'RPC_TRANSPORT');

    const thrown = await run({ method: 'getLatestBlockhash', params: [] }, { reply: { throws: true } });
    assert.equal(thrown.res.statusCode, 502);
    assert.equal(thrown.res.body.code, 'RPC_TRANSPORT');
});

test('no upstream url configured is 503 RPC_UNAVAILABLE, not a crash', async () => {
    const r = await run({ method: 'getLatestBlockhash', params: [] }, { rpcUrl: null });
    assert.equal(r.res.statusCode, 503);
    assert.equal(r.res.body.code, 'RPC_UNAVAILABLE');
    assert.equal(r.fetch.calls.length, 0);
});

test('a non-POST is refused and a malformed body is BAD_BODY', async () => {
    const get = await run(null, { req: Object.assign(makeReq(null), { method: 'GET', body: undefined }) });
    assert.equal(get.res.statusCode, 400);
    assert.equal(get.res.body.code, 'METHOD_NOT_ALLOWED');

    const junk = await run(null, { req: Object.assign(makeReq('this is not json'), {}) });
    assert.equal(junk.res.statusCode, 400);
    assert.equal(junk.res.body.code, 'BAD_BODY');
});

// =============================================================================
// 5. CORS preflight + rate limit
// =============================================================================

test('an OPTIONS preflight is answered 204 with the shared CORS headers', async () => {
    const handler = T.makeHandler({ getSql: () => fakeSql(), fetchImpl: fakeFetch(), rpcUrl: () => RPC_URL });
    const res = makeRes();
    await handler({ method: 'OPTIONS', url: '/', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(String(res.headers['access-control-allow-methods']), /POST/);
    assert.equal(res.ended, true);
});

test('an exhausted IP budget refuses 429 and never reaches the node', async () => {
    const r = await run({ method: 'sendTransaction', params: ['AQABAgMEBQY='] },
        { sql: fakeSql({ grants: 100000 }) });
    assert.equal(r.res.statusCode, 429);
    assert.equal(r.res.body.code, 'RATE_LIMITED');
    assert.equal(r.fetch.calls.length, 0);
});

test('an UNREADABLE budget table serves anyway - the pay path fails OPEN, loudly', async () => {
    // The nonce rail's argument, for the same reason: a missing table must not take
    // the one revenue rail on web offline. failClosed:false is asserted behaviourally
    // because the flag itself is one word in a call site nobody re-reads.
    const r = await run({ method: 'getLatestBlockhash', params: [] },
        { sql: fakeSql({ budgetError: new Error('relation "promo_ip_budget" does not exist') }) });
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.fetch.calls.length, 1);
});

// =============================================================================
// 6. The list lives in ONE place
// =============================================================================

test('api/wallet/rpc.js is the only file under api/ that names these RPC methods as a list', () => {
    // A second copy of the allow-list — in a client, a helper or a doc — is the
    // duplicated-state failure CLAUDE.md sec.2/sec.5/sec.16 each describe: the
    // copies drift and the drift is silent. The proxy's list is the list.
    const apiDir = path.join(__dirname, '..', 'api');
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.js')) continue;
            if (p.endsWith(path.join('wallet', 'rpc.js'))) continue;
            const src = fs.readFileSync(p, 'utf8');
            // Three or more of the five names in one file is a second list, not an
            // incidental single call (skr-staking legitimately names getAccountInfo).
            const hits = T.ALLOWED_METHOD_NAMES.filter((m) => src.includes(m)).length;
            if (hits >= 3) offenders.push(path.relative(path.join(__dirname, '..'), p));
        }
    };
    walk(apiDir);
    assert.deepEqual(offenders, [], 'a second RPC method list exists at: ' + offenders.join(', '));
});
