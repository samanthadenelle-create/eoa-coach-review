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

        private SolanaWalletAdapter _adapter;
        private WalletAccount _account;
        private bool _connected;

        public string ProviderName => "Solana Wallet Adapter (WebGL)";
        public bool IsConnected => _connected && _account.IsValid;
        public WalletAccount Account => _account;
        public bool CanSignMessages => _connected && _adapter != null;

        public async UniTask<WalletAccount> Connect(WalletNetwork network)
        {
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
            if (!_connected || !_account.IsValid) return balance;

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
                    "WebGL GetBalance HTTP " + req.responseCode + " " + req.error);
                return balance;
            }
            var dto = JsonUtility.FromJson<SkrBalanceDto>(req.downloadHandler.text);
            if (dto == null || !dto.ok)
            {
                FlowTrace.Warn("Wallet", "WebGL GetBalance body not ok");
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
            if (_adapter == null || string.IsNullOrEmpty(utf8Message))
                return null;
            var bytes = System.Text.Encoding.UTF8.GetBytes(utf8Message);
            var sig = await _adapter.SignMessage(bytes);
            if (sig == null || sig.Length == 0) return null;
            return Merkator.BitCoin.Base58Encoding.Encode(sig);
        }
    }
}
#endif
