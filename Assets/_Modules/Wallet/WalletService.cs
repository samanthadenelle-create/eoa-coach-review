// =============================================================================
// WalletService — the app-facing wallet surface (spec Part 3 wallet row, Week 7)
// -----------------------------------------------------------------------------
// C# port of src/modules/wallet/ (useGameWallet.ts + walletConfig.ts). The React
// hook wraps @solana/wallet-adapter-react; the Unity port wraps the Solana Unity
// SDK. The SDK is NOT installed yet — its install is deferred to Week 7 (see the
// unity-decisions.md row dated 2026-05-18). So WalletService talks to an
// IWalletProvider INTERFACE, and the only provider shipped today is the
// devnet-mock StubWalletProvider. When the SDK lands, a SolanaWalletProvider
// implementing IWalletProvider slots in with NO change to WalletService or any
// caller — the seam is the interface.
//
// Devnet-only by design: spec Part 10 forbids real-mainnet transactions; the
// WalletNetwork enum ships as Devnet and the flip to Mainnet is owner-gated.
//
// Async: every wallet operation returns UniTask (never async void) per the
// port-spec "async UniTask" mandate (Part 3).
// =============================================================================

using System;
using Cysharp.Threading.Tasks;
using UnityEngine;

namespace DeNelle.Wallet
{
    /// <summary>
    /// The Solana cluster the wallet talks to. Devnet only in the v2 foundation
    /// (spec Part 10 — mainnet is owner-gated). Flipping <see cref="WalletService.Network"/>
    /// to <see cref="Mainnet"/> requires explicit owner approval.
    /// </summary>
    public enum WalletNetwork
    {
        /// <summary>Free test SOL — the only network used in the v2 foundation.</summary>
        Devnet = 0,
        /// <summary>Real-money mainnet — owner-gated, never selected by the agent.</summary>
        Mainnet = 1,
    }

    /// <summary>The currency rail a pack is paid in. Mirrors monetization-v2-spec §4.</summary>
    public enum CurrencyKind
    {
        /// <summary>Native SOL transfer.</summary>
        Sol = 0,
        /// <summary>USDC SPL-token transfer.</summary>
        Usdc = 1,
        /// <summary>SKR SPL-token transfer — the Solana Seeker phone's native token.</summary>
        Skr = 2,
    }

    /// <summary>Connection lifecycle state, mirrors the React hook's connected/connecting pair.</summary>
    public enum WalletStatus
    {
        /// <summary>No wallet connected.</summary>
        Disconnected = 0,
        /// <summary>A connection handshake is in progress.</summary>
        Connecting = 1,
        /// <summary>A wallet is connected and an address is available.</summary>
        Connected = 2,
    }

    /// <summary>
    /// A connected wallet's identity. The address is a plain base58 string — the
    /// player's on-chain identity — never a raw key object (React parity:
    /// useGameWallet exposes <c>address</c> as a base58 string, not a PublicKey).
    /// </summary>
    [Serializable]
    public struct WalletAccount
    {
        /// <summary>The base58 wallet address. This IS the player's on-chain identity.</summary>
        public string Address;
        /// <summary>Display name of the connected wallet (e.g. "Phantom", "Devnet Stub").</summary>
        public string WalletName;

        public bool IsValid => !string.IsNullOrEmpty(Address);

        /// <summary>Short <c>AbCd…WxYz</c> form for compact UI, or empty when no address.</summary>
        public string ShortAddress
        {
            get
            {
                if (string.IsNullOrEmpty(Address) || Address.Length < 8) return Address ?? string.Empty;
                return $"{Address.Substring(0, 4)}…{Address.Substring(Address.Length - 4)}";
            }
        }
    }

    /// <summary>Per-currency balances of the connected wallet (lamports converted to SOL etc.).</summary>
    [Serializable]
    public struct WalletBalance
    {
        /// <summary>SOL balance (native, in whole SOL — not lamports).</summary>
        public double Sol;
        /// <summary>USDC balance (in whole USDC).</summary>
        public double Usdc;
        /// <summary>SKR balance (in whole SKR).</summary>
        public double Skr;

        /// <summary>Returns the balance for one rail.</summary>
        public double For(CurrencyKind currency)
        {
            switch (currency)
            {
                case CurrencyKind.Sol: return Sol;
                case CurrencyKind.Usdc: return Usdc;
                case CurrencyKind.Skr: return Skr;
                default: return 0d;
            }
        }
    }

