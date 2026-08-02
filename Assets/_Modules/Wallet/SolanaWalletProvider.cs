// =============================================================================
// SolanaWalletProvider — the real Solana Unity SDK IWalletProvider (Week 7)
// -----------------------------------------------------------------------------
// This is the production wallet seam. It implements IWalletProvider over the
// Solana Unity SDK (the maintained Unity C# SDK — magicblock-labs /
// Solana.Unity-SDK, the Solana Foundation Unity SDK). When the SDK package is
// resolved, WalletService routes Connect / GetBalance / Pay through here. When
// it is not, WalletService transparently falls back to StubWalletProvider.
//
// ── COMPILES WITH OR WITHOUT THE SDK ─────────────────────────────────────────
// All SDK-touching code lives inside `#if SOLANA_SDK`. The `SOLANA_SDK` scripting
// define is NOT set by the agent — the integrator adds it (Project Settings ▸
// Player ▸ Scripting Define Symbols, or a csc.rsp) once the Solana Unity SDK
// package resolves in Unity. With the define OFF, this file still compiles: the
// class exists, IsSdkAvailable returns false, and every method fails cleanly
// with a descriptive error so WalletService can pick the stub instead.
//
// This isolation is deliberate (v2-unity-port-spec.md "isolate SDK-touching
// code and guard it"): the SDK's exact API surface is volatile across versions,
// so confining every SDK call to one guarded file means an SDK-version mismatch
// breaks ONLY this file's #if block, never the whole Wallet module.
//
// ── DEVNET ONLY (spec Part 10) ───────────────────────────────────────────────
// Every call takes the WalletNetwork from WalletService (Devnet in the v2
// foundation). RPC URLs + token mints resolve through WalletEndpoints. The agent
// never selects Mainnet.
//
// ── NO SECRETS ───────────────────────────────────────────────────────────────
// The game holds NO private key. The player's own wallet — Phantom (desktop
// deep-link) or the Seeker Seed Vault via Mobile Wallet Adapter — owns the key
// and signs every transaction. This provider only builds the unsigned transfer
// and hands it to the connected wallet to sign + send.
//
// ── INTEGRATOR-VERIFY API CALLS ──────────────────────────────────────────────
// The exact SDK type/method names below are the agent's best knowledge of the
// Solana Unity SDK and are FLAGGED in docs/port-notes/week7-wallet.md. Each
// uncertain call is marked `// SDK-VERIFY:` inline. If a name differs in the
// resolved SDK version, the fix is local to this file's #if block.
//
// WO-766 SWEEP (2026-08-02): every marker was re-checked statically against
// the PINNED package (magicblock-labs/Solana.Unity-SDK v1.2.9; see
// Packages/manifest.json) by reading the SDK sources (Web3.cs, WalletBase.cs).
// Items now annotated "VERIFIED (v1.2.9)" are confirmed; drift found and FIXED:
//   * LoginPhantom() does not exist in v1.2.9 - desktop branch removed
//     (desktop/editor stay on StubWalletProvider; SOLANA_SDK is Android-only).
//   * Web3.Logout() is synchronous void, not awaitable.
//   * Web3.Instance is a scene MonoBehaviour singleton nothing created -
//     EnsureWeb3Host() now lazily creates + configures it before login.
//   * Tx build switched from TransactionBuilder.Build(empty)+Deserialize to
//     the SDK-documented Transaction-model + SignAndSendTransaction pattern.
// Markers that remain SDK-VERIFY could not be confirmed without a package
// resolve - the orchestrator's compile gate surfaces any residue there.
//
// WO-766 SAFETY INVARIANT (spec s3): this provider is used for IDENTITY +
// cloud-save MESSAGE-signing only. The only transfer-constructing code in the
// wallet module is SendPayment below, and it is UNREACHABLE in release:
// PackStore.Purchase refuses when FeatureFlags.RealmStorePurchase is OFF (the
// release default) before anything can reach WalletService.Pay/PayFlat.
// Connect + SignMessage are gasless and move no funds.
// =============================================================================

using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;
using UnityEngine;

