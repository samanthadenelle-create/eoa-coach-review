'use strict';

// =============================================================================
// test/webgl-wallet-connect.test.js — WO-1958.
// -----------------------------------------------------------------------------
// ⭐ THE POINT OF THIS FILE: it proves the Jupiter connect STATE MACHINE without
// a single npm package on disk.
//
// The shipping bundle needs @reown/appkit + @reown/appkit-adapter-solana +
// @reown/appkit-wallet-button, which are ESM-only, multi-megabyte, and NOT
// installed in this repo today. `wallet-connect.core.js` therefore takes those
// three constructors as INJECTED dependencies, and this file runs it in a vm
// realm against fakes. So the half that can actually be got wrong — which outcome
// produces which reason code — is executed, not grepped.
//
// ⛔ WHAT IT IS GUARDING. WO-1957 section 0: the Solana SDK's WebGL path reports a
// successful REDIRECT and a player CANCEL with the same words (`Login cancelled`),
// and that ambiguity cost a day. Every terminal state here must carry its OWN
// reason code, and these tests fail if two collapse into one.
//
//   node --test test/webgl-wallet-connect.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const PI = path.join(root, 'Assets', 'WebGLTemplates', 'Pi');
const XNFT = path.join(root, 'Assets', 'WebGLTemplates', 'xNFT');
const CORE_PATH = path.join(PI, 'wallet-connect.core.js');
const SRC_PATH = path.join(PI, 'wallet-connect.src.js');

// The WalletConnect-explorer facts this whole ticket rests on, queried at
// explorer-api.walletconnect.com/v3/wallets?search=jupiter on 2026-09-22.
// Hardcoded here ON PURPOSE: if a future edit changes the id, this fails, which is
// the only thing standing between us and an `includeWalletIds` that silently
// matches nothing and renders an EMPTY wallet list.
const JUPITER_EXPLORER_ID =
    '0ef262ca2a56b88d179c93a21383fee4e135bd7bc6680e5c2356ff8e38301037';
const JUPITER_SLUG = 'jupiter';

function loadCore() {
    const sandbox = { module: { exports: {} }, console };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), sandbox, { filename: CORE_PATH });
    return sandbox.module.exports;
}

// A fake Reown trio. `behaviour` decides what walletButton.connect() does, which is
// the ONLY thing the machine branches on.
function fakeDeps(behaviour) {
    const seen = { appKitOptions: null, connectedWallet: null, closed: 0 };
    const appKit = {
        close() { seen.closed += 1; },
        getAddress() { return behaviour.appKitAddress || ''; },
        getWalletProvider() { return behaviour.provider || null; },
        disconnect() { seen.disconnected = true; }
    };
    return {
        seen,
        deps: {
            createAppKit(options) { seen.appKitOptions = options; return appKit; },
            SolanaAdapter: function SolanaAdapter(cfg) { seen.adapterConfig = cfg; },
            createAppKitWalletButton(cfg) {
                seen.walletButtonConfig = cfg;
                return {
                    connect(wallet) {
                        seen.connectedWallet = wallet;
                        return behaviour.connect();
                    }
                };
            },
            solanaNetwork: { id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }
        }
    };
}

function make(behaviour, overrides) {
    const core = loadCore();
    const f = fakeDeps(behaviour);
    const machine = core.createEoaWalletConnect(Object.assign({
        projectId: 'test-project-id',
        deps: f.deps,
        trace() {},
        timeoutMs: 50
    }, overrides || {}));
    return { core, machine, seen: f.seen };
}

// -----------------------------------------------------------------------------

test('WO-1958: the core loads standalone and exposes the proven Jupiter ids', () => {
    const core = loadCore();
    assert.equal(core.JUPITER_WALLET, JUPITER_SLUG);
    assert.equal(core.JUPITER_EXPLORER_ID, JUPITER_EXPLORER_ID);
    assert.equal(core.JUPITER_EXPLORER_ID.length, 64,
        'the explorer id is 64 hex chars; a truncated one matches NO wallet and renders an empty list');
});

