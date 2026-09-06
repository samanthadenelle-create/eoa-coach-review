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
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using DeNelle.Core;
using DeNelle.Core.Web3;
using DeNelle.Core.Diagnostics;
using DeNelle.Core.Platform;
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

        public static PaymentResult Indeterminate(string sku, CurrencyKind currency, double amount,
                                                   string signature, string error)
        {
            return new PaymentResult
            {
                Ok = false, PackSku = sku, Currency = currency, AmountNative = amount,
                TxSignature = signature, Error = error,
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

        /// <summary>
        /// True when this provider can ed25519-sign an arbitrary message with the
        /// connected wallet key (the real SolanaWalletProvider). False for the
        /// devnet stub, which has no key — the backend save-auth path skips the
        /// auth headers when this is false (WO-121, offline-safe).
        /// </summary>
        bool CanSignMessages { get; }

        /// <summary>
        /// ed25519-signs the EXACT UTF-8 bytes of <paramref name="utf8Message"/> with
        /// the connected wallet and returns the base58 signature, or null when the
        /// provider cannot sign / no wallet is connected. Used for the backend
        /// save-auth challenge (WO-121); the caller owns the message format.
        /// </summary>
        UniTask<string> SignMessageBase58(string utf8Message);
    }

    /// <summary>
    /// The app-facing wallet surface — the Unity analog of the React
    /// <c>useGameWallet</c> hook. Game code (the pack store, the title screen's
    /// Connect button) depends on THIS, not on <see cref="IWalletProvider"/> and
    /// never on the Solana SDK. Exposes <see cref="Connect"/>, <see cref="GetBalance"/>
    /// and <see cref="Pay"/> as the spec's three required operations (Part 3).
    /// </summary>
    public sealed class WalletService : IWalletSigner
    {
        // ── The owner-gated network constant (spec Part 10) ──────────────────
        // THIS is the single static constant the spec calls out: the v2
        // foundation runs devnet, and flipping the realm to mainnet is ONE edit
        // here — and an edit the agent never makes. It ships, and stays, Devnet.
        // Mainnet requires explicit written owner approval (Part 10).
        // ⛔ MAINNET IS THE RULED, PERMANENT STATE. DO NOT REVERT THIS LINE.
        //
        // ⚠ THE COMMENT THAT STOOD HERE UNTIL 2026-08-25 SAID THE OPPOSITE, AND FOLLOWING IT WOULD
        // NOW KILL LIVE SALES. It read "TEMPORARILY MAINNET ... REVERT TO Devnet THE MOMENT THE
        // CANARY IS DONE", and described safety as resting on a canary-only allowlist: one SKU, one
        // wallet. That was TRUE on 2026-08-23 and every clause of it is now FALSE:
        //   * the owner ruled the FULL authored ladder live (WO-1159) - 27 SKUs, $1.99-$49.99;
        //   * the server quotes every one of them on mainnet-beta (verified live 2026-08-25);
        //   * two real ladder purchases SETTLED (391 SKR each) into the 2-of-3 treasury vault;
        //   * the owner has since WITHDRAWN that revenue on chain.
        // A seat obeying the old instruction would have reverted a live, paying game to devnet while
        // believing it was following canon - the exact failure class CLAUDE.md sec.15 exists to stop,
        // and the reason a stale instruction is more dangerous than no instruction at all.
        //
        // ⛔ THE MATCHED PAIR STILL GOVERNS (CANON_GROUND_TRUTH_2026-08-23): this constant is safe at
        // Mainnet ONLY while FeatureFlags.RealmStorePurchase is true, and that flag is safe ONLY
        // while this is Mainnet. On Devnet the tokens are free test tokens and the purchase chain
        // COMPLETES - real packs granted for worthless SKR, with purchase_completed events
        // indistinguishable from real revenue. MonetizationActivationRegression pins BOTH; moving
        // either one alone turns the suite red, on purpose. Move them together or not at all.
        //
        // Depth beyond this line is unchanged: SolanaWalletProvider.SendPayment still requires the
        // SKR rail and a positive SERVER-QUOTED amount, and carries no SKU allowlist of its own
        // because the server quote is the single authority on what is sellable.
        public const WalletNetwork DefaultNetwork = WalletNetwork.Mainnet;

        // ── Treasury (devnet display only) ───────────────────────────────────
        // Public address shown for transparency (spec Week 7 "Rewards Distributor
        // display"). Sourced from docs/wallets-of-record.md §2 — the hardware-
        // backed Rewards Distributor wallet — via the canonical wallets.json
        // (WalletRegistry). Public addresses only; never a private key (Part 10).
        // The revenue-treasury wallets (§4 of wallets-of-record) are not yet
        // provisioned, so the Rewards Distributor stands in for the transparency
        // display until the Squads multisig treasuries exist.
        public static string RewardsDistributorAddress => WalletRegistry.RewardsDistributorAddress;

        private readonly IWalletProvider _provider;

        /// <summary>
        /// Hard ceiling on ONE wallet-connect handshake (seconds).
        /// <para>
        /// Mobile Wallet Adapter has no failure mode of its own for "no wallet app is
        /// installed" or "the player backgrounded the wallet and never came back" - the
        /// await simply never resolves, which on the login surface reads to the player as
        /// a frozen game. 30s matches the existing PiSignInController.Authenticate ceiling
        /// (the same shape of problem: an external app must answer) and is generous enough
        /// that a real player picking an account is never cut off.
        /// </para>
        /// <para>
        /// Counted in UNSCALED player-loop time: while the app is backgrounded (the player
        /// IS in the wallet app) Unity's loop is paused, so the budget does not burn - it
        /// resumes counting when they return. That is the intended semantic.
        /// </para>
        /// </summary>
        public const float ConnectTimeoutSeconds = 30f;

        /// <summary>
        /// Why the LAST <see cref="Connect"/> did not produce an account, in player-facing
        /// words; empty after a success. Callers surface this instead of guessing
        /// "cancelled" - a timeout and a refusal need different next steps from the player.
        /// </summary>
        public string LastConnectError { get; private set; } = string.Empty;

        /// <summary>
        /// The active Solana network. Devnet in the v2 foundation (spec Part 10),
        /// seeded from <see cref="DefaultNetwork"/>. The flip to Mainnet is
        /// owner-gated — the agent never sets this to Mainnet without written
        /// owner approval.
        /// </summary>
        public WalletNetwork Network { get; private set; } = DefaultNetwork;

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
        /// True ONLY when the connected wallet is a real, key-holding, signing wallet -
        /// never the devnet stub. This is the single attestation the save layer accepts
        /// before a wallet address may key a CLOUD identity (GameStateService.BindWallet
        /// attested overload).
        /// <para>
        /// Why it exists: the stub used to mint a plain 44-char base58 string, and the
        /// old cloud-identity test was a denylist ("does not start with guest-local-"), so
        /// a stub address read as a real player. With SOLANA_SDK missing from a build,
        /// EVERY device would have keyed the SAME cloud row. Attestation is now positive
        /// and comes from the provider, not from the shape of a string.
        /// </para>
        /// </summary>
        public bool IsRealSigningWallet =>
            IsConnected && !(_provider is StubWalletProvider) && _provider.CanSignMessages;

        // ── WO-931 (2026-08-10): payment-seam refusal reasons ────────────────
        // The save layer consults IsRealSigningWallet before keying a cloud
        // identity; until WO-931 the PAYMENT layer never did — so on any build
        // where auto-select lands on the stub (release desktop/WebGL, Android
        // without SOLANA_SDK), a fabricated SendPayment "success" flowed straight
        // into PackStore.ApplyPackContents: free packs plus a fake
        // purchase_completed analytics event. Pay/PayFlat now refuse at the seam,
        // BEFORE _provider.SendPayment, in every build configuration (Editor,
        // development and release alike — deliberately NOT #if-guarded). Public
        // consts so the regression cases assert the exact reason, not a paraphrase.
        /// <summary>WO-931: <see cref="Pay"/>/<see cref="PayFlat"/> refusal reason when the resolved provider is the devnet stub.</summary>
        public const string StubPaymentRefusalReason =
            "Payments are unavailable: the devnet stub wallet cannot make a real payment.";
        /// <summary>WO-931: refusal reason when a connected provider holds no signing key (fails <see cref="IsRealSigningWallet"/>).</summary>
        public const string NonSigningPaymentRefusalReason =
            "Payments are unavailable: the connected wallet provider holds no signing key.";

        /// <summary>
        /// Constructs the service over an explicit provider — used by tests and
        /// any caller that wants to pin the provider (e.g. force the stub).
        /// </summary>
        public WalletService(IWalletProvider provider)
        {
            _provider = provider ?? new StubWalletProvider();
        }

        /// <summary>
        /// Constructs the service and AUTO-SELECTS the provider: the real
        /// <see cref="SolanaWalletProvider"/> when the Solana Unity SDK is
        /// compiled in (the <c>SOLANA_SDK</c> scripting define is set), the
        /// devnet <see cref="StubWalletProvider"/> otherwise. So the whole
        /// wallet + store module compiles and runs end-to-end with no SDK
        /// installed, and "lights up" the real SDK the moment the integrator
        /// resolves the package and sets the define — with no caller change.
        /// </summary>
        public WalletService()
        {
            // WO-766: the real provider is selected only where it can actually
            // complete a connect - an ANDROID DEVICE build with the SDK compiled in.
            //
            // 2026-08-06 FIX (F8 capture 10:41:22, scene Title, WINDOWS standalone
            // Player.log): this test used to be
            //     SolanaWalletProvider.IsSdkAvailable && !Application.isEditor
            // on the belief - stated in the comment that lived here - that
            // "SOLANA_SDK is set for the ANDROID target group only". It is not.
            // The define comes from a platform-independent versionDefine in
            // DeNelle.Wallet.asmdef ("com.solana.unity_sdk" -> "SOLANA_SDK",
            // includePlatforms empty), NOT from ProjectSettings, so it is defined on
            // EVERY target including Standalone and WebGL. The old test therefore
            // excluded only the Editor: the Windows exe picked the real provider and
            // Connect threw NotSupportedException("...Editor/desktop use
            // StubWalletProvider") - naming a fallback that never happened. Desktop
            // Connect Wallet produced a LogError and nothing else, and because no
            // account was ever bound the save layer stayed local-only while telling
            // the log to "tap Connect Wallet once to re-attest".
            //
            // IsSupportedOnThisPlatform is compiled from the same
            // "#if SOLANA_SDK && UNITY_ANDROID && !UNITY_EDITOR" that guards the
            // working body of SolanaWalletProvider.Connect, so this branch and that
            // capability cannot drift. It also closes the identical latent hole for
            // WebGL / any future non-Android target, which the old test had too.
            //
            // NOT WEAKENED: on an Android device build the condition is unchanged -
            // SDK compiled in, not the editor - so the Seeker still gets, and only
            // gets, the real MWA provider.
            //
            // NOT A CLOUD-SYNC LOOPHOLE: the stub is still a StubWalletProvider, so
            // IsRealSigningWallet (above) stays FALSE on desktop and BindWallet is
            // called un-attested. Desktop remains LOCAL-ONLY by design - a devnet
            // stub address must never key a shared cloud save row. This change only
            // stops Connect from erroring; it grants the stub nothing.
            if (SolanaWalletProvider.IsSupportedOnThisPlatform)
            {
                _provider = new SolanaWalletProvider();
                // WO-766 safety invariant (spec s3), traced once per session:
                // the real wallet is IDENTITY + cloud-save message-signing only.
                // FeatureFlags.RealmStorePurchase stays release-gated OFF, so no
                // transfer transaction is ever constructed with purchases off.
                FlowTrace.Once("Wallet", "wo766-real-provider",
                    "SolanaWalletProvider selected - identity/save mode, purchases off " +
                    "(RealmStorePurchase release-gated; no transfer path reachable).");
                Debug.Log("[WalletService] Using SolanaWalletProvider (Solana Unity SDK compiled in).");
            }
            else
            {
                _provider = new StubWalletProvider();
                // Say WHICH of the two reasons it was. The old line claimed "Editor
                // session" for every stub selection, which is what made the desktop
                // player's mis-selection invisible until it threw (F8 2026-08-06).
                // Local-only saves are the correct outcome here, not a degradation.
                Debug.Log(SolanaWalletProvider.IsSdkAvailable
                    ? "[WalletService] Using StubWalletProvider (SDK present, but Mobile Wallet Adapter needs an " +
                      "Android device - editor/desktop/WebGL run the devnet mock; saves stay local-only)."
                    : "[WalletService] Using StubWalletProvider (Solana Unity SDK absent - devnet mock).");
            }
        }

        /// <summary>
        /// Constructs the service for a chosen provider mode. Passing
        /// <c>useStub: true</c> forces the editor/no-wallet mock even when the
        /// SDK is present — handy for offline dev and EditMode tests. The default
        /// auto-selects the real SDK provider when it is available.
        /// </summary>
        public static WalletService Create(bool useStub = false)
        {
            return useStub
                ? new WalletService(new StubWalletProvider())
                : new WalletService();
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
            using var _ = FlowTrace.Enter("Wallet", $"Connect (provider={ProviderName}, {NetworkLabel})");
            if (IsConnected) return Account;

            SetStatus(WalletStatus.Connecting);
            LastConnectError = string.Empty;

            // WO-1420: the ONLY way to tell "our deadline expired" from "the provider threw a
            // TimeoutException as its refusal shape" is to measure. Unscaled real time, because the
            // Timeout below uses UnscaledDeltaTime and a paused/slowed game must not skew the branch.
            float connectStartedAt = Time.realtimeSinceStartup;
            DateTime associationCloseBefore = TargetedLocalAssociationScenario.LastAssociationCloseUtc;
            try
            {
                // TIME-BOUNDED (security audit 2026-08-02): an unanswered MWA handshake
                // used to hang forever and froze the login surface. On expiry this throws
                // TimeoutException, which lands in the catch below as a normal failure -
                // status returns to Disconnected and the caller gets an honest reason.
                var account = await _provider.Connect(Network)
                    .Timeout(TimeSpan.FromSeconds(ConnectTimeoutSeconds), DelayType.UnscaledDeltaTime);
                SetStatus(account.IsValid ? WalletStatus.Connected : WalletStatus.Disconnected);

                // WO-121: expose this connected wallet as the backend save-auth
                // signer so GameStateService (DeNelle.Core) can sign the nonce
                // without referencing DeNelle.Wallet. The devnet stub registers
                // too but reports CanSign == false, so headers stay skipped until
                // a real signer (SolanaWalletProvider) is connected.
                if (account.IsValid)
                {
                    CoreServices.RegisterWalletSigner(this);
                    // PRIVACY (security audit 2026-08-02): log the MASKED address only.
                    // FlowTrace lines ride WebTraceSink -> api/trace.js into analytics_events
                    // AND into plaintext Vercel logs, so a full base58 pubkey here publishes
                    // the player's on-chain identity (and every transaction they ever made)
                    // to anyone with log access. ShortAddress is enough to tell two wallets
                    // apart while debugging.
                    FlowTrace.Step("Wallet", $"Connect OK — {account.ShortAddress} ({account.WalletName}).");

                    // The RETURN LEG of the connect seam (2026-08-05 Seeker capture): the
                    // connect above succeeded end to end while every view still read
                    // "Connect Wallet", because nothing ever published a CONNECTED state.
                    // Published HERE, not in a caller, because this is the single choke
                    // point BOTH connect paths pass through - the corner button
                    // (WalletSkinBootstrap) and the login surface (LoginWalletBridge).
                    CurrencySkinResolver.PublishWalletConnected(account.Address);
                }
                else
                {
                    LastConnectError = "Connect was cancelled or refused by the wallet.";
                    FlowTrace.Warn("Wallet", "Connect resolved an INVALID account — cancelled or refused; staying disconnected.");
                }

                return account;
            }
            // ⛔ WO-1420 — A TimeoutException HERE HAS TWO VERY DIFFERENT CAUSES, AND REPORTING THE
            // WRONG ONE MIS-STEERS EVERY FUTURE TRIAGE OF THIS SEAM.
            //   (a) OUR deadline expired: the wallet never answered for ConnectTimeoutSeconds.
            //   (b) The provider/MWA layer threw TimeoutException as its REFUSAL shape, long before
            //       our deadline, and UniTask.Timeout re-surfaced it (the delay promise never won
            //       the race).
            // Device capture seq 4683, 2026-09-06 00:49:31 (build 2026.09.06.357453): Connect at
            // 31.425, Fail at 31.822 - FOUR HUNDRED MILLISECONDS - while the message asserted 30 s.
            // Five wallet handlers were installed and one of them ANSWERED, closing the association
            // endpoint at 31.538. The old copy sent a reader looking for a missing wallet app.
            // Branch on measured elapsed time; nothing else can tell (a) from (b).
            catch (TimeoutException ex)
            {
                float elapsed = Time.realtimeSinceStartup - connectStartedAt;
                bool ourDeadline = elapsed >= ConnectTimeoutSeconds;

                // WO-1420 item 2: name the association close in the SAME line when it happened
                // during THIS attempt, so a triage never again has to correlate two threads by
                // timestamp. Correlation only - see LastAssociationCloseUtc's remarks.
                DateTime closedAt = TargetedLocalAssociationScenario.LastAssociationCloseUtc;
                string closeNote = closedAt > associationCloseBefore
                    ? " A wallet closed its one-shot association endpoint during this attempt, so the " +
                      "wallet app WAS reachable and answered."
                    : string.Empty;

                if (ourDeadline)
                {
                    LastConnectError = "Your wallet did not respond in " + (int)ConnectTimeoutSeconds +
                                       " seconds. Open your wallet app and try again.";
                    FlowTrace.Fail("Wallet",
                        $"Connect TIMED OUT after {elapsed:F1}s (our {ConnectTimeoutSeconds}s deadline expired - " +
                        "no wallet app installed, or the handshake was never answered) — staying disconnected." +
                        closeNote);
                }
                else
                {
                    LastConnectError = "Your wallet refused the connection. Open your wallet app and try again.";
                    FlowTrace.Fail("Wallet",
                        $"Connect REFUSED by the wallet after {elapsed:F1}s (TimeoutException raised INSIDE the " +
                        $"provider, not our {ConnectTimeoutSeconds}s deadline): {ex.Message} — staying disconnected." +
                        closeNote);
                }

                SetStatus(WalletStatus.Disconnected);
                return default;
            }
            catch (Exception ex)
            {
                LastConnectError = "Wallet connect failed (" + ex.GetType().Name + ").";
                FlowTrace.Fail("Wallet", $"Connect FAILED: {ex.GetType().Name}: {ex.Message} — staying disconnected.");
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
                FlowTrace.Fail("Wallet", $"Disconnect FAILED: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                CoreServices.UnregisterWalletSigner(this); // WO-121
                SetStatus(WalletStatus.Disconnected);
                // Same seam as the connect publish above - a view that showed the
                // connected address must fall back to its connect label, never keep
                // claiming a wallet that is gone.
                CurrencySkinResolver.PublishWalletDisconnected();
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
                FlowTrace.Fail("Wallet", $"GetBalance FAILED: {ex.GetType().Name}: {ex.Message} — returning zero balance.");
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
            using var _ = FlowTrace.Enter("Wallet", $"Pay pack='{pack?.Sku ?? "<null>"}' {currency} ({NetworkLabel})");

            if (pack == null)
            {
                FlowTrace.Fail("Wallet", "Pay: pack definition is null — payment aborted.");
                return PaymentResult.Failure(string.Empty, currency, "Pack definition is null.");
            }

            // WO-931: the stub can NEVER pay — refuse OUTRIGHT, before any
            // connection-state check, so the refusal cannot be raced by connect
            // timing and sits before the first await (the [wallet-provider]
            // regression drives this branch synchronously). This is the
            // IsConnected-free half of IsRealSigningWallet: the type test.
            if (_provider is StubWalletProvider)
            {
                FlowTrace.Fail("Wallet",
                    $"Pay '{pack.Sku}' ({currency}) REFUSED: stub provider cannot sign — no real payment " +
                    "rail on this platform (WO-931; player NOT charged, pack NOT granted).");
                return PaymentResult.Failure(pack.Sku, currency, StubPaymentRefusalReason);
            }

            if (!IsConnected)
            {
                FlowTrace.Warn("Wallet", $"Pay '{pack.Sku}' ({currency}): no wallet connected — aborted (player NOT charged).");
                return PaymentResult.Failure(pack.Sku, currency, "No wallet connected — connect a wallet first.");
            }

            var amount = pack.AmountFor(currency);
            if (amount <= 0d)
            {
                FlowTrace.Fail("Wallet", $"Pay '{pack.Sku}': no price for {currency} (amount={amount}) — payment aborted.");
                return PaymentResult.Failure(pack.Sku, currency, $"Pack '{pack.Sku}' has no price for {currency}.");
            }

            // WO-931 belt to the stub short-circuit above: with IsConnected now
            // settled, this is EXACTLY the save layer's attestation (reused, not
            // rewritten). It also closes the decorator dodge — the dev-only
            // DevWalletProbe delegates SendPayment to an INNER stub, so it passes
            // the type test above but can never attest here (CanSignMessages
            // delegates to the stub's false). No key, no payment.
            if (!IsRealSigningWallet)
            {
                FlowTrace.Fail("Wallet",
                    $"Pay '{pack.Sku}' ({currency}) REFUSED: provider '{ProviderName}' is not a real signing " +
                    "wallet (IsRealSigningWallet is false) — no key, no payment (WO-931; player NOT charged).");
                return PaymentResult.Failure(pack.Sku, currency, NonSigningPaymentRefusalReason);
            }

            try
            {
                var result = await _provider.SendPayment(pack.Sku, currency, amount, Network);
                if (!result.Ok)
                    FlowTrace.Fail("Wallet",
                        $"Pay '{pack.Sku}' ({currency}, {amount}) FAILED at provider: {result.Error}");
                else
                    FlowTrace.Step("Wallet", $"Pay '{pack.Sku}' ({currency}, {amount}) confirmed — tx {result.TxSignature}.");
                return result;
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Wallet",
                    $"Pay '{pack.Sku}' ({currency}, {amount}) THREW: {ex.GetType().Name}: {ex.Message} — outcome indeterminate.");
                return PaymentResult.Failure(pack.Sku, currency, ex.Message);
            }
        }

        /// <summary>
        /// WO7: Flat-fee payment for non-pack transactions (e.g. tower swaps).
        /// Sends <paramref name="amount"/> of <paramref name="currency"/> using
        /// the raw provider payment path, bypassing PackDef. The
        /// <paramref name="transactionId"/> is used as the SKU memo for audit logs.
        /// </summary>
        public async UniTask<PaymentResult> PayFlat(
            string       transactionId,
            CurrencyKind currency,
            double       amount)
        {
            using var _ = FlowTrace.Enter("Wallet", $"PayFlat tx='{transactionId}' {currency} amount={amount} ({NetworkLabel})");

            // WO-931: same seam as Pay. PayFlat reaches the SAME
            // StubWalletProvider.SendPayment and was gated by NOTHING (not even
            // RealmStorePurchase) — unreachable today only because both its
            // callers are scene-absent. Gate it now, while the seam is open.
            if (_provider is StubWalletProvider)
            {
                FlowTrace.Fail("Wallet",
                    $"PayFlat '{transactionId}' ({currency}) REFUSED: stub provider cannot sign — no real " +
                    "payment rail on this platform (WO-931; player NOT charged).");
                return PaymentResult.Failure(transactionId, currency, StubPaymentRefusalReason);
            }

            if (!IsConnected)
            {
                FlowTrace.Warn("Wallet", $"PayFlat '{transactionId}' ({currency}): no wallet connected — aborted (player NOT charged).");
                return PaymentResult.Failure(transactionId, currency, "No wallet connected.");
            }

            if (amount <= 0d)
            {
                FlowTrace.Fail("Wallet", $"PayFlat '{transactionId}' ({currency}): amount must be > 0 (was {amount}) — aborted.");
                return PaymentResult.Failure(transactionId, currency, "Amount must be > 0.");
            }

            // WO-931 belt (see Pay): a connected provider that cannot attest a
            // real signing key must never fabricate a "settled" flat payment.
            if (!IsRealSigningWallet)
            {
                FlowTrace.Fail("Wallet",
                    $"PayFlat '{transactionId}' ({currency}) REFUSED: provider '{ProviderName}' is not a real " +
                    "signing wallet (IsRealSigningWallet is false) — no key, no payment (WO-931).");
                return PaymentResult.Failure(transactionId, currency, NonSigningPaymentRefusalReason);
            }

            try
            {
                var result = await _provider.SendPayment(transactionId, currency, amount, Network);
                if (!result.Ok)
                    FlowTrace.Fail("Wallet",
                        $"PayFlat '{transactionId}' ({currency}, {amount}) FAILED at provider: {result.Error}");
                else
                    FlowTrace.Step("Wallet", $"PayFlat '{transactionId}' ({currency}, {amount}) confirmed — tx {result.TxSignature}.");
                return result;
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Wallet",
                    $"PayFlat '{transactionId}' ({currency}, {amount}) THREW: {ex.GetType().Name}: {ex.Message} — outcome indeterminate.");
                return PaymentResult.Failure(transactionId, currency, ex.Message);
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
                FlowTrace.Warn("Wallet", "Mainnet selected — owner-gated per spec Part 10. The v2 foundation runs devnet only.");
            Network = network;
        }

        private void SetStatus(WalletStatus status)
        {
            if (Status == status) return;
            Status = status;
            StatusChanged?.Invoke(status);
        }

        // =====================================================================
        //  IWalletSigner — backend save-auth signing seam (WO-121)
        // =====================================================================

        /// <summary>
        /// True when the underlying provider can ed25519-sign a message AND a
        /// wallet is connected. The devnet stub returns false, so the backend
        /// save-auth path skips the auth headers (offline-safe).
        /// </summary>
        bool IWalletSigner.CanSign => IsConnected && _provider.CanSignMessages;

        /// <summary>The connected wallet's base58 address (the on-chain identity = playerId).</summary>
        string IWalletSigner.WalletAddress => _provider.Account.Address;

        /// <summary>
        /// ed25519-signs the UTF-8 message with the connected wallet and returns
        /// the base58 signature (or null when it cannot sign). Delegates to the
        /// provider; the caller (GameStateService) owns the canonical message
        /// format so client + backend agree byte-for-byte.
        /// </summary>
        async Task<string> IWalletSigner.SignMessageBase58(string utf8Message)
        {
            if (!IsConnected || !_provider.CanSignMessages)
                return null;

            try
            {
                return await _provider.SignMessageBase58(utf8Message);
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Wallet", $"SignMessage FAILED: {ex.GetType().Name}: {ex.Message} — returning null (save-auth headers skipped).");
                return null;
            }
        }
    }
}
