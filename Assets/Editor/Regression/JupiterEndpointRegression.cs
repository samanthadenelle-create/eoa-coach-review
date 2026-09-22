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
//   6. [sign]     WO-1943: an MWA sign refusal is RETURNED, never thrown.
//   7. [door]     WO-1943: the Core swap door cannot throw into PackStore.
//   8. [fee-default] WO-1951: the SHIPPED SwapFeeConfig default is 0 bps, so the
//                 unconditional "0% STORE FEE" footer is true by RULE and not by
//                 the accident of no asset existing; and no authored asset takes
//                 a fee while that footer still promises zero.
//   9. [total-cost] WO-1951: the player is shown what they ACTUALLY pay - the
//                 quote's own MaxInAmount (route/AMM fee + <=0.5% slippage) plus
//                 the NetworkFee constant - as a FontRole.Numeral line on BOTH
//                 surfaces that offer the swap, in every locale table. A
//                 fee-only assertion would pass while a player spent 61.2 SKR of
//                 input for a 60 SKR pack and read the difference as our fee.
//
//   (!) [fee], [fee-default] and [total-cost] are THREE DIFFERENT AXES - the query
//   parameter, the shipped default, and what the player is told. Do not merge them.
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

        // WO-1951: the fee-default + total-cost disclosure chain.
        private const string FeeConfigPath = "Assets/_Modules/Web3/SwapFeeConfig.cs";
        private const string StoreStringsPath = "Assets/_Modules/Wallet/StoreStrings.cs";
        private const string PickerPath = "Assets/_Modules/Wallet/UI/SwapFundingPickerModal.cs";
        private const string FeeFieldDecl = "private int _platformFeeBps = ";
        private const string FooterFeeKey = "storeTrustFee";
        private const string TotalCostKey = "storeSwapTotalCost";
        private const string NetworkFeeKey = "storeSwapNetworkFee";
        // A SwapFeeConfig asset is well under 4 KB. LightingData / NavMesh / terrain assets
        // in this tree run to tens of MB, and ReadAllText-ing every one of them on every gate
        // run is both a slowdown the lead feels and an OOM risk on a machine that already
        // leaks commit charge overnight. Anything larger than this cannot be the asset we
        // are looking for, and the skip count is reported rather than hidden.
        private const long MaxFeeAssetBytes = 256 * 1024;
        private const string NetworkFeeLiteral = "0.000005m";
        private static readonly string[] LocaleDirs =
        {
            "Assets/Resources/Data/Canonical", "Assets/StreamingAssets/Data/Canonical"
        };
        private static readonly string[] Locales =
        {
            "en", "es", "pt-BR", "de", "fr", "ru", "ar", "ja", "ko", "zh-Hans"
        };

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
            notes.Append("[door] Core swap door returns a traced false, cannot throw into PackStore; ");

            // --- 8. the shipped platform-fee DEFAULT is the safe state ----------------
            if (!CheckFeeDefault(notes, out reason)) return false;

            // --- 9. the player is shown the TOTAL, not only our zero cut --------------
            if (!CheckTotalCostDisclosure(notes, out reason)) return false;

            reason = "[jupiter-endpoint] SOURCE LINT PASS (text only - does NOT reach Jupiter; a live quote " +
                     "and an owner swap attempt are the WO-1901 acceptance): " + notes;
            return true;
        }

        // =====================================================================
        //  8. [fee-default] - WO-1951
        // ---------------------------------------------------------------------
        //  "0% STORE FEE" (storeTrustFee) is drawn unconditionally on every store
        //  frame by StoreLegalFooter. Until 2026-09-22 it was true ONLY BY ACCIDENT:
        //  SwapFeeConfig._platformFeeBps defaulted to 20 (0.2 %) and the fee tail was
        //  inert purely because NO SwapFeeConfig.asset exists under Assets/, so
        //  JupiterSwapService's feeAccount was always empty. The open owner task at
        //  JupiterSwapBootstrap.cs:217 says to create that asset - and the day anyone
        //  does, a 0.2 % fee starts riding the top-up swap with NO code change while
        //  the footer still says 0 %. This case pins the literal default AND fails on
        //  any authored asset that carries a fee while the footer still claims zero.
        // =====================================================================
        private static bool CheckFeeDefault(StringBuilder notes, out string reason)
        {
            if (!TryRead(FeeConfigPath, out string cfg, out reason)) return false;

            if (!cfg.Contains(FeeFieldDecl + "0;"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee-default]: " + FeeConfigPath +
                         " does not declare '" + FeeFieldDecl + "0;'. The SHIPPED DEFAULT must be the safe " +
                         "state, not the un-authored one: today the '0% STORE FEE' promise in storeTrustFee holds " +
                         "only because no SwapFeeConfig.asset exists, and the moment the open owner task at " +
                         "JupiterSwapBootstrap.cs:217 is done as written the footer goes from true to false " +
                         "with no code change at all (WO-1951 sec.3). Turning a live fee on must stay a " +
                         "deliberate edit to an authored asset.";
                return false;
            }
            // The retired literal must be gone, not merely shadowed by a second declaration.
            if (CountOf(cfg, FeeFieldDecl) != 1)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee-default]: " + FeeConfigPath + " declares '" +
                         FeeFieldDecl + "' " + CountOf(cfg, FeeFieldDecl) + " times. One field, one default - " +
                         "a second declaration is how the retired 20 bps comes back while this lint still " +
                         "finds the 0 it was looking for (CLAUDE.md sec.16 duplicated state).";
                return false;
            }

            // Any AUTHORED asset that takes a fee while the footer still says 0 % is the
            // contradiction itself - the one the audit's own ranked fix list names (item 6).
            bool footerClaimsZero = false;
            int localesRead = 0;
            foreach (string dir in LocaleDirs)
            {
                foreach (string loc in Locales)
                {
                    string p = dir + "/" + loc + ".json";
                    if (!File.Exists(p)) continue;
                    localesRead++;
                    string t;
                    try { t = File.ReadAllText(p); } catch { continue; }
                    int k = t.IndexOf("\"" + FooterFeeKey + "\"", StringComparison.Ordinal);
                    if (k < 0) continue;
                    int eol = t.IndexOf('\n', k);
                    string line = eol < 0 ? t.Substring(k) : t.Substring(k, eol - k);
                    if (line.Contains("0%") || line.Contains("0 %")) footerClaimsZero = true;
                }
            }

            int assets = 0, offenders = 0, skippedLarge = 0;
            string firstOffender = null;
            try
            {
                foreach (string path in Directory.GetFiles("Assets", "*.asset", SearchOption.AllDirectories))
                {
                    try { if (new FileInfo(path).Length > MaxFeeAssetBytes) { skippedLarge++; continue; } }
                    catch { continue; }
                    string text;
                    try { text = File.ReadAllText(path); } catch { continue; }
                    if (!text.Contains("_platformFeeBps")) continue;
                    assets++;
                    int k = text.IndexOf("_platformFeeBps", StringComparison.Ordinal);
                    int eol = text.IndexOf('\n', k);
                    string line = eol < 0 ? text.Substring(k) : text.Substring(k, eol - k);
                    string val = line.Substring(line.IndexOf(':') + 1).Trim();
                    if (int.TryParse(val, out int bps) && bps > 0)
                    {
                        offenders++;
                        if (firstOffender == null) firstOffender = path + " (_platformFeeBps: " + bps + ")";
                    }
                }
            }
            catch (Exception ex)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee-default]: could not scan Assets/ for an " +
                         "authored SwapFeeConfig asset (" + ex.GetType().Name + ": " + ex.Message + "). The " +
                         "lint fails rather than pass blind on an unread tree.";
                return false;
            }

            if (offenders > 0 && footerClaimsZero)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [fee-default]: " + firstOffender + " configures a " +
                         "NON-ZERO platform fee while " + FooterFeeKey + " still promises the player '0%'. " +
                         "Both cannot be true. Either set the asset back to 0, or change the footer copy in " +
                         "all " + localesRead + " locale tables first - the store's own trust strip is not " +
                         "allowed to lie about a fee the swap is taking (WO-1951, audit sec.7 item 6).";
                return false;
            }

            notes.Append("[fee-default] shipped default 0 bps, ").Append(assets)
                 .Append(" authored fee asset(s), ").Append(offenders).Append(" with a fee, ")
                 .Append(skippedLarge).Append(" oversized .asset skipped, footer claims 0% in ")
                 .Append(localesRead).Append(" locale table(s); ");
            reason = null;
            return true;
        }

        // =====================================================================
        //  9. [total-cost] - WO-1951, the half a fee-only test would miss
        // ---------------------------------------------------------------------
        //  Outside review, verbatim: the regression "must assert what the PLAYER pays
        //  in total (route/AMM fee, <=0.5% slippage, the NetworkFee constant 0.000005)
        //  beside the SKR price, not only that platformFeeBps is zero, because a player
        //  who pays 61.2 SKR of input for a 60 SKR pack will not parse 'store fee' vs
        //  'swap cost'." So this case follows the whole chain and fails if ANY link is
        //  missing:
        //    quote -> SwapQuote.MaxInAmount (Jupiter's own otherAmountThreshold: the
        //    route fee AND the slippage tolerance are already inside it)
        //      -> SwapFundingCandidate.Cost  (QuoteCandidateAsync)
        //        -> the total-cost sentence  (SwapFundingPickerModal.TotalCostText,
        //           FontRole.Numeral, + SwapQuote.NetworkFee named separately because
        //           the Solana base fee is paid OUTSIDE the route)
        //          -> DRAWN on BOTH surfaces that offer the swap (picker row + refusal).
        //  Every check is SLICE-SCOPED to the method that must carry it, so a stray
        //  reference elsewhere in the file cannot satisfy it (the WO-1943 [sign]/[door]
        //  discipline). Finding the locale key merely DEFINED would prove nothing - an
        //  unused key is exactly the state this ticket exists to rule out.
        // =====================================================================
        private static bool CheckTotalCostDisclosure(StringBuilder notes, out string reason)
        {
            // 9a. the key is minted ONCE, in the store's key registry.
            if (!TryRead(StoreStringsPath, out string keys, out reason)) return false;
            if (!keys.Contains("KeySwapTotalCost = \"" + TotalCostKey + "\"") ||
                !keys.Contains("KeySwapNetworkFee = \"" + NetworkFeeKey + "\""))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: " + StoreStringsPath +
                         " does not declare BOTH KeySwapTotalCost = \"" + TotalCostKey + "\" and " +
                         "KeySwapNetworkFee = \"" + NetworkFeeKey + "\". The total the player actually hands " +
                         "over is player-facing copy and routes through the locale system like every other " +
                         "string (CLAUDE.md localization law) - a literal at the draw site is the defect, not " +
                         "a shortcut. It is TWO keys because the one-sentence form measured longer than the " +
                         "landscape Compact modal band and FitSingleLine would have ellipsized the figure.";
                return false;
            }

            // 9b. the candidate's Cost is the QUOTE's own input side, not a client-side estimate.
            if (!TryRead(ServicePath, out string svc, out reason)) return false;
            // Anchored on the DECLARATION's parameter list, not on the bare name: the first
            // "QuoteCandidateAsync(" in the file is a CALL SITE, and a slice starting there
            // would run over the wrong method entirely.
            string quoteSlice = SliceBetween(svc, "QuoteCandidateAsync(SwapInputToken token", "private ");
            if (quoteSlice == null || !quoteSlice.Contains("c.Cost = quote.MaxInAmount"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: QuoteCandidateAsync in " +
                         ServicePath + " no longer assigns c.Cost from quote.MaxInAmount. MaxInAmount is " +
                         "Jupiter's own otherAmountThreshold - the MAXIMUM the wallet can be charged once " +
                         "slippage is applied, already inclusive of the route/AMM fee. It is the ONLY figure " +
                         "that matches the transaction about to be signed; a total recomputed from " +
                         "SwapFeeConfig._slippageBps can drift from it and a disclosure that drifts is worse " +
                         "than none (WO-1951 sec.8).";
                return false;
            }
            if (!svc.Contains("NetworkFee = " + NetworkFeeLiteral))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: the Solana base fee constant " +
                         NetworkFeeLiteral + " is gone from " + ServicePath + ". It is paid OUTSIDE the " +
                         "Jupiter route, so it is not inside MaxInAmount and the disclosure names it " +
                         "separately; without the constant the line silently under-states the total.";
                return false;
            }
            // The slippage tolerance the review names (<=0.5%) is the config default, and the
            // disclosure's honesty depends on it staying within the copy's claim.
            if (!TryRead(FeeConfigPath, out string cfg2, out reason)) return false;
            if (!cfg2.Contains("private int _slippageBps = 50;"))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: " + FeeConfigPath + " no longer " +
                         "defaults _slippageBps to 50 (0.5 %). The outside review pinned the player's total as " +
                         "route fee + <=0.5% slippage + the network fee; raising this default raises what the " +
                         "player pays, so it is a deliberate copy-and-disclosure change, not a tuning tweak.";
                return false;
            }

            // 9c. the sentence is BUILT from that Cost + the quote's NetworkFee, as a Numeral.
            if (!TryRead(PickerPath, out string modal, out reason)) return false;
            string helperSlice = SliceBetween(modal, "CheapestQuoted(", "private void OnRowTapped(");
            if (helperSlice == null)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: could not locate the total-cost " +
                         "helpers in " + PickerPath + ". The suite fails rather than pass on a file it cannot " +
                         "recognise as the swap funding surface.";
                return false;
            }
            foreach (var needed in new[]
                     {
                         "KeySwapTotalCost",          // the locale key, resolved - never a literal
                         "KeySwapNetworkFee",         // its once-per-surface companion
                         "c.Cost",                    // == quote.MaxInAmount (route fee + slippage)
                         "c.Quote.NetworkFee",        // the Solana base fee, from the QUOTE
                         "FontRole.Numeral"           // money is tabular (typography roles ruling)
                     })
            {
                if (helperSlice.Contains(needed)) continue;
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: the total-cost helpers in " +
                         PickerPath + " no longer reference '" + needed + "'. The disclosure must read the " +
                         "QUOTED maximum input (c.Cost = quote.MaxInAmount: route/AMM fee and slippage " +
                         "included) plus the quote's own NetworkFee, drawn FontRole.Numeral, resolved through " +
                         "KeySwapTotalCost. Drop any one of those and the line either lies, drifts from the " +
                         "signed transaction, or stops being localised.";
                return false;
            }

            // 9d. it is actually DRAWN, on BOTH surfaces that offer the swap. A defined-but-
            //     unused key is precisely the state this case exists to rule out.
            string pickerSlice = SliceBetween(modal, "private void BuildPicker(", "private void BuildRow(");
            if (pickerSlice == null || !pickerSlice.Contains("DrawNetworkFee("))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: BuildPicker in " + PickerPath +
                         " does not draw the network-fee line. The Solana base fee is the THIRD cost the " +
                         "outside review named and the only one not already inside each row's total; it is " +
                         "drawn once per surface, so losing it here loses it from the picker entirely.";
                return false;
            }
            string rowSlice = SliceBetween(modal, "private void BuildRow(", "CheapestQuoted(");
            if (rowSlice == null || !rowSlice.Contains("DrawTotalCost("))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: BuildRow in " + PickerPath +
                         " does not draw the total-cost line. The picker row shows what the player spends and " +
                         "is the last surface before the wallet sheet; without this line the only fee copy in " +
                         "the whole flow is the store footer's '0% STORE FEE', which is true about OUR cut and " +
                         "misleading about what leaves the wallet (WO-1951 sec.4).";
                return false;
            }
            string refusalSlice = SliceBetween(modal, "private void BuildRefusal(", "private float MeasureContentHeightPx(");
            if (refusalSlice == null || !refusalSlice.Contains("DrawTotalCost(") ||
                !refusalSlice.Contains("DrawNetworkFee("))
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: BuildRefusal in " + PickerPath +
                         " does not draw BOTH the total-cost and the network-fee line. The refusal notice " +
                         "tells a player their wallet " +
                         "cannot cover the swap - the total they would have to reach is the single most useful " +
                         "number on that surface, and it is the one the shortfall lines are measured against.";
                return false;
            }

            // 9e. the key resolves to a real, argument-carrying sentence in EVERY locale table
            //     and its StreamingAssets mirror. LocaleParityRegression enforces key parity;
            //     this asserts the SHAPE the draw site depends on.
            int files = 0;
            foreach (string dir in LocaleDirs)
            {
                foreach (string loc in Locales)
                {
                    string p = dir + "/" + loc + ".json";
                    if (!File.Exists(p))
                    {
                        reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: locale table " + p +
                                 " is missing. The disclosure is drawn in every locale; a missing table is a " +
                                 "failure, not a skip.";
                        return false;
                    }
                    string t;
                    try { t = File.ReadAllText(p); }
                    catch (Exception ex)
                    {
                        reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: cannot read " + p + " (" +
                                 ex.GetType().Name + ": " + ex.Message + ").";
                        return false;
                    }
                    // Both keys, each with ITS OWN arguments. Between them they name all three
                    // costs the outside review listed; a translation that drops one silently
                    // hides part of what the player pays.
                    if (!CheckLocaleRow(t, p, TotalCostKey, new[] { "{amount}", "{token}" }, ref reason)) return false;
                    if (!CheckLocaleRow(t, p, NetworkFeeKey, new[] { "{network}" }, ref reason)) return false;
                    files++;
                }
            }

            notes.Append("[total-cost] quote.MaxInAmount -> c.Cost -> Numeral disclosure drawn on the picker " +
                         "row AND the refusal notice, + the once-per-surface network fee, both keys in ")
                 .Append(files).Append(" locale files with their named args");
            reason = null;
            return true;
        }

        /// <summary>
        /// One locale row must EXIST and carry every named argument the draw site substitutes.
        /// Key parity itself is LocaleParityRegression's job; this asserts the SHAPE the draw
        /// site depends on, which parity alone would not catch.
        /// </summary>
        private static bool CheckLocaleRow(string table, string path, string key, string[] args, ref string reason)
        {
            int k = table.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0)
            {
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: " + path + " lacks \"" + key +
                         "\". Every player-facing string exists in every locale table AND its " +
                         "StreamingAssets mirror (CLAUDE.md localization law); a key present in English " +
                         "only reads as '[[missing:...]]' or silently falls back mid-surface.";
                return false;
            }
            int eol = table.IndexOf('\n', k);
            string line = eol < 0 ? table.Substring(k) : table.Substring(k, eol - k);
            foreach (string arg in args)
            {
                if (line.Contains(arg)) continue;
                reason = "[jupiter-endpoint] SOURCE LINT FAIL [total-cost]: " + path + "'s \"" + key +
                         "\" does not carry the named argument " + arg + ". {amount} is the quoted maximum " +
                         "input (route/AMM fee + slippage already inside it), {token} its symbol, {network} " +
                         "the Solana base fee paid outside the route - together they are the whole of what " +
                         "the player hands over, and a translation that drops one hides part of it.";
                return false;
            }
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
