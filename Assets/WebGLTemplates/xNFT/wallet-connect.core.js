// =============================================================================
// wallet-connect.core.js — the Jupiter Mobile (Reown / WalletConnect) connect
// state machine, WO-1958.
// -----------------------------------------------------------------------------
// ⭐ WHY THIS FILE IS SEPARATE FROM wallet-connect.src.js, AND WHY IT TAKES ITS
// DEPENDENCIES AS ARGUMENTS.
//
// The shipping bundle needs @reown/appkit + @reown/appkit-adapter-solana +
// @reown/appkit-wallet-button, which are ESM-only, multi-megabyte, and NOT on
// disk in this repo today. If the state machine lived inside that import graph it
// could not be tested until someone ran `npm install`, and the only thing anyone
// would ever actually get wrong — the STATE MACHINE — would be the untested half.
//
// So the machine lives here, takes {createAppKit, SolanaAdapter,
// createAppKitWalletButton, solanaNetwork} as INJECTED constructors, and is
// executed against fakes by test/webgl-wallet-connect.test.js in a vm realm.
// wallet-connect.src.js is the four-line ESM entry that imports the real packages
// and hands them to this function. esbuild bundles the pair into
// wallet-connect.bundle.js.
//
// -----------------------------------------------------------------------------
// ⛔ THE ONE DEFECT THIS FILE EXISTS TO NOT REPEAT (WO-1957 §0, measured).
//
// The Solana Unity SDK's WebGL path cannot tell a REDIRECT from a CANCEL: the CDN
// bundle's Solflare connect() arm is `return void(...)`, so a successful handoff
// and a closed sheet both arrive in C# as `Login cancelled`. Owner's own iPhone
// session, web_trace `wt-a73bdc1d3350`, 2026-09-22 12:12:26Z.
//
// ⛔ THEREFORE: EVERY TERMINAL STATE BELOW CARRIES ITS OWN `reason` CODE, and no
// code path here may ever produce a sentence a reader could confuse with a cancel.
// `cancelled`, `timeout`, `no-project-id`, `no-bundle`, `failed` are five different
// facts and the C# side branches on them.
//
// -----------------------------------------------------------------------------
// WHAT IS PROVEN ABOUT THE JUPITER PATH (each read at source 2026-09-22; the WO
// carries the full citations):
//
//  1. Jupiter Mobile IS a registered WalletConnect wallet. WalletConnect explorer
//     API, entry `0ef262ca2a56b88d179c93a21383fee4e135bd7bc6680e5c2356ff8e38301037`:
//       "name":"Jupiter", "chains":["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
//       "sdks":["sign_v1","sign_v2"], "mobile":{"native":"jupiter://","universal":null}
//  2. Reown AppKit turns that `mobile_link` into a SAME-DEVICE deeplink.
//     CoreHelperUtil.formatNativeUrl builds `jupiter://wc?uri=<encoded wc uri>`
//     and w3m-connecting-wc-mobile calls
//     `CoreHelperUtil.openHref(redirect, isIframe() ? '_top' : '_self')`.
//  3. @jup-ag/jup-mobile-adapter's React-ness is a WRAPPER, not a requirement. Its
//     own dist (`dist/adapters.mjs`, downloaded and read) contains:
//       function initReownAppKit({appKitOptions}) {
//         const solanaWeb3JsAdapter = new SolanaAdapter({wallets: []});
//         const appKit = createAppKit({adapters:[solanaWeb3JsAdapter],
//                                      networks:[solanaNetwork], ...appKitOptions});
//         return {solanaWeb3JsAdapter, appKit}; }
//     — no React in it — and its "Jupiter Mobile" proxy adapter connects with
//       setTimeout(() => { connectReown("jupiter"); }, 0)
//     i.e. AppKit's wallet-button `connect('jupiter')`. That call has a
//     FRAMEWORK-AGNOSTIC core export: `createAppKitWalletButton({namespace})`
//     (@reown/appkit-wallet-button `dist/types/exports/index.d.ts`).
//
// ⚠ AND WHAT IS NOT PROVEN, STATED HERE SO NOBODY READS OPTIMISM INTO THE CODE:
//  - `AppKitWalletButton.connect(wallet)` on a MOBILE browser pushes the
//    `AllWallets` VIEW (client.js `connectWalletConnect.onOpen(isMobile)`), not a
//    one-tap Jupiter deeplink. So on a phone the player taps "Jupiter Mobile" and
//    then taps Jupiter in AppKit's own list. `includeWalletIds` pins that list to
//    Jupiter alone so the second tap is unambiguous — that is the mitigation, and
//    it is not the same thing as one tap.
//  - Jupiter registers NO universal link (`universal:null`), so iOS has only the
//    custom scheme. If the app is not installed, nothing happens and there is no
//    App Store fallback. The timeout below is the only thing that turns that
//    silence into a sentence.
// =============================================================================
(function (global) {
    'use strict';

    // The WalletConnect-explorer SLUG AppKit's wallet-button takes, and the explorer
    // ID behind it. Both READ AT SOURCE from the explorer API response quoted above.
    // ⛔ Do not "tidy" the id into a shorter form — `includeWalletIds` matches the
    // full 64-hex explorer id and a truncated one silently matches nothing, which
    // would present an EMPTY wallet list that looks like a load failure.
    var JUPITER_WALLET = 'jupiter';
    var JUPITER_EXPLORER_ID =
        '0ef262ca2a56b88d179c93a21383fee4e135bd7bc6680e5c2356ff8e38301037';

    // How long we wait for an approval before saying so. Deliberately generous: the
    // player is switching apps, approving in Jupiter, and switching back, and a
    // WebGL tab that gets backgrounded on iOS can take seconds to resume.
    var DEFAULT_TIMEOUT_MS = 180000;

    // Terminal reason codes. Each is a DIFFERENT FACT and the C# side branches on
    // them; none of them may be collapsed into a generic failure.
    var REASON = {
        CONNECTED: 'connected',
        NO_PROJECT_ID: 'no-project-id',
        NO_BUNDLE: 'no-bundle',
        CANCELLED: 'cancelled',
        TIMEOUT: 'timeout',
        FAILED: 'failed'
    };

    function noop() {}

    function createEoaWalletConnect(options) {
        var opts = options || {};
        var deps = opts.deps || {};
        var trace = typeof opts.trace === 'function' ? opts.trace : noop;
        var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        var projectId = opts.projectId ? String(opts.projectId) : '';

        var state = 'idle';
        var reason = '';
        var address = '';
        var detail = '';
        var appKit = null;
        var walletButton = null;
        var inFlight = null;

        function snapshot() {
            return {
                state: state,
                reason: reason,
                address: address,
                detail: detail,
                projectId: projectId ? 'set' : 'missing'
            };
        }

        function settle(nextState, nextReason, nextDetail) {
            state = nextState;
            reason = nextReason;
            detail = nextDetail || '';
            trace('[EoaWalletConnect] ' + nextState + ' reason=' + nextReason +
                  (detail ? ' detail=' + detail : ''));
            return snapshot();
        }

        // ⛔ THE REFUSAL THAT MUST COME FIRST. Without a Reown projectId the AppKit
        // relay rejects the session before any UI appears, and the player would see a
        // modal that silently does nothing. Refusing here, by name, is the whole
        // reason this branch exists.
        function ensureConfigured() {
            if (!projectId) {
                settle('refused', REASON.NO_PROJECT_ID,
                       'no Reown projectId is configured (Assets/WebGLTemplates/Pi/reown.config.json ' +
                       'is absent or empty, so window.EOA_REOWN_PROJECT_ID was never set)');
                return false;
            }
            if (typeof deps.createAppKit !== 'function' ||
                typeof deps.SolanaAdapter !== 'function' ||
                typeof deps.createAppKitWalletButton !== 'function') {
                settle('refused', REASON.NO_BUNDLE,
                       'wallet-connect.bundle.js did not supply the Reown constructors ' +
                       '(run `npm run web:bundle`)');
                return false;
            }
            return true;
        }

        function ensureAppKit() {
            if (appKit) return appKit;
            var solanaAdapter = new deps.SolanaAdapter({ wallets: [] });
            appKit = deps.createAppKit({
                adapters: [solanaAdapter],
                networks: [deps.solanaNetwork],
                projectId: projectId,
                metadata: opts.metadata,
                // Pin the list to the ONE wallet this door is for. On a phone
                // AppKit's wallet-button pushes the AllWallets view rather than
                // deeplinking straight out (see the header), so an unpinned list
                // would bury Jupiter among hundreds of rows.
                includeWalletIds: [JUPITER_EXPLORER_ID],
                featuredWalletIds: [JUPITER_EXPLORER_ID],
                features: { analytics: false, email: false, socials: false }
            });
            walletButton = deps.createAppKitWalletButton({ namespace: 'solana' });
            trace('[EoaWalletConnect] AppKit created, namespace=solana, wallet=' + JUPITER_WALLET);
            return appKit;
        }

        // Resolves with a snapshot. NEVER rejects — a rejected promise crossing the
        // jslib boundary becomes an unhandled rejection with no reason code, which is
        // exactly the information loss this whole ticket is about.
        function connect(walletId) {
            if (inFlight) {
                trace('[EoaWalletConnect] connect ignored: one is already in flight');
                return inFlight;
            }
            if (!ensureConfigured()) return Promise.resolve(snapshot());

            var wallet = walletId ? String(walletId) : JUPITER_WALLET;
            state = 'opening';
            reason = '';
            detail = '';
            address = '';

            inFlight = new Promise(function (resolve) {
                var done = false;
                var timer = null;

                function finish(snap) {
                    if (done) return;
                    done = true;
                    if (timer) { try { clearTimeout(timer); } catch (e) { /* no timers in a vm realm */ } }
                    inFlight = null;
                    resolve(snap);
                }

                try {
                    ensureAppKit();
                } catch (err) {
                    finish(settle('refused', REASON.FAILED,
                                  'AppKit could not be created: ' + msg(err)));
                    return;
                }

                try {
                    timer = setTimeout(function () {
                        // ⛔ THE SILENT-APP CASE. Jupiter has no universal link, so an
                        // uninstalled app swallows the `jupiter://` navigation with no
                        // error of any kind. Without this the player stares at a modal
                        // forever; with it they get a sentence that names the cause.
                        finish(settle('refused', REASON.TIMEOUT,
                                      'no approval arrived within ' + timeoutMs + 'ms - the Jupiter ' +
                                      'app may not be installed (it registers no universal link, so a ' +
                                      'missing app fails silently)'));
                        try { if (appKit && appKit.close) appKit.close(); } catch (e) { /* closing is best effort */ }
                    }, timeoutMs);
                } catch (e) { timer = null; }

                state = 'awaiting-approval';
                trace('[EoaWalletConnect] awaiting approval for wallet=' + wallet);

                var attempt;
                try {
                    attempt = walletButton.connect(wallet);
                } catch (err) {
                    finish(settle('refused', REASON.FAILED, 'connect threw: ' + msg(err)));
                    return;
                }

                Promise.resolve(attempt).then(function (result) {
                    var addr = readAddress(result) || readAppKitAddress();
                    if (!addr) {
                        // Resolved with nothing = the modal closed without an account.
                        // A DISTINCT reason, never the SDK's ambiguous "Login cancelled".
                        finish(settle('refused', REASON.CANCELLED,
                                      'the Reown modal closed without an approved account'));
                        return;
                    }
                    address = addr;
                    try { if (appKit && appKit.close) appKit.close(); } catch (e) { /* best effort */ }
                    finish(settle('connected', REASON.CONNECTED, 'address=' + addr));
                }).catch(function (err) {
                    finish(settle('refused', REASON.FAILED, msg(err)));
                });
            });

            return inFlight;
        }

        function msg(err) {
            if (!err) return 'unknown error';
            if (typeof err === 'string') return err;
            return err.message ? String(err.message) : String(err);
        }

        // AppKit's wallet-button resolves a ParsedCaipAddress
        // ({address, chainId, chainNamespace}), but a plain string shows up in older
        // shapes, so both are read rather than assumed.
        function readAddress(result) {
            if (!result) return '';
            if (typeof result === 'string') return result;
            if (result.address) return String(result.address);
            return '';
        }

        function readAppKitAddress() {
            try {
                if (appKit && typeof appKit.getAddress === 'function') {
                    return String(appKit.getAddress('solana') || '');
                }
            } catch (e) { /* absence is the answer */ }
            return '';
        }

        // The SIGNING SEAM. SolanaWalletConnectProvider (@reown/appkit-adapter-solana
        // 1.8.24, `dist/types/src/providers/SolanaWalletConnectProvider.d.ts`, read at
        // source) declares:
        //     signMessage(message: Uint8Array): Promise<Uint8Array>
        //     signTransaction<T extends AnyTransaction>(transaction: T): Promise<T>
        //     signAndSendTransaction<T>(transaction: T, sendOptions?): Promise<string>
        //     signAllTransactions / sendTransaction / publicKey
        // — which is exactly what ISwapSigningWallet and SendPayment need on the C#
        // side. This returns it; it does NOT wrap it, because a wrapper here would be
        // a second place for the transaction shape to go wrong.
        function provider() {
            try {
                if (appKit && typeof appKit.getWalletProvider === 'function') {
                    return appKit.getWalletProvider() || null;
                }
            } catch (e) { /* not connected yet */ }
            return null;
        }

        function disconnect() {
            try {
                if (appKit && typeof appKit.disconnect === 'function') appKit.disconnect();
            } catch (e) { trace('[EoaWalletConnect] disconnect threw: ' + msg(e)); }
            address = '';
            return settle('idle', '', '');
        }

        return {
            connect: connect,
            disconnect: disconnect,
            provider: provider,
            address: function () { return address; },
            state: snapshot,
            JUPITER_WALLET: JUPITER_WALLET,
            JUPITER_EXPLORER_ID: JUPITER_EXPLORER_ID,
            REASON: REASON
        };
    }

    var api = {
        createEoaWalletConnect: createEoaWalletConnect,
        JUPITER_WALLET: JUPITER_WALLET,
        JUPITER_EXPLORER_ID: JUPITER_EXPLORER_ID,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        REASON: REASON
    };

    global.eoaWalletConnectCore = api;
    // Node (the regression suite) requires this file directly; browsers ignore it.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
