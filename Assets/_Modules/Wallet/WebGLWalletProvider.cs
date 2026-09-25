// WebGLWalletProvider — Wallet Standard (Magicblock) on UNITY_WEBGL only (WO-1887).
// Seeker keeps SolanaWalletProvider / MWA. Editor and Windows stay on StubWalletProvider.
#if SOLANA_SDK && UNITY_WEBGL && !UNITY_EDITOR
using System;
using Cysharp.Threading.Tasks;
using Solana.Unity.SDK;
using UnityEngine;
using UnityEngine.Networking;
using DeNelle.Core.Backend;
using DeNelle.Core.Diagnostics;

namespace DeNelle.Wallet
{
    public sealed class WebGLWalletProvider : IWalletProvider, ISwapSigningWallet
    {
        public const string JupiterInstallUrl = "https://jup.ag";

        /// <summary>
        /// WO-1958. The wallet name recorded when the session came in through the Jupiter
        /// Mobile (Reown / WalletConnect) door rather than the Wallet-Standard picker. It
        /// is a DIFFERENT name on purpose: the signing route differs (the bundle's Reown
        /// provider, not <c>window.walletAdapterLib</c>), so a trace that cannot tell them
        /// apart cannot diagnose a signature failure.
        /// </summary>
        public const string JupiterMobileWalletName = "Jupiter Mobile (WalletConnect)";

        private SolanaWalletAdapter _adapter;
        private WalletAccount _account;
        private bool _connected;

        public string ProviderName => "Solana Wallet Adapter (WebGL)";
        public bool IsConnected => _connected && _account.IsValid;
        public WalletAccount Account => _account;
        // WO-2037 add-on — the WO-1958 named gap is CLOSED here. A session that came in
        // through the Jupiter Mobile door has NO `_adapter` (Connect returns before the SDK
        // adapter is built). MEASURED consequence on the owner's iPhone (live build 385039,
        // 2026-09-25): `MintSessionAsync aborted (no signer) why=explicit-connect`, then
        // `[BackendAuth] ... no real signer available` and Order Chat asking her to sign
        // in. That session now signs through the Reown provider's
        // `signMessage(Uint8Array): Promise<Uint8Array>` (@reown/appkit-adapter-solana
        // 1.8.24, SolanaWalletConnectProvider.js:67-74) via EoaWalletBridge.jslib.
        public bool CanSignMessages =>
            _connected && (_adapter != null || (IsJupiterSession && WebGLWalletBridge.JupiterCanSignMessages()));

        private bool IsJupiterSession => _connected && _account.WalletName == JupiterMobileWalletName;

        /// <summary>
        /// WO-1957. The last sentence this provider owes the player about a connect that did not
        /// produce an account — resolved through the locale, never an English literal. Empty when
        /// there is nothing to say. Read by whatever surface asked for the connect; it is a NOTICE,
        /// not an error channel, because a handoff is a normal outcome and not a failure.
        /// </summary>
        public static string LastConnectNotice { get; private set; } = string.Empty;

        /// <summary>
        /// WO-1957. The wallet the page came back from, or an empty string — `?eoaWallet=`,
        /// written by wallet-handoff.js before the redirect and read off location.search at load.
        /// Exposed so the funnel can carry <c>source=mobile-handoff-return</c> on the EXISTING
        /// <c>store_wallet_connect_tapped</c> event. ⛔ Do NOT add a second call site for that
        /// event name — StoreFirstScreenRegression fails the build when the count is not 1.
        /// </summary>
        public static string HandoffReturnedFrom { get; private set; } = string.Empty;