test('WO-1958: no projectId REFUSES by name, and never opens anything', async () => {
    const { machine, seen } = make({ connect: () => Promise.resolve({ address: 'never' }) },
                                   { projectId: '' });
    const snap = await machine.connect();
    assert.equal(snap.state, 'refused');
    assert.equal(snap.reason, 'no-project-id');
    assert.equal(seen.appKitOptions, null, 'AppKit must not be constructed without a projectId');
    assert.match(snap.detail, /reown\.config\.json/);
});

test('WO-1958: a missing bundle refuses with no-bundle, distinct from no-project-id', async () => {
    const core = loadCore();
    const machine = core.createEoaWalletConnect({ projectId: 'p', deps: {}, trace() {} });
    const snap = await machine.connect();
    assert.equal(snap.reason, 'no-bundle');
});

test('WO-1958: a successful connect reports connected + the address', async () => {
    const { machine, seen } = make({
        connect: () => Promise.resolve({ address: 'Grf9pk1Qs5JUPITERFAKEADDRESS', chainId: 'solana' })
    });
    const snap = await machine.connect();
    assert.equal(snap.state, 'connected');
    assert.equal(snap.reason, 'connected');
    assert.equal(snap.address, 'Grf9pk1Qs5JUPITERFAKEADDRESS');
    assert.equal(machine.address(), 'Grf9pk1Qs5JUPITERFAKEADDRESS');
    assert.equal(seen.connectedWallet, JUPITER_SLUG);
    assert.ok(seen.closed >= 1, 'the modal is closed once an account lands');
});

test('WO-1958: a bare string result is accepted too (older ParsedCaipAddress shapes)', async () => {
    const { machine } = make({ connect: () => Promise.resolve('BareStringAddress') });
    const snap = await machine.connect();
    assert.equal(snap.state, 'connected');
    assert.equal(snap.address, 'BareStringAddress');
});

test('WO-1958: the wallet list is PINNED to Jupiter, by the full explorer id', async () => {
    const { machine, seen } = make({ connect: () => Promise.resolve({ address: 'A' }) });
    await machine.connect();
    // Arrays built inside the vm realm have a DIFFERENT Array prototype, so
    // deepStrictEqual fails on values that are identical. Compare the contents.
    assert.deepEqual(Array.from(seen.appKitOptions.includeWalletIds), [JUPITER_EXPLORER_ID]);
    assert.deepEqual(Array.from(seen.appKitOptions.featuredWalletIds), [JUPITER_EXPLORER_ID]);
    assert.equal(seen.walletButtonConfig.namespace, 'solana',
        'the wallet button must be scoped to solana or it resolves the wrong chain adapter');
    assert.equal(seen.appKitOptions.projectId, 'test-project-id');
});

// ⛔ THE LOAD-BEARING TEST OF THIS FILE.
test('WO-1958: a closed modal is CANCELLED, a silent app is TIMEOUT, a throw is FAILED - three distinct codes', async () => {
    const closed = make({ connect: () => Promise.resolve(null) });
    const a = await closed.machine.connect();
    assert.equal(a.reason, 'cancelled');
    assert.match(a.detail, /closed without an approved account/);

    const silent = make({ connect: () => new Promise(() => {}) });
    const b = await silent.machine.connect();
    assert.equal(b.reason, 'timeout');
    assert.match(b.detail, /universal link/,
        'the timeout sentence must name the real cause: Jupiter registers no universal link, ' +
        'so an uninstalled app swallows the jupiter:// navigation with no error at all');

    const threw = make({ connect: () => Promise.reject(new Error('relay exploded')) });
    const c = await threw.machine.connect();
    assert.equal(c.reason, 'failed');
    assert.match(c.detail, /relay exploded/);

    const codes = new Set([a.reason, b.reason, c.reason]);
    assert.equal(codes.size, 3,
        'WO-1957 section 0: a redirect and a cancel wearing the same words cost a day. ' +
        'These three outcomes must NEVER collapse into one code.');
});

