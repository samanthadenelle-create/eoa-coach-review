// =============================================================================
// wallet-connect.src.js — the ESM ENTRY that esbuild bundles into
// wallet-connect.bundle.js. WO-1958.
// -----------------------------------------------------------------------------
// This file is DELIBERATELY THIN. Everything that can be got wrong — the connect
// state machine, the reason codes, the wallet ids, the timeout — lives in
// wallet-connect.core.js, which carries no imports and is therefore executed by
// test/webgl-wallet-connect.test.js in a vm realm WITHOUT any npm package on disk.
// What is left here is the part a test cannot check anyway: which packages to
// import and what to hand the core.
//
// ⛔ DO NOT MOVE LOGIC UP INTO THIS FILE. The moment a branch lives here it is
// untestable until someone runs `npm install` in the repo root, and the untestable
// branch is always the one that ships broken.
//
// BUILD:  npm run web:bundle   (tools/build-wallet-connect.mjs -> esbuild)
// OUTPUT: Assets/WebGLTemplates/{Pi,xNFT}/wallet-connect.bundle.js, COMMITTED, so
//         the Unity build stays hermetic and needs no node step.
//
// THE projectId. Never baked in here. The bundle reads
// `window.EOA_REOWN_PROJECT_ID`, which the template sets from the gitignored
// `reown.config.json` via the generated `reown-config.js`. When that file is
// absent the global is undefined and the core REFUSES BY NAME
// (reason `no-project-id`) instead of opening a modal that silently does nothing.
// =============================================================================
import './wallet-connect.core.js';

import { createAppKit } from '@reown/appkit';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { createAppKitWalletButton } from '@reown/appkit-wallet-button';
import { solana } from '@reown/appkit/networks';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

// wallet-connect.core.js installs itself on the page global (it has no exports of
// its own in ESM form), so it is read back from there rather than imported by name.
const core = globalThis.eoaWalletConnectCore;

function trace(line) {
    try {
        if (typeof globalThis.piTraceEmit === 'function') globalThis.piTraceEmit(line, false);
        else if (globalThis.console && globalThis.console.info) globalThis.console.info(line);
    } catch (e) { /* telemetry never blocks a connect */ }
}

function readProjectId() {
    try { return String(globalThis.EOA_REOWN_PROJECT_ID || ''); }
    catch (e) { return ''; }
}

function metadata() {
    let url = '';
    let name = 'Echoes of Elarion';
    try { url = String(globalThis.location && globalThis.location.origin || ''); } catch (e) { url = ''; }
    return {
        name,
        description: 'Echoes of a Forgotten Civilization',
        url,
        icons: url ? [url + '/TemplateData/favicon.ico'] : []
    };
}

let instance = null;

// The ONE page global this bundle publishes. EoaWalletBridge.jslib talks to it and
// nothing else does.
globalThis.eoaWalletConnect = {
    // Present-and-loaded probe. The jslib uses it to tell "the bundle never loaded"
    // apart from "the bundle loaded and refused", which are different facts and get
    // different sentences in front of the player.
    available() { return true; },

    projectIdConfigured() { return readProjectId() !== ''; },

    instance() {
        if (!instance) {
            instance = core.createEoaWalletConnect({
                projectId: readProjectId(),
                metadata: metadata(),
                trace,
                deps: {
                    createAppKit,
                    SolanaAdapter,
                    createAppKitWalletButton,
                    solanaNetwork: solana
                }
            });
        }
        return instance;
    },

    connect(walletId) { return this.instance().connect(walletId); },

    // ⭐ THE SIGNING SEAM, AND WHY IT LIVES IN THE BUNDLE.
    //
    // EoaWalletBridge.jslib's sign path is base64-in / base64-out and deliberately
    // opaque (a Jupiter swap is a v0 transaction the Unity SDK's C# wrapper cannot
    // model). Its existing arms go through `window.walletAdapterLib`, which only
    // exists once the Solana SDK has loaded its CDN bundle — and on the Jupiter
    // path it NEVER DOES, because Connect returns before the adapter is built. So
    // the base64 <-> transaction step has to happen where a web3.js already is,
    // which is here: @reown/appkit-adapter-solana depends on @solana/web3.js
    // 1.98.4, so Transaction and VersionedTransaction come in with the bundle and
    // NOTHING new is added to the payload for this.
    //
    // The legacy/v0 fallback pair is the same shape the CDN bundle uses (read at
    // source 2026-09-22): try Transaction.from, fall back to
    // VersionedTransaction.deserialize. `.serialize()` is defined on both.
    //
    // The provider is SolanaWalletConnectProvider (@reown/appkit-adapter-solana
    // 1.8.24, dist/types/src/providers/SolanaWalletConnectProvider.d.ts, read at
    // source): signMessage / signTransaction<T> / signAndSendTransaction<T> /
    // signAllTransactions / sendTransaction / publicKey. `signTransaction` is used
    // here and not `signAndSendTransaction` ON PURPOSE: WO-1955's SendPayment and
    // SignAndSendSwapTransaction both submit through /api/wallet/rpc, and moving
    // submission into the wallet would make a second, divergent submit path.
    async signTransactionBase64(base64) {
        const provider = this.provider();
        if (!provider || typeof provider.signTransaction !== 'function') {
            throw new Error('no Jupiter/WalletConnect provider is connected');
        }
        const bytes = Uint8Array.from(atob(String(base64)), (c) => c.charCodeAt(0));
        let tx;
        try { tx = Transaction.from(bytes); }
        catch (e) { tx = VersionedTransaction.deserialize(bytes); }
        const signed = await provider.signTransaction(tx);
        if (!signed) throw new Error('the wallet returned no signed transaction');
        const out = signed.serialize();
        let binary = '';
        const raw = out instanceof Uint8Array ? out : new Uint8Array(out);
        for (let i = 0; i < raw.length; i += 1) binary += String.fromCharCode(raw[i]);
        return btoa(binary);
    },

    // True when a Reown/WalletConnect provider is connected and can sign. The jslib
    // checks this FIRST so a Jupiter session never falls through to the CDN bundle's
    // wallet-name path, which on this branch was never populated.
    canSign() {
        const provider = this.provider();
        return !!(provider && typeof provider.signTransaction === 'function');
    },

    // WO-2037 add-on: the MESSAGE-signing seam (the wallet-nonce login / session
    // mint). Logic lives in wallet-connect.core.js; base64 of the raw signature out.
    canSignMessage() { return this.instance().canSignMessage(); },
    signMessageBase64(utf8Text) { return this.instance().signMessageBase64(utf8Text); },

    disconnect() { return this.instance().disconnect(); },
    provider() { return this.instance().provider(); },
    address() { return this.instance().address(); },
    state() { return this.instance().state(); },
    JUPITER_WALLET: core.JUPITER_WALLET,
    JUPITER_EXPLORER_ID: core.JUPITER_EXPLORER_ID,
    REASON: core.REASON
};

trace('[EoaWalletConnect] bundle loaded, projectId=' +
      (readProjectId() ? 'set' : 'MISSING') + ', wallet=' + core.JUPITER_WALLET);
