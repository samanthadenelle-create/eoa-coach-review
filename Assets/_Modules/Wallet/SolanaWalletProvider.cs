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
using System.Text;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;

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

        /// <summary>
        /// True ONLY where this provider can actually complete a connect: an
        /// Android DEVICE build with the SDK compiled in. Everything else -
        /// Windows/macOS/Linux standalone, WebGL, and the Editor on any target -
        /// must use <see cref="StubWalletProvider"/>.
        /// <para>
        /// WHY THIS EXISTS (F8 capture 2026-08-06 10:41:22, scene Title, WINDOWS
        /// standalone Player.log): the desktop exe selected THIS provider and then
        /// threw NotSupportedException out of Connect - "Editor/desktop use
        /// StubWalletProvider" - while doing no such thing. Tapping Connect Wallet
        /// on desktop produced a LogError and nothing else.
        /// </para>
        /// <para>
        /// The selector at WalletService.cs was written as
        /// <c>IsSdkAvailable AND NOT Application.isEditor</c> on the stated belief
        /// that "SOLANA_SDK is set for the ANDROID target group only". THAT BELIEF
        /// IS FALSE. ProjectSettings.asset lists SOLANA_SDK under Android and NOT
        /// under Standalone (scriptingDefineSymbols), but the define does not come
        /// from there at all - it comes from a PLATFORM-INDEPENDENT versionDefine in
        /// Assets/_Modules/Wallet/DeNelle.Wallet.asmdef ("com.solana.unity_sdk" ->
        /// "SOLANA_SDK", with includePlatforms empty). The package resolves on every
        /// target, so SOLANA_SDK is defined on EVERY target. IsSdkAvailable is
        /// therefore true in the Windows player, isEditor is false in any player,
        /// and the real provider got picked on a platform it cannot serve.
        /// </para>
        /// <para>
        /// The fix is to test the PLATFORM, not the define. This predicate is
        /// compiled from the EXACT same condition that guards the working body of
        /// <see cref="Connect"/> below, so selection and capability can never drift
        /// apart again - if one is true the other is true, by construction.
        /// </para>
        /// </summary>
        public static bool IsSupportedOnThisPlatform
        {
#if SOLANA_SDK && UNITY_ANDROID && !UNITY_EDITOR
            get => true;
#else
            get => false;
#endif
        }

        private WalletAccount _account;
        private bool _connected;

#if SOLANA_SDK
        // MWA auth token from the last successful authorize/reauthorize. Lets a
        // follow-up sign_messages call REAUTHORIZE instead of re-prompting the
        // player for a fresh grant.
        //
        // 2026-08-17: this field used to be commented "Session-scoped only - never
        // persisted", and that WAS the defect. The owner connected on her Seeker,
        // force-quit, relaunched, and was asked to connect again: on relaunch this
        // was null, so there was no grant to reauthorize against and MWA ran a full
        // `authorize` - which IS the connect prompt. Her SAVE came back, because
        // GameState.BoundWallet is persisted and keys the row; identity survived a
        // restart, the session did not.
        //
        // It is now MIRRORED into MwaSessionStore, which seals it under an
        // AndroidKeyStore AES-256/GCM key before it touches PlayerPrefs and binds it
        // to the address it was issued for. This field remains the in-process copy;
        // the store is the across-launch copy. Read the MwaSessionStore header for
        // the full security rationale - in one line: the token is a capability
        // grant, so it is never written in plaintext, never logged, and destroyed on
        // disconnect.
        private string _authToken;