test('WO-1958: no reason code anywhere reads like the SDK ambiguous cancel', () => {
    const core = loadCore();
    // The SDK's own string is `Login cancelled` (SolanaWalletAdapterWebGL.cs:198).
    // EMITTING it here would re-create the exact ambiguity this ticket removes.
    // Comments are stripped first: the header QUOTES that sentence while recording
    // the RCA, and a lint that cannot tell a citation from an emission would push
    // the next author to delete the explanation rather than keep the guard.
    const code = fs.readFileSync(CORE_PATH, 'utf8')
        .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/Login cancelled/i.test(code),
        'the core must never emit the SDK sentence that cannot tell a redirect from a cancel');
    assert.deepEqual(Array.from(Object.values(core.REASON)).sort(),
        ['cancelled', 'connected', 'failed', 'no-bundle', 'no-project-id', 'timeout']);
});

test('WO-1958: a second connect while one is in flight does not start a second modal', async () => {
    let resolveIt;
    const { machine, seen } = make({ connect: () => new Promise((r) => { resolveIt = r; }) });
    const first = machine.connect();
    const second = machine.connect();
    assert.equal(first, second, 'the in-flight promise is returned, not a new attempt');
    // WO-2037: the button's connect now runs after the (bounded) wallet-list wait
    // and the display_uri subscription, i.e. a few microtasks later, not in the
    // same turn - that same-turn call is exactly what produced the QR on iPhone.
    await new Promise((r) => setTimeout(r, 0));
    resolveIt({ address: 'Addr' });
    const snap = await first;
    assert.equal(snap.state, 'connected');
    assert.equal(seen.closed, 1);
});

test('WO-1958: provider() returns AppKit\'s wallet provider - the signing seam', async () => {
    const provider = {
        signTransaction() {}, signAndSendTransaction() {},
        signAllTransactions() {}, signMessage() {}
    };
    const { machine } = make({ connect: () => Promise.resolve({ address: 'A' }), provider });
    await machine.connect();
    const got = machine.provider();
    assert.equal(got, provider);
    // The four names are read at source from
    // @reown/appkit-adapter-solana@1.8.24 dist/types/src/providers/SolanaWalletConnectProvider.d.ts.
    for (const fn of ['signTransaction', 'signAndSendTransaction', 'signAllTransactions', 'signMessage']) {
        assert.equal(typeof got[fn], 'function');
    }
});

test('WO-1958: disconnect clears the address and returns to idle', async () => {
    const { machine } = make({ connect: () => Promise.resolve({ address: 'A' }) });
    await machine.connect();
    const snap = machine.disconnect();
    assert.equal(snap.state, 'idle');
    assert.equal(machine.address(), '');
});

// --- the BUILD CONTRACT half --------------------------------------------------

test('WO-1958: the build script header format is the freshness contract', async () => {
    const mod = await import('node:url').then(({ pathToFileURL }) =>
        import(pathToFileURL(path.join(root, 'tools', 'build-wallet-connect.mjs')).href));
    const line = mod.headerLine('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', '0.25.0');
    assert.equal(line,
        '// EOA_WALLET_CONNECT_BUNDLE srcHash=aaaaaaaaaaaaaaaa coreHash=bbbbbbbbbbbbbbbb esbuild=0.25.0');
    // tools/web-build-contracts.ps1 re-hashes the two sources and string-matches
    // `srcHash=<16>` and `coreHash=<16>` against this line. 16 hex chars, always.
    assert.equal(mod.shortHash('anything').length, 16);
    assert.match(mod.shortHash('anything'), /^[0-9a-f]{16}$/);
});

test('WO-1958: the generated projectId shim sets exactly one global, JSON-quoted', async () => {
    const mod = await import('node:url').then(({ pathToFileURL }) =>
        import(pathToFileURL(path.join(root, 'tools', 'build-wallet-connect.mjs')).href));
    const shim = mod.configShim('abc"123');
    assert.match(shim, /GITIGNORED/);
    assert.ok(shim.includes('window.EOA_REOWN_PROJECT_ID = "abc\\"123";'),
        'the id is JSON-quoted, so a stray quote cannot break out into code: ' + shim);
    assert.equal(mod.configShim('').includes('window.EOA_REOWN_PROJECT_ID = "";'), true);
});

