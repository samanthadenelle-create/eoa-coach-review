// WebGLWalletProvider — Wallet Standard (Magicblock) on UNITY_WEBGL only (WO-1887).
// Seeker keeps SolanaWalletProvider / MWA. Editor and Windows stay on StubWalletProvider.
#if SOLANA_SDK && UNITY_WEBGL && !UNITY_EDITOR
using System;
using Cysharp.Threading.Tasks;
using Solana.Unity.SDK;
using UnityEngine;
using DeNelle.Core.Diagnostics;

namespace DeNelle.Wallet
{
    public sealed class WebGLWalletProvider : IWalletProvider
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

        public UniTask<WalletBalance> GetBalance(WalletNetwork network)
        {
            return UniTask.FromResult(default(WalletBalance));
        }

        public UniTask<PaymentResult> SendPayment(
            string packSku, CurrencyKind currency, double amount, WalletNetwork network)
        {
            return UniTask.FromResult(PaymentResult.Failure(
                packSku, currency,
                "WebGL pack purchase uses Jupiter swap (follow-up); SendPayment is not wired."));
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