    /// <summary>
    /// The outcome of a <see cref="WalletService.Pay"/> call — a settled or failed
    /// devnet transaction. <see cref="Ok"/> with a non-empty <see cref="TxSignature"/>
    /// means the transfer confirmed; the pack store then applies the contents.
    /// </summary>
    [Serializable]
    public struct PaymentResult
    {
        /// <summary>True when the transfer was submitted and confirmed.</summary>
        public bool Ok;
        /// <summary>The base58 transaction signature, or empty on failure.</summary>
        public string TxSignature;
        /// <summary>The SKU of the pack that was paid for.</summary>
        public string PackSku;
        /// <summary>The rail the pack was paid in.</summary>
        public CurrencyKind Currency;
        /// <summary>The native amount transferred (SOL / USDC / SKR units).</summary>
        public double AmountNative;
        /// <summary>Human-readable failure reason, or empty on success.</summary>
        public string Error;

        public static PaymentResult Failure(string sku, CurrencyKind currency, string error)
        {
            return new PaymentResult { Ok = false, PackSku = sku, Currency = currency, Error = error };
        }

        public static PaymentResult Success(string sku, CurrencyKind currency, double amount, string signature)
        {
            return new PaymentResult
            {
                Ok = true,
                PackSku = sku,
                Currency = currency,
                AmountNative = amount,
                TxSignature = signature,
            };
        }
    }

    /// <summary>
    /// The Solana-specific seam. <see cref="WalletService"/> depends on this
    /// interface, never on the SDK directly. Two implementations are foreseen:
    ///   * <see cref="StubWalletProvider"/> — devnet mock, shipped now (no SDK).
    ///   * SolanaWalletProvider — wraps the Solana Unity SDK, lands Week 7 when
    ///     the SDK is installed. Its <see cref="Connect"/> opens Mobile Wallet
    ///     Adapter on Android/Seeker and a deep-link flow on iOS/desktop.
    /// Every method returns UniTask so the SDK's real async calls drop in cleanly.
    /// </summary>
    public interface IWalletProvider
    {
        /// <summary>A short display name for the provider (UI / diagnostics).</summary>
        string ProviderName { get; }

        /// <summary>True once a wallet is connected and an address is available.</summary>
        bool IsConnected { get; }

        /// <summary>The connected account, or an invalid <see cref="WalletAccount"/> when disconnected.</summary>
        WalletAccount Account { get; }

        /// <summary>
        /// Opens the wallet-connect flow and resolves with the connected account.
        /// On a real provider: MWA on Android/Seeker, deep-link on iOS/desktop.
        /// </summary>
        UniTask<WalletAccount> Connect(WalletNetwork network);

        /// <summary>Disconnects the current wallet. Safe to call when already disconnected.</summary>
        UniTask Disconnect();

        /// <summary>Reads the connected wallet's SOL / USDC / SKR balances on the given network.</summary>
        UniTask<WalletBalance> GetBalance(WalletNetwork network);

        /// <summary>
        /// Builds, signs and sends a transfer of <paramref name="amount"/> in
        /// <paramref name="currency"/> to the treasury, then awaits confirmation.
        /// Devnet only in the v2 foundation.
        /// </summary>
        UniTask<PaymentResult> SendPayment(string packSku, CurrencyKind currency, double amount, WalletNetwork network);
    }

    /// <summary>
    /// The app-facing wallet surface — the Unity analog of the React
    /// <c>useGameWallet</c> hook. Game code (the pack store, the title screen's
    /// Connect button) depends on THIS, not on <see cref="IWalletProvider"/> and
    /// never on the Solana SDK. Exposes <see cref="Connect"/>, <see cref="GetBalance"/>
    /// and <see cref="Pay"/> as the spec's three required operations (Part 3).
    /// </summary>
    public sealed class WalletService
    {
        // ── Treasury (devnet display only) ───────────────────────────────────
        // Public address shown for transparency (spec Week 7 "Rewards Distributor
        // display"). Pulled from docs/wallets-of-record.md §2 — the hardware-backed
        // Rewards Distributor wallet. Public addresses only; never a private key
        // (spec Part 10). The revenue-treasury wallets (§4 of wallets-of-record)
        // are not yet provisioned, so the Rewards Distributor stands in for the
        // transparency display until the Squads multisig treasuries exist.
        public const string RewardsDistributorAddress = "2JRmEmrqUbhTiHX3u5bes5kHYZeZkJ2V1cMWubxwnmNi";

        private readonly IWalletProvider _provider;

        /// <summary>
        /// The active Solana network. Devnet in the v2 foundation (spec Part 10).
        /// A single static-style flip to Mainnet is owner-gated — the agent never
        /// sets this to Mainnet without written owner approval.
        /// </summary>
        public WalletNetwork Network { get; private set; } = WalletNetwork.Devnet;

        /// <summary>Human-readable label for the active network — used by UI badges.</summary>
        public string NetworkLabel => Network == WalletNetwork.Mainnet ? "Mainnet" : "Devnet";

        /// <summary>Raised whenever the connection status changes (connected / disconnected).</summary>
        public event Action<WalletStatus> StatusChanged;