test('WO-1958: the example config is tracked and carries an EMPTY projectId', () => {
    const example = JSON.parse(fs.readFileSync(path.join(PI, 'reown.config.example.json'), 'utf8'));
    assert.equal(example.projectId, '',
        'the tracked example must never carry a real projectId - the real one is gitignored');
    assert.ok(Array.isArray(example._console_steps) && example._console_steps.length >= 4,
        'the console steps are the owner-action runbook and live with the file they describe');
});

test('WO-1958: both templates carry byte-identical sources and load reown-config.js', () => {
    for (const name of ['wallet-connect.core.js', 'wallet-connect.src.js']) {
        assert.equal(fs.readFileSync(path.join(PI, name), 'utf8'),
                     fs.readFileSync(path.join(XNFT, name), 'utf8'),
                     name + ' has drifted between the Pi and xNFT templates');
    }
    for (const dir of [PI, XNFT]) {
        const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
        assert.ok(html.includes('<script src="reown-config.js"></script>'),
            dir + '/index.html must load the generated projectId shim');
        // ⛔ AND MUST NOT LOAD THE BUNDLE. It is multi-megabyte and this page already
        // dies at loader 90% on iOS Safari from payload alone; EoaWalletBridge.jslib
        // injects it on the connect tap.
        assert.ok(!html.includes('<script src="wallet-connect.bundle.js"></script>'),
            dir + '/index.html must NOT load the bundle at boot - it is injected lazily');
    }
});

test('WO-1958: the ESM entry keeps NO logic - the state machine stays testable', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    assert.ok(src.includes("from '@reown/appkit'"));
    assert.ok(src.includes("from '@reown/appkit-adapter-solana'"));
    assert.ok(src.includes("from '@reown/appkit-wallet-button'"));
    assert.ok(src.includes('EOA_REOWN_PROJECT_ID'),
        'the projectId is read off the page global, never baked into the committed bundle');
    assert.ok(!/\bcreateEoaWalletConnect\s*\([\s\S]*?\bif\s*\(/.test(src.split('deps:')[0] || ''),
        'branching belongs in wallet-connect.core.js, which is testable without npm packages');
});

// =============================================================================
// WO-2037 — the same-device Jupiter deep link, and the Reown message signer.
// -----------------------------------------------------------------------------
// The RCA (read at source, @reown 1.8.24): the wallet-button's wallet list is an
// ASYNC fetch started by its constructor, and the old core called .connect() in the
// same turn, so AppKit got `wallet: undefined` and
// w3m-connecting-wc-view/index.js:117-120 chose the QR on the owner's iPhone.
// =============================================================================

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPAD_AS_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';
// A realistic pairing uri. The symKey is the SECRET the traces must never carry.
const SYMKEY = 'd4f1c0ffee5ecret5ymkey000000000000000000000000000000000000000000ab';
const WC_URI = 'wc:7f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3b2a1908@2' +
    '?relay-protocol=irn&symKey=' + SYMKEY + '&expiryTimestamp=1790000000';

// A richer Reown fake: a wallet-button with the real readiness API, and an AppKit
// whose UniversalProvider emits `display_uri` when the button connects - the same
// order the real stack produces.
function fakeReown(opts) {
    const o = opts || {};
    const log = { order: [], navigations: [], traces: [], stored: {} };
    const listeners = {};
    let ready = !!o.readyAtStart;
    const readySubs = [];
    const universalProvider = {
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); log.order.push('on:' + ev); },
        off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); log.order.push('off:' + ev); },
        emit(ev, arg) { (listeners[ev] || []).slice().forEach((f) => f(arg)); }
    };
    const provider = o.provider || null;
    const appKit = {
        close() {},
        getAddress() { return ''; },
        getWalletProvider() { return provider; },
        getUniversalProvider() { return Promise.resolve(universalProvider); },
        disconnect() {}
    };
    const button = {
        isReady() { return ready; },
        subscribeIsReady(cb) { readySubs.push(cb); },
        connect(wallet) {
            log.order.push('connect:' + wallet + ':ready=' + ready);
            universalProvider.emit('display_uri', WC_URI);
            return o.connectResult ? o.connectResult() : Promise.resolve({ address: 'Addr111' });
        }
    };
    if (typeof o.readyAfterMs === 'number') {
        setTimeout(() => { ready = true; readySubs.forEach((cb) => cb({ isReady: true })); }, o.readyAfterMs);
    }
    const storage = {
        getItem(k) { return Object.prototype.hasOwnProperty.call(log.stored, k) ? log.stored[k] : null; },
        setItem(k, v) { log.stored[k] = String(v); }
    };
    const machineOpts = {
        projectId: 'test-project-id',
        timeoutMs: 2000,
        readyWaitMs: typeof o.readyWaitMs === 'number' ? o.readyWaitMs : 60,
        deeplinkObserveMs: 20,
        navigator: { userAgent: o.ua || IPHONE_UA, maxTouchPoints: o.touch || 0 },
        navigate(url) { log.navigations.push(url); },
        storage,
        trace(line) { log.traces.push(line); },
        deps: {
            createAppKit() { return appKit; },
            SolanaAdapter: function SolanaAdapter() {},
            createAppKitWalletButton() { return button; },
            solanaNetwork: { id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }
        }
    };
    return { log, machineOpts, universalProvider };
}

