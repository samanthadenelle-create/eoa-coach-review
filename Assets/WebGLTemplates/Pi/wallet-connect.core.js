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
// -----------------------------------------------------------------------------
// ⛔ WO-2037 — WHY THE OWNER'S iPHONE GOT A QR CODE (read at source, 1.8.24).
//
// The earlier note here said the wallet-button "pushes the AllWallets view on a
// mobile browser". That is FALSE for 'jupiter': @reown/appkit-wallet-button
// dist/esm/src/client.js:68 passes `walletConnect: wallet === 'walletConnect'`,
// so ConnectorControllerUtil.js:29 calls `onOpen(isMobile() && false)` and the
// button ALWAYS pushes 'ConnectingWalletConnect' with `{ wallet: walletButton }`
// (client.js:76). `walletButton` comes from WalletUtil.getWalletButton
// (WalletUtil.js:7), which reads `ApiController.state.walletButtons` — filled by
// an ASYNC `/getWallets` fetch the button's CONSTRUCTOR starts (client.js:9-15,
// ApiController.js:42-53). The old code constructed the button and called
// `.connect('jupiter')` in the SAME synchronous turn, so the list was still `[]`,
// `wallet` was undefined, and appkit-scaffold-ui
// views/w3m-connecting-wc-view/index.js:117-120 —
//     if (!this.wallet) { this.platforms.push('qrcode'); ... return; }
// — chose QR before `CoreHelperUtil.isMobile()` (line 138) was ever consulted.
// The phone / landscape-956px viewport was irrelevant: isMobile() is
// `pointer:coarse || /iPhone|.../ UA` (CoreHelperUtil.js:13-16), true on her device.
//
// THE FIX, two layers, ONE navigation owner per attempt:
//  A. connect() now waits (bounded, READY_WAIT_MS) for the button's wallet list,
//     so AppKit receives Jupiter's `mobile_link` ('jupiter://') and on a phone
//     renders w3m-connecting-wc-mobile, which deep-links itself
//     (ConnectionControllerUtil.onConnectMobile -> openHref(redirect,'_self')) AND
//     shows its own gesture-backed "Open" button if Safari refuses the async one.
//  B. If the list is NOT ready in time (fetch failed / slow) the modal falls back
//     to QR; on a PHONE this file then owns the deep link: it listens to the
//     UniversalProvider's `display_uri` and navigates to `jupiter://wc?uri=...`
//     itself. Only one of A/B ever navigates, so the player never gets two
//     app-switch prompts.
//  ⚠ NOT PROVEN: whether iOS Safari honours a custom-scheme navigation that
//    happens seconds after the tap (the relay hop). The `deeplink outcome=` trace
//    line is the instrument; AppKit's "Open" button (path A) is the fallback.
//
// ⚠ AND WHAT IS NOT PROVEN, STATED HERE SO NOBODY READS OPTIMISM INTO THE CODE:
//  - Jupiter registers NO universal link (`universal:null`), so iOS has only the
//    custom scheme. If the app is not installed, nothing happens and there is no
//    App Store fallback. The timeout below is the only thing that turns that
//    silence into a sentence.
//
// -----------------------------------------------------------------------------
// ⛔ WO-2197 — A RELAY THAT REFUSES THIS PAGE MUST NOT LEAVE A SPINNER.
//
// Player bug report #32 (2026-09-29 11:50Z, iPhone Safari, echoes-of-elarion
// .vercel.app): the WalletConnect relay answered
//     WebSocket connection closed abnormally with code: 3000 (Unauthorized: origin not allowed)
// Nothing here listened for it, no `display_uri` ever arrived, and the modal spun
// until the player closed it (~40 s; trace `refused reason=failed detail=Modal
// closed`). Where that sentence is born, read at source in the bundled
// @walletconnect/core (wallet-connect.bundle.js, 2026-09-30):
//   jsonrpc-provider onClose: `t.code===3e3 && this.events.emit("error", new
//     Error("WebSocket connection closed abnormally with code: ..."))`
//   Relayer onProviderErrorHandler: `this.events.emit("relayer_error", err)`, then
//     `transportExplicitlyClosed = true` (it does NOT reconnect by itself).
// and the relayer is reachable as UniversalProvider `.client.core.relayer`.
//
// So three layers, each closing the modal and tearing down every per-attempt
// listener and timer (cleanup() below):
//  1. `relayer_error` classified by classifyRelayRejection -> reason
//     `origin-not-allowed` + the page origin, LATCHED on the instance so a second
//     tap in the same page answers at once instead of costing another wait.
//  2. The same classifier on the wallet-button's own rejection and on window
//     `unhandledrejection` / `error` (relay-shaped text only).
//  3. A NO-PROGRESS watchdog: no `display_uri` within NO_URI_WATCHDOG_MS of the
//     tap -> reason `no-uri-timeout`. It stands down when display_uri cannot be
//     observed on this AppKit shape at all, or when the relay already produced a
//     pairing uri on this page (AppKit reuses an unexpired uri without emitting a
//     new display_uri, and a healthy second attempt must not be killed).
// The snapshot carries `origin`, `uriSeen` and `uriObservable` so the C# side can
// tell "the player closed a working modal" from "the player closed a spinner that
// never had a pairing uri" - the second is a door that was never open.
// ⚠ NOT PROVEN FROM HERE: which origins the Reown dashboard allows. That list is
// the owner's; this code is correct whichever origins are registered.
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

    // WO-2037 layer A: how long connect() waits for the wallet-button's `/getWallets`
    // list before letting AppKit open anyway. Bounded because ApiController's fetch
    // has no try/finally — a failed fetch leaves `ready` false forever.
    var READY_WAIT_MS = 4000;

    // How long after a deep link we watch for the page going hidden (= iOS switched
    // to Jupiter) before recording "no app switch".
    var DEEPLINK_OBSERVE_MS = 4000;

    // WO-2197: the NO-PROGRESS watchdog. A healthy relay hands AppKit a `wc:`
    // pairing uri within a few seconds of the tap; none within this window means
    // the relay never answered this page, and the player must be told so instead of
    // watching a spinner until DEFAULT_TIMEOUT_MS. Measured from the tap, so it
    // includes the (bounded) READY_WAIT_MS wallet-list wait and the (bounded)
    // UniversalProvider wait - up to 2 x READY_WAIT_MS before connect() even starts.
    var NO_URI_WATCHDOG_MS = 15000;

    // Jupiter's explorer `mobile.native`. AppKit's CoreHelperUtil.formatNativeUrl
    // turns it into `jupiter://wc?uri=<encodeURIComponent(wc uri)>`; buildDeepLink
    // below produces the byte-identical string.
    var JUPITER_NATIVE = 'jupiter://';

    // Pure byte helpers — no TextEncoder / btoa dependency, so the vm-realm suite
    // runs them exactly as the page does.
    function utf8Bytes(str) {
        var out = [];
        for (var i = 0; i < str.length; i += 1) {
            var c = str.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                var d = str.charCodeAt(i + 1);
                if (d >= 0xdc00 && d <= 0xdfff) {
                    c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                    i += 1;
                }
            }
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return out;
    }

    function toByteArray(v) {
        if (!v || typeof v.length !== 'number') return [];
        var out = [];
        for (var i = 0; i < v.length; i += 1) out.push(v[i] & 255);
        return out;
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function bytesToBase64(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
            var n = (a << 16) | ((b || 0) << 8) | (c || 0);
            s += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
                 (i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=') +
                 (i + 2 < bytes.length ? B64.charAt(n & 63) : '=');
        }
        return s;
    }

    function buildDeepLink(wcUri) {
        return JUPITER_NATIVE + 'wc?uri=' + encodeURIComponent(String(wcUri));
    }

    // "Is this a phone/tablet browser?" — COPIED from wallet-handoff.js
    // isMobileBrowser() (WO-2037: same rule, not edited there). iPadOS 13+ reports a
    // DESKTOP Macintosh UA, so the touch-point probe is the only reliable iPad tell.
    // Returns the answer AND the reason, because the trace must say why.
    function classifyDevice(nav) {
        var s = '';
        try { s = String((nav && nav.userAgent) || ''); } catch (e) { s = ''; }
        if (/android|iphone|ipod|ipad|iemobile|blackberry|opera mini/i.test(s)) {
            return { phone: true, why: 'ua-mobile-token' };
        }
        try {
            if (/Macintosh/i.test(s) && nav && typeof nav.maxTouchPoints === 'number' &&
                nav.maxTouchPoints > 1) {
                return { phone: true, why: 'ipad-as-mac-touch' };
            }
        } catch (e) { /* hardened browsers hide maxTouchPoints; fall through */ }
        return { phone: false, why: s ? 'no-mobile-token' : 'no-user-agent' };
    }

    // Terminal reason codes. Each is a DIFFERENT FACT and the C# side branches on
    // them; none of them may be collapsed into a generic failure.
    var REASON = {
        CONNECTED: 'connected',
        NO_PROJECT_ID: 'no-project-id',
        NO_BUNDLE: 'no-bundle',
        CANCELLED: 'cancelled',
        TIMEOUT: 'timeout',
        FAILED: 'failed',
        // WO-2197: the relay refused this page's ORIGIN (Reown allow-list). A door
        // that cannot open here - the C# side falls through to the next wallet.
        ORIGIN_NOT_ALLOWED: 'origin-not-allowed',
        // WO-2197: no pairing uri within NO_URI_WATCHDOG_MS - the relay never
        // answered, whatever the cause. Also a door that cannot open here.
        NO_URI_TIMEOUT: 'no-uri-timeout'
    };

    function noop() {}

    function readText(x) {
        if (x == null) return '';
        if (typeof x === 'string') return x;
        var parts = [];
        try { if (x.message) parts.push(String(x.message)); } catch (e) { /* opaque */ }
        try { if (typeof x.reason === 'string') parts.push(x.reason); } catch (e) { /* opaque */ }
        try {
            if (x.reason && typeof x.reason === 'object') parts.push(readText(x.reason));
        } catch (e) { /* opaque */ }
        try {
            if (x.error && typeof x.error === 'object') parts.push(readText(x.error));
        } catch (e) { /* opaque */ }
        if (!parts.length) { try { parts.push(String(x)); } catch (e) { /* opaque */ } }
        return parts.join(' ');
    }

    function readCode(x) {
        if (!x || typeof x !== 'object') return null;
        try {
            if (typeof x.code === 'number') return x.code;
            if (x.reason && typeof x.reason === 'object' && typeof x.reason.code === 'number') return x.reason.code;
            if (x.error && typeof x.error === 'object' && typeof x.error.code === 'number') return x.error.code;
        } catch (e) { /* opaque */ }
        return null;
    }

    // WO-2197. Is this error / close event the WalletConnect relay REFUSING this
    // page? Returns REASON.ORIGIN_NOT_ALLOWED or ''. Accepts an Error (the
    // relayer's own `relayer_error` payload), a CloseEvent-shaped {code, reason},
    // an unhandledrejection-shaped {reason: Error} or a bare string. PURE: the
    // suite drives it directly.
    function classifyRelayRejection(x) {
        if (readCode(x) === 3000) return REASON.ORIGIN_NOT_ALLOWED;
        var text = readText(x);
        if (/origin not allowed/i.test(text)) return REASON.ORIGIN_NOT_ALLOWED;
        if (/closed abnormally with code:?\s*3000\b/i.test(text)) return REASON.ORIGIN_NOT_ALLOWED;
        if (/\bunauthori[sz]ed\b/i.test(text)) return REASON.ORIGIN_NOT_ALLOWED;
        return '';
    }

    // The WINDOW-level listeners see every unhandled error on the page, not only
    // the relay's, so they only act on text that is relay-shaped - a stray game
    // `Unauthorized` must never be read as "the relay refused this origin".
    function looksRelayShaped(x) {
        if (readCode(x) === 3000) return true;
        return /websocket|relay|walletconnect|origin not allowed|code:?\s*3000\b/i.test(readText(x));
    }

    function pageOrigin(opts) {
        try { if (opts && opts.origin) return String(opts.origin); } catch (e) { /* fall through */ }
        try { return String((global.location && global.location.origin) || ''); } catch (e) { return ''; }
    }

    function createEoaWalletConnect(options) {
        var opts = options || {};
        var deps = opts.deps || {};
        var trace = typeof opts.trace === 'function' ? opts.trace : noop;
        var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        var projectId = opts.projectId ? String(opts.projectId) : '';
        var readyWaitMs = typeof opts.readyWaitMs === 'number' ? opts.readyWaitMs : READY_WAIT_MS;
        var observeMs = typeof opts.deeplinkObserveMs === 'number' ? opts.deeplinkObserveMs : DEEPLINK_OBSERVE_MS;
        var noUriWatchdogMs = typeof opts.noUriWatchdogMs === 'number' ? opts.noUriWatchdogMs : NO_URI_WATCHDOG_MS;
        var origin = pageOrigin(opts);
        // The one navigation this file performs (WO-2037 layer B). Injected so the
        // suite can capture it; in the page it is a same-frame location change, the
        // same frame AppKit's own openHref targets outside an iframe ('_self').
        var navigate = typeof opts.navigate === 'function' ? opts.navigate : function (url) {
            global.location.href = url;
        };

        var state = 'idle';
        var reason = '';
        var address = '';
        var detail = '';
        var appKit = null;
        var walletButton = null;
        var inFlight = null;

        // WO-2197 — instance-level relay facts. ONE persistent relayer listener and
        // ONE persistent display_uri listener per AppKit instance (hookRelayOnce),
        // never one per attempt, so repeated taps add nothing to the page.
        var relayHooked = false;
        var relayRejection = '';   // latched: the relay refused this origin
        var relayProven = false;   // latched: the relay produced a pairing uri here
        var active = null;         // the in-flight attempt's reject hook, or null
        // The current/last attempt's uri facts, carried on every snapshot. The
        // attempt's ctx IS this object, so no terminal path can forget to stamp it.
        var facts = { done: false, seen: false, observable: '', detach: noop };

        function snapshot() {
            return {
                state: state,
                reason: reason,
                address: address,
                detail: detail,
                projectId: projectId ? 'set' : 'missing',
                // WO-2197: the page origin the relay judged, and whether a pairing
                // uri ever arrived. Never the uri itself (it carries the symKey).
                origin: origin,
                uriSeen: !!facts.seen,
                uriObservable: String(facts.observable || '')
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

            facts = { done: false, seen: false, observable: '', detach: noop };
            // WO-2197: the relay already refused this origin on this page. It does
            // not reconnect by itself (transportExplicitlyClosed), so opening the
            // modal again would only rebuild the same spinner. Answer at once.
            if (relayRejection) {
                trace('[EoaWalletConnect] relay refused this page earlier origin=' + (origin || 'unknown') +
                      ' - not reopening the modal');
                return Promise.resolve(settle('refused', REASON.ORIGIN_NOT_ALLOWED,
                    'the WalletConnect relay refused this page origin=' + (origin || 'unknown') +
                    ' (latched) detail=' + relayRejection));
            }

            var wallet = walletId ? String(walletId) : JUPITER_WALLET;
            state = 'opening';
            reason = '';
            detail = '';
            address = '';

            inFlight = new Promise(function (resolve) {
                var done = false;
                var timer = null;
                var watchdog = null;
                var detachWindow = noop;
                // Shared with attachDisplayUri, which may subscribe LATE (after its
                // bound) and must know whether the attempt is already over. It is
                // the instance `facts`, so snapshot() always reports this attempt.
                var ctx = facts;

                // WO-2197: ONE teardown for every terminal path - the approval
                // timer, the watchdog, the per-attempt display_uri listener and the
                // window listeners. The instance-level relay hooks stay (one each).
                function cleanup() {
                    if (timer) { try { clearTimeout(timer); } catch (e) { /* no timers in a vm realm */ } timer = null; }
                    if (watchdog) { try { clearTimeout(watchdog); } catch (e) { /* vm realm */ } watchdog = null; }
                    try { ctx.detach(); } catch (e) { /* best effort */ }
                    ctx.detach = noop;
                    try { detachWindow(); } catch (e) { /* best effort */ }
                    detachWindow = noop;
                    active = null;
                }

                function finish(snap) {
                    if (done) return;
                    done = true;
                    ctx.done = true;
                    cleanup();
                    inFlight = null;
                    resolve(snap);
                }

                function closeModal() {
                    try { if (appKit && appKit.close) appKit.close(); } catch (e) { /* closing is best effort */ }
                }

                // A door that cannot open here: say so by NAME, close the modal, and
                // leave the page as it was before the tap.
                function failUnavailable(nextReason, why) {
                    if (done) return;
                    trace('[EoaWalletConnect] door unavailable reason=' + nextReason +
                          ' origin=' + (origin || 'unknown') + ' uriSeen=' + ctx.seen +
                          ' uriObservable=' + (ctx.observable || 'unknown'));
                    finish(settle('refused', nextReason, why));
                    closeModal();
                }

                try {
                    ensureAppKit();
                } catch (err) {
                    ctx.observable = 'failed';
                    finish(settle('refused', REASON.FAILED,
                                  'AppKit could not be created: ' + msg(err)));
                    return;
                }

                active = {
                    reject: function (why, via) {
                        failUnavailable(REASON.ORIGIN_NOT_ALLOWED,
                            'the WalletConnect relay refused this page origin=' + (origin || 'unknown') +
                            ' via=' + via + ' detail=' + why);
                    }
                };

                detachWindow = watchWindowErrors(function (why, via) {
                    if (active) active.reject(why, via);
                });

                try {
                    watchdog = setTimeout(function () {
                        watchdog = null;
                        if (done || ctx.seen) return;
                        if (relayProven) {
                            trace('[EoaWalletConnect] no-uri watchdog stood down: the relay already produced a ' +
                                  'pairing uri on this page (AppKit may reuse it without a new display_uri)');
                            return;
                        }
                        if (ctx.observable === 'unsupported') {
                            trace('[EoaWalletConnect] no-uri watchdog cannot judge: display_uri is not observable ' +
                                  'on this AppKit - the ' + timeoutMs + 'ms approval timeout still applies');
                            return;
                        }
                        failUnavailable(REASON.NO_URI_TIMEOUT,
                            'no WalletConnect pairing uri within ' + noUriWatchdogMs + 'ms of the tap - the relay ' +
                            'never answered this page origin=' + (origin || 'unknown') +
                            ' (uriObservable=' + (ctx.observable || 'unknown') + ')');
                    }, noUriWatchdogMs);
                } catch (e) { watchdog = null; }

                try {
                    timer = setTimeout(function () {
                        // ⛔ THE SILENT-APP CASE. Jupiter has no universal link, so an
                        // uninstalled app swallows the `jupiter://` navigation with no
                        // error of any kind. Without this the player stares at a modal
                        // forever; with it they get a sentence that names the cause.
                        timer = null;
                        finish(settle('refused', REASON.TIMEOUT,
                                      'no approval arrived within ' + timeoutMs + 'ms - the Jupiter ' +
                                      'app may not be installed (it registers no universal link, so a ' +
                                      'missing app fails silently)'));
                        closeModal();
                    }, timeoutMs);
                } catch (e) { timer = null; }

                state = 'awaiting-approval';
                trace('[EoaWalletConnect] awaiting approval for wallet=' + wallet +
                      ' origin=' + (origin || 'unknown'));

                var device = classifyDevice(opts.navigator || global.navigator);
                trace('[EoaWalletConnect] platform=' + (device.phone ? 'phone' : 'desktop') +
                      ' why=' + device.why);
                var startedAt = now();

                // ONE navigation owner per attempt (see header): AppKit when the
                // wallet list arrived in time, this file when it did not AND we are on
                // a phone, nobody on desktop (the QR is the desktop path).
                var owner = 'appkit';

                function onDisplayUri(uri) {
                    if (done || ctx.seen) return;
                    ctx.seen = true;
                    relayProven = true;
                    var u = String(uri || '');
                    // ⛔ NEVER the uri itself: it carries the pairing symKey.
                    trace('[EoaWalletConnect] display_uri received scheme=' +
                          (u.indexOf('wc:') === 0 ? 'wc' : 'other') + ' len=' + u.length +
                          ' afterMs=' + (now() - startedAt) + ' owner=' + owner);
                    if (owner !== 'eoa') {
                        if (device.phone) observeDeepLink('appkit');
                        return;
                    }
                    var link = buildDeepLink(u);
                    trace('[EoaWalletConnect] deeplink attempted scheme=' +
                          JUPITER_NATIVE.replace('://', '') + ' owner=eoa via=location');
                    try {
                        navigate(link);
                    } catch (err) {
                        trace('[EoaWalletConnect] deeplink outcome=threw owner=eoa detail=' + msg(err) +
                              ' - the QR modal stays up');
                        return;
                    }
                    observeDeepLink('eoa');
                }

                waitForWalletButton(walletButton, readyWaitMs).then(function (ready) {
                    if (done) return null;
                    trace('[EoaWalletConnect] wallet-button ready=' + ready +
                          ' waitedMs=' + (now() - startedAt));
                    if (ready !== true) {
                        owner = device.phone ? 'eoa' : 'none';
                        trace('[EoaWalletConnect] wallet list not ready - AppKit will show its QR view; ' +
                              (device.phone ? 'this page owns the jupiter:// deep link'
                                            : 'desktop keeps the QR'));
                    }
                    return attachDisplayUri(onDisplayUri, ctx);
                }).then(function () {
                    if (done) return;

                    var attempt;
                    try {
                        attempt = walletButton.connect(wallet);
                    } catch (err) {
                        onError(err, 'connect threw: ');
                        return;
                    }
                    Promise.resolve(attempt).then(function (r) { onResult(r); },
                                                  function (e) { onError(e); })
                        .catch(function (e) { onError(e); });
                }).catch(function (err) {
                    onError(err);
                });

                function onError(err, prefix) {
                    // After a WO-2197 close, AppKit rejects with "Modal closed" - by
                    // then `done` is true and this is correctly a no-op.
                    if (done) return;
                    // WO-2197: the wallet-button's own rejection can carry the relay's
                    // refusal sentence; if it does, that is the reason, not `failed`.
                    if (classifyRelayRejection(err) === REASON.ORIGIN_NOT_ALLOWED) {
                        relayRejection = msg(err);
                        failUnavailable(REASON.ORIGIN_NOT_ALLOWED,
                            'the WalletConnect relay refused this page origin=' + (origin || 'unknown') +
                            ' via=connect-rejection detail=' + msg(err));
                        return;
                    }
                    finish(settle('refused', REASON.FAILED, (prefix || '') + msg(err)));
                }

                function onResult(result) {
                    if (done) return;
                    var addr = readAddress(result) || readAppKitAddress();
                    if (!addr) {
                        // Resolved with nothing = the modal closed without an account.
                        // A DISTINCT reason, never the SDK's ambiguous "Login cancelled".
                        finish(settle('refused', REASON.CANCELLED,
                                      'the Reown modal closed without an approved account'));
                        return;
                    }
                    address = addr;
                    closeModal();
                    if (device.phone) ensureDeepLinkChoice('connect owner=' + owner);
                    finish(settle('connected', REASON.CONNECTED, 'address=' + addr));
                }
            });

            return inFlight;
        }

        function now() {
            try { return Date.now(); } catch (e) { return 0; }
        }

        // -------------------------------------------------------------------------
        // WO-2037 add-on — SIGN A MESSAGE through the Reown session, and make the
        // request HOP to Jupiter on the same phone.
        //
        // The request itself: SolanaWalletConnectProvider.signMessage(Uint8Array) ->
        // Promise<Uint8Array> (@reown/appkit-adapter-solana 1.8.24
        // dist/esm/src/providers/SolanaWalletConnectProvider.js:67-74: it sends
        // `solana_signMessage` with the message base58-encoded and returns
        // `base58.decode(result.signature)`, i.e. the raw 64 signature bytes).
        // This returns those bytes BASE64 so the jslib/C# boundary stays a string;
        // C# base58-encodes, exactly as its Magicblock arm already does.
        //
        // The hop: WalletConnect's sign-client, on every session request, reads
        // localStorage `WALLETCONNECT_DEEPLINK_CHOICE` and, when present and the
        // document has focus, opens `<href>/wc?requestId=..&sessionTopic=..` with
        // window.open(_self) (@walletconnect/sign-client engine request ->
        // utils handleDeeplinkRedirect, read in the bundled dist). AppKit writes that
        // key only when ITS mobile view did the connect (onConnectMobile ->
        // setWcLinking -> finalizeWcConnection). A connect that went through the QR
        // (the owner's 2026-09-25 session) or through this file's own deep link never
        // wrote it, so no sign request would ever foreground Jupiter. On a phone this
        // file writes the SAME value AppKit would ({href:'jupiter://',name}) when it
        // is absent, so the sign-client's own hop runs.
        // -------------------------------------------------------------------------
        var DEEPLINK_CHOICE_KEY = 'WALLETCONNECT_DEEPLINK_CHOICE';

        function storageRef() {
            try { return opts.storage || global.localStorage || null; } catch (e) { return null; }
        }

        function readDeepLinkChoice() {
            var s = storageRef();
            if (!s) return '';
            try { return String(s.getItem(DEEPLINK_CHOICE_KEY) || ''); } catch (e) { return ''; }
        }

        function ensureDeepLinkChoice(why) {
            var s = storageRef();
            if (!s) { trace('[EoaWalletConnect] deeplink-choice unwritable (no storage) why=' + why); return false; }
            var existing = readDeepLinkChoice();
            if (existing) {
                trace('[EoaWalletConnect] deeplink-choice present why=' + why +
                      ' jupiter=' + (existing.indexOf(JUPITER_NATIVE) >= 0));
                return true;
            }
            try {
                s.setItem(DEEPLINK_CHOICE_KEY, JSON.stringify({ href: JUPITER_NATIVE, name: 'Jupiter' }));
                trace('[EoaWalletConnect] deeplink-choice set href=' + JUPITER_NATIVE + ' why=' + why);
                return true;
            } catch (e) {
                trace('[EoaWalletConnect] deeplink-choice write threw why=' + why + ' detail=' + msg(e));
                return false;
            }
        }

        function canSignMessage() {
            var p = provider();
            return !!(p && typeof p.signMessage === 'function');
        }

        // Resolves the BASE64 of the signature bytes; rejects with a named Error.
        // ⛔ Never traces the message or the signature — lengths only.
        function signMessageBase64(utf8Text) {
            var p = provider();
            if (!p || typeof p.signMessage !== 'function') {
                trace('[EoaWalletConnect] signMessage refused: no Reown provider is connected');
                return Promise.reject(new Error('no Jupiter/WalletConnect provider is connected'));
            }
            var bytes = utf8Bytes(String(utf8Text == null ? '' : utf8Text));
            var dev = classifyDevice(opts.navigator || global.navigator);
            trace('[EoaWalletConnect] signMessage requested len=' + bytes.length +
                  ' platform=' + (dev.phone ? 'phone' : 'desktop') +
                  ' deeplinkChoice=' + (readDeepLinkChoice() ? 'present' : 'absent'));
            if (dev.phone) {
                ensureDeepLinkChoice('signMessage');
                observeDeepLink('walletconnect-request');
            }
            var started = now();
            var call;
            try { call = p.signMessage(new Uint8Array(bytes)); }
            catch (e) { call = Promise.reject(e); }
            return Promise.resolve(call).then(function (sig) {
                var raw = toByteArray(sig);
                if (!raw.length) {
                    trace('[EoaWalletConnect] signMessage returned NO signature afterMs=' + (now() - started));
                    throw new Error('the wallet returned no signature');
                }
                trace('[EoaWalletConnect] signMessage signed sigBytes=' + raw.length +
                      ' afterMs=' + (now() - started));
                return bytesToBase64(raw);
            }, function (err) {
                trace('[EoaWalletConnect] signMessage refused afterMs=' + (now() - started) +
                      ' detail=' + msg(err));
                throw (err instanceof Error) ? err : new Error(msg(err));
            });
        }

        // Resolves true when the wallet-button's wallet list is loaded, false when it
        // did not arrive within `ms`, 'unknown' when the button exposes no readiness
        // API (older shapes / test fakes) — 'unknown' is treated as ready, i.e.
        // AppKit keeps the navigation, which is the pre-WO-2037 behaviour.
        function waitForWalletButton(button, ms) {
            return new Promise(function (resolve) {
                if (!button || typeof button.isReady !== 'function') { resolve('unknown'); return; }
                var settled = false;
                var t = null;
                function done(v) {
                    if (settled) return;
                    settled = true;
                    if (t) { try { clearTimeout(t); } catch (e) { /* vm realm */ } }
                    resolve(v);
                }
                try { if (button.isReady()) { done(true); return; } } catch (e) { /* fall through */ }
                try {
                    if (typeof button.subscribeIsReady === 'function') {
                        button.subscribeIsReady(function (s) { if (s && s.isReady) done(true); });
                    }
                } catch (e) { /* the timer below still settles it */ }
                try { t = setTimeout(function () { done(false); }, ms); } catch (e) { done(false); }
            });
        }

        // Subscribes `handler` to the WalletConnect UniversalProvider's
        // `display_uri` (the event that carries the `wc:` pairing uri) BEFORE the
        // connect starts, so the uri cannot be missed. Resolves when subscribed or
        // when the READY_WAIT_MS bound elapses, whichever is first; it sets
        // `ctx.detach` and `ctx.observable` itself.
        // AppKit.getUniversalProvider() is public and memoised
        // (@reown/appkit appkit-base-client.js:1595-1615).
        //
        // WO-2197: `ctx.observable` is what the no-uri watchdog judges by:
        //   'unsupported' - this AppKit has no getUniversalProvider (older shapes,
        //                   test fakes): the watchdog cannot judge and stands down.
        //   'pending'     - asked, not answered yet. If the provider arrives AFTER
        //                   the bound it is still subscribed (LATE), so a slow init
        //                   never makes the watchdog kill a working attempt.
        //   'yes'         - subscribed.
        //   'failed'      - it threw / rejected / answered no provider: no pairing
        //                   uri can arrive, so the watchdog fires.
        function attachDisplayUri(handler, ctx) {
            if (!appKit || typeof appKit.getUniversalProvider !== 'function') {
                ctx.observable = 'unsupported';
                trace('[EoaWalletConnect] display_uri not observable: AppKit exposes no getUniversalProvider');
                return Promise.resolve();
            }
            ctx.observable = 'pending';
            var got;
            try { got = appKit.getUniversalProvider(); } catch (e) {
                ctx.observable = 'failed';
                trace('[EoaWalletConnect] display_uri not observable: getUniversalProvider threw ' + msg(e));
                return Promise.resolve();
            }
            return new Promise(function (resolve) {
                var released = false;
                var bound = null;
                function release() {
                    if (released) return;
                    released = true;
                    if (bound) { try { clearTimeout(bound); } catch (e) { /* vm realm */ } bound = null; }
                    resolve();
                }
                Promise.resolve(got).then(function (up) {
                    if (!up || typeof up.on !== 'function') {
                        ctx.observable = 'failed';
                        trace('[EoaWalletConnect] display_uri not observable: no UniversalProvider');
                        release();
                        return;
                    }
                    hookRelayOnce(up);
                    if (ctx.done) { release(); return; }
                    if (released) {
                        trace('[EoaWalletConnect] display_uri subscribed LATE (after the ' + readyWaitMs +
                              'ms bound) - the watchdog keeps judging');
                    }
                    up.on('display_uri', handler);
                    ctx.observable = 'yes';
                    ctx.detach = function detach() {
                        try {
                            if (typeof up.off === 'function') up.off('display_uri', handler);
                            else if (typeof up.removeListener === 'function') up.removeListener('display_uri', handler);
                        } catch (e) { /* detaching is best effort */ }
                    };
                    release();
                }, function (err) {
                    ctx.observable = 'failed';
                    trace('[EoaWalletConnect] display_uri not observable: ' + msg(err));
                    release();
                });
                try {
                    bound = setTimeout(function () {
                        bound = null;
                        if (released) return;
                        trace('[EoaWalletConnect] UniversalProvider not ready within ' + readyWaitMs +
                              'ms - connecting anyway, still listening');
                        release();
                    }, readyWaitMs);
                } catch (e) { /* vm realm */ }
            });
        }

        // WO-2197 — ONCE per AppKit instance: listen on the relayer for the
        // refusal, and on display_uri for proof the relay works here. Both are
        // deliberately PERSISTENT (one listener each for the instance's life, never
        // one per tap) - relay facts outlive a single attempt.
        // The relayer is UniversalProvider `.client.core.relayer`, and its
        // `relayer_error` event carries the Error built in jsonrpc-provider onClose
        // for close code 3000 (both read at source in wallet-connect.bundle.js).
        function hookRelayOnce(up) {
            if (relayHooked) return;
            relayHooked = true;
            var relayer = null;
            try { relayer = up.client && up.client.core && up.client.core.relayer; } catch (e) { relayer = null; }
            var target = null;
            try {
                if (relayer && typeof relayer.on === 'function') target = relayer;
                else if (relayer && relayer.events && typeof relayer.events.on === 'function') target = relayer.events;
            } catch (e) { target = null; }
            if (target) {
                try {
                    target.on('relayer_error', onRelayError);
                    trace('[EoaWalletConnect] relay watch attached origin=' + (origin || 'unknown'));
                } catch (e) {
                    trace('[EoaWalletConnect] relay watch could not attach: ' + msg(e) +
                          ' - the no-uri watchdog is the backstop');
                }
            } else {
                trace('[EoaWalletConnect] relay errors not observable: no client.core.relayer - ' +
                      'the no-uri watchdog is the backstop');
            }
            try { up.on('display_uri', onAnyDisplayUri); } catch (e) { /* the per-attempt listener still runs */ }
        }

        function onRelayError(err) {
            var kind = classifyRelayRejection(err);
            trace('[EoaWalletConnect] relayer_error kind=' + (kind || 'other') +
                  ' origin=' + (origin || 'unknown') + ' detail=' + msg(err));
            if (kind !== REASON.ORIGIN_NOT_ALLOWED) return;
            relayRejection = msg(err);
            if (active) active.reject(relayRejection, 'relayer_error');
        }

        function onAnyDisplayUri() {
            relayProven = true;
            if (relayRejection) {
                trace('[EoaWalletConnect] relay produced a pairing uri after an earlier refusal - latch cleared');
                relayRejection = '';
            }
        }

        // WO-2197 — per ATTEMPT: a relay refusal that surfaces only as an unhandled
        // error/rejection on the page. Relay-shaped text only (looksRelayShaped).
        // Returns the detach function; cleanup() always calls it.
        function watchWindowErrors(onRefusal) {
            var win = opts.window || global;
            if (!win || typeof win.addEventListener !== 'function') return noop;
            function handle(ev, via) {
                var payload = ev && (ev.reason || ev.error || ev);
                if (!looksRelayShaped(payload)) return;
                if (classifyRelayRejection(payload) !== REASON.ORIGIN_NOT_ALLOWED) return;
                relayRejection = readText(payload);
                onRefusal(relayRejection, via);
            }
            function onRejection(ev) { handle(ev, 'unhandledrejection'); }
            function onErrorEvent(ev) { handle(ev, 'window-error'); }
            try {
                win.addEventListener('unhandledrejection', onRejection);
                win.addEventListener('error', onErrorEvent);
            } catch (e) { return noop; }
            return function detach() {
                try {
                    win.removeEventListener('unhandledrejection', onRejection);
                    win.removeEventListener('error', onErrorEvent);
                } catch (e) { /* best effort */ }
            };
        }

        // The OUTCOME instrument for a deep link: iOS backgrounds the page when it
        // switches to Jupiter, so `visibilitychange -> hidden` within the window is
        // the proof the hop happened. No hide = blocked, prompt still up, or app
        // not installed (Jupiter registers no universal link).
        function observeDeepLink(who) {
            var doc = opts.document || global.document;
            if (!doc || typeof doc.addEventListener !== 'function') {
                trace('[EoaWalletConnect] deeplink outcome=unobservable owner=' + who);
                return;
            }
            var t0 = now();
            var over = false;
            var timer = null;
            function onVis() {
                if (over) return;
                if (doc.visibilityState === 'hidden') {
                    over = true;
                    try { doc.removeEventListener('visibilitychange', onVis); } catch (e) { /* ok */ }
                    if (timer) { try { clearTimeout(timer); } catch (e) { /* vm */ } }
                    trace('[EoaWalletConnect] deeplink outcome=app-switched owner=' + who +
                          ' hiddenAfterMs=' + (now() - t0));
                }
            }
            try { doc.addEventListener('visibilitychange', onVis); } catch (e) { return; }
            try {
                timer = setTimeout(function () {
                    if (over) return;
                    over = true;
                    try { doc.removeEventListener('visibilitychange', onVis); } catch (e) { /* ok */ }
                    trace('[EoaWalletConnect] deeplink outcome=no-app-switch owner=' + who +
                          ' withinMs=' + observeMs + ' (blocked, prompt pending, or Jupiter not ' +
                          'installed) - the AppKit modal stays up as the fallback');
                }, observeMs);
            } catch (e) { /* vm realm */ }
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
            canSignMessage: canSignMessage,
            signMessageBase64: signMessageBase64,
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
        READY_WAIT_MS: READY_WAIT_MS,
        NO_URI_WATCHDOG_MS: NO_URI_WATCHDOG_MS,
        classifyRelayRejection: classifyRelayRejection,
        buildDeepLink: buildDeepLink,
        classifyDevice: classifyDevice,
        utf8Bytes: utf8Bytes,
        bytesToBase64: bytesToBase64,
        REASON: REASON
    };

    global.eoaWalletConnectCore = api;
    // Node (the regression suite) requires this file directly; browsers ignore it.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
