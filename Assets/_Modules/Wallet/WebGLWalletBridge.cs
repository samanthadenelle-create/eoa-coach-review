// =============================================================================
// WebGLWalletBridge — the C# half of Assets/Plugins/WebGL/EoaWalletBridge.jslib.
// -----------------------------------------------------------------------------
// It does exactly one thing: hand an OPAQUE base64 transaction to the browser
// wallet and get the SIGNED base64 back. No transaction model, no version, no
// opinion about what is inside. That is the whole point.
//
// ⛔ WHY NOT THE SDK'S OWN SIGN PATH. SolanaWalletAdapterWebGL.cs:154-158 serialises
// a Solana.Unity.Rpc.Models.Transaction on the way out and :220 deserialises one on
// the way back, and the pinned SDK 1.2.9 has no VersionedTransaction in that path
// (WalletService.cs:882-884 records it). Jupiter returns v0. So the legacy SPL
// transfer can and does go through the SDK wrapper, while the SWAP must bypass the
// wrapper — and only the wrapper, not the browser: the page-side lib was read at
// source 2026-09-22 and already deserialises BOTH models and serialises both back.
//
// ⛔ INSTALL BEFORE YOU CONNECT. EnsureInstalled() must run before the SDK's adapter
// loads its CDN script, because the wallet NAME is observable only as it passes
// through the lib's own connectWallet call (the lib exposes no accessor for the
// connected wallet, and the SDK keeps it in a private static). Calling it late is
// not an error — it simply leaves the name uncaptured, and a swap then REFUSES with
// a sentence that says so rather than guessing which wallet to ask.
//
// Assembly: DeNelle.Wallet. WebGL player only.
// =============================================================================
#if SOLANA_SDK && UNITY_WEBGL && !UNITY_EDITOR
using System;
using System.Runtime.InteropServices;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;

namespace DeNelle.Wallet
{
    internal static class WebGLWalletBridge
    {
        [DllImport("__Internal")] private static extern int EoaWalletBridgeInstall();
        [DllImport("__Internal")] private static extern string EoaWalletBridgeWalletName();
        [DllImport("__Internal")] private static extern int EoaWalletBridgeSignBegin(string txBase64);
        [DllImport("__Internal")] private static extern int EoaWalletBridgeSignPoll(int handle);
        [DllImport("__Internal")] private static extern string EoaWalletBridgeSignResult(int handle);
        [DllImport("__Internal")] private static extern string EoaWalletHandoffCapability();
        [DllImport("__Internal")] private static extern int EoaWalletHandoffOpen(string walletId);
        [DllImport("__Internal")] private static extern string EoaWalletHandoffReturn();
        [DllImport("__Internal")] private static extern void EoaWalletBridgeSignRelease(int handle);

        // A wallet sheet is a HUMAN action. The deadline exists so a page the player
        // abandoned reports a refusal instead of leaving the store spinning forever;
        // it is generous on purpose, because a short one turns a slow reader into a
        // failed purchase.
        private const double SignDeadlineSeconds = 180d;

        private static bool _installed;

        /// <summary>
        /// Installs the wallet-name capture hook. Idempotent, safe to call every time,
        /// and it must be called BEFORE the wallet picker runs.
        /// </summary>
        internal static void EnsureInstalled()
        {
            if (_installed) return;
            try
            {
                _installed = EoaWalletBridgeInstall() == 1;
                FlowTrace.Step("WebPay", "wallet bridge install=" + _installed);
            }
            catch (Exception ex)
            {
                // A missing jslib symbol is a BUILD problem, and it must be loud here
                // rather than silent at the moment a player taps Buy.
                FlowTrace.Fail("WebPay", "wallet bridge install threw " + ex.GetType().Name + ": " + ex.Message);
                _installed = false;
            }
        }