function makeReown(opts) {
    const core = loadCore();
    const f = fakeReown(opts);
    return { core, machine: core.createEoaWalletConnect(f.machineOpts), log: f.log };
}

function assertNoSecret(traces) {
    const all = traces.join('\n');
    assert.ok(!all.includes(SYMKEY), 'a trace line carried the pairing symKey:\n' + all);
    assert.ok(!all.includes(WC_URI), 'a trace line carried the raw wc: uri');
    assert.ok(!all.includes(encodeURIComponent(WC_URI)), 'a trace line carried the encoded wc: uri');
}

test('WO-2037: buildDeepLink is byte-identical to AppKit formatNativeUrl for jupiter://', () => {
    const core = loadCore();
    // CoreHelperUtil.formatNativeUrl('jupiter://', uri): 'jupiter://' already ends
    // with '/', so it returns `jupiter://wc?uri=${encodeURIComponent(uri)}`.
    assert.equal(core.buildDeepLink(WC_URI), 'jupiter://wc?uri=' + encodeURIComponent(WC_URI));
    assert.ok(core.buildDeepLink(WC_URI).startsWith('jupiter://wc?uri=wc%3A'));
});

test('WO-2037: the device rule is the wallet-handoff.js rule (UA token + iPad-as-Mac touch probe)', () => {
    const core = loadCore();
    assert.deepEqual(Object.assign({}, core.classifyDevice({ userAgent: IPHONE_UA })),
        { phone: true, why: 'ua-mobile-token' });
    assert.deepEqual(Object.assign({}, core.classifyDevice({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 5 })),
        { phone: true, why: 'ipad-as-mac-touch' });
    assert.equal(core.classifyDevice({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 0 }).phone, false,
        'a real Mac (no touch points) keeps the desktop QR');
    assert.equal(core.classifyDevice({ userAgent: DESKTOP_UA }).phone, false);
    // Same regex as wallet-handoff.js isMobileBrowser(), read from the file so a
    // drift in either copy fails here.
    const handoff = fs.readFileSync(path.join(PI, 'wallet-handoff.js'), 'utf8');
    const coreSrc = fs.readFileSync(CORE_PATH, 'utf8');
    const token = '/android|iphone|ipod|ipad|iemobile|blackberry|opera mini/i';
    assert.ok(handoff.includes(token) && coreSrc.includes(token),
        'the mobile-token regex must match wallet-handoff.js isMobileBrowser() exactly');
});