#endif

        // =====================================================================
        //  DAPP IDENTITY (2026-08-05 - THE wallet-connect root cause)
        // ---------------------------------------------------------------------
        //  MWA wallets VERIFY the calling dapp: they take the identity.uri we
        //  send in `authorize`, fetch <identityUri>/.well-known/assetlinks.json,
        //  and look for an `android_app` statement naming our package + signing
        //  certificate. Per the MWA spec a wallet SHOULD decline with
        //  ERROR_AUTHORIZATION_FAILED (-1) when the caller cannot be verified.
        //
        //  We were shipping the SDK's DEFAULT identity "https://solana.unity-sdk.gg/"
        //  (SolanaMobileWalletAdapter.cs:18-21) because the options object was
        //  constructed bare. That host returns HTTP 404 for
        //  /.well-known/assetlinks.json - so NO wallet could ever verify us and
        //  every connect died with -1. Latency proved it: 6.76s first attempt
        //  (remote fetch -> 404) collapsing to ~1.1s on retries (cached negative).
        //
        //  The statement is now served by api/assetlinks.js, rewritten onto
        //  /.well-known/assetlinks.json in vercel.json. If you change the host
        //  here you MUST move that endpoint with it.
        // =====================================================================

        /// <summary>
        /// The dapp identity URI sent to the wallet. MUST be ABSOLUTE - the SDK
        /// client throws ArgumentException otherwise
        /// (MobileWalletAdapterClient.cs:62-65) - and MUST be the host that
        /// actually serves /.well-known/assetlinks.json.
        /// </summary>
        public const string DappIdentityUri = "https://defenders-of-the-realm-v2.vercel.app/";

        /// <summary>
        /// Dapp icon, RELATIVE to <see cref="DappIdentityUri"/>. MUST be relative -
        /// the SDK client throws ArgumentException on an absolute icon Uri
        /// (MobileWalletAdapterClient.cs:66-69).
        /// <para>
        /// 2026-08-06 BRANDING FIX - two defects lived in the old value "/icon.png":
        /// </para>
        /// <para>
        /// (1) NOTHING SERVED IT. vercel.json publishes "Builds/WebGL" as the static
        /// root and that output carries only Build/, StreamingAssets/, index.html and
        /// validation-key.txt - there is no icon.png anywhere on the host, and no
        /// public/ directory exists (an outputDirectory project does not serve one).
        /// The wallet's icon fetch therefore 404'd, and an MWA wallet that cannot
        /// load the dapp icon falls back to its OWN generic/placeholder art - which
        /// is exactly the "SDK branding, not ours" the owner saw. The icon is now
        /// served by api/icon.js (the game's real 144px app icon) through the
        /// /icon.png rewrite in vercel.json, mirroring the assetlinks pattern.
        /// </para>
        /// <para>
        /// (2) LEADING SLASH. The MWA spec defines this field as a path RELATIVE TO
        /// the identity URI, and the Android reference wallets resolve it by
        /// APPENDING to that URI rather than by RFC-3986 reference resolution. A
        /// leading "/" then yields a doubled slash ("https://host//icon.png"). The
        /// SDK's own default carries the same slash (SolanaMobileWalletAdapter.cs:19)
        /// and is equally wrong. Solana Mobile's published dapp sample uses a bare
        /// "favicon.ico". Bare relative path it is - it resolves correctly under BOTH
        /// append-style and RFC-style resolution.
        /// </para>
        /// Best-effort display only: a missing icon never fails authorization, it
        /// only costs us the branding.
        /// </summary>
        public const string DappIconUri = "icon.png";

        /// <summary>Player-facing name shown in the wallet's approval sheet (owner-approved).</summary>
        public const string DappIdentityName = "Echoes of Elarion";

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
            // Desktop + editor stay on StubWalletProvider: v1.2.9 has no desktop
            // deep-link API (LoginPhantom does NOT exist) and WalletService keeps
            // the stub in the Editor.
            // 2026-08-05: the authorize handshake no longer goes through
            // Web3.Instance.LoginWalletAdapter() - see the block below. Web3 is
            // still created (EnsureWeb3Host) because it owns the RPC clients.
            try
            {
#if UNITY_ANDROID && !UNITY_EDITOR
                // The Web3 facade is a scene MonoBehaviour - ensure it exists
                // and is pointed at the right cluster BEFORE the login call
                // (nothing in the project authored one; Web3.Instance would be
                // null and the login would NRE).
                // Still required: the Web3 facade owns the RPC/streaming clients
                // that GetBalance + SendPayment resolve through, and the
                // options-graph instantiation below is load-bearing for those.
                EnsureWeb3Host(network);

                // =====================================================
                //  STEP 1 - SILENT RESUME (2026-08-17, the relaunch fix)
                // -----------------------------------------------------
                //  If a sealed grant survives from a previous launch, spend
                //  one `reauthorize` round-trip on it FIRST. A valid token
                //  re-establishes the dapp<->account link with NO approval
                //  sheet, so the returning player never sees a connect
                //  prompt. Everything about this step is best-effort: no
                //  stored token, an expired/revoked one, a different wallet,
                //  a wallet that will not answer - every one of them falls
                //  through to the full authorize below. There is no path on
                //  which a failed resume leaves the player unable to connect.
                // =====================================================
                var storedToken = MwaSessionStore.Load(BoundWalletAddressOrEmpty());
                if (!string.IsNullOrEmpty(storedToken))
                {
                    var resumed = await TryResumeSession(storedToken, network);
                    if (resumed.IsValid) return resumed;
                    // Deliberate fall-through: STEP 2 prompts, exactly as before.
                    FlowTrace.Step("Wallet",
                        "MWA silent resume did not produce an account - falling back to a full authorize (player will be prompted).");
                }

                // =====================================================
                //  STEP 2 - FULL AUTHORIZE (the original, unchanged path)
                // =====================================================
                // Mobile Wallet Adapter - the wallet app / Seed Vault signs.
                //
                // 2026-08-05: this NO LONGER goes through
                // Web3.Instance.LoginWalletAdapter(). That path builds an
                // IMPLICIT association intent, so Android elects the winner among
                // every installed handler - on the owner's Seeker that is Jupiter,
                // and the Seeker's own wallet is never offered. Owner ruling:
                // "Seeker should use seeker wallet ... make sure that's the
                // primary before trying to use another one."
                // TargetedLocalAssociationScenario is a clone of the SDK scenario
                // that adds queryIntentActivities + Intent.setPackage() against a
                // DATA preference chain, and falls back to the implicit intent
                // when no preferred wallet is installed.
                var scenario = new TargetedLocalAssociationScenario();
                var authorization = await scenario.Authorize(
                    DappIdentityUri, DappIconUri, DappIdentityName, ClusterName(network));

                if (authorization == null || authorization.PublicKey == null)
                {
                    _connected = false;
                    _account = default;
                    _authToken = null;
                    FlowTrace.Warn("Wallet",
                        "MWA authorize returned no account - user cancelled or no wallet app responded.");
                    return default;
                }

                // AuthorizationResult.PublicKey is the BASE64-decoded address
                // BYTES (AuthorizationResult.cs) - wrap it to get base58.
                var publicKey = new PublicKey(authorization.PublicKey);
                _authToken = authorization.AuthToken;

                _account = new WalletAccount
                {
                    Address = publicKey.Key, // base58 string
                    WalletName = ProviderName,
                };
                _connected = true;

                // Seal the fresh grant BOUND TO THIS ADDRESS so the next launch can
                // resume silently. Failure to persist is never fatal - it costs one
                // prompt next time and says so in the trace (MwaSessionStore.Save).
                MwaSessionStore.Save(_authToken, _account.Address);

                FlowTrace.Step("Wallet",
                    $"SolanaWalletProvider connected ({network}) - {_account.ShortAddress}.");
                return _account;
#else
                // SDK compiled in but not an Android device build (the Editor, or
                // a Standalone/WebGL player - the asmdef versionDefine sets
                // SOLANA_SDK on every target). v1.2.9 has no desktop deep-link API
                // and MWA needs a device, so fail loudly instead of calling an API
                // that does not exist.
                //
                // This is now GENUINELY defense in depth: WalletService selects on
                // IsSupportedOnThisPlatform, which is compiled from this exact same
                // #if, so nothing off-device can reach here. Until 2026-08-06 the
                // selector used the SDK define instead and the Windows exe DID reach
                // here - see IsSupportedOnThisPlatform for the capture.
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
                _authToken = null;
                FlowTrace.Fail("Wallet",
                    $"SolanaWalletProvider.Connect FAILED: {ex.GetType().Name}: {ex.Message}");
                var hint = ExplainConnectFailure(ex);
                if (hint != null) FlowTrace.Fail("Wallet", hint);
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
                _authToken = null; // drop the MWA grant with the session
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
            // A player who disconnects must ACTUALLY be disconnected: drop the
            // persisted grant and destroy the keystore key that sealed it, so no
            // later launch can silently resume this wallet. Outside the SDK #if on
            // purpose - an explicit disconnect revokes the stored session in every
            // build configuration, not only where the SDK compiled in.
            MwaSessionStore.Clear("explicit disconnect");

            _connected = false;
            _account = default;
        }

        // =====================================================================
        //  Silent resume (2026-08-17) — the relaunch fix
        // =====================================================================