        // ====================================================================
        // WO-1957 — the mobile-browser handoff seam.
        //
        // ⛔ READ THIS BEFORE CHANGING THE CONNECT PATH. The wallet-adapter CDN
        // bundle already carries the Solflare universal link and already fires it
        // on an iPhone (its gate is `ua.includes("iphone") && ua.includes("safari")`,
        // true on iOS Chrome). The arm is `return void(...)`, so the bundle returns
        // undefined, SolanaWalletAdapterWebGL.jslib throws, and
        // OnWalletConnected(null) raises `Login cancelled`
        // (SolanaWalletAdapterWebGL.cs:198). MEASURED — the owner's iPhone session,
        // web_trace wt-a73bdc1d3350, 2026-09-22 12:12:26Z:
        //     [Flow:Wallet] Connect FAILED: Exception: Login cancelled
        // A redirect and a cancel are INDISTINGUISHABLE to that code, so the player
        // being handed to Solflare reads the same words as the player who closed the
        // sheet. This seam lets Connect ask the page BEFORE it opens a picker that
        // can only offer extensions which are not installed.
        //
        // ⛔ AND MWA CANNOT RESCUE AN iPHONE: the bundle gates
        // SolanaMobileWalletAdapter on a literal `/android/i` userAgent test.
        // ====================================================================

        /// <summary>
        /// What the page can tell us about this browser. Every field defaults to the
        /// CONSERVATIVE value, so a missing page module or a thrown lookup lands on
        /// "no opinion" and the ordinary desktop picker path runs unchanged.
        /// </summary>
        internal struct HandoffCapability
        {
            public bool Mobile;
            public bool Injected;
            public string InjectedName;
            public bool Framed;
            public string ReturnedFrom;

            /// <summary>
            /// The one question Connect actually asks: a phone browser with no wallet
            /// injected is the ONLY shape where the SDK picker cannot help.
            /// </summary>
            public bool NeedsHandoff => Mobile && !Injected;

            public override string ToString() =>
                "mobile=" + Mobile + " injected=" + (string.IsNullOrEmpty(InjectedName) ? "none" : InjectedName) +
                " framed=" + Framed + " returned=" + (string.IsNullOrEmpty(ReturnedFrom) ? "none" : ReturnedFrom);
        }

        [Serializable]
        private class HandoffCapabilityDto
        {
            public bool mobile;
            public bool injected;
            public string injectedName;
            public bool framed;
            public string returned;
        }

        /// <summary>The Solflare browse target. Read at source in the CDN bundle and
        /// confirmed against docs.solflare.com — it needs no session and no key.</summary>
        internal const string HandoffSolflare = "solflare";

        /// <summary>The Phantom browse target — same shape, same bundle.</summary>
        internal const string HandoffPhantom = "phantom";

        /// <summary>
        /// Reads the page's capability. NEVER throws: a refusal is a value, because a
        /// throw here would unwind the connect path and tell the player the outcome is
        /// unknown when nothing has happened at all.
        /// </summary>
        internal static HandoffCapability Capability()
        {
            var cap = default(HandoffCapability);
            cap.InjectedName = string.Empty;
            cap.ReturnedFrom = string.Empty;
            try
            {
                string json = EoaWalletHandoffCapability();
                if (string.IsNullOrEmpty(json)) return cap;
                var dto = UnityEngine.JsonUtility.FromJson<HandoffCapabilityDto>(json);
                if (dto == null) return cap;
                cap.Mobile = dto.mobile;
                cap.Injected = dto.injected;
                cap.InjectedName = dto.injectedName ?? string.Empty;
                cap.Framed = dto.framed;
                cap.ReturnedFrom = dto.returned ?? string.Empty;
            }
            catch (Exception ex)
            {
                // A missing jslib symbol is a BUILD problem and must be loud here
                // rather than silent at the moment a player taps Connect.
                FlowTrace.Fail("Wallet", "handoff capability threw " + ex.GetType().Name + ": " + ex.Message);
            }
            return cap;
        }