// ⛔ THE RCA PIN. The old core connected in the same turn as the button was built.
test('WO-2037: connect WAITS for the wallet-button list, so AppKit gets Jupiter (not wallet:undefined -> QR)', async () => {
    const { machine, log } = makeReown({ readyAfterMs: 15, readyWaitMs: 1000 });
    const snap = await machine.connect();
    assert.equal(snap.state, 'connected');
    const c = log.order.find((x) => x.startsWith('connect:'));
    assert.equal(c, 'connect:jupiter:ready=true',
        'walletButton.connect ran before the /getWallets list arrived - that is the QR defect');
    assert.ok(log.traces.some((l) => /wallet-button ready=true/.test(l)));
    // AppKit owns the navigation when the list is ready: this file must NOT also
    // navigate, or the player gets two app-switch prompts.
    assert.equal(log.navigations.length, 0);
    assert.ok(log.traces.some((l) => /display_uri received scheme=wc .*owner=appkit/.test(l)));
    assertNoSecret(log.traces);
});

test('WO-2037: PHONE + list not ready -> this page deep-links jupiter://wc?uri=<encoded display_uri>', async () => {
    const { machine, log } = makeReown({ ua: IPHONE_UA, readyWaitMs: 10 });
    const snap = await machine.connect();
    assert.equal(snap.state, 'connected');
    assert.deepEqual(log.navigations, ['jupiter://wc?uri=' + encodeURIComponent(WC_URI)]);
    assert.ok(log.order.indexOf('on:display_uri') < log.order.findIndex((x) => x.startsWith('connect:')),
        'display_uri must be subscribed BEFORE the connect starts or the uri can be missed');
    assert.ok(log.order.includes('off:display_uri'), 'the listener is detached after the attempt');
    assert.ok(log.traces.some((l) => /platform=phone why=ua-mobile-token/.test(l)));
    assert.ok(log.traces.some((l) => /wallet-button ready=false/.test(l)));
    assert.ok(log.traces.some((l) => /deeplink attempted scheme=jupiter owner=eoa/.test(l)));
    assertNoSecret(log.traces);
});

test('WO-2037: iPad-as-Mac (touch probe) takes the phone path too', async () => {
    const { machine, log } = makeReown({ ua: IPAD_AS_MAC_UA, touch: 5, readyWaitMs: 10 });
    await machine.connect();
    assert.equal(log.navigations.length, 1);
    assert.ok(log.traces.some((l) => /platform=phone why=ipad-as-mac-touch/.test(l)));
});

test('WO-2037: DESKTOP never deep-links - the QR stays the desktop path', async () => {
    const { machine, log } = makeReown({ ua: DESKTOP_UA, readyWaitMs: 10 });
    const snap = await machine.connect();
    assert.equal(snap.state, 'connected');
    assert.equal(log.navigations.length, 0);
    assert.ok(log.traces.some((l) => /platform=desktop why=no-mobile-token/.test(l)));
    assert.ok(log.traces.some((l) => /desktop keeps the QR/.test(l)));
    assertNoSecret(log.traces);
});

test('WO-2037: the reason codes and the timeout are unchanged by the readiness wait', async () => {
    const core = loadCore();
    const f = fakeReown({ readyWaitMs: 5, connectResult: () => new Promise(() => {}) });
    f.machineOpts.timeoutMs = 40;
    const b = await core.createEoaWalletConnect(f.machineOpts).connect();
    assert.equal(b.reason, 'timeout');
    const closed = makeReown({ readyWaitMs: 5, connectResult: () => Promise.resolve(null) });
    assert.equal((await closed.machine.connect()).reason, 'cancelled');
    const threw = makeReown({ readyWaitMs: 5, connectResult: () => Promise.reject(new Error('relay exploded')) });
    assert.equal((await threw.machine.connect()).reason, 'failed');
});

test('WO-2037: a phone connect persists the WalletConnect deep-link choice so sign requests hop to Jupiter', async () => {
    const { machine, log } = makeReown({ ua: IPHONE_UA, readyWaitMs: 10 });
    await machine.connect();
    const choice = JSON.parse(log.stored.WALLETCONNECT_DEEPLINK_CHOICE);
    // The exact value AppKit's own onConnectMobile would persist (href = the
    // formatNativeUrl `href`, i.e. the bare scheme).
    assert.equal(choice.href, 'jupiter://');
    const desk = makeReown({ ua: DESKTOP_UA, readyWaitMs: 10 });
    await desk.machine.connect();
    assert.equal(desk.log.stored.WALLETCONNECT_DEEPLINK_CHOICE, undefined,
        'desktop must not write a deep-link choice - a desktop session request has no app to open');
});