#if SOLANA_SDK
// VERIFIED (v1.2.9): Solana.Unity.SDK (Web3 facade), Solana.Unity.Wallet
// (Account, PublicKey, WalletBase), Solana.Unity.Rpc (IRpcClient,
// ClientFactory). Solana.Unity.Rpc.Models carries Transaction /
// TransactionInstruction / SignaturePubKeyPair for the SDK-documented
// sign-and-send pattern (replaces the old Rpc.Builders TransactionBuilder use).
// SDK-VERIFY: Solana.Unity.Programs member signatures (SystemProgram /
// TokenProgram / AssociatedTokenAccountProgram) - see markers in SendPayment.
using Solana.Unity.SDK;
using Solana.Unity.Wallet;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Types;
using Solana.Unity.Rpc.Models;
using Solana.Unity.Programs;
#endif

namespace DeNelle.Wallet
{
    /// <summary>
    /// The production <see cref="IWalletProvider"/> over the Solana Unity SDK.
    /// Connects a real wallet (Mobile Wallet Adapter on Android/Seeker, Phantom
    /// deep-link on desktop), reads SOL / USDC / SKR balances, and builds + sends
    /// the pack-purchase transfer on devnet.
    /// </summary>
    public sealed class SolanaWalletProvider : IWalletProvider
    {
        /// <summary>
        /// True when the Solana Unity SDK is compiled in (the <c>SOLANA_SDK</c>
        /// scripting define is set). When false, <see cref="WalletService"/>
        /// falls back to <see cref="StubWalletProvider"/>.
        /// </summary>
        public static bool IsSdkAvailable
        {
#if SOLANA_SDK
            get => true;
#else
            get => false;
#endif
        }

        private WalletAccount _account;
        private bool _connected;

        /// <inheritdoc/>
        public string ProviderName => "Solana Wallet";

        /// <inheritdoc/>
        public bool IsConnected => _connected;

        /// <inheritdoc/>
        public WalletAccount Account => _account;

        // =====================================================================
        //  Connect / Disconnect
        // =====================================================================

        /// <inheritdoc/>
        public async UniTask<WalletAccount> Connect(WalletNetwork network)
        {
#if SOLANA_SDK
            // -- Real SDK path (Android / Mobile Wallet Adapter ONLY, WO-766) --
            // VERIFIED (v1.2.9 Web3.cs): Web3.Instance is the facade singleton;
            // Task<Account> LoginWalletAdapter() is the MWA entry point (Seed
            // Vault / Phantom / Solflare on-device). LoginPhantom() does NOT
            // exist in v1.2.9 - the old desktop deep-link branch was drift and
            // is removed; desktop + editor stay on StubWalletProvider (the
            // SOLANA_SDK define is set for the Android target group only, and
            // WalletService keeps the stub in the Editor).
            try
            {
#if UNITY_ANDROID && !UNITY_EDITOR
                // The Web3 facade is a scene MonoBehaviour - ensure it exists
                // and is pointed at the right cluster BEFORE the login call
                // (nothing in the project authored one; Web3.Instance would be
                // null and the login would NRE).
                EnsureWeb3Host(network);

                // Mobile Wallet Adapter - the wallet app / Seed Vault signs.
                // VERIFIED (v1.2.9): Web3.Instance.LoginWalletAdapter().
                // (`var` deliberately: avoids any Account-type name collision
                // between Solana.Unity.Wallet and Solana.Unity.Rpc.Models.)
                var web3Account = await Web3.Instance.LoginWalletAdapter();

                if (web3Account == null || web3Account.PublicKey == null)
                {
                    _connected = false;
                    _account = default;
                    FlowTrace.Warn("Wallet",
                        "MWA login returned no account - user cancelled or no wallet app responded.");
                    return default;
                }

                _account = new WalletAccount
                {
                    Address = web3Account.PublicKey.Key, // base58 string
                    WalletName = ProviderName,
                };
                _connected = true;
                FlowTrace.Step("Wallet",
                    $"SolanaWalletProvider connected ({network}) - {_account.ShortAddress}.");
                return _account;
#else
                // SDK compiled in but not an Android device build (this is the
                // Editor with the Android target active, or a future target
                // that sets SOLANA_SDK). v1.2.9 has no desktop deep-link API
                // and MWA needs a device - fail loudly instead of calling an
                // API that does not exist. WalletService never selects this
                // provider off-device, so this is defense in depth.
                await UniTask.CompletedTask;
                throw new NotSupportedException(
                    "SolanaWalletProvider supports Android Mobile Wallet Adapter only (WO-766). " +
                    "Editor/desktop use StubWalletProvider.");
#endif
            }
            catch (Exception ex)
            {
                _connected = false;
                _account = default;
                FlowTrace.Fail("Wallet",
                    $"SolanaWalletProvider.Connect FAILED: {ex.GetType().Name}: {ex.Message}");
                throw;
            }
#else
            // ── SDK absent ───────────────────────────────────────────────────
            // WalletService should never construct this provider when the SDK
            // is absent (it checks IsSdkAvailable first), but guard anyway.
            await UniTask.CompletedTask;
            throw new InvalidOperationException(
                "Solana Unity SDK is not installed (SOLANA_SDK define unset). " +
                "Use StubWalletProvider for editor / no-wallet testing.");
#endif
        }

