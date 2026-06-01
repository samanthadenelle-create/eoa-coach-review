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
// =============================================================================

using System;
using Cysharp.Threading.Tasks;
using UnityEngine;

#if SOLANA_SDK
// SDK-VERIFY: namespaces of the Solana Unity SDK (magicblock-labs/Solana.Unity-SDK).
// Confirmed-stable across recent versions: Solana.Unity.Wallet, Solana.Unity.Rpc,
// Solana.Unity.Programs, Solana.Unity.SDK (the Web3 MonoBehaviour + adapters).
using Solana.Unity.SDK;
using Solana.Unity.Wallet;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Types;
using Solana.Unity.Programs;
using Solana.Unity.Rpc.Builders;
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
            // ── Real SDK path ────────────────────────────────────────────────
            // The Solana Unity SDK exposes a Web3 MonoBehaviour singleton that
            // owns the active wallet + RpcClient. Two login routes:
            //   * Android / Seeker  → Mobile Wallet Adapter (Seed Vault signs).
            //   * Desktop / iOS     → Phantom deep-link.
            // SDK-VERIFY: the Web3 facade + LoginWalletAdapter / LoginPhantom
            // method names. Recent SDK versions expose Web3.Instance and
            // Web3.LoginWalletAdapter() / Web3.LoginPhantom(). Confirm in the
            // resolved package; adjust here only.
            try
            {
                Account web3Account;

#if UNITY_ANDROID && !UNITY_EDITOR
                // Mobile Wallet Adapter — the Seeker's Seed Vault signs.
                // SDK-VERIFY: LoginWalletAdapter() is the MWA entry point.
                web3Account = await Web3.Instance.LoginWalletAdapter();
#else
                // Desktop / iOS — Phantom deep-link fallback.
                // SDK-VERIFY: LoginPhantom() is the deep-link entry point.
                web3Account = await Web3.Instance.LoginPhantom();
#endif
                if (web3Account == null || web3Account.PublicKey == null)
                {
                    _connected = false;
                    _account = default;
                    return default;
                }

                _account = new WalletAccount
                {
                    Address = web3Account.PublicKey.Key, // base58 string
                    WalletName = ProviderName,
                };
                _connected = true;
                Debug.Log($"[SolanaWalletProvider] Connected ({network}) — {_account.ShortAddress}.");
                return _account;
            }
            catch (Exception ex)
            {
                _connected = false;
                _account = default;
                Debug.LogError($"[SolanaWalletProvider] Connect failed: {ex.Message}");
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
                // SDK-VERIFY: Web3.Instance.Logout() is the disconnect call.
                if (Web3.Instance != null)
                    await Web3.Instance.Logout();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[SolanaWalletProvider] Disconnect failed: {ex.Message}");
            }
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

            try
            {
                var wallet = Web3.Wallet; // SDK-VERIFY: the active WalletBase
                if (wallet == null)
                    return PaymentResult.Failure(packSku, currency, "No active wallet on the SDK.");

                var rpc = ResolveRpc(network);
                var from = new PublicKey(_account.Address);
                var to = new PublicKey(recipient);

                // SDK-VERIFY: GetLatestBlockHashAsync → Result.Value.Blockhash.
                var blockHash = await rpc.GetLatestBlockHashAsync();
                if (blockHash == null || !blockHash.WasSuccessful || blockHash.Result == null)
                    return PaymentResult.Failure(packSku, currency, "Could not fetch a recent blockhash.");
                var recentBlockhash = blockHash.Result.Value.Blockhash;

                byte[] txBytes;

                if (currency == CurrencyKind.Sol)
                {
                    // ── Native SOL transfer ──────────────────────────────────
                    var lamports = UiToBaseUnits(amount, WalletEndpoints.SolDecimals);
                    // SDK-VERIFY: TransactionBuilder + SystemProgram.Transfer.
                    txBytes = new TransactionBuilder()
                        .SetRecentBlockHash(recentBlockhash)
                        .SetFeePayer(from)
                        .AddInstruction(SystemProgram.Transfer(from, to, lamports))
                        .Build(Array.Empty<Account>()); // unsigned — wallet signs below
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

                    var builder = new TransactionBuilder()
                        .SetRecentBlockHash(recentBlockhash)
                        .SetFeePayer(from);

                    // If the recipient has no ATA for this mint yet, create it
                    // (payer = sender). Harmless to always include on devnet QA.
                    // SDK-VERIFY: CreateAssociatedTokenAccount signature.
                    builder.AddInstruction(
                        AssociatedTokenAccountProgram.CreateAssociatedTokenAccount(from, to, mint));

                    // SDK-VERIFY: TokenProgram.Transfer(source, dest, amount, owner).
                    builder.AddInstruction(
                        TokenProgram.Transfer(fromAta, toAta, baseUnits, from));

                    txBytes = builder.Build(Array.Empty<Account>());
                }

                // ── Sign + send through the connected wallet ─────────────────
                // The player's wallet (Phantom / Seeker Seed Vault) signs — the
                // game holds NO key. SDK-VERIFY: WalletBase.SignAndSendTransaction
                // accepts a Transaction; if it needs a Transaction object rather
                // than raw bytes, deserialize with Transaction.Deserialize(txBytes).
                var tx = Transaction.Deserialize(txBytes);
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
                var wallet = Web3.Wallet; // SDK-VERIFY: the active WalletBase
                if (wallet == null)
                {
                    Debug.LogWarning("[SolanaWalletProvider] SignMessage: no active wallet on the SDK.");
                    return null;
                }

                var messageBytes = System.Text.Encoding.UTF8.GetBytes(utf8Message);

                // SDK-VERIFY: WalletBase.SignMessage(byte[]) → byte[] ed25519
                // signature (64 bytes). On MWA / Seed Vault this prompts the
                // player's wallet to sign the off-chain message. The game holds
                // NO key — the connected wallet signs (spec Part 10).
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
        /// Resolves an RpcClient for the network. Prefers the SDK's already-live
        /// client when it matches; otherwise builds one for the right cluster.
        /// SDK-VERIFY: ClientFactory.GetClient(string url) + Web3.Rpc.
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
                    // UiAmount is the human-readable double; fall back to raw / 10^decimals.
                    if (amt.UiAmount.HasValue)
                        total += amt.UiAmount.Value;
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
