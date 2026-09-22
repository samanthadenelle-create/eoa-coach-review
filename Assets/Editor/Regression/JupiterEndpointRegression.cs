// =============================================================================
// JupiterEndpointRegression - WO-1901 (the Jupiter swap door was dead in every
// build because the hardcoded aggregator host had been retired by Jupiter and
// UnityWebRequest reports a DNS failure as the string "Unknown Error").
// -----------------------------------------------------------------------------
// Assembly: DeNelle.EditorRegression. Shape: public static bool Run(out string reason)
// - registered into DataRegression.RunAll by the orchestrator.
//
// HONEST SCOPE. THIS SUITE IS A SOURCE LINT AND SAYS SO IN EVERY REASON STRING.
// It reads .cs text; it does NOT reach the network and CANNOT prove Jupiter
// answers. Proving that is a live probe + an owner swap attempt (the WO-1901
// acceptance). What a lint CAN do is stop the repoint being undone and stop the
// failure lines being reduced back to a bare req.error - which is precisely the
// state that cost an entire shipped monetisation path, silently, for weeks.
//
// WHAT THIS PINS, AND WHY EACH ONE IS HERE
//   1. [retired]  NO .cs under Assets/_Modules names the retired v6 aggregator
//                 host. The needle is assembled at runtime from parts so this
//                 file does not trip its own scan. Scan root is _Modules ONLY:
//                 Assets/Editor legitimately names Jupiter hosts in other gates.
//   2. [pair]     JupiterSwapService declares exactly the lite-api v1 quote and
//                 swap consts, and declares them ONCE. A second hardcoded host
//                 anywhere is how one of the pair comes back stale.
//   3. [code]     every Jupiter HTTP failure line carries req.responseCode. A
//                 line that logs only req.error is the WO-1901 defect verbatim:
//                 a DNS failure prints "Unknown Error" and names neither the
//                 host, the status, nor Jupiter's own errorCode in the body.
//   4. [once]     the FlowTrace.Once "swap-endpoint" marker still exists, so a
//                 trace PROVES which endpoint a given build talked to instead
//                 of leaving it inferred from the source that was read later.
//   5. [fee]      platformFeeBps is never appended unconditionally. Probed live
//                 2026-09-20: a quote carrying platformFee, POSTed to /swap with
//                 no feeAccount, returns HTTP 400 errorCode NOT_SUPPORTED. An
//                 unconditional fee param therefore breaks the swap one step
//                 later than the dead host did, for a build with no fee account.
// =============================================================================
using System;
using System.IO;
using System.Text;

namespace DeNelle.Editor.Regression
{
    public static class JupiterEndpointRegression
    {
        private const string ServicePath = "Assets/_Modules/Web3/JupiterSwapService.cs";
        private const string ModulesRoot = "Assets/_Modules";
        // WO-1943: the two files that carry the refusal contract.
        private const string ProviderPath = "Assets/_Modules/Wallet/SolanaWalletProvider.cs";
        private const string DoorPath = "Assets/_Modules/Core/Backend/JupiterSwapDoor.cs";

        private const string QuoteConst = "https://lite-api.jup.ag/swap/v1/quote";
        private const string SwapConst  = "https://lite-api.jup.ag/swap/v1/swap";

        // Assembled from parts so this suite's own source does not contain the
        // literal it forbids - otherwise the scan in [retired] would have to
        // special-case its own path, and a special case is how a lint goes blind.
        private static string RetiredHost() => "quote-" + "api.jup.ag";

        public static bool Run(out string reason)
        {
            var notes = new StringBuilder();

            // --- 1. the retired host appears in no module source ----------------------
            string needle = RetiredHost();
            string offender = null;
            int scanned = 0;
            try
            {
                foreach (string path in Directory.GetFiles(ModulesRoot, "*.cs", SearchOption.AllDirectories))
                {
                    scanned++;
                    if (File.ReadAllText(path).Contains(needle)) { offender = path; break; }
                }
            }
            catch (Exception ex)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [retired]: could not scan " + ModulesRoot +
                         " (" + ex.GetType().Name + ": " + ex.Message + "). The lint fails rather than " +
                         "pass blind on an unread tree.";
                return false;
            }
            if (offender != null)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [retired]: " + offender + " still names the " +
                         "RETIRED Jupiter v6 aggregator host. That host's DNS record is gone; " +
                         "UnityWebRequest reports the failure as \"Unknown Error\" and every swap fails " +
                         "closed with funnel reason=provider-refused, on web AND Android, with nothing " +
                         "on screen. Use the lite-api v1 consts in " + ServicePath + " (WO-1901).";
                return false;
            }
            notes.Append("[retired] ").Append(scanned).Append(" module .cs scanned, host absent; ");

            if (!TryRead(ServicePath, out string raw, out reason)) return false;