        /// <inheritdoc/>
        public async UniTask Disconnect()
        {
#if SOLANA_SDK
            try
            {
                // VERIFIED (v1.2.9 Web3.cs): Logout() is a SYNCHRONOUS void
                // method - the old `await Web3.Instance.Logout()` was drift.
                // (An async Task DisconnectWalletAdapter() also exists; plain
                // Logout() covers the session teardown this seam needs.)
                if (Web3.Instance != null)
                    Web3.Instance.Logout();
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Wallet",
                    $"SolanaWalletProvider.Disconnect FAILED: {ex.GetType().Name}: {ex.Message}");
            }
            await UniTask.CompletedTask;
#else
            await UniTask.CompletedTask;
#endif
            _connected = false;
            _account = default;
        }

        // =====================================================================
        //  GetBalance — SOL / USDC / SKR
        // =====================================================================

        /// <inheritdoc/>
        public async UniTask<WalletBalance> GetBalance(WalletNetwork network)
        {
#if SOLANA_SDK
            if (!_connected || !_account.IsValid)
            {
                Debug.LogWarning("[SolanaWalletProvider] GetBalance with no wallet connected.");
                return default;
            }

            var balance = new WalletBalance();
            try
            {
                var rpc = ResolveRpc(network);
                var owner = new PublicKey(_account.Address);

                // ── Native SOL ───────────────────────────────────────────────
                // SDK-VERIFY: IRpcClient.GetBalanceAsync(string) → RequestResult
                // whose Result.Value is lamports (ulong).
                var solResult = await rpc.GetBalanceAsync(owner.Key);
                if (solResult != null && solResult.WasSuccessful && solResult.Result != null)
                    balance.Sol = LamportsToUi(solResult.Result.Value, WalletEndpoints.SolDecimals);

                // ── SPL tokens — USDC / SKR ──────────────────────────────────
                balance.Usdc = await ReadSplBalance(rpc, owner,
                    WalletEndpoints.UsdcMint(network), WalletEndpoints.UsdcDecimals);

                var skrMint = WalletEndpoints.SkrMint(network);
                if (!string.IsNullOrEmpty(skrMint))
                    balance.Skr = await ReadSplBalance(rpc, owner, skrMint, WalletEndpoints.SkrDecimals);
                // else: SKR devnet mint not yet provisioned — leave 0 (week7-wallet.md).
            }
            catch (Exception ex)
            {
                Debug.LogError($"[SolanaWalletProvider] GetBalance failed: {ex.Message}");
            }
            return balance;
#else
            await UniTask.CompletedTask;
            throw new InvalidOperationException("Solana Unity SDK is not installed (SOLANA_SDK define unset).");
#endif
        }

        // =====================================================================
        //  SendPayment — the devnet pack-purchase transfer
        // =====================================================================