        public async UniTask<WalletAccount> Connect(WalletNetwork network)
        {
            LastConnectNotice = string.Empty;

            // ================================================================
            // WO-1957 — ASK THE PAGE BEFORE OPENING A PICKER THAT CANNOT HELP.
            //
            // ⛔ THE MEASURED DEFECT, so nobody re-derives it. The CDN bundle
            // (@magicblock-labs/unity-wallet-adapter@1.2.1, read at source
            // 2026-09-22) registers `new SolflareWalletAdapter()` in EVERY browser,
            // its readyState is `Loadable` everywhere, and its connect() already does
            //     window.location.href = `https://solflare.com/ul/v1/browse/${href}?ref=${origin}`
            // when `isIosAndRedirectable()` — a gate that is TRUE on iPhone Chrome,
            // because it tests `ua.includes("iphone") && ua.includes("safari")` and
            // iOS Chrome's UA ends `Safari/604.1`. That arm is `return void(...)`, so
            // the bundle returns undefined, SolanaWalletAdapterWebGL.jslib throws
            // "Unable to connect to: …", and OnWalletConnected(null) raises
            // `Login cancelled` (SolanaWalletAdapterWebGL.cs:198).
            //
            // MEASURED, not inferred — the owner's iPhone session, web_trace
            // `wt-a73bdc1d3350`, 2026-09-22 12:12:26Z:
            //     [Flow:Wallet] Connect FAILED: Exception: Login cancelled — staying disconnected.
            // A REDIRECT AND A CANCEL ARE INDISTINGUISHABLE TO THAT CODE, which is
            // why the owner reads it as "the game can only find extension wallets".
            //
            // ⛔ AND MWA IS NOT AN ESCAPE: the bundle gates SolanaMobileWalletAdapter
            // on a literal `/android/i` test and logs "MobileWalletAdapter: Not
            // mobile" on every iPhone. No configuration reaches it from iOS.
            //
            // DESKTOP IS UNTOUCHED. `NeedsHandoff` is false whenever the browser is
            // not a phone OR a wallet is already injected (including inside a wallet's
            // own in-app browser, which is exactly where the ordinary path works), so
            // the block below is skipped and `_adapter.Login()` runs as it always has.
            // ================================================================
            WebGLWalletBridge.EnsureInstalled();
            var handoff = WebGLWalletBridge.Capability();
            HandoffReturnedFrom = handoff.ReturnedFrom ?? string.Empty;
            FlowTrace.Step("Wallet", "WebGLWalletProvider.Connect handoff capability " + handoff);

            if (!string.IsNullOrEmpty(handoff.ReturnedFrom) && !handoff.Injected)
            {
                // The interesting failure, and it gets its own line: the player DID come
                // back from the wallet app and the wallet still is not here. Guessing a
                // cause would be inference — this records the fact so the next session
                // reads it instead of re-theorising.
                FlowTrace.Warn("Wallet",
                    "WebGLWalletProvider.Connect — returned from '" + handoff.ReturnedFrom +
                    "' but NO wallet is injected on this page. The handoff round-tripped without " +
                    "landing inside the wallet's in-app browser.");
            }

            if (handoff.NeedsHandoff)
            {
                // ============================================================
                // WO-1958 — JUPITER MOBILE IS TRIED FIRST, AND WO-1957 §1g IS
                // CORRECTED, NOT SOFTENED.
                //
                // That WO said Jupiter "is deliberately NOT tried: its adapter is a
                // React hook with no UMD build and its docs describe QR scanning,
                // never a same-device deeplink". Two of those three are still true
                // and the third is FALSE, which is the whole of this ticket:
                //  - React hook: true, but @jup-ag/jup-mobile-adapter's own dist was
                //    downloaded and read 2026-09-22 and its initReownAppKit is pure
                //    vanilla (`new SolanaAdapter({wallets:[]})` + `createAppKit(...)`),
                //    and its "Jupiter Mobile" connect is literally
                //    `connectReown("jupiter")` — AppKit's wallet button, which has a
                //    framework-agnostic core export `createAppKitWalletButton`.
                //  - No UMD build: true, and WHY `npm run web:bundle` now exists.
                //  - "Never a same-device deeplink": FALSE. The WalletConnect explorer
                //    registers Jupiter with `mobile.native = "jupiter://"` (entry
                //    0ef262ca…1037, queried 2026-09-22) and AppKit's own mobile path
                //    builds `jupiter://wc?uri=<encoded>` and navigates to it. The DOCS
                //    do not claim it; the REGISTRY and the CODE do. That is the
                //    difference between "undocumented" and "not supported", and
                //    WO-1957 recorded the first as if it were the second.
                //
                // WHY FIRST: the Reown path keeps the player ON THIS PAGE — the
                // WalletConnect session survives the app switch, so the return leg is
                // a relay message rather than a full page reload inside a wallet's
                // in-app browser (which is a second, harder thing that may not even
                // boot a payload this size). The browse handoff is the fallback.
                //
                // ⚠ AND THE HONEST LIMIT: Jupiter registers NO universal link, so this
                // rides a custom scheme with no App Store fallback. An uninstalled app
                // swallows the navigation silently — which is why the bridge's timeout
                // is a reported refusal and not a hang.
                // ============================================================
                if (WebGLWalletBridge.JupiterConfigured())
                {
                    LastConnectNotice = StoreStrings.Get(StoreStrings.KeyCommerceAwaitingApproval);
                    FlowTrace.Step("Wallet",
                        "WebGLWalletProvider.Connect — phone browser, no injected wallet, Reown " +
                        "projectId present: opening the Jupiter Mobile (WalletConnect) door.");
                    var jup = await WebGLWalletBridge.ConnectJupiter();
                    if (jup.Ok)
                    {
                        _account = new WalletAccount
                        {
                            Address = jup.Address,
                            WalletName = JupiterMobileWalletName,
                        };
                        _connected = true;
                        LastConnectNotice = StoreStrings.Get(StoreStrings.KeyCommerceReady);
                        FlowTrace.Step("Wallet",
                            "WebGLWalletProvider connected via Jupiter Mobile " + _account.ShortAddress);
                        return _account;
                    }

                    // ⛔ THE REASON CODE DECIDES, NOT A BOOLEAN. A player who CLOSED the
                    // sheet must not then be thrown at a second wallet — that is hostile,
                    // and it is the mirror of the WO-1957 defect (one outcome wearing
                    // another's words). Only "the door was never really available"
                    // falls through to the browse handoff.
                    bool doorWasUnavailable = jup.Reason == "no-project-id" || jup.Reason == "no-bundle";
                    if (!doorWasUnavailable)
                    {
                        LastConnectNotice = StoreStrings.Get(StoreStrings.KeyBalanceNoWallet);
                        FlowTrace.Warn("Wallet",
                            "WebGLWalletProvider.Connect — Jupiter Mobile did not connect (" + jup +
                            "). NOT falling through to a second wallet: this outcome was the " +
                            "player's or the device's, not a missing door.");
                        _connected = false;
                        _account = default;
                        return default;
                    }
                    FlowTrace.Warn("Wallet",
                        "WebGLWalletProvider.Connect — the Jupiter door is not available on this " +
                        "build (" + jup + "). Falling through to the Solflare browse handoff.");
                }

                // Solflare is the ONE browse-deeplink target proven at source (the CDN
                // bundle, and docs.solflare.com .../other-methods/browse) that also
                // injects a provider into its in-app browser, which is what makes the
                // return leg complete.
                bool started = WebGLWalletBridge.OpenHandoff(WebGLWalletBridge.HandoffSolflare);
                LastConnectNotice = started
                    ? StoreStrings.Get(StoreStrings.KeyCommerceOpeningWallet)
                    : StoreStrings.Get(StoreStrings.KeyBalanceNoWallet);
                FlowTrace.Warn("Wallet",
                    "WebGLWalletProvider.Connect — phone browser with no injected wallet. " +
                    (started
                        ? "Handed off to Solflare; this page is navigating away and NO account is returned here."
                        : "The handoff could not start; nothing was opened and nothing was connected."));
                _connected = false;
                _account = default;
                return default;
            }
            // ================================================================

            // ⛔ BEFORE THE ADAPTER EXISTS, NOT AFTER. The browser wallet's NAME is
            // observable exactly once - as it passes through the page lib's own
            // connectWallet call - and the lib exposes no accessor for the connected
            // wallet (bundle read at source 2026-09-22) while the SDK keeps it in a
            // private static. The bridge installs a property hook so the CDN's own
            // `window.walletAdapterLib = ...` assignment lands in our setter. Installed
            // late it captures nothing, and the swap arm then REFUSES with a sentence
            // that says so rather than guessing which wallet to ask.
            WebGLWalletBridge.EnsureInstalled();

            var webGl = new SolanaWalletAdapterWebGLOptions
            {
                walletAdapterUIPrefab = Resources.Load<GameObject>("SolanaUnitySDK/WalletAdapterUI"),
                walletAdapterButtonPrefab = Resources.Load<GameObject>("SolanaUnitySDK/WalletAdapterButton"),
            };
            if (webGl.walletAdapterUIPrefab == null || webGl.walletAdapterButtonPrefab == null)
            {
                FlowTrace.Fail("Wallet",
                    "WebGLWalletProvider: SolanaUnitySDK WalletAdapter prefabs missing under Resources.");
                Application.OpenURL(JupiterInstallUrl);
                return default;
            }

            var opts = new SolanaWalletAdapterOptions
            {
                solanaWalletAdapterWebGLOptions = webGl,
            };
            // flag_12: Jupiter public API is mainnet; WalletService.DefaultNetwork is Mainnet.
            var cluster = network == WalletNetwork.Mainnet
                ? RpcCluster.MainNet
                : RpcCluster.DevNet;
            _adapter = new SolanaWalletAdapter(opts, cluster, autoConnectOnStartup: false);

            FlowTrace.Step("Wallet",
                "WebGLWalletProvider.Connect — Magicblock adapter Login (Wallet Standard picker).");
            var acc = await _adapter.Login();
            if (acc == null || acc.PublicKey == null)
            {
                FlowTrace.Warn("Wallet",
                    "WebGLWalletProvider.Connect — Login returned no account (cancelled or no wallet). Opening Jupiter install.");
                Application.OpenURL(JupiterInstallUrl);
                _connected = false;
                _account = default;
                return default;
            }

            _account = new WalletAccount
            {
                Address = acc.PublicKey.ToString(),
                WalletName = ProviderName,
            };
            _connected = true;
            FlowTrace.Step("Wallet",
                "WebGLWalletProvider connected " + _account.ShortAddress);
            return _account;
        }