test('WO-2037 add-on: signMessageBase64 signs the UTF-8 bytes and returns base64 of the raw signature', async () => {
    const seen = {};
    const sig = new Uint8Array(64).map((_, i) => i + 1);
    const provider = {
        signTransaction() {},
        signMessage(bytes) { seen.bytes = Array.from(bytes); return Promise.resolve(sig); }
    };
    const { machine, log } = makeReown({ ua: IPHONE_UA, readyAtStart: true, provider });
    await machine.connect();
    assert.equal(machine.canSignMessage(), true);
    const message = 'dotr-save:v1:Addr111:nonce-é:load';
    const b64 = await machine.signMessageBase64(message);
    assert.deepEqual(seen.bytes, Array.from(Buffer.from(message, 'utf8')),
        'the wallet must be asked to sign the exact UTF-8 bytes the server rebuilds');
    assert.equal(b64, Buffer.from(sig).toString('base64'));
    const all = log.traces.join('\n');
    assert.ok(/signMessage requested len=\d+ platform=phone deeplinkChoice=present/.test(all));
    assert.ok(/signMessage signed sigBytes=64/.test(all));
    assert.ok(!all.includes(message) && !all.includes('nonce-'), 'the message body must never be traced');
    assert.ok(!all.includes(b64), 'the signature must never be traced');
});

test('WO-2037 add-on: signMessageBase64 REFUSES by name with no provider, and propagates a wallet refusal', async () => {
    const none = makeReown({ readyAtStart: true, provider: null });
    assert.equal(none.machine.canSignMessage(), false);
    await assert.rejects(none.machine.signMessageBase64('x'), /no Jupiter\/WalletConnect provider/);
    const refusing = makeReown({ readyAtStart: true,
        provider: { signMessage() { return Promise.reject(new Error('User rejected')); } } });
    await refusing.machine.connect();
    await assert.rejects(refusing.machine.signMessageBase64('x'), /User rejected/);
    assert.ok(refusing.log.traces.some((l) => /signMessage refused afterMs=\d+ detail=User rejected/.test(l)));
});

test('WO-2037 add-on: the byte helpers match Node Buffer', () => {
    const core = loadCore();
    for (const s of ['', 'a', 'ab', 'abc', 'dotr-save:v1:x:y:load', 'é€😀']) {
        assert.deepEqual(Array.from(core.utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')), s);
        const bytes = Array.from(Buffer.from(s, 'utf8'));
        assert.equal(core.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), s);
    }
});

test('WO-2037 add-on: the jslib exports the message-sign pair and the C# bridge imports it', () => {
    const jslib = fs.readFileSync(path.join(root, 'Assets', 'Plugins', 'WebGL', 'EoaWalletBridge.jslib'), 'utf8');
    const bridge = fs.readFileSync(path.join(root, 'Assets', '_Modules', 'Wallet', 'WebGLWalletBridge.cs'), 'utf8');
    for (const sym of ['EoaJupiterCanSignMessage', 'EoaJupiterSignMessageBegin']) {
        assert.ok(jslib.includes(sym + ':'), 'jslib does not export ' + sym);
        assert.ok(bridge.includes('extern') && bridge.includes(sym + '('), 'WebGLWalletBridge.cs does not import ' + sym);
    }
    const provider = fs.readFileSync(path.join(root, 'Assets', '_Modules', 'Wallet', 'WebGLWalletProvider.cs'), 'utf8');
    assert.ok(/CanSignMessages\s*=>[\s\S]{0,160}IsJupiterSession[\s\S]{0,80}JupiterCanSignMessages\(\)/.test(provider),
        'CanSignMessages must admit a Jupiter session, or MintSessionAsync aborts with "no signer" again');
    assert.ok(/SignMessageJupiter\(/.test(provider));
});