#if SOLANA_SDK && UNITY_ANDROID && !UNITY_EDITOR
        /// <summary>
        /// The wallet address this device's save is bound to, or empty when the
        /// save is not (yet) keyed by a real wallet.
        /// <para>
        /// ONE AUTHORITY, no second notion of "the current wallet":
        /// <c>GameState.BoundWallet</c> is the save key, and
        /// <c>GameStateService.IsCloudIdentityShaped</c> is the same gate the save
        /// layer already applies to decide whether that value is a wallet address
        /// at all. A local guest key ("guest-local-...") is NOT a wallet, so it
        /// contributes no binding - and that is safe, because the address the
        /// wallet returns from the reauthorize is checked against the address
        /// stored beside the token regardless.
        /// </para>
        /// </summary>
        private static string BoundWalletAddressOrEmpty()
        {
            return Guard.Try("Wallet", "read bound wallet for session binding", () =>
            {
                var bound = DeNelle.Core.State.GameStateService.Instance?.State?.BoundWallet;
                return DeNelle.Core.State.GameStateService.IsCloudIdentityShaped(bound) ? bound : string.Empty;
            }, string.Empty);
        }

        /// <summary>
        /// Spends one MWA <c>reauthorize</c> on a persisted grant. Returns the
        /// connected account on success, or an invalid account on ANY failure -
        /// in which case the caller falls through to a full authorize.
        /// <para>
        /// A failure here is ORDINARY, not exceptional: MWA tokens are revocable
        /// wallet-side and can expire, the player may have switched wallets, or the
        /// wallet app may simply not answer. Every one of those clears the stored
        /// session and costs exactly one connect prompt - the behaviour we had
        /// before this path existed.
        /// </para>
        /// </summary>
        private async UniTask<WalletAccount> TryResumeSession(string storedToken, WalletNetwork network)
        {
            AuthorizationResult reauth;
            try
            {
                var scenario = new TargetedLocalAssociationScenario();
                reauth = await scenario.Reauthorize(
                    DappIdentityUri, DappIconUri, DappIdentityName, storedToken);
            }
            catch (Exception ex)
            {
                // NOTE: the message may name the JSON-RPC failure but never the
                // token - nothing in this file interpolates the grant into a string.
                FlowTrace.Warn("Wallet",
                    $"MWA reauthorize FAILED ({ex.GetType().Name}: {ex.Message}) - discarding the stored session.");
                MwaSessionStore.Clear("reauthorize failed - grant revoked, expired, or the wallet did not answer");
                return default;
            }

            if (reauth == null || reauth.PublicKey == null)
            {
                MwaSessionStore.Clear("reauthorize returned no account");
                return default;
            }

            var address = new PublicKey(reauth.PublicKey).Key;

            // THE BINDING CHECK, applied to the WALLET'S OWN ANSWER. A token
            // silently accepted for a different wallet would cross-key the cloud
            // save row - the worst outcome in this system. Refuse and re-prompt.
            if (!MwaSessionStore.MatchesStoredWallet(address))
            {
                MwaSessionStore.Clear(
                    $"reauthorize answered as {MwaSessionStore.Mask(address)}, which is NOT the wallet the grant " +
                    "was issued for - refusing to resume");
                return default;
            }

            // The wallet MAY rotate the token on reauthorize (the MWA spec allows a
            // new auth_token in the response); keep whichever one we now hold.
            _authToken = string.IsNullOrEmpty(reauth.AuthToken) ? storedToken : reauth.AuthToken;
            _account = new WalletAccount
            {
                Address = address,
                WalletName = ProviderName,
            };
            _connected = true;
            MwaSessionStore.Save(_authToken, address);

            FlowTrace.Step("Wallet",
                $"SolanaWalletProvider RESUMED silently ({network}) - {_account.ShortAddress}, no connect prompt.");
            return _account;
        }