        public UniTask Disconnect()
        {
            try { _adapter?.Logout(); }
            catch (Exception ex)
            {
                FlowTrace.Warn("Wallet", "WebGLWalletProvider.Logout: " + ex.Message);
            }
            _adapter = null;
            _connected = false;
            _account = default;
            return UniTask.CompletedTask;
        }

        public async UniTask<WalletBalance> GetBalance(WalletNetwork network)
        {
            var balance = default(WalletBalance);
            // WO-1948 review add-on 3: every exit that did not READ the wallet is Unknown, never
            // a known zero - the swap rail refuses on Unknown instead of claiming "have 0".
            if (!_connected || !_account.IsValid) { balance.Unknown = true; return balance; }

            // Browser CORS cannot hit public Solana RPC reliably. Our API
            // proxies getTokenAccountsByOwner (itch 2026-09-20: chip said
            // "SKR balance unavailable" because this used to return default 0).
            string url = BackendRequestSigner.BackendBase + "/api/wallet/skr-balance?address="
                         + UnityWebRequest.EscapeURL(_account.Address);
            using var req = UnityWebRequest.Get(url);
            var op = req.SendWebRequest();
            while (!op.isDone) await UniTask.Yield();
            if (req.result != UnityWebRequest.Result.Success)
            {
                FlowTrace.Warn("Wallet",
                    "WebGL GetBalance HTTP " + req.responseCode + " " + req.error + " - balance UNKNOWN (not zero).");
                balance.Unknown = true;
                return balance;
            }
            var dto = JsonUtility.FromJson<SkrBalanceDto>(req.downloadHandler.text);
            if (dto == null || !dto.ok)
            {
                FlowTrace.Warn("Wallet", "WebGL GetBalance body not ok - balance UNKNOWN (not zero).");
                balance.Unknown = true;
                return balance;
            }
            balance.Skr = dto.skr;
            FlowTrace.Step("Wallet", "WebGL GetBalance skr=" + dto.skr.ToString("0.##"));
            return balance;
        }

