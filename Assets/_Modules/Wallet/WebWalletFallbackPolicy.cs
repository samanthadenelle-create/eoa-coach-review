// =============================================================================
// WebWalletFallbackPolicy - WO-2197. Which web wallet outcomes mean "that door
// cannot open here", and which doors the player is offered next.
// -----------------------------------------------------------------------------
// Assembly: DeNelle.Wallet (!GOOGLE_PLAY). PURE: no Unity API, no #if on the
// player platform, so WebWalletFallbackRegression EXECUTES it in the editor rather
// than grepping for it. WebGLWalletProvider (UNITY_WEBGL only) asks it and acts.
//
// OWNER RULE (2026-09-30): on the WEB build (itch, the vercel hosts, phone or
// desktop browsers that are NOT Pi Browser) a player who cannot use Pi must ALWAYS
// be able to reach some Solana wallet - connecting must never dead-end in a
// spinner.
//
// THE MEASURED DEFECT (player bug report #32, 2026-09-29 11:50Z, iPhone Safari on
// echoes-of-elarion.vercel.app): the WalletConnect relay answered
//     WebSocket connection closed abnormally with code: 3000 (Unauthorized: origin not allowed)
// nothing caught it, the Reown modal spun until the player closed it (~40 s), and
// the trace read `refused reason=failed detail=Modal closed`. Before WO-2197 only
// `no-project-id` / `no-bundle` counted as "the door was never available", so this
// outcome fell into the "the player's own cancel - offer nothing" branch: a dead end.
//
// wallet-connect.core.js now names the relay refusal (`origin-not-allowed`) and a
// relay that never produced a pairing uri (`no-uri-timeout`), and reports whether a
// pairing uri was ever seen. This file decides what those facts MEAN.
// =============================================================================
using System.Collections.Generic;

namespace DeNelle.Wallet
{
    public static class WebWalletFallbackPolicy
    {
        // --- Reason codes, byte-identical to wallet-connect.core.js REASON ---------
        public const string ReasonNoProjectId = "no-project-id";
        public const string ReasonNoBundle = "no-bundle";
        public const string ReasonOriginNotAllowed = "origin-not-allowed";
        public const string ReasonNoUriTimeout = "no-uri-timeout";
        public const string ReasonCancelled = "cancelled";
        public const string ReasonFailed = "failed";

        // --- The snapshot's uriObservable values (wallet-connect.core.js) ----------
        public const string UriObservableYes = "yes";
        public const string UriObservablePending = "pending";
        public const string UriObservableFailed = "failed";
        public const string UriObservableUnsupported = "unsupported";

        // --- Handoff target ids, byte-identical to wallet-handoff.js TARGETS -------
        // The SINGLE C# home for these strings: WebGLWalletBridge.HandoffPhantom /
        // HandoffSolflare are defined FROM these, so the two cannot drift.
        public const string TargetPhantom = "phantom";
        public const string TargetSolflare = "solflare";

        /// <summary>
        /// The chooser's row order. Phantom then Solflare - the two browse deeplinks
        /// proven at source in wallet-handoff.js, each carrying the return URL. The
        /// injected-wallet rung never reaches the chooser (a page with an injected
        /// wallet takes the Wallet-Standard picker first), and WalletConnect is the
        /// door that just failed, so it is not re-offered here.
        /// </summary>
        public static readonly string[] ChooserOrder = { TargetPhantom, TargetSolflare };

        /// <summary>
        /// True when a Jupiter (WalletConnect) outcome means the DOOR was never really
        /// open on this page, so the player must be offered the next one - as opposed
        /// to the player cancelling a door that worked, which offers nothing (being
        /// thrown at a second wallet after you said no is hostile, WO-1958).
        /// </summary>
        /// <param name="reason">The core's reason code.</param>
        /// <param name="uriSeen">Whether a WalletConnect pairing uri ever arrived.</param>
        /// <param name="uriObservable">Whether the page could observe display_uri at all.</param>
        public static bool IsDoorUnavailable(string reason, bool uriSeen, string uriObservable)
        {
            switch (reason ?? string.Empty)
            {
                case ReasonNoProjectId:
                case ReasonNoBundle:
                case ReasonOriginNotAllowed:
                case ReasonNoUriTimeout:
                    return true;
                case ReasonCancelled:
                case ReasonFailed:
                    // The player closed a SPINNER: the relay was asked and no pairing uri
                    // ever came, so there was nothing to approve. Bug report #32 exactly.
                    // When display_uri could not be observed at all we cannot tell a
                    // spinner from a working modal, and the pre-WO-2197 reading stands.
                    return !uriSeen && RelayWasAsked(uriObservable);
                default:
                    return false;
            }
        }

        /// <summary>
        /// 'yes' / 'pending' / 'failed': the page asked for the UniversalProvider, so a
        /// missing pairing uri is a fact. 'unsupported' / empty: it could not tell.
        /// </summary>
        public static bool RelayWasAsked(string uriObservable)
        {
            return uriObservable == UriObservableYes
                || uriObservable == UriObservablePending
                || uriObservable == UriObservableFailed;
        }

        /// <summary>
        /// A relay refusal of this page's ORIGIN is deterministic for the page's life
        /// (the Reown allow-list does not change mid-session and the relayer does not
        /// reconnect by itself), so a second Connect tap skips straight to the chooser
        /// instead of opening the same spinner again. A no-uri timeout is NOT latched:
        /// it can be a slow network, and the next tap deserves another try.
        /// </summary>
        public static bool LatchesForPage(string reason)
        {
            return reason == ReasonOriginNotAllowed;
        }

        /// <summary>
        /// The chooser rows, in <see cref="ChooserOrder"/>, filtered to the targets the
        /// page says it can open. An empty/absent page list (an older cached template
        /// that does not report targets) offers the full order rather than nothing -
        /// an empty chooser is the dead end this ticket exists to remove.
        /// </summary>
        public static List<string> ChooserTargets(IReadOnlyList<string> pageTargets)
        {
            var rows = new List<string>(ChooserOrder.Length);
            bool filter = pageTargets != null && pageTargets.Count > 0;
            foreach (string id in ChooserOrder)
            {
                if (!filter || Contains(pageTargets, id)) rows.Add(id);
            }
            if (rows.Count == 0) rows.AddRange(ChooserOrder);
            return rows;
        }

        /// <summary>The locale key for a chooser row's caption.</summary>
        public static string RowKey(string target)
        {
            return "wallet.chooser." + (target ?? string.Empty);
        }

        private static bool Contains(IReadOnlyList<string> list, string id)
        {
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i] == id) return true;
            }
            return false;
        }
    }
}