#endif

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
                    balance.Skr = await ReadSplBalance(rpc, owner, skrMint, WalletEndpoints.SkrDecimals(network));
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

#if MAINNET_CANARY_TEST
            if (network == WalletNetwork.Mainnet &&
                (!string.Equals(packSku, PurchaseGate.MainnetCanarySku, StringComparison.Ordinal) ||
                 currency != CurrencyKind.Skr ||
                 !string.Equals(_account.Address, MainnetCanaryCatalog.OwnerWallet, StringComparison.Ordinal)))
                return PaymentResult.Failure(packSku, currency,
                    "Mainnet payment refused: this build authorizes only the owner 1 SKR canary.");
#else
            // GUARDRAIL (spec Part 10): devnet only. The agent never sets
            // WalletService.ActiveNetwork to Mainnet, but defend in depth here.
            if (network == WalletNetwork.Mainnet)
                return PaymentResult.Failure(packSku, currency,
                    "Mainnet payment blocked — the v2 foundation is devnet-only (spec Part 10).");

            // The pack-purchase recipient. The §4 Squads multisig revenue
            // treasuries are not yet provisioned, so devnet transfers land in the
            // documented dev/staging smoke-test wallet (wallets.json).
#endif
            var recipient = network == WalletNetwork.Mainnet
                ? WalletRegistry.MainnetPurchaseRecipientAddress
                : WalletRegistry.DevnetPurchaseRecipientAddress;
            if (string.IsNullOrEmpty(recipient))
                return PaymentResult.Failure(packSku, currency,
                    $"No owner-approved {network} purchase recipient configured.");

            // WO-766 SAFETY: this is the ONLY transfer-constructing code in the
            // wallet module, and it is UNREACHABLE in release builds -
            // PackStore.Purchase refuses when FeatureFlags.RealmStorePurchase
            // is OFF (release default) before anything can reach
            // WalletService.Pay/PayFlat. Kept compiled for the later payments WO.
            try
            {
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
                    var decimals = WalletEndpoints.DecimalsFor(currency, network);
                    var baseUnits = UiToBaseUnits(amount, decimals);

                    // Associated Token Accounts for sender + recipient.
                    // SDK-VERIFY: AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount.
                    var fromAta = AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount(from, mint);
                    var toAta = AssociatedTokenAccountProgram.DeriveAssociatedTokenAccount(to, mint);

                    // Create the recipient ATA only when it does not exist. The SDK version in this
                    // build exposes the legacy create instruction, not create-idempotent; emitting
                    // it unconditionally makes every payment after the first fail preflight.
                    var recipientAta = await rpc.GetAccountInfoAsync(toAta.Key, Commitment.Confirmed);
                    if (recipientAta == null || !recipientAta.WasSuccessful || recipientAta.Result == null)
                        return PaymentResult.Failure(packSku, currency,
                            "Could not verify the recipient token account; no payment was submitted.");
                    if (recipientAta.Result.Value == null)
                        tx.Instructions.Add(
                            AssociatedTokenAccountProgram.CreateAssociatedTokenAccount(from, to, mint));

                    // Checked transfer pins the mint and decimals into the signed instruction. The
                    // backend independently requires the identical parsed transferChecked shape.
                    tx.Instructions.Add(TokenProgram.TransferChecked(
                        fromAta, toAta, baseUnits, decimals, from, mint));
                }

                // ── Sign + send through the connected wallet ─────────────────
                // The player's wallet (Phantom / Seeker Seed Vault) signs — the
                // game holds NO key.
                // MON-1147: sign through the same TARGETED MWA association that established the
                // connected identity. Web3.Wallet is intentionally absent on this connection path;
                // reviving it would reintroduce implicit wallet election and could ask a different
                // wallet to sign. The returned wire payload contains the wallet signature but no key.
                // MWA requires a fully formed wire transaction: its signature vector must contain
                // one 64-byte placeholder for each required signer. WalletBase.SignTransaction does
                // this through Transaction.Sign(Account) before invoking an external wallet. This
                // targeted path bypasses WalletBase, so mirror that SDK step with the public-only
                // account; it creates the fee-payer placeholder without possessing a private key.
                tx.Sign(new Account(string.Empty, from));
                var scenario = new TargetedLocalAssociationScenario();
                var signedWire = await scenario.SignTransaction(
                    DappIdentityUri, DappIconUri, DappIdentityName,
                    ClusterName(network), _authToken, tx.Serialize());
                if (signedWire == null || signedWire.Length == 0)
                    return PaymentResult.Failure(packSku, currency,
                        "Wallet returned no signed transaction (cancelled or refused).");

                // Capture the deterministic signature before transport. If RPC accepts the wire
                // but its response is lost, PackStore can still persist and reconcile this receipt.
                if (!TryReadPrimarySignature(signedWire, out string signedSignature))
                    return PaymentResult.Failure(packSku, currency,
                        "Wallet returned a malformed signed transaction; nothing was submitted.");

                // The pinned SDK collapses some HTTP/RPC failures into the opaque string
                // "Unable to parse json", discarding the node response. Use explicit JSON-RPC
                // so the signed transaction is submitted once and refusals stay diagnosable.
                var submitted = await SubmitSignedTransaction(
                    WalletEndpoints.RpcUrl(network), signedWire);

                if (string.IsNullOrEmpty(submitted.signature))
                {
                    return PaymentResult.Indeterminate(packSku, currency, amount, signedSignature,
                        "Transaction submission outcome is unknown. Reconcile this receipt; do not pay again.");
#if false
                    var err = submitted.error;
                    return PaymentResult.Failure(packSku, currency, $"Transaction submission failed — {err}.");
                    #endif
                }

                var signature = submitted.signature;
                if (!string.Equals(signature, signedSignature, StringComparison.Ordinal))
                    return PaymentResult.Indeterminate(packSku, currency, amount, signedSignature,
                        "RPC returned a different signature. Reconcile the wallet-signed receipt; do not pay again.");

                // ── Await devnet confirmation ────────────────────────────────
                // RPC acceptance is the handoff point, not entitlement authority. Return the
                // signature immediately so PackStore persists it before any finality wait. The
                // authenticated backend independently requires finalized chain data and exact
                // signer/recipient/mint/decimals/amount before granting.

                Debug.Log($"[SolanaWalletProvider] Devnet tx submitted — {packSku}: {amount} {currency}, sig {signature}; backend finality required.");
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