        [Serializable]
        private class SkrBalanceDto
        {
            public bool ok;
            public double skr;
        }

        /// <summary>
        /// The one-sheet SKR pack purchase on web. Built, signed and submitted by
        /// <see cref="WebGLPaymentBuilder"/> — the same transferChecked contract
        /// api/purchases/verify.js matches on Android, with the blockhash / ATA read /
        /// submission travelling through /api/wallet/rpc because a browser cannot call
        /// a public Solana RPC.
        /// </summary>
        /// <remarks>
        /// This method used to return a hardcoded <c>PaymentResult.Failure</c> saying the
        /// WebGL purchase was a follow-up and this path was unwired (the exact sentence is
        /// deliberately not reproduced — WebPayPathRegression's [wired] pin fails on that
        /// string, so quoting it here would fail the suite over prose),
        /// which is what made the web/itch build a ZERO-REVENUE surface: a player could
        /// connect, read a balance and sign a login, then buy nothing at all.
        /// </remarks>
        public UniTask<PaymentResult> SendPayment(
            string packSku, CurrencyKind currency, double amount, WalletNetwork network)
        {
            if (!IsConnected)
                return UniTask.FromResult(PaymentResult.Failure(
                    packSku, currency, "No wallet is connected. Nothing was charged."));
            return WebGLPaymentBuilder.SendPayment(_account.Address, packSku, currency, amount, network);
        }