        /// <inheritdoc/>
        public async UniTask<PaymentResult> SendPayment(
            string packSku, CurrencyKind currency, double amount, WalletNetwork network)
        {
#if SOLANA_SDK
            if (!_connected || !_account.IsValid)
                return PaymentResult.Failure(packSku, currency, "No wallet connected.");

            // GUARDRAIL (spec Part 10): devnet only. The agent never sets
            // WalletService.ActiveNetwork to Mainnet, but defend in depth here.
            if (network == WalletNetwork.Mainnet)
                return PaymentResult.Failure(packSku, currency,
                    "Mainnet payment blocked — the v2 foundation is devnet-only (spec Part 10).");

            // The pack-purchase recipient. The §4 Squads multisig revenue
            // treasuries are not yet provisioned, so devnet transfers land in the
            // documented dev/staging smoke-test wallet (wallets.json).
            var recipient = WalletRegistry.DevnetPurchaseRecipientAddress;
            if (string.IsNullOrEmpty(recipient))
                return PaymentResult.Failure(packSku, currency, "No devnet purchase recipient configured.");

            // WO-766 SAFETY: this is the ONLY transfer-constructing code in the
            // wallet module, and it is UNREACHABLE in release builds -
            // PackStore.Purchase refuses when FeatureFlags.RealmStorePurchase
            // is OFF (release default) before anything can reach
            // WalletService.Pay/PayFlat. Kept compiled for the later payments WO.
            try
            {
                var wallet = Web3.Wallet; // VERIFIED (v1.2.9): static WalletBase
                if (wallet == null)
                    return PaymentResult.Failure(packSku, currency, "No active wallet on the SDK.");

                var rpc = ResolveRpc(network);
                var from = new PublicKey(_account.Address);
                var to = new PublicKey(recipient);

                // SDK-VERIFY: GetLatestBlockHashAsync -> Result.Value.Blockhash.
                var blockHash = await rpc.GetLatestBlockHashAsync();
                if (blockHash == null || !blockHash.WasSuccessful || blockHash.Result == null)
                    return PaymentResult.Failure(packSku, currency, "Could not fetch a recent blockhash.");
                var recentBlockhash = blockHash.Result.Value.Blockhash;

                // WO-766: build the UNSIGNED transaction with the SDK-documented
                // pattern - a Solana.Unity.Rpc.Models.Transaction with an
                // Instructions list, handed to WalletBase.SignAndSendTransaction
                // (VERIFIED v1.2.9: Task<RequestResult<string>>
                // SignAndSendTransaction(Transaction, bool skipPreflight,
                // Commitment)). This replaces the old
                // TransactionBuilder.Build(empty signers) + Deserialize hack,
                // which produced a zero-signature serialization the SDK never
                // documents round-tripping.
                // SDK-VERIFY: Transaction model property names
                // (RecentBlockHash / FeePayer / Instructions / Signatures).
                var tx = new Transaction
                {
                    RecentBlockHash = recentBlockhash,
                    FeePayer = from,
                    Instructions = new List<TransactionInstruction>(),
                    Signatures = new List<SignaturePubKeyPair>(),
                };

                if (currency == CurrencyKind.Sol)
                {
                    // ── Native SOL transfer ──────────────────────────────────
                    var lamports = UiToBaseUnits(amount, WalletEndpoints.SolDecimals);
                    // SDK-VERIFY: SystemProgram.Transfer(PublicKey, PublicKey, ulong).
                    tx.Instructions.Add(SystemProgram.Transfer(from, to, lamports));
                }
                else
                {
                    // ── SPL-token transfer — USDC / SKR ──────────────────────
                    var mintStr = WalletEndpoints.MintFor(currency, network);
                    if (string.IsNullOrEmpty(mintStr))
                        return PaymentResult.Failure(packSku, currency,
                            $"{currency} mint not configured for {network} — see WalletEndpoints / week7-wallet.md.");

                    var mint = new PublicKey(mintStr);
                    var decimals = WalletEndpoints.DecimalsFor(currency);
                    var baseUnits = UiToBaseUnits(amount, decimals);

                    // Associated Token Accounts for sender + recipient.
                    // SDK-VERIFY: AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount.
                    var fromAta = AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount(from, mint);
                    var toAta = AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount(to, mint);

                    // If the recipient has no ATA for this mint yet, create it
                    // (payer = sender). Harmless to always include on devnet QA.
                    // SDK-VERIFY: CreateAssociatedTokenAccount(payer, owner, mint).
                    tx.Instructions.Add(
                        AssociatedTokenAccountProgram.CreateAssociatedTokenAccount(from, to, mint));

                    // SDK-VERIFY: TokenProgram.Transfer(source, dest, amount, owner).
                    tx.Instructions.Add(
                        TokenProgram.Transfer(fromAta, toAta, baseUnits, from));
                }

                // ── Sign + send through the connected wallet ─────────────────
                // The player's wallet (Phantom / Seeker Seed Vault) signs — the
                // game holds NO key.
                var sendResult = await wallet.SignAndSendTransaction(tx);

                if (sendResult == null || !sendResult.WasSuccessful || string.IsNullOrEmpty(sendResult.Result))
                {
                    var err = sendResult != null ? sendResult.Reason : "unknown error";
                    return PaymentResult.Failure(packSku, currency, $"Transaction submission failed — {err}.");
                }

                var signature = sendResult.Result;

                // ── Await devnet confirmation ────────────────────────────────
                var confirmed = await ConfirmTransaction(rpc, signature);
                if (!confirmed)
                    return PaymentResult.Failure(packSku, currency,
                        $"Transaction {signature} did not confirm in time.");

                Debug.Log($"[SolanaWalletProvider] Devnet tx confirmed — {packSku}: {amount} {currency}, sig {signature}.");
                return PaymentResult.Success(packSku, currency, amount, signature);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[SolanaWalletProvider] SendPayment failed: {ex.Message}");
                return PaymentResult.Failure(packSku, currency, ex.Message);
            }
#else
            await UniTask.CompletedTask;
            throw new InvalidOperationException("Solana Unity SDK is not installed (SOLANA_SDK define unset).");
#endif
        }