        /// <summary>
        /// Starts the cross-app handoff. True only when a navigation was actually
        /// STARTED — the page returns false when it has no deeplink for that target,
        /// and Jupiter deliberately has none (it ships a React hook with no UMD build
        /// and its docs describe QR scanning, never a same-device deeplink).
        /// </summary>
        internal static bool OpenHandoff(string walletId)
        {
            if (string.IsNullOrEmpty(walletId)) return false;
            try
            {
                bool started = EoaWalletHandoffOpen(walletId) == 1;
                if (started) FlowTrace.Step("Wallet", "handoff started -> " + walletId);
                else FlowTrace.Warn("Wallet", "handoff could NOT start for '" + walletId +
                                              "' - no navigation happened, nothing was opened.");
                return started;
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Wallet", "handoff open threw " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        /// <summary>The wallet id this page came back from, or an empty string.</summary>
        internal static string HandoffReturn()
        {
            try { return EoaWalletHandoffReturn() ?? string.Empty; }
            catch (Exception) { return string.Empty; }
        }

        /// <summary>The captured browser wallet name, or an empty string.</summary>
        internal static string WalletName()
        {
            try { return EoaWalletBridgeWalletName() ?? string.Empty; }
            catch (Exception) { return string.Empty; }
        }

        /// <summary>
        /// Signs an opaque base64 transaction (legacy or v0) with the connected browser
        /// wallet. Returns, never throws — a refusal is a result, because an unwound
        /// stack reaches PackStore's outer catch and tells the player the outcome is
        /// INDETERMINATE when nothing was signed at all (the WO-1943 RCA).
        /// </summary>
        internal static async UniTask<(bool ok, string signedBase64, string error)> SignBase64(
            string txBase64, string what)
        {
            if (string.IsNullOrEmpty(txBase64))
                return (false, null, "There was nothing to sign.");

            EnsureInstalled();

            int handle;
            try { handle = EoaWalletBridgeSignBegin(txBase64); }
            catch (Exception ex)
            {
                FlowTrace.Fail("WebPay", "sign begin threw " + ex.GetType().Name + ": " + ex.Message);
                return (false, null, "This build cannot reach the browser wallet. Nothing was signed.");
            }
            if (handle <= 0)
                return (false, null, "The browser wallet bridge did not start. Nothing was signed.");

            FlowTrace.Step("WebPay", "sign requested (" + what + ") handle=" + handle +
                                     " wallet=" + WalletName());

            try
            {
                double deadline = UnityEngine.Time.realtimeSinceStartupAsDouble + SignDeadlineSeconds;
                while (true)
                {
                    int state = EoaWalletBridgeSignPoll(handle);
                    if (state == 1)
                    {
                        string signed = EoaWalletBridgeSignResult(handle);
                        if (string.IsNullOrEmpty(signed))
                            return (false, null, "The wallet returned an empty signature. Nothing was submitted.");
                        FlowTrace.Step("WebPay", "sign returned (" + what + ") bytes=" + signed.Length);
                        return (true, signed, null);
                    }
                    if (state == 2)
                    {
                        string message = EoaWalletBridgeSignResult(handle);
                        if (string.IsNullOrEmpty(message)) message = "the wallet refused the signature";
                        FlowTrace.Fail("WebPay", "sign REFUSED (" + what + "): " + message);
                        // The second sentence is the one that must always be true on
                        // this branch, and it is: the bridge reports an error only
                        // before any wire has been handed to the proxy.
                        return (false, null, "Wallet did not sign: " + message +
                                             ". Nothing was submitted and nothing was charged.");
                    }
                    if (state == 3)
                        return (false, null, "The browser wallet bridge lost the request. Nothing was submitted.");

                    if (UnityEngine.Time.realtimeSinceStartupAsDouble > deadline)
                    {
                        FlowTrace.Fail("WebPay", "sign TIMED OUT (" + what + ") after " +
                                                 SignDeadlineSeconds + "s");
                        return (false, null,
                            "The wallet approval was never completed. Nothing was submitted and nothing was charged.");
                    }
                    await UniTask.Yield();
                }
            }
            finally
            {
                try { EoaWalletBridgeSignRelease(handle); } catch (Exception) { }
            }
        }
    }
}
#endif