        /// <summary>
        /// The Jupiter swap arm. Jupiter returns a VERSIONED (v0) transaction, which the
        /// SDK's WebGL wrapper cannot carry — it round-trips through the legacy
        /// Transaction model (SolanaWalletAdapterWebGL.cs:154-158, :220). The page-side
        /// lib handles both models (measured in the CDN bundle, 2026-09-22), so the bytes
        /// go to the browser opaque and come back opaque.
        /// </summary>
        public UniTask<(bool ok, string signature, string error)> SignAndSendSwapTransaction(
            string swapTransactionBase64, WalletNetwork network)
        {
            if (!IsConnected)
                return UniTask.FromResult((false, (string)null, "no wallet connected"));
            return WebGLPaymentBuilder.SignAndSendSwap(swapTransactionBase64, network);
        }

        public async UniTask<string> SignMessageBase58(string utf8Message)
        {
            if (string.IsNullOrEmpty(utf8Message))
                return null;
            if (_adapter == null)
            {
                if (!IsJupiterSession)
                {
                    FlowTrace.Warn("Wallet",
                        "WebGLWalletProvider.SignMessageBase58 — no Magicblock adapter and not a Jupiter " +
                        "session; nothing can sign.");
                    return null;
                }
                // WO-2037 add-on: the Jupiter (Reown / WalletConnect) arm. On a phone the
                // page persists the WalletConnect deep-link choice so the sign-client
                // foregrounds Jupiter for this request (wallet-connect.core.js).
                FlowTrace.Step("Wallet",
                    "WebGLWalletProvider.SignMessageBase58 via Jupiter (WalletConnect) len=" + utf8Message.Length);
                var jup = await WebGLWalletBridge.SignMessageJupiter(utf8Message);
                if (!jup.ok || jup.signature == null || jup.signature.Length == 0)
                {
                    FlowTrace.Warn("Wallet",
                        "WebGLWalletProvider.SignMessageBase58 via Jupiter did not sign: " + jup.error);
                    return null;
                }
                FlowTrace.Step("Wallet",
                    "WebGLWalletProvider.SignMessageBase58 via Jupiter signed sigBytes=" + jup.signature.Length);
                return Merkator.BitCoin.Base58Encoding.Encode(jup.signature);
            }
            var bytes = System.Text.Encoding.UTF8.GetBytes(utf8Message);
            var sig = await _adapter.SignMessage(bytes);
            if (sig == null || sig.Length == 0) return null;
            return Merkator.BitCoin.Base58Encoding.Encode(sig);
        }
    }
}
#endif