#if SOLANA_SDK
        private static bool TryReadPrimarySignature(byte[] wire, out string signature)
        {
            signature = null;
            if (wire == null || wire.Length < 65) return false;
            int offset = 0, count = 0, shift = 0;
            byte current;
            do
            {
                if (offset >= wire.Length || shift > 21) return false;
                current = wire[offset++];
                count |= (current & 0x7f) << shift;
                shift += 7;
            } while ((current & 0x80) != 0);
            if (count < 1 || offset + 64 > wire.Length) return false;
            var bytes = new byte[64];
            Buffer.BlockCopy(wire, offset, bytes, 0, bytes.Length);
            bool any = false;
            for (int i = 0; i < bytes.Length; i++) any |= bytes[i] != 0;
            if (!any) return false;
            signature = new Solana.Unity.Wallet.Utilities.Base58Encoder().EncodeData(bytes);
            return !string.IsNullOrEmpty(signature);
        }
#endif

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
                var messageBytes = System.Text.Encoding.UTF8.GetBytes(utf8Message);

                // =========================================================
                //  ALWAYS the targeted association. NEVER Web3.Wallet.
                // ---------------------------------------------------------
                //  This used to prefer Web3.Wallet when it was non-null and
                //  only fall back to our scenario. That preference is now
                //  REMOVED, for three reasons, in order of severity:
                //
                //  1. SDK BUG - "dequeue after close". Web3.Wallet on Android
                //     is a SolanaWalletAdapter wrapping SolanaMobileWalletAdapter,
                //     whose SignMessage drives the SDK's own
                //     LocalAssociationScenario (SolanaMobileWalletAdapter.cs:145-187).
                //     That scenario's action pump is:
                //
                //       LocalAssociationScenario.cs:132-138
                //         if (_actions.Count == 0 || response is { Failed: true })
                //             CloseAssociation(response);   // <-- NO return
                //         var action = _actions.Dequeue();  // <-- runs anyway
                //
                //     There is no `return` and no `else`. On the LAST response
                //     the queue is empty, CloseAssociation() is entered, and
                //     control falls straight into Dequeue() on an empty Queue
                //     -> InvalidOperationException, thrown from inside the
                //     websocket OnMessage callback (HandleEncryptedSessionPayload,
                //     :98-110, which has no try/catch). The signature itself has
                //     already resolved by then, so the failure is a torn-down
                //     message pump rather than a clean error - the classic
                //     "connect worked, signing dies later" shape. Our scenario
                //     has no action queue at all, so it cannot reproduce this.
                //
                //  2. IDENTITY. The SDK adapter signs under whatever options the
                //     Web3 facade happens to hold. Our scenario always sends the
                //     three DappIdentity* constants above, so the sign sheet is
                //     branded identically to the connect sheet.
                //
                //  3. WALLET TARGETING. The SDK adapter builds an IMPLICIT
                //     association intent, which on the owner's Seeker elects
                //     Jupiter instead of the Seeker's own wallet - so a signature
                //     could be demanded from a DIFFERENT wallet than the one that
                //     authorized, and the address would not match.
                //
                //  Reuses the stored auth token so the wallet REAUTHORIZES rather
                //  than re-prompting the player for a fresh grant. The game holds
                //  NO key - the connected wallet signs (spec Part 10). This is the
                //  WO-766 identity / save-auth path (dotr-save:v1 challenge).
                // =========================================================
                FlowTrace.Step("Wallet", "SignMessage via targeted MWA association.");
                var addressBytes = new PublicKey(_account.Address).KeyBytes;
                var scenario = new TargetedLocalAssociationScenario();
                var sigBytes = await scenario.SignMessage(
                    DappIdentityUri, DappIconUri, DappIdentityName,
                    ClusterName(WalletService.DefaultNetwork),
                    _authToken, messageBytes, addressBytes);

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
        /// CLOSED (2026-08-05): accessibility was never the problem - those fields
        /// (and solanaWalletAdapterOptions, Web3.cs:88) are all plain public and
        /// directly assignable. The real defect was missing INSTANTIATION:
        /// AddComponent skips Unity's deserialization pass, so every [Serializable]
        /// reference field arrives null and the first Login NREs. Fixed below by
        /// populating the whole options graph. No Resources prefab, no reflection.
        /// SDK-VERIFY: RpcCluster member names (DevNet / MainNet).
        /// </summary>
        private static void EnsureWeb3Host(WalletNetwork network)
        {
            if (Web3.Instance != null) return;

            var host = new GameObject("Web3 (WO-766 SolanaWalletProvider)");
            UnityEngine.Object.DontDestroyOnLoad(host);
            var web3 = host.AddComponent<Web3>();

            // AddComponent leaves [Serializable] reference fields NULL - Unity only
            // instantiates them when deserializing an authored asset. Web3.LoginWalletAdapter
            // dereferences solanaWalletAdapterOptions on its FIRST statement (Web3.cs:264),
            // and SolanaMobileWalletAdapter.Login dereferences _walletOptions - BOTH NRE
            // without this graph. Captured on-device 2026-08-05 (Seeker, build 312200).
            // Bare ctors are deliberate: each SDK options type's own field initializers
            // supply valid values (identityUri must parse as an absolute Uri).
            web3.solanaWalletAdapterOptions = new SolanaWalletAdapterOptions
            {
                // WO-XXX 2026-08-05 ROOT CAUSE: this used to be a BARE ctor, which
                // means it shipped the SDK's DEFAULT identity (see the constants
                // above). Every MWA wallet then failed to verify us and declined
                // with ERROR_AUTHORIZATION_FAILED. Explicit identity now, here too,
                // so any code path that still goes through the Web3 facade's
                // adapter carries the SAME identity as the targeted scenario.
                solanaMobileWalletAdapterOptions = new SolanaMobileWalletAdapterOptions
                {
                    identityUri = DappIdentityUri,
                    iconUri     = DappIconUri,
                    name        = DappIdentityName,
                },
                solanaWalletAdapterWebGLOptions  = new SolanaWalletAdapterWebGLOptions(),
                phantomWalletOptions             = new PhantomWalletOptions(),
            };

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

        private static async UniTask<(string signature, string error)> SubmitSignedTransaction(
            string rpcUrl, byte[] signedWire)
        {
            string wireBase64 = Convert.ToBase64String(signedWire);
            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                jsonrpc = "2.0",
                id = 1,
                method = "sendTransaction",
                @params = new object[]
                {
                    wireBase64,
                    new
                    {
                        encoding = "base64",
                        skipPreflight = false,
                        preflightCommitment = "confirmed",
                        maxRetries = 3,
                    }
                }
            }));

            using var req = new UnityWebRequest(rpcUrl, "POST")
            {
                uploadHandler = new UploadHandlerRaw(body),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = 20,
            };
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");

            try { await req.SendWebRequest(); }
            catch (Exception ex)
            {
                return (null, $"RPC transport {ex.GetType().Name}: {ex.Message}");
            }

            string responseText = req.downloadHandler?.text ?? string.Empty;
            JObject response = null;
            try { response = JObject.Parse(responseText); }
            catch (Exception ex)
            {
                string preview = responseText.Length > 240 ? responseText.Substring(0, 240) : responseText;
                return (null, $"RPC HTTP {req.responseCode} returned non-JSON ({ex.GetType().Name}): {preview}");
            }

            string signature = response["result"]?.Value<string>();
            if (!string.IsNullOrEmpty(signature)) return (signature, null);

            string message = response["error"]?["message"]?.Value<string>();
            string data = response["error"]?["data"]?.ToString(Formatting.None);
            if (string.IsNullOrEmpty(message)) message = $"RPC HTTP {req.responseCode} returned no signature";
            if (!string.IsNullOrEmpty(data)) message += $"; data={data}";
            return (null, message);
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
                await UniTask.Delay(pollMs, ignoreTimeScale: true);
            }
            return false;
        }