            // --- 2. the v1 pair is declared, exactly once -----------------------------
            if (!raw.Contains("private const string QuoteUrl = \"" + QuoteConst + "\";"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [pair]: " + ServicePath + " no longer declares " +
                         "QuoteUrl as the lite-api v1 quote endpoint (" + QuoteConst + "). Probed live " +
                         "2026-09-20: that path returns HTTP 200 for USDC->SKR ExactOut with " +
                         "access-control-allow-origin: * , which is what makes it WebGL-safe.";
                return false;
            }
            if (!raw.Contains("private const string SwapUrl = \"" + SwapConst + "\";"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [pair]: " + ServicePath + " no longer declares " +
                         "SwapUrl as the lite-api v1 swap endpoint (" + SwapConst + "). The quote and the " +
                         "swap MUST be the same API version - a v1 quote posted to a retired swap host is " +
                         "the same silent dead end, one step later.";
                return false;
            }
            if (CountOf(raw, "private const string QuoteUrl") != 1 || CountOf(raw, "private const string SwapUrl") != 1)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [pair]: QuoteUrl/SwapUrl are declared more than " +
                         "once in " + ServicePath + ". They are the SINGLE pair by rule (CLAUDE.md sec.16's " +
                         "duplicated-state lesson) - a second copy is how one of them comes back stale.";
                return false;
            }
            notes.Append("[pair] v1 quote+swap consts declared once each; ");

            // --- 3. failure lines carry the status code -------------------------------
            if (!raw.Contains("req.responseCode"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [code]: " + ServicePath + " no longer reads " +
                         "req.responseCode anywhere. That is the WO-1901 defect verbatim: the trace read " +
                         "'[Flow:Swap] ExactOut quote FAILED: Unknown Error' and named neither the status, " +
                         "the host, nor Jupiter's own errorCode from the response body.";
                return false;
            }
            if (!raw.Contains("HttpFailureDetail"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [code]: the HttpFailureDetail helper is gone " +
                         "from " + ServicePath + ". It is the ONE builder that guarantees every Jupiter " +
                         "failure line carries error + responseCode + host + the first 200 chars of the " +
                         "body; without it each call site drifts back to a bare req.error.";
                return false;
            }
            int detailUses = CountOf(raw, "HttpFailureDetail(req,");
            if (detailUses < 3)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [code]: only " + detailUses + " of the 3 Jupiter " +
                         "HTTP failure paths (GetQuoteAsync, GetQuoteExactOutAsync, ExecuteSwapAsync) use " +
                         "HttpFailureDetail. An unlogged path is a path that will one day print " +
                         "\"Unknown Error\" and cost another silent monetisation outage.";
                return false;
            }
            notes.Append("[code] responseCode + body on ").Append(detailUses).Append(" failure paths; ");

            // --- 4. the endpoint marker still fires -----------------------------------
            if (!raw.Contains("\"swap-endpoint\""))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [once]: the FlowTrace.Once \"swap-endpoint\" " +
                         "marker is gone from " + ServicePath + ". It is the only line that PROVES from a " +
                         "captured trace which Jupiter host a given build talked to - without it, the next " +
                         "endpoint retirement is diagnosed by reading source and guessing (CLAUDE.md sec.12).";
                return false;
            }
            notes.Append("[once] swap-endpoint marker present; ");

            // --- 5. the platform fee is conditional -----------------------------------
            if (CountOf(raw, "platformFeeBps=") == 0)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee]: no platformFeeBps query parameter in " +
                         ServicePath + " at all. The suite fails rather than pass on a file it cannot " +
                         "recognise as the swap service.";
                return false;
            }
            if (!raw.Contains("if (!string.IsNullOrEmpty(feeAccount))"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee]: platformFeeBps is no longer gated on a " +
                         "configured feeAccount. Probed live 2026-09-20: a quote carrying platformFee POSTed " +
                         "to the v1 /swap endpoint with no feeAccount returns HTTP 400 " +
                         "{\"errorCode\":\"NOT_SUPPORTED\",\"error\":\"feeAccount is required for swap with " +
                         "platformFee\"}. Appending the fee unconditionally therefore kills the swap for any " +
                         "build whose SwapFeeConfig has no fee wallet - the same closed door, one step later.";
                return false;
            }
            notes.Append("[fee] platformFeeBps gated on a configured feeAccount; ");

            // --- 6. a wallet sign REFUSAL is returned, never thrown --------------------
            // WO-1943. The owner's Seeker swap got a 200 quote AND a 200 /swap, then the
            // wallet answered sign_transactions with MWA ERROR_AUTHORIZATION_FAILED (-1).
            // SignAndSendSwapTransaction caught ONLY TimeoutException, so the generic
            // Exception unwound into PackStore.Purchase's outer catch and told the player
            // the outcome was indeterminate and a charge might have settled. It had not:
            // the stack dies before TryReadPrimarySignature and before
            // SubmitSignedTransaction. The check is METHOD-SCOPED (a slice between the
            // method header and the next method) so an unrelated catch elsewhere in that
            // 2000-line provider can never satisfy it.
            if (!TryRead(ProviderPath, out string prov, out reason)) return false;
            string signSlice = SliceBetween(prov, "SignAndSendSwapTransaction(", "SubmitSignedTransaction(");
            if (signSlice == null)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [sign]: could not locate " +
                         "SignAndSendSwapTransaction in " + ProviderPath + " (or the method no longer " +
                         "precedes SubmitSignedTransaction). The suite fails rather than pass on a file " +
                         "it cannot recognise as the MWA swap-signing path.";
                return false;
            }
            if (!signSlice.Contains("catch (TimeoutException"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [sign]: SignAndSendSwapTransaction no longer " +
                         "catches TimeoutException. That arm is what lets PackStore say the wallet never " +
                         "answered and NOTHING was submitted (SignTimeoutMessage); losing it turns the " +
                         "wallet-slow case back into an indeterminate-charge scare.";
                return false;
            }
            if (!signSlice.Contains("ExplainConnectFailure("))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [sign]: SignAndSendSwapTransaction does not " +
                         "route its failure through ExplainConnectFailure. Without the generic " +
                         "catch (Exception) arm that calls it, an MWA ERROR_AUTHORIZATION_FAILED (-1) " +
                         "PROPAGATES out of the provider, through JupiterSwapService and the Core door, " +
                         "into PackStore.Purchase's outer catch - which tells the player the outcome is " +
                         "indeterminate and \"if a charge settled the entitlement may be lost\". That is " +
                         "FALSE here: nothing is signed and nothing is submitted on this path (WO-1943, " +
                         "owner's Seeker attempt on build 2026.09.21.379625).";
                return false;
            }
            if (CountOf(signSlice, "catch (Exception") < 2)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [sign]: SignAndSendSwapTransaction has fewer " +
                         "than two catch (Exception) arms - the base64 decode guard AND the sign-refusal " +
                         "guard. A sign failure that is not caught is returned to the player as a charge " +
                         "scare instead of \"the pack was not charged\" (WO-1943).";
                return false;
            }
            notes.Append("[sign] MWA refusal returned via ExplainConnectFailure, not thrown; ");

            // --- 7. the Core door cannot throw into the store -------------------------
            if (!TryRead(DoorPath, out string door, out reason)) return false;
            if (!door.Contains("CoreServices.Jupiter.TopUpSkrAsync"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [door]: " + DoorPath + " no longer awaits " +
                         "CoreServices.Jupiter.TopUpSkrAsync. The suite fails rather than pass on a file " +
                         "it cannot recognise as the Core-side swap door.";
                return false;
            }
            if (!door.Contains("catch (Exception"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [door]: " + DoorPath + " awaits the Web3 " +
                         "implementation with no catch (Exception). This is a Core seam over another " +
                         "assembly: anything it raises lands in PackStore.Purchase's outer catch and is " +
                         "reported as an indeterminate outcome with a possible lost entitlement. The " +
                         "top-up runs BEFORE the pack Pay, so nothing can have been charged - the door " +
                         "must return a traced false (WO-1943).";
                return false;
            }
            notes.Append("[door] Core swap door returns a traced false, cannot throw into PackStore");

            reason = "[jupiter-endpoint] SOURCE LINT PASS (text only - does NOT reach Jupiter; a live quote " +
                     "and an owner swap attempt are the WO-1901 acceptance): " + notes;
            return true;
        }

        /// <summary>
        /// The text between the first occurrence of <paramref name="start"/> and the first
        /// occurrence of <paramref name="end"/> after it, or null when either is missing or
        /// out of order. Keeps a method-scoped check from being satisfied by an unrelated
        /// catch elsewhere in a 2000-line file (WO-1943).
        /// </summary>
        private static string SliceBetween(string haystack, string start, string end)
        {
            if (string.IsNullOrEmpty(haystack)) return null;
            int a = haystack.IndexOf(start, StringComparison.Ordinal);
            if (a < 0) return null;
            int b = haystack.IndexOf(end, a + start.Length, StringComparison.Ordinal);
            if (b < 0) return null;
            return haystack.Substring(a, b - a);
        }

        private static int CountOf(string haystack, string needle)
        {
            int n = 0, i = 0;
            while ((i = haystack.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { n++; i += needle.Length; }
            return n;
        }

        private static bool TryRead(string path, out string text, out string reason)
        {
            text = null;
            try { text = File.ReadAllText(path); }
            catch (Exception ex)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL: cannot read " + path + " (" +
                         ex.GetType().Name + ": " + ex.Message + "). The swap service is a shipped " +
                         "monetisation path; a missing file is a failure, not a skip.";
                return false;
            }
            reason = null;
            return true;
        }
    }
}
