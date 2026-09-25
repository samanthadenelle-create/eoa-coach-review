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