        /// <summary>The current connection status.</summary>
        public WalletStatus Status { get; private set; } = WalletStatus.Disconnected;

        /// <summary>True once a wallet is connected and an address is available.</summary>
        public bool IsConnected => Status == WalletStatus.Connected && _provider.IsConnected;

        /// <summary>The connected account, or an invalid <see cref="WalletAccount"/> when disconnected.</summary>
        public WalletAccount Account => _provider.Account;

        /// <summary>The provider backing this service (the stub today, the SDK at Week 7).</summary>
        public string ProviderName => _provider.ProviderName;

        /// <summary>
        /// Constructs the service over a provider. With no argument, ships the
        /// devnet <see cref="StubWalletProvider"/> — everything compiles and runs
        /// without the Solana Unity SDK. Pass a real provider once the SDK lands.
        /// </summary>
        public WalletService(IWalletProvider provider = null)
        {
            _provider = provider ?? new StubWalletProvider();
        }

        // =====================================================================
        //  Connect / Disconnect
        // =====================================================================

        /// <summary>
        /// Opens the wallet-connect flow (React parity: <c>useGameWallet.connect</c>).
        /// On a real provider this routes through Mobile Wallet Adapter on the
        /// Seeker or a deep-link wallet on iOS/desktop. Resolves with the connected
        /// account; on failure, status returns to <see cref="WalletStatus.Disconnected"/>.
        /// </summary>
        public async UniTask<WalletAccount> Connect()
        {
            if (IsConnected) return Account;

            SetStatus(WalletStatus.Connecting);
            try
            {
                var account = await _provider.Connect(Network);
                SetStatus(account.IsValid ? WalletStatus.Connected : WalletStatus.Disconnected);
                return account;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[WalletService] Connect failed: {ex.Message}");
                SetStatus(WalletStatus.Disconnected);
                return default;
            }
        }

        /// <summary>Disconnects the current wallet (React parity: <c>useGameWallet.disconnect</c>).</summary>
        public async UniTask Disconnect()
        {
            try
            {
                await _provider.Disconnect();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[WalletService] Disconnect failed: {ex.Message}");
            }
            finally
            {
                SetStatus(WalletStatus.Disconnected);
            }
        }

        // =====================================================================
        //  GetBalance
        // =====================================================================

        /// <summary>
        /// Reads the connected wallet's SOL / USDC / SKR balances. Returns a zero
        /// balance (and logs) when no wallet is connected.
        /// </summary>
        public async UniTask<WalletBalance> GetBalance()
        {
            if (!IsConnected)
            {
                Debug.LogWarning("[WalletService] GetBalance called with no wallet connected.");
                return default;
            }

            try
            {
                return await _provider.GetBalance(Network);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[WalletService] GetBalance failed: {ex.Message}");
                return default;
            }
        }

        // =====================================================================
        //  Pay — the pack-purchase transaction
        // =====================================================================

        /// <summary>
        /// Pays for a pack in the chosen currency rail: builds, signs and sends a
        /// transfer to the treasury on the active (devnet) network and awaits
        /// confirmation. The pack store calls this, then — on <see cref="PaymentResult.Ok"/>
        /// — applies the pack contents to GameState.
        /// </summary>
        /// <param name="pack">The pack being purchased.</param>
        /// <param name="currency">The rail to pay in (SOL / USDC / SKR).</param>
        public async UniTask<PaymentResult> Pay(PackDef pack, CurrencyKind currency)
        {
            if (pack == null)
                return PaymentResult.Failure(string.Empty, currency, "Pack definition is null.");

            if (!IsConnected)
                return PaymentResult.Failure(pack.Sku, currency, "No wallet connected — connect a wallet first.");

            var amount = pack.AmountFor(currency);
            if (amount <= 0d)
                return PaymentResult.Failure(pack.Sku, currency, $"Pack '{pack.Sku}' has no price for {currency}.");

            try
            {
                return await _provider.SendPayment(pack.Sku, currency, amount, Network);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[WalletService] Pay failed: {ex.Message}");
                return PaymentResult.Failure(pack.Sku, currency, ex.Message);
            }
        }

        // =====================================================================
        //  Network — owner-gated
        // =====================================================================

        /// <summary>
        /// Switches the active network. Selecting <see cref="WalletNetwork.Mainnet"/>
        /// is gated by spec Part 10: the agent never does this without written
        /// owner approval. Provided so an owner can flip it deliberately.
        /// </summary>
        public void SetNetwork(WalletNetwork network)
        {
            if (network == WalletNetwork.Mainnet)
                Debug.LogWarning("[WalletService] Mainnet selected — owner-gated per spec Part 10. The v2 foundation runs devnet only.");
            Network = network;
        }

        private void SetStatus(WalletStatus status)
        {
            if (Status == status) return;
            Status = status;
            StatusChanged?.Invoke(status);
        }
    }
}