#endif

        // =====================================================================
        //  Pure unit-conversion helpers — no SDK types, always compiled
        // =====================================================================

        /// <summary>
        /// The MWA `cluster` string for a network. The wallet uses this to pick
        /// which chain it authorizes for. Matches the SDK's own RPCNameMap
        /// (WalletBase.cs:43-49). Kept out of the SDK #if so it is unit-testable.
        /// </summary>
        internal static string ClusterName(WalletNetwork network)
        {
            return network == WalletNetwork.Mainnet ? "mainnet-beta" : "devnet";
        }

        /// <summary>
        /// Turns the SDK's opaque MWA failure strings into an honest, actionable
        /// line. Returns null when we have nothing better to say than the raw
        /// message.
        /// <para>
        /// WHY (2026-08-05): the wallet's ERROR_AUTHORIZATION_FAILED (-1) arrives
        /// as the bare JSON-RPC message "authorization request failed", which the
        /// SDK rethrows verbatim (JsonRpc20Client.Receiver -> SetException). That
        /// reads like a USER DECLINE and cost hours of misdiagnosis - the actual
        /// cause was that the wallet could not VERIFY our dapp identity against
        /// /.well-known/assetlinks.json. Never let that string stand alone again.
        /// </para>
        /// ASCII only - this goes to Player.log / logcat / the F8 break-log.
        /// </summary>
        internal static string ExplainConnectFailure(Exception ex)
        {
            var msg = ex == null ? null : ex.Message;
            if (string.IsNullOrEmpty(msg)) return null;

            if (msg.IndexOf("authorization request failed", StringComparison.OrdinalIgnoreCase) >= 0 ||
                msg.IndexOf("ERROR_AUTHORIZATION_FAILED", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "MWA ERROR_AUTHORIZATION_FAILED (-1) - the wallet DECLINED the authorize request. " +
                       "This is usually NOT a user cancel: the wallet could not verify our dapp identity. " +
                       "Check that " + DappIdentityUri + ".well-known/assetlinks.json returns 200 with an " +
                       "android_app statement for the running package AND for the certificate this build is " +
                       "actually signed with (apksigner verify --print-certs). A Play App Signing build needs " +
                       "Google's re-signing certificate appended to api/assetlinks.js.";
            }

            if (msg.IndexOf("never connected back", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex is TimeoutException)
            {
                return "MWA association timed out - the wallet app never dialed the local websocket back. " +
                       "Check that a Solana wallet is installed/unlocked and that the <queries> block for the " +
                       "solana-wallet scheme actually reached the packaged AndroidManifest.";
            }

            return null;
        }

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
