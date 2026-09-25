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
        FAILED: 'failed'
    };

    function noop() {}

    function createEoaWalletConnect(options) {
        var opts = options || {};
        var deps = opts.deps || {};
        var trace = typeof opts.trace === 'function' ? opts.trace : noop;
        var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        var projectId = opts.projectId ? String(opts.projectId) : '';
        var readyWaitMs = typeof opts.readyWaitMs === 'number' ? opts.readyWaitMs : READY_WAIT_MS;
        var observeMs = typeof opts.deeplinkObserveMs === 'number' ? opts.deeplinkObserveMs : DEEPLINK_OBSERVE_MS;
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

                var device = classifyDevice(opts.navigator || global.navigator);
                trace('[EoaWalletConnect] platform=' + (device.phone ? 'phone' : 'desktop') +
                      ' why=' + device.why);
                var startedAt = now();
                var uriSeen = false;
                var detachUri = noop;

                // ONE navigation owner per attempt (see header): AppKit when the
                // wallet list arrived in time, this file when it did not AND we are on
                // a phone, nobody on desktop (the QR is the desktop path).
                var owner = 'appkit';

                function onDisplayUri(uri) {
                    if (done || uriSeen) return;
                    uriSeen = true;
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
                    return attachDisplayUri(onDisplayUri);
                }).then(function (detach) {
                    if (typeof detach === 'function') detachUri = detach;
                    if (done) { detachUri(); return; }

                    var attempt;
                    try {
                        attempt = walletButton.connect(wallet);
                    } catch (err) {
                        detachUri();
                        finish(settle('refused', REASON.FAILED, 'connect threw: ' + msg(err)));
                        return;
                    }
                    Promise.resolve(attempt).then(function (r) { detachUri(); onResult(r); },
                                                  function (e) { detachUri(); onError(e); })
                        .catch(onError);
                }).catch(function (err) {
                    detachUri();
                    onError(err);
                });

                function onError(err) {
                    finish(settle('refused', REASON.FAILED, msg(err)));
                }

                function onResult(result) {
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
        // connect starts, so the uri cannot be missed. Resolves a detach function.
        // AppKit.getUniversalProvider() is public and memoised
        // (@reown/appkit appkit-base-client.js:1595-1615).
        function attachDisplayUri(handler) {
            if (!appKit || typeof appKit.getUniversalProvider !== 'function') {
                trace('[EoaWalletConnect] display_uri not observable: AppKit exposes no getUniversalProvider');
                return Promise.resolve(noop);
            }
            var got;
            try { got = appKit.getUniversalProvider(); } catch (e) { got = null; }
            var bounded = new Promise(function (resolve) {
                try { setTimeout(function () { resolve(null); }, readyWaitMs); } catch (e) { /* vm */ }
            });
            return Promise.race([Promise.resolve(got), bounded]).then(function (up) {
                if (!up || typeof up.on !== 'function') {
                    trace('[EoaWalletConnect] display_uri not observable: no UniversalProvider');
                    return noop;
                }
                up.on('display_uri', handler);
                return function detach() {
                    try {
                        if (typeof up.off === 'function') up.off('display_uri', handler);
                        else if (typeof up.removeListener === 'function') up.removeListener('display_uri', handler);
                    } catch (e) { /* detaching is best effort */ }
                };
            }, function (err) {
                trace('[EoaWalletConnect] display_uri not observable: ' + msg(err));
                return noop;
            });
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