        // =====================================================================
        //  Message signing (WO-121) — backend save-auth ed25519 signature
        // =====================================================================

        /// <inheritdoc/>
        public bool CanSignMessages
        {
#if SOLANA_SDK
            // A real key is available once a wallet is connected via the SDK.
            get => _connected && _account.IsValid;
#else
            get => false;
#endif
        }

        /// <inheritdoc/>
        public async UniTask<string> SignMessageBase58(string utf8Message)
        {
#if SOLANA_SDK
            if (!_connected || !_account.IsValid)
                return null;
            if (string.IsNullOrEmpty(utf8Message))
                return null;

            try
            {
                var wallet = Web3.Wallet; // VERIFIED (v1.2.9): static WalletBase
                if (wallet == null)
                {
                    Debug.LogWarning("[SolanaWalletProvider] SignMessage: no active wallet on the SDK.");
                    return null;
                }

                var messageBytes = System.Text.Encoding.UTF8.GetBytes(utf8Message);

                // VERIFIED (v1.2.9 WalletBase.cs): abstract Task<byte[]>
                // SignMessage(byte[] message) - the 64-byte ed25519 signature.
                // On MWA / Seed Vault this prompts the player's wallet to sign
                // the off-chain message. The game holds NO key - the connected
                // wallet signs (spec Part 10). This is the WO-766 identity/save
                // auth path (dotr-save:v1 challenge, GameStateService).
                var sigBytes = await wallet.SignMessage(messageBytes);
                if (sigBytes == null || sigBytes.Length == 0)
                {
                    Debug.LogWarning("[SolanaWalletProvider] SignMessage returned no signature.");
                    return null;
                }

                // The backend expects the signature base58-encoded. Use the SDK's
                // own base58 encoder so it round-trips with bs58.decode server-side.
                // SDK-VERIFY: Solana.Unity.Wallet.Utilities.Encoders.Base58.EncodeData.
                return new Solana.Unity.Wallet.Utilities.Base58Encoder().EncodeData(sigBytes);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[SolanaWalletProvider] SignMessage failed: {ex.Message}");
                return null;
            }
#else
            await UniTask.CompletedTask;
            return null; // SDK absent — cannot sign; caller skips auth headers.
#endif
        }

#if SOLANA_SDK
        // =====================================================================
        //  SDK helpers — all behind the SOLANA_SDK guard
        // =====================================================================

        /// <summary>
        /// WO-766: the SDK's Web3 facade is a MonoBehaviour singleton that must
        /// exist in a scene BEFORE any Login* call - nothing in this project
        /// authored one, so <c>Web3.Instance</c> would be null and the MWA login
        /// would NRE. Creates + configures a persistent host lazily.
        /// VERIFIED (v1.2.9 Web3.cs): serialized fields rpcCluster / customRpc /
        /// webSocketsRpc / autoConnectOnStartup exist with these names.
        /// SDK-VERIFY: their accessibility (public vs [SerializeField] private) -
        /// if the gate flags access, configure via a Resources prefab instead
        /// and keep only the existence check here. NO reflection (CLAUDE.md s10).
        /// SDK-VERIFY: RpcCluster member names (DevNet / MainNet).
        /// </summary>
        private static void EnsureWeb3Host(WalletNetwork network)
        {
            if (Web3.Instance != null) return;

            var host = new GameObject("Web3 (WO-766 SolanaWalletProvider)");
            UnityEngine.Object.DontDestroyOnLoad(host);
            var web3 = host.AddComponent<Web3>();

            web3.rpcCluster = network == WalletNetwork.Mainnet ? RpcCluster.MainNet : RpcCluster.DevNet;
            web3.customRpc = WalletEndpoints.RpcUrl(network);
            web3.webSocketsRpc = WalletEndpoints.WsUrl(network);
            web3.autoConnectOnStartup = false;

            FlowTrace.Step("Wallet",
                $"Web3 host created for {network} (rpc={WalletEndpoints.RpcUrl(network)}).");
        }

        /// <summary>
        /// Resolves an RpcClient for the network. Prefers the SDK's already-live
        /// client when it matches; otherwise builds one for the right cluster.
        /// VERIFIED (v1.2.9): Web3.Rpc is a static IRpcClient.
        /// SDK-VERIFY: ClientFactory.GetClient(string url) overload.
        /// </summary>
        private static IRpcClient ResolveRpc(WalletNetwork network)
        {
            var url = WalletEndpoints.RpcUrl(network);
            // Reuse the SDK's client if Web3 is live; else build a fresh one.
            if (Web3.Rpc != null)
                return Web3.Rpc;
            return ClientFactory.GetClient(url);
        }

        /// <summary>
        /// Reads one SPL token balance for an owner + mint. Returns 0 when the
        /// owner has no token account for the mint (an un-funded rail).
        /// SDK-VERIFY: GetTokenAccountsByOwnerAsync filtered by mint, and the
        /// TokenAmount.UiAmount / UiAmountString field on the result.
        /// </summary>
        private static async UniTask<double> ReadSplBalance(
            IRpcClient rpc, PublicKey owner, string mint, int decimals)
        {
            if (string.IsNullOrEmpty(mint)) return 0d;
            try
            {
                var accounts = await rpc.GetTokenAccountsByOwnerAsync(owner.Key, mint);
                if (accounts == null || !accounts.WasSuccessful ||
                    accounts.Result == null || accounts.Result.Value == null)
                    return 0d;

                double total = 0d;
                foreach (var acc in accounts.Result.Value)
                {
                    var amt = acc.Account.Data.Parsed.Info.TokenAmount;
                    if (amt == null) continue;
                    // UiAmount is the human-readable amount; the explicit cast
                    // compiles whether the SDK types it double? or decimal?
                    // (SDK-VERIFY: TokenBalance.UiAmount numeric type).
                    // Fall back to raw / 10^decimals.
                    if (amt.UiAmount.HasValue)
                        total += (double)amt.UiAmount.Value;
                    else if (ulong.TryParse(amt.Amount, out var raw))
                        total += LamportsToUi(raw, decimals);
                }
                return total;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SolanaWalletProvider] SPL balance read failed for mint {mint}: {ex.Message}");
                return 0d;
            }
        }

        /// <summary>
        /// Polls the RPC until the transaction reaches a confirmed/finalized
        /// commitment, or a timeout elapses. Devnet finality is ~1–2s; we poll
        /// for up to ~30s. SDK-VERIFY: GetSignatureStatusesAsync result shape.
        /// </summary>
        private static async UniTask<bool> ConfirmTransaction(IRpcClient rpc, string signature)
        {
            const int maxAttempts = 30;
            const int pollMs = 1000;
            for (var i = 0; i < maxAttempts; i++)
            {
                try
                {
                    var status = await rpc.GetSignatureStatusesAsync(
                        new System.Collections.Generic.List<string> { signature }, true);
                    if (status != null && status.WasSuccessful &&
                        status.Result != null && status.Result.Value != null &&
                        status.Result.Value.Count > 0)
                    {
                        var s = status.Result.Value[0];
                        if (s != null)
                        {
                            if (!string.IsNullOrEmpty(s.ConfirmationStatus) &&
                                (s.ConfirmationStatus == "confirmed" || s.ConfirmationStatus == "finalized"))
                                return s.Error == null;
                        }
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[SolanaWalletProvider] Confirmation poll {i} failed: {ex.Message}");
                }
                await UniTask.Delay(pollMs);
            }
            return false;
        }
#endif

        // =====================================================================
        //  Pure unit-conversion helpers — no SDK types, always compiled
        // =====================================================================

        /// <summary>Converts a base-unit integer (lamports / token base units) to a UI double.</summary>
        private static double LamportsToUi(ulong baseUnits, int decimals)
        {
            return baseUnits / System.Math.Pow(10d, decimals);
        }

        /// <summary>Converts a UI amount to base units (lamports / token base units).</summary>
        private static ulong UiToBaseUnits(double amount, int decimals)
        {
            if (amount <= 0d) return 0UL;
            var scaled = System.Math.Round(amount * System.Math.Pow(10d, decimals),
                MidpointRounding.AwayFromZero);
            if (scaled < 0d) return 0UL;
            return (ulong)scaled;
        }
    }
}
