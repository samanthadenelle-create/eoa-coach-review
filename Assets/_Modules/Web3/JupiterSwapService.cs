// =============================================================================
// JupiterSwapService — fetches quotes from the Jupiter aggregator REST API and
// hosts the in-game swap panel (WO-43).
// -----------------------------------------------------------------------------
// Implements IJupiterService (DeNelle.Core); registers itself with CoreServices
// on Awake so any module can open the panel via CoreServices.Jupiter without an
// assembly reference to DeNelle.Web3.
//
// ── WHAT IS REAL vs SCAFFOLDED ───────────────────────────────────────────────
//   REAL : the Jupiter /quote fetch (UnityWebRequest), JSON parse, fee maths,
//          panel show/hide, and the connected-wallet lookup through the existing
//          DeNelle.Wallet.WalletService.
//   STUB : the actual swap-transaction SIGNING + SUBMISSION. The project's
//          SolanaWalletProvider has no Jupiter-swap signing path, and signing a
//          real Jupiter transaction cannot be verified here. ExecuteSwapAsync
//          fetches the serialised /swap transaction from Jupiter and then hands
//          off to WalletBridgeStub, which only logs + fires a fake signature in
//          the editor and HARD-FAILS in a release build. Wire the real signer
//          (a follow-up WO) before shipping.
//
// ── SECURITY / DEVNET ────────────────────────────────────────────────────────
//   No secrets, keys, or API keys are stored here. The game holds NO private
//   key; the player's wallet signs. The SKR mint, the Jupiter API base, and the
//   fee token-account are OWNER-CONFIG placeholders flagged below. NOTE: the
//   project wallet stack is DEVNET-ONLY and owner-gated to mainnet (spec Part
//   10); the public Jupiter aggregator is MAINNET. Reconcile that before live
//   use — see docs flag in the WO report.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using DeNelle.Core;
using DeNelle.Core.Analytics;   // WO-1948: swap_sign_requested / swap_sign_result ride the ONE EventTracker rail
using DeNelle.Core.Backend;
using DeNelle.Core.Diagnostics;
using DeNelle.Wallet;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UIElements;

namespace DeNelle.Web3
{
    [RequireComponent(typeof(UIDocument))]
    public sealed class JupiterSwapService : MonoBehaviour, IJupiterService
    {
        // ── Jupiter REST endpoints (WO-1901) ─────────────────────────────────
        // OWNER-CONFIG: Jupiter aggregator API base. These are the public mainnet
        // endpoints and they are the SINGLE pair — never re-type a Jupiter host
        // anywhere else in the codebase (JupiterEndpointRegression pins that).
        //
        // ⛔ THE RETIRED v6 HOST NO LONGER RESOLVES. Until 2026-09-20 these two
        // consts named Jupiter's retired v6 aggregator host; its DNS record is
        // gone, UnityWebRequest surfaces a DNS failure as the useless string
        // "Unknown Error", and EVERY swap in EVERY build (web + Android) failed
        // closed with funnel reason=provider-refused. That is why the failure
        // paths below log responseCode + host + body, not just req.error.
        // Probed live 2026-09-20: /swap/v1/quote returns HTTP 200 for USDC->SKR
        // ExactOut with access-control-allow-origin: * (WebGL-safe).
        private const string QuoteUrl = "https://lite-api.jup.ag/swap/v1/quote";
        private const string SwapUrl = "https://lite-api.jup.ag/swap/v1/swap";

        // Host only — safe to log (carries no amounts, no wallet, no fee account).
        private static string HostOf(string url)
        {
            try { return new Uri(url).Host; } catch { return "<unparsable-url>"; }
        }

        /// <summary>
        /// First-use marker naming the Jupiter host this build talks to, so a
        /// trace PROVES which endpoint answered instead of leaving it inferred.
        /// </summary>
        private static void TraceEndpointOnce()
        {
            FlowTrace.Once("Swap", "swap-endpoint",
                "Jupiter host=" + HostOf(QuoteUrl) + " quotePath=/swap/v1/quote swapPath=/swap/v1/swap");
        }

        /// <summary>
        /// The one failure-line builder for every Jupiter HTTP path. NEVER log
        /// req.error alone — a DNS failure reduces to "Unknown Error" and names
        /// nothing (WO-1901). Includes the transport error, the HTTP status code,
        /// the HOST (not the query string, which carries amounts), and the first
        /// 200 chars of the response body, which is where Jupiter puts its own
        /// errorCode (e.g. NOT_SUPPORTED / TOKEN_NOT_TRADABLE).
        /// </summary>
        private static string HttpFailureDetail(UnityWebRequest req, string url)
        {
            string body = req != null && req.downloadHandler != null ? (req.downloadHandler.text ?? string.Empty) : string.Empty;
            if (body.Length > 200) body = body.Substring(0, 200);
            body = body.Replace("\n", " ").Replace("\r", " ");
            return "error='" + (req != null ? (req.error ?? "<null>") : "<null-req>") + "'"
                 + " responseCode=" + (req != null ? req.responseCode : -1)
                 + " host=" + HostOf(url)
                 + " body[0..200]='" + body + "'";
        }

        // ── Token mints ──────────────────────────────────────────────────────
        // USDC + SOL mints are sourced from the existing single-source-of-truth
        // DeNelle.Wallet.WalletEndpoints rather than re-hardcoded here, so the
        // swap panel follows the same network discipline as the wallet stack.
        // SKR has no published mint in any doc the agent can read (WalletEndpoints
        // ships it empty) — OWNER must fill the SKR SPL mint before a real swap.
        [SerializeField]
        [Tooltip("OWNER-CONFIG: SKR SPL token mint address (the swap OUTPUT mint). " +
                 "Leave as the placeholder in the editor scaffold; the quote will " +
                 "still round-trip for UI testing but a real swap needs the live mint. " +
                 "WalletEndpoints.SkrMint also ships empty for the same reason.")]
        private string _skrMint = "REPLACE_WITH_SKR_MINT_ADDRESS";

        [SerializeField] private SwapFeeConfig _feeConfig;
        [SerializeField] private UIDocument _document;

        [Tooltip("Optional shared WalletService. When unassigned the service " +
                 "discovers a WalletConnectDialog in the scene to read the " +
                 "connected address, else runs with no wallet (Confirm disabled).")]
        [SerializeField] private WalletConnectDialog _walletDialog;

        // ── Decimals (SPL convention) ─────────────────────────────────────────
        // USDC + SKR are 6 by SPL convention (WalletEndpoints), SOL is 9.
        private const int UsdcDecimals = 6;
        private const int SolDecimals = 9;
        private const int SkrDecimals = 6;   // assumed; verify vs live mint metadata.

        // Wrapped-SOL mint — canonical, network-independent. Only used by the v2
        // SOL input path (not surfaced in the v1 UI). USDC is sourced from
        // WalletEndpoints instead so the rail follows the wallet stack's network.
        private const string WrappedSolMint = "So11111111111111111111111111111111111111112";

        // ── THE ONE token -> mint / decimals mapping (WO-1948) ──────────────
        // Both quote paths (the manual panel's ExactIn GetQuoteAsync and the store's
        // ExactOut GetQuoteExactOutAsync) resolve their inputMint HERE. The ExactOut path
        // used to carry its own hardcoded `WalletEndpoints.UsdcMint(net)` local, which is
        // how a SOL-only wallet was asked to sign a USDC spend (the WO-1948 defect).
        private static string InputMintFor(SwapInputToken token, WalletNetwork net)
            => token == SwapInputToken.SOL ? WrappedSolMint : WalletEndpoints.UsdcMint(net);

        private static int InputDecimalsFor(SwapInputToken token)
            => token == SwapInputToken.SOL ? SolDecimals : UsdcDecimals;

        private static string SymbolFor(SwapInputToken token)
            => token == SwapInputToken.SOL ? "SOL" : "USDC";

        // ── Panel controller (resolved at runtime) ───────────────────────────
        private JupiterSwapPanelController _panelController;

        /// <summary>The fee config in effect (read-only for the controller).</summary>
        public SwapFeeConfig FeeConfig => _feeConfig;

        // =====================================================================
        //  Lifecycle
        // =====================================================================

        private void Awake()
        {
            if (_document == null) _document = GetComponent<UIDocument>();
            CoreServices.RegisterJupiter(this);
        }

        private void Start()
        {
            _panelController = GetComponent<JupiterSwapPanelController>();
            if (_panelController == null)
                Debug.LogWarning("[JupiterSwapService] No JupiterSwapPanelController " +
                                 "on this GameObject — panel will not open.");
            // Panel starts hidden.
            SetPanelVisible(false);
        }

        private void OnDestroy() => CoreServices.UnregisterJupiter(this);

        // =====================================================================
        //  Connected wallet address — through the existing wallet stack
        // =====================================================================

        /// <summary>
        /// The connected wallet's base58 address, or empty when no wallet is
        /// connected. Reads through the existing DeNelle.Wallet stack so we do
        /// not invent a second wallet surface.
        /// </summary>
        public string ConnectedWalletKey
        {
            get
            {
                var w = ResolveWallet();
                return (w != null && w.IsConnected) ? w.Account.Address : string.Empty;
            }
        }

        private WalletService ResolveWallet()
        {
            // WalletService is NOT a UnityEngine.Object. PackStore's instance is
            // stamped on WalletService.ConnectedInstance at Connect. The dialog
            // constructs a second, disconnected WalletService in Awake — that is
            // why Seeker 16:40:29 saw 1222 SKR in the store and "no connected
            // wallet" on ExactOut.
            if (WalletService.ConnectedInstance != null && WalletService.ConnectedInstance.IsConnected)
                return WalletService.ConnectedInstance;
            if (_walletDialog == null)
                _walletDialog = FindAnyObjectByType<WalletConnectDialog>(FindObjectsInactive.Include);
            if (_walletDialog != null && _walletDialog.Wallet != null && _walletDialog.Wallet.IsConnected)
                return _walletDialog.Wallet;
            return _walletDialog != null ? _walletDialog.Wallet : null;
        }

        // =====================================================================
        //  IJupiterService
        // =====================================================================

        public void OpenSwapPanel(decimal minimumSkr = 0m)
        {
            SetPanelVisible(true);
            if (_panelController != null)
                _panelController.Initialise(minimumSkr, _feeConfig);
        }

        public void CloseSwapPanel() => SetPanelVisible(false);

        public async Task<SwapQuote> GetQuoteAsync(SwapInputToken input, decimal inputAmount)
        {
            FlowTrace.Step("Swap", $"GetQuoteAsync input={input} amount={inputAmount} outMint='{_skrMint}'");
            if (_skrMint == "REPLACE_WITH_SKR_MINT_ADDRESS" || string.IsNullOrEmpty(_skrMint))
                FlowTrace.Warn("Swap", "SKR mint is the unset placeholder — quote round-trips for UI but a real swap will fail (flag_13)");
            if (_feeConfig == null)
            {
                FlowTrace.Warn("Swap", "SwapFeeConfig not assigned — using defaults (slippage 50, fee 20bps, no fee account)");
                Debug.LogWarning("[JupiterSwapService] SwapFeeConfig not assigned — using defaults.");
            }

            int slippageBps = _feeConfig != null ? _feeConfig.SlippageBps : 50;
            int platformFeeBps = _feeConfig != null ? _feeConfig.PlatformFeeBps : 20;
            string feeAccount = _feeConfig != null ? _feeConfig.FeeWalletAddress : string.Empty;

            string skrMint = ResolvedSkrMint();
            if (string.IsNullOrEmpty(skrMint) || skrMint == "REPLACE_WITH_SKR_MINT_ADDRESS")
            {
                FlowTrace.Fail("Swap", "GetQuoteAsync aborted: SKR mint unresolved.");
                return null;
            }
            string inputMint = InputMintFor(input, WalletService.DefaultNetwork);
            int decimals = InputDecimalsFor(input);

            // Jupiter amounts are in the token's smallest unit.
            long amountUnits = (long)(inputAmount * (decimal)Math.Pow(10, decimals));
            if (amountUnits <= 0) { FlowTrace.Warn("Swap", $"GetQuoteAsync aborted: amountUnits<=0 ({amountUnits}) for input {inputAmount}"); return null; }

            var sb = new StringBuilder(QuoteUrl);
            sb.Append("?inputMint=").Append(UnityWebRequest.EscapeURL(inputMint));
            sb.Append("&outputMint=").Append(UnityWebRequest.EscapeURL(skrMint));
            sb.Append("&amount=").Append(amountUnits.ToString(CultureInfo.InvariantCulture));
            sb.Append("&slippageBps=").Append(slippageBps.ToString(CultureInfo.InvariantCulture));
            // ⛔ platformFeeBps ONLY when a fee account is configured. Probed live
            // 2026-09-20: a quote carrying platformFee posted to /swap/v1/swap with
            // no feeAccount returns HTTP 400 {"errorCode":"NOT_SUPPORTED",
            // "error":"feeAccount is required for swap with platformFee"} — i.e.
            // asking for the fee unconditionally BREAKS the swap for an unconfigured
            // build. feeAccount is accepted (and ignored) on /quote; the swap body
            // is where it is actually consumed.
            if (!string.IsNullOrEmpty(feeAccount))
            {
                sb.Append("&platformFeeBps=").Append(platformFeeBps.ToString(CultureInfo.InvariantCulture));
                sb.Append("&feeAccount=").Append(UnityWebRequest.EscapeURL(feeAccount));
            }

            TraceEndpointOnce();
            TrackQuoteRequested("ExactIn", input, inputMint, amountUnits, slippageBps);
            using var req = UnityWebRequest.Get(sb.ToString());
            req.SetRequestHeader("Accept", "application/json");

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
            {
                string detail = HttpFailureDetail(req, QuoteUrl);
                FlowTrace.Warn("Swap", "Quote request FAILED: " + detail);
                Debug.LogWarning("[JupiterSwapService] Quote request failed: " + detail);
                TrackQuoteResult("ExactIn", input, inputMint, amountUnits, req.responseCode, null, detail);
                return null;
            }

            FlowTrace.Step("Swap", "quote HTTP ok — parsing");
            var parsed = ParseQuote(req.downloadHandler.text, inputAmount, decimals, slippageBps,
                                    input, inputMint, exactOut: false);
            TrackQuoteResult("ExactIn", input, inputMint, amountUnits, req.responseCode, parsed,
                             parsed == null ? "parse failed" : null);
            return parsed;
        }

        // ── swap_quote_requested / swap_quote_result (WO-1948 review add-on 2) ───────────
        // One pair per Jupiter /quote call on either path. amountUnits is the base-unit
        // amount as sent (input units on ExactIn, SKR units on ExactOut); inAmount/skrOut
        // are the parsed whole-unit figures when the DTO carried them.
        private static void TrackQuoteRequested(string mode, SwapInputToken input, string inputMint,
                                                long amountUnits, int slippageBps)
        {
            Guard.Try("Swap", "analytics swap_quote_requested", () => EventTracker.Track("swap_quote_requested", new
            {
                mode,
                inputToken = input.ToString(),
                inputMint = inputMint ?? string.Empty,
                amountUnits,
                slippageBps,
                platform = EventTracker.Platform,
                channel = EventTracker.Channel
            }));
        }

        private static void TrackQuoteResult(string mode, SwapInputToken input, string inputMint,
                                             long amountUnits, long httpStatus, SwapQuote quote, string error)
        {
            Guard.Try("Swap", "analytics swap_quote_result", () => EventTracker.Track("swap_quote_result", new
            {
                mode,
                inputToken = input.ToString(),
                inputMint = inputMint ?? string.Empty,
                amountUnits,
                ok = quote != null,
                httpStatus,
                inAmount = quote != null ? (double)quote.InAmount : 0d,
                maxInAmount = quote != null ? (double)quote.MaxInAmount : 0d,
                skrOut = quote != null ? (double)quote.SkrOut : 0d,
                error = error ?? string.Empty,
                platform = EventTracker.Platform,
                channel = EventTracker.Channel
            }));
        }

        // =====================================================================
        //  Quote parsing (JsonUtility — no third-party JSON dependency)
        // =====================================================================

        /// <summary>
        /// Parses the Jupiter /quote JSON response into a <see cref="SwapQuote"/>.
        /// Uses <see cref="JsonUtility"/> with a private DTO to avoid pulling a
        /// JSON library into the DeNelle.Web3 asmdef.
        /// </summary>
        private SwapQuote ParseQuote(string json, decimal inputAmount, int inputDecimals, int slippageBps,
                                     SwapInputToken inputToken, string inputMint, bool exactOut)
        {
            try
            {
                var dto = JsonUtility.FromJson<QuoteResponseDto>(json);
                if (dto == null) return null;

                // Jupiter returns outAmount as a string of base units.
                decimal skrRaw = 0m;
                if (!string.IsNullOrEmpty(dto.outAmount) &&
                    decimal.TryParse(dto.outAmount, NumberStyles.Integer, CultureInfo.InvariantCulture, out var rawOut))
                    skrRaw = rawOut;

                decimal skrOut = skrRaw / (decimal)Math.Pow(10, SkrDecimals);

                // WO-1948: the INPUT side. inAmount is the quoted spend; on ExactOut,
                // otherAmountThreshold is the MAXIMUM the wallet can be charged once
                // slippage is applied - that is the figure a balance must cover. On ExactIn
                // the threshold is a minimum-OUT and is deliberately ignored here.
                decimal inParsed = 0m;
                if (!string.IsNullOrEmpty(dto.inAmount) &&
                    decimal.TryParse(dto.inAmount, NumberStyles.Integer, CultureInfo.InvariantCulture, out var rawIn))
                    inParsed = rawIn / (decimal)Math.Pow(10, inputDecimals);
                decimal inAmount = inParsed > 0m ? inParsed : inputAmount;
                decimal maxIn = inAmount;
                if (exactOut && !string.IsNullOrEmpty(dto.otherAmountThreshold) &&
                    decimal.TryParse(dto.otherAmountThreshold, NumberStyles.Integer, CultureInfo.InvariantCulture, out var rawMax))
                {
                    decimal parsedMax = rawMax / (decimal)Math.Pow(10, inputDecimals);
                    if (parsedMax > maxIn) maxIn = parsedMax;
                }

                decimal rate = inAmount > 0 ? skrOut / inAmount : 0m;

                // Platform fee (in input-token units).
                decimal platformFee = 0m;
                if (dto.platformFee != null && !string.IsNullOrEmpty(dto.platformFee.amount) &&
                    decimal.TryParse(dto.platformFee.amount, NumberStyles.Integer, CultureInfo.InvariantCulture, out var pfRaw))
                    platformFee = pfRaw / (decimal)Math.Pow(10, inputDecimals);

                return new SwapQuote
                {
                    SkrOut = skrOut,
                    Rate = rate,
                    PlatformFee = platformFee,
                    NetworkFee = 0.000005m,   // Solana base fee — refine with an actual estimate.
                    SlippageBps = slippageBps,
                    RoutePlan = json,         // forwarded verbatim to /swap
                    InputToken = inputToken,
                    InputMint = inputMint,
                    InAmount = inAmount,
                    MaxInAmount = maxIn
                };
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Swap", $"quote parse error (UI shows no rate): {ex.GetType().Name}: {ex.Message}");
                Debug.LogWarning($"[JupiterSwapService] Quote parse error: {ex.Message}");
                return null;
            }
        }

        // =====================================================================
        //  Swap transaction — SCAFFOLD (signing is a stub; see file header)
        // =====================================================================

        /// <summary>
        /// Requests a serialised swap transaction from Jupiter and forwards it to
        /// the wallet bridge for signing + submission. SCAFFOLD: the wallet bridge
        /// is a stub (WalletBridgeStub). Returns true when the /swap request
        /// itself succeeded and was handed off; it does NOT mean a real on-chain
        /// swap occurred. Wire a real signer before shipping.
        /// </summary>
        // User-supplied portion of the /swap body — serialized via JsonUtility so all
        // string fields are correctly escaped (B-JSONINJ). quoteResponse is spliced in raw.
        [Serializable]
        private struct SwapRequestTail
        {
            public string userPublicKey;
            public bool wrapAndUnwrapSol;
            // Jupiter /swap/v1/swap: let the API size the compute-unit limit rather
            // than shipping the 1.4M default, which overpays priority fees.
            public bool dynamicComputeUnitLimit;
        }

        // The fee-bearing variant. JsonUtility emits every field of a struct, so a
        // single DTO would always send "feeAccount":"" and Jupiter treats that as a
        // supplied-but-invalid account. Two DTOs keep the key ABSENT when unset.
        [Serializable]
        private struct SwapRequestTailWithFee
        {
            public string userPublicKey;
            public bool wrapAndUnwrapSol;
            public bool dynamicComputeUnitLimit;
            public string feeAccount;
        }

        [Serializable]
        private class SwapResponseDto
        {
            public string swapTransaction;
            // 2026-09-22 live probe: Jupiter simulates the swap server-side and reports the
            // failure HERE, with HTTP 200, before any wallet sheet - an unfunded payer reads
            // "Attempt to debit an account but found no record of a prior credit.". The field is
            // null, a string, or an object depending on the route; JsonUtility cannot tell an
            // absent/null object from an empty one, so the truth is read by
            // SwapSimulationError.Extract over the raw body and this DTO field is informational.
            public SimulationErrorDto simulationError;
            public long simulationSlot;
        }

        [Serializable]
        private class SimulationErrorDto
        {
            public string errorCode;
            public string error;
        }

        public Task<bool> ExecuteSwapAsync(SwapQuote quote, string userPublicKey)
            => ExecuteSwapCoreAsync(quote, userPublicKey, "manual");

        /// <summary>
        /// <paramref name="selection"/> names HOW the input token was chosen ("auto" / "picker"
        /// from the store top-up, "manual" from the swap panel) - it rides on the analytics
        /// events only; transaction behaviour is identical for all three.
        /// </summary>
        private async Task<bool> ExecuteSwapCoreAsync(SwapQuote quote, string userPublicKey, string selection,
                                                      string fundingContext = "")
        {
            FlowTrace.Step("Swap", $"ExecuteSwapAsync user='{(string.IsNullOrEmpty(userPublicKey) ? "<empty>" : userPublicKey)}' hasQuote={quote != null}");
            if (quote == null || string.IsNullOrEmpty(userPublicKey)) { FlowTrace.Warn("Swap", "ExecuteSwapAsync aborted: null quote or empty userPublicKey (no wallet connected?)"); return false; }

            // Build the /swap request body. quote.RoutePlan is the verbatim /quote
            // response JSON (exactly the quoteResponse object the /swap endpoint expects),
            // so it stays raw. The user-supplied fields go through a DTO + JsonUtility.ToJson
            // so userPublicKey is PROPERLY ESCAPED (security audit B-JSONINJ — no string-concat
            // JSON injection). We splice the serialized tail (minus its opening brace) after the
            // raw quoteResponse.
            string feeAccount = _feeConfig != null ? _feeConfig.FeeWalletAddress : string.Empty;
            string tailJson = string.IsNullOrEmpty(feeAccount)
                ? JsonUtility.ToJson(new SwapRequestTail
                  {
                      userPublicKey = userPublicKey,
                      wrapAndUnwrapSol = true,
                      dynamicComputeUnitLimit = true
                  })
                : JsonUtility.ToJson(new SwapRequestTailWithFee
                  {
                      userPublicKey = userPublicKey,
                      wrapAndUnwrapSol = true,
                      dynamicComputeUnitLimit = true,
                      feeAccount = feeAccount
                  });
            string tailInner = tailJson.Substring(1, tailJson.Length - 2); // strip the wrapping braces
            string body = "{\"quoteResponse\":" + quote.RoutePlan + "," + tailInner + "}";

            TraceEndpointOnce();
            using var req = new UnityWebRequest(SwapUrl, "POST");
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
            {
                string detail = HttpFailureDetail(req, SwapUrl);
                FlowTrace.Warn("Swap", "/swap request FAILED: " + detail + " — no transaction to sign");
                Debug.LogWarning("[JupiterSwapService] Swap request failed: " + detail);
                return false;
            }

            string swapJson = req.downloadHandler.text;
            var dto = JsonUtility.FromJson<SwapResponseDto>(swapJson);
            if (dto == null || string.IsNullOrEmpty(dto.swapTransaction))
            {
                FlowTrace.Fail("Swap", "/swap ok but swapTransaction missing — cannot sign.");
                return false;
            }

            // ── PRE-SIGN SIMULATION GATE (2026-09-22 live probe) ──────────────────────────
            // Jupiter simulates the built transaction and, for a payer that cannot fund it,
            // answers 200 with simulationError POPULATED. That is a refusal we can read BEFORE
            // opening any wallet sheet - so no sign request is made, the player sees the
            // not-charged path, and the trace/event carry the exact simulation text plus the
            // funding context computed earlier. The WO-1943 catch arms downstream are untouched.
            string simulationError = SwapSimulationError.Extract(swapJson);
            if (simulationError != null)
            {
                string slot = dto.simulationSlot > 0 ? " slot=" + dto.simulationSlot.ToString(CultureInfo.InvariantCulture) : string.Empty;
                FlowTrace.Warn("Swap", "/swap returned simulationError - NOT requesting a sign (player NOT charged): " +
                                       simulationError + slot +
                                       (string.IsNullOrEmpty(fundingContext) ? string.Empty : " | funding[" + fundingContext + "]"));
                TrackSignResult("refused-presim", simulationError, 0L, quote.InputToken.ToString(),
                                quote.InputMint ?? string.Empty, selection, null, fundingContext);
                return false;
            }

            var wallet = ResolveWallet();
            if (wallet == null)
            {
                FlowTrace.Fail("Swap", "ExecuteSwapAsync: no WalletService — cannot sign.");
                return false;
            }

            FlowTrace.Step("Swap", "/swap ok — opaque swapTransaction to wallet (no Transaction.Deserialize; Jupiter v0).");

            // ── WO-1948 analytics: the sign request and its result, on the ONE EventTracker rail ──
            // swap_sign_requested fires immediately before the MWA sign call; swap_sign_result
            // fires on every exit of that call (ok / refused / error). The provider's own catch
            // arms (WO-1943) already RETURN timeout + refusal as (false, null, hint), so judging
            // sent.ok/sent.error here covers every arm without touching them; a throw from any
            // other cause is recorded as "error" and RETHROWN so SwapVM / JupiterSwapDoor keep
            // the indeterminate-outcome semantics they were written for.
            string inputToken = quote.InputToken.ToString();
            string inputMint = quote.InputMint ?? string.Empty;

            // ── Review add-on 4: the swap's FEE PAYER vs the MWA-AUTHORIZED account, byte for byte ──
            // userPublicKey is what the /swap body named as the payer; wallet.Account.Address is the
            // base58 of AuthorizationResult.PublicKey (SolanaWalletProvider.Connect). Base58 is ASCII,
            // so an ordinal string compare IS a byte-for-byte compare of the encoded keys. Logged
            // MASKED (privacy rule at WalletService.Connect): 4+4 chars is enough to tell two apart.
            string authorized = wallet.Account.Address ?? string.Empty;
            bool feePayerMatches = string.Equals(userPublicKey, authorized, StringComparison.Ordinal);
            string payerMasked = Mask(userPublicKey), authorizedMasked = Mask(authorized);
            if (feePayerMatches)
                FlowTrace.Step("Swap", "ExecuteSwapAsync fee payer " + payerMasked + " == MWA authorized account " + authorizedMasked + " (byte-for-byte).");
            else
                FlowTrace.Warn("Swap", "ExecuteSwapAsync fee payer MISMATCH: swap userPublicKey=" + payerMasked +
                                       " vs MWA authorized account=" + authorizedMasked +
                                       " - the wallet will be asked to sign for a payer it did not authorize.");

            FlowTrace.Step("Swap", "ExecuteSwapAsync requesting sign: token=" + inputToken + " mint=" + inputMint +
                                   " cost=" + quote.InAmount.ToString("0.######", CultureInfo.InvariantCulture) +
                                   " maxCost=" + quote.MaxInAmount.ToString("0.######", CultureInfo.InvariantCulture) +
                                   " selection=" + selection + " feePayerMatches=" + feePayerMatches +
                                   (string.IsNullOrEmpty(fundingContext) ? string.Empty : " funding[" + fundingContext + "]"));
            Guard.Try("Swap", "analytics swap_sign_requested", () => EventTracker.Track("swap_sign_requested", new
            {
                sku = (string)null,   // the Core door carries only the SKR amount; PackStore does not pass its sku
                inputToken,
                inputMint,
                quotedCost = (double)quote.InAmount,
                maxCost = (double)quote.MaxInAmount,
                skrOut = (double)quote.SkrOut,
                selection,
                feePayerMatches,
                feePayer = payerMasked,
                authorizedAccount = authorizedMasked,
                funding = fundingContext ?? string.Empty,
                platform = EventTracker.Platform,
                channel = EventTracker.Channel
            }));

            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            (bool ok, string signature, string error) sent;
            try
            {
                sent = await wallet.SignAndSendSwapTransaction(dto.swapTransaction);
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                TrackSignResult("error", ex.GetType().Name + ": " + ex.Message, stopwatch.ElapsedMilliseconds,
                                inputToken, inputMint, selection, null, fundingContext);
                throw;
            }
            stopwatch.Stop();
            if (!sent.ok)
            {
                // The neutral sign-path hint (SolanaWalletProvider.ExplainSignRefusal) plus the funding
                // context computed BEFORE the request: what the wallet held, what each token needed.
                FlowTrace.Fail("Swap", "wallet SignAndSendSwap FAILED: " + (sent.error ?? "unknown") +
                                       (string.IsNullOrEmpty(fundingContext) ? string.Empty : " | funding[" + fundingContext + "]"));
                TrackSignResult("refused", sent.error, stopwatch.ElapsedMilliseconds, inputToken, inputMint, selection, null, fundingContext);
                return false;
            }
            FlowTrace.Step("Swap", "swap submitted sig=" + sent.signature);
            TrackSignResult("ok", null, stopwatch.ElapsedMilliseconds, inputToken, inputMint, selection, sent.signature, fundingContext);
            CloseSwapPanel();
            return true;
        }

        /// <summary>First 4 + last 4 characters of a base58 key, or "&lt;empty&gt;" - never the full key in a log.</summary>
        private static string Mask(string key)
        {
            if (string.IsNullOrEmpty(key)) return "<empty>";
            return key.Length <= 8 ? key : key.Substring(0, 4) + "…" + key.Substring(key.Length - 4);
        }

        /// <summary>swap_sign_result: outcome ok | refused | error, the wallet's error text, the MWA
        /// code when the text carries one ("MWA ERROR_AUTHORIZATION_FAILED (-1)"), elapsed ms, and
        /// the funding context (balances + per-token need/have) computed before the request.</summary>
        private static void TrackSignResult(string outcome, string error, long elapsedMs,
                                            string inputToken, string inputMint, string selection, string signature,
                                            string funding)
        {
            int? mwaCode = MwaCodeOf(error);
            Guard.Try("Swap", "analytics swap_sign_result", () => EventTracker.Track("swap_sign_result", new
            {
                outcome,
                error = error ?? string.Empty,
                mwaCode,
                elapsedMs,
                inputToken,
                inputMint,
                selection,
                signature = signature ?? string.Empty,
                funding = funding ?? string.Empty,
                platform = EventTracker.Platform,
                channel = EventTracker.Channel
            }));
        }

        /// <summary>The "(-1)" style code inside an MWA hint, or null when the text carries none.</summary>
        private static int? MwaCodeOf(string error)
        {
            if (string.IsNullOrEmpty(error)) return null;
            int at = error.IndexOf("MWA ", StringComparison.Ordinal);
            if (at < 0) return null;
            int open = error.IndexOf('(', at);
            if (open < 0) return null;
            int close = error.IndexOf(')', open);
            if (close < 0) return null;
            string inner = error.Substring(open + 1, close - open - 1).Trim();
            return int.TryParse(inner, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out int code)
                ? code : (int?)null;
        }

        /// <summary>
        /// Night Market shortfall: ExactOut quote for <paramref name="minimumSkr"/> SKR,
        /// then the connected wallet confirms. No silent send.
        /// </summary>
        public async Task<bool> TopUpSkrAsync(decimal minimumSkr)
        {
            FlowTrace.Step("Swap", "TopUpSkrAsync ExactOut minimumSkr=" + minimumSkr.ToString("0.##"));
            if (minimumSkr <= 0m) return true;
            string walletKey = ConnectedWalletKey;
            if (string.IsNullOrEmpty(walletKey))
            {
                var w = ResolveWallet();
                if (w != null && !w.IsConnected)
                {
                    FlowTrace.Step("Swap", "TopUpSkrAsync: wallet present but disconnected — Connect() then ExactOut.");
                    try { await w.Connect(); }
                    catch (Exception ex)
                    {
                        FlowTrace.Fail("Swap", "TopUpSkrAsync Connect threw " + ex.GetType().Name + ": " + ex.Message);
                        return false;
                    }
                    walletKey = ConnectedWalletKey;
                }
            }
            if (string.IsNullOrEmpty(walletKey))
            {
                FlowTrace.Warn("Swap", "TopUpSkrAsync: no connected wallet — blocked (player NOT charged).");
                return false;
            }
            FlowTrace.Step("Swap", "TopUpSkrAsync wallet=" + walletKey.Substring(0, Math.Min(8, walletKey.Length)) + "…");

            // ── WO-1948 s3.1: READ THE WALLET BEFORE QUOTING ANYTHING ────────────────────
            // The rail used to go straight to a USDC ExactOut quote and hand a SOL-only
            // wallet a spend it could not make. Balances first; the three numbers are traced
            // so a captured run proves the comparison happened rather than inferring it.
            var connected = ResolveWallet();
            var balances = await ReadBalancesForSwapAsync(connected);
            FlowTrace.Step("Swap", "TopUpSkrAsync balances: sol=" + SwapFundingSelector.F(balances.sol) +
                                   " usdc=" + SwapFundingSelector.F(balances.usdc) +
                                   " skr=" + SwapFundingSelector.F(balances.skr) +
                                   " known=" + balances.known);
            if (!balances.known)
            {
                // Review add-on 3: an UNREAD wallet is neither rich nor empty. Never quote, never
                // sign, never report "holds nothing" - refuse through the not-charged path.
                FlowTrace.Warn("Swap", "TopUpSkrAsync: wallet balance UNKNOWN (read failed or no wallet) - refusing before any quote or sign request (player NOT charged).");
                TrackFundingDecision(minimumSkr, balances, null, "unknown-balance", null, null);
                return false;
            }

            // ── s3.2: quote EVERY candidate for the same ExactOut amount, then decide ───────
            var decision = await DecideFundingAsync(minimumSkr, balances);

            SwapFundingCandidate chosen;
            string how;
            switch (decision.Outcome)
            {
                case SwapFundingOutcome.Auto:
                    chosen = decision.Chosen;
                    how = "auto";
                    break;

                case SwapFundingOutcome.Picker:
                    // s3.3: two or more tokens cover it - the player taps the one to spend,
                    // BEFORE any /swap POST or MWA sign request. Quotes are already in hand.
                    FlowTrace.Step("Swap", "TopUpSkrAsync: " + decision.Eligible.Count +
                                           " tokens cover it - showing the picker before any sign request.");
                    int picked = await SwapFundingPickerModal.ShowPickerAsync(decision.Eligible);
                    if (picked < 0 || picked >= decision.Eligible.Count)
                    {
                        FlowTrace.Warn("Swap", "TopUpSkrAsync: picker dismissed without a choice - no sign request (player NOT charged).");
                        TrackFundingDecision(minimumSkr, balances, decision, "picker-dismissed", null, null);
                        return false;
                    }
                    chosen = decision.Eligible[picked];
                    how = "picker";
                    break;

                default:
                    // s3.4: NEVER request a signature for a spend the wallet cannot make.
                    FlowTrace.Warn("Swap", "TopUpSkrAsync: no token covers minimumSkr — refusing before any sign request. " +
                                           SwapFundingSelector.ShortfallSummary(decision.Considered));
                    TrackFundingDecision(minimumSkr, balances, decision, "refused", null, null);
                    Guard.Try("Swap", "show swap funding refusal", () => SwapFundingPickerModal.ShowRefusal(decision.Considered));
                    return false;
            }

            FlowTrace.Step("Swap", "TopUpSkrAsync input mint selected: " + chosen.Symbol + " (" + how + ")" +
                                   " needed=" + SwapFundingSelector.F(chosen.Cost) +
                                   " have=" + SwapFundingSelector.F(chosen.Spendable) +
                                   " mint=" + chosen.Mint);
            TrackFundingDecision(minimumSkr, balances, decision, how, chosen.Symbol, chosen.Mint);
            FlowTrace.Step("Swap", "TopUpSkrAsync requesting sign: mint=" + chosen.Mint +
                                   " amount=" + SwapFundingSelector.F(chosen.Cost) + " token=" + chosen.Symbol);
            // The funding context rides into the sign-result trace/event so a REFUSAL at the sheet is
            // read next to what the wallet held and what was asked, never as a dapp-identity mystery.
            string fundingContext = "balances sol=" + SwapFundingSelector.F(balances.sol) + " usdc=" + SwapFundingSelector.F(balances.usdc) +
                                    " skr=" + SwapFundingSelector.F(balances.skr) + "; " +
                                    SwapFundingSelector.ShortfallSummary(decision.Considered);
            return await ExecuteSwapCoreAsync(chosen.Quote, walletKey, how, fundingContext);
        }

        /// <summary>The manual swap panel's balance read (SwapVM through ISwapBackend) - the SAME
        /// seam the store top-up uses, so both surfaces feed the one selector.</summary>
        public Task<(decimal sol, decimal usdc, decimal skr, bool known)> ReadBalancesAsync()
            => ReadBalancesForSwapAsync(ResolveWallet());

        /// <summary>
        /// The connected wallet's SOL / USDC / SKR through the EXISTING seam
        /// (WalletService.GetBalance -> SolanaWalletProvider.GetBalance, one RPC round).
        /// <c>known</c> is FALSE when the read did not happen (no wallet, provider threw,
        /// WalletBalance.Unknown) - an unread wallet is never quoted or signed against, and it
        /// is never reported as "holds nothing" either (WO-1948 review add-on 3).
        /// </summary>
        private static async Task<(decimal sol, decimal usdc, decimal skr, bool known)> ReadBalancesForSwapAsync(WalletService wallet)
        {
            if (wallet == null || !wallet.IsConnected)
            {
                FlowTrace.Warn("Swap", "TopUpSkrAsync balance read skipped: no connected WalletService - balance UNKNOWN.");
                return (0m, 0m, 0m, false);
            }
            try
            {
                var b = await wallet.GetBalance();
                if (b.Unknown)
                {
                    FlowTrace.Warn("Swap", "TopUpSkrAsync balance read returned UNKNOWN (WalletService.GetBalance did not read the wallet) - refusing rather than guessing.");
                    return (0m, 0m, 0m, false);
                }
                return ((decimal)b.Sol, (decimal)b.Usdc, (decimal)b.Skr, true);
            }
            catch (Exception ex)
            {
                FlowTrace.Fail("Swap", "TopUpSkrAsync balance read THREW " + ex.GetType().Name + ": " + ex.Message +
                                       " - balance UNKNOWN (the swap will be refused, not guessed).");
                return (0m, 0m, 0m, false);
            }
        }

        /// <summary>
        /// swap_funding_decision (WO-1948 review add-on 1): the wallet's balances AT THE MOMENT of
        /// the top-up decision, the reserve, each candidate's quoted cost, the outcome and the
        /// chosen mint. This single row is what would have diagnosed the 2026-09-21 refusal
        /// without a device (0 USDC held; the -1 was an unpayable, well-formed swap).
        /// </summary>
        private static void TrackFundingDecision(decimal minimumSkr,
            (decimal sol, decimal usdc, decimal skr, bool known) balances,
            SwapFundingDecision decision, string outcome, string chosenToken, string chosenMint)
        {
            decimal solCost = 0m, usdcCost = 0m; bool solQuoted = false, usdcQuoted = false;
            if (decision != null)
            {
                for (int i = 0; i < decision.Considered.Count; i++)
                {
                    var c = decision.Considered[i];
                    if (c.Token == SwapInputToken.SOL) { solCost = c.Cost; solQuoted = c.Quoted; }
                    else if (c.Token == SwapInputToken.USDC) { usdcCost = c.Cost; usdcQuoted = c.Quoted; }
                }
            }
            decimal reserve = WalletEndpoints.SolReserveForRentAndFees;
            FlowTrace.Step("Swap", "TopUpSkrAsync funding decision row: minimumSkr=" + SwapFundingSelector.F(minimumSkr) +
                                   " sol=" + SwapFundingSelector.F(balances.sol) + " usdc=" + SwapFundingSelector.F(balances.usdc) +
                                   " skr=" + SwapFundingSelector.F(balances.skr) + " known=" + balances.known +
                                   " solReserve=" + SwapFundingSelector.F(reserve) +
                                   " solSpendable=" + SwapFundingSelector.F(SwapFundingSelector.Spendable(balances.sol, reserve)) +
                                   " solCost=" + SwapFundingSelector.F(solCost) + " usdcCost=" + SwapFundingSelector.F(usdcCost) +
                                   " outcome=" + outcome + " chosen=" + (chosenToken ?? "-") + " mint=" + (chosenMint ?? "-"));
            Guard.Try("Swap", "analytics swap_funding_decision", () => EventTracker.Track("swap_funding_decision", new
            {
                minimumSkr = (double)minimumSkr,
                sol = (double)balances.sol,
                usdc = (double)balances.usdc,
                skr = (double)balances.skr,
                balanceKnown = balances.known,
                solReserve = (double)reserve,
                solSpendable = (double)SwapFundingSelector.Spendable(balances.sol, reserve),
                solCost = (double)solCost,
                solQuoted,
                usdcCost = (double)usdcCost,
                usdcQuoted,
                outcome,
                chosenToken = chosenToken ?? string.Empty,
                chosenMint = chosenMint ?? string.Empty,
                platform = EventTracker.Platform,
                channel = EventTracker.Channel
            }));
        }

        /// <summary>
        /// Build the candidate list (preference order: SOL, then USDC), fetch one ExactOut quote
        /// per candidate, and run the ONE selector. Every candidate quote is traced, the losing
        /// one included (WO-1948 s3.6 step 3).
        /// <para>s3.2 step 4 ("any other funded routable token") has NO data source in the
        /// existing seam: GetBalance reads exactly SOL / USDC / SKR and SKR is excluded by rule
        /// (never source-swap SKR to buy SKR). A further token is one Add() here once a balance
        /// seam for it exists.</para>
        /// </summary>
        private async Task<SwapFundingDecision> DecideFundingAsync(decimal skrNeeded,
            (decimal sol, decimal usdc, decimal skr, bool known) balances)
        {
            var wallet = ResolveWallet();
            var net = wallet != null ? wallet.Network : WalletService.DefaultNetwork;
            var candidates = new List<SwapFundingCandidate>(2)
            {
                await QuoteCandidateAsync(SwapInputToken.SOL, net, balances.sol,
                                          WalletEndpoints.SolReserveForRentAndFees, skrNeeded),
                await QuoteCandidateAsync(SwapInputToken.USDC, net, balances.usdc, 0m, skrNeeded)
            };
            var decision = SwapFundingSelector.Select(candidates);
            FlowTrace.Step("Swap", "TopUpSkrAsync funding decision: " + decision.Outcome + " - " + decision.Why);
            return decision;
        }

        private async Task<SwapFundingCandidate> QuoteCandidateAsync(SwapInputToken token, WalletNetwork net,
            decimal balance, decimal reserve, decimal skrNeeded)
        {
            var c = new SwapFundingCandidate
            {
                Token = token,
                Symbol = SymbolFor(token),
                Mint = InputMintFor(token, net),
                Balance = balance,
                Reserve = reserve
            };
            var quote = await GetQuoteExactOutAsync(skrNeeded, token);
            if (quote == null)
            {
                FlowTrace.Warn("Swap", "TopUpSkrAsync candidate quote " + c.Symbol + ": NO QUOTE (mint=" + c.Mint +
                                       ") balance=" + SwapFundingSelector.F(balance) +
                                       " spendable=" + SwapFundingSelector.F(c.Spendable) + " - not eligible.");
                return c;
            }
            c.Quoted = true;
            c.Quote = quote;
            c.Cost = quote.MaxInAmount > 0m ? quote.MaxInAmount : quote.InAmount;
            FlowTrace.Step("Swap", "TopUpSkrAsync candidate quote " + c.Symbol + ": mint=" + c.Mint +
                                   " in=" + SwapFundingSelector.F(quote.InAmount) +
                                   " maxIn=" + SwapFundingSelector.F(quote.MaxInAmount) +
                                   " skrOut=" + SwapFundingSelector.F(quote.SkrOut) +
                                   " balance=" + SwapFundingSelector.F(balance) +
                                   " reserve=" + SwapFundingSelector.F(reserve) +
                                   " spendable=" + SwapFundingSelector.F(c.Spendable) +
                                   " covers=" + c.Covers);
            return c;
        }

        /// <summary>
        /// ExactOut quote for <paramref name="skrNeeded"/> SKR paid in <paramref name="input"/>.
        /// WO-1948: the input mint is a PARAMETER resolved through the one InputMintFor seam -
        /// this method no longer decides the token on its own.
        /// </summary>
        private async Task<SwapQuote> GetQuoteExactOutAsync(decimal skrNeeded, SwapInputToken input)
        {
            string skrMint = ResolvedSkrMint();
            var wallet = ResolveWallet();
            var net = wallet != null ? wallet.Network : WalletService.DefaultNetwork;
            int skrDecimals = WalletEndpoints.SkrDecimals(net);
            long outUnits = (long)(skrNeeded * (decimal)Math.Pow(10, skrDecimals));
            if (outUnits <= 0)
            {
                FlowTrace.Warn("Swap", "GetQuoteExactOutAsync aborted: outUnits<=0");
                return null;
            }

            int slippageBps = _feeConfig != null ? _feeConfig.SlippageBps : 50;
            int platformFeeBps = _feeConfig != null ? _feeConfig.PlatformFeeBps : 20;
            string feeAccount = _feeConfig != null ? _feeConfig.FeeWalletAddress : string.Empty;
            string inputMint = InputMintFor(input, net);
            int inputDecimals = InputDecimalsFor(input);

            var sb = new StringBuilder(QuoteUrl);
            sb.Append("?inputMint=").Append(UnityWebRequest.EscapeURL(inputMint));
            sb.Append("&outputMint=").Append(UnityWebRequest.EscapeURL(skrMint));
            sb.Append("&amount=").Append(outUnits.ToString(CultureInfo.InvariantCulture));
            sb.Append("&swapMode=ExactOut");
            sb.Append("&slippageBps=").Append(slippageBps.ToString(CultureInfo.InvariantCulture));
            // Same rule as GetQuoteAsync: no fee account configured => no platform
            // fee on the quote, or the paired /swap POST hard-fails with 400
            // NOT_SUPPORTED and the top-up dies one step later than it used to.
            if (!string.IsNullOrEmpty(feeAccount))
            {
                sb.Append("&platformFeeBps=").Append(platformFeeBps.ToString(CultureInfo.InvariantCulture));
                sb.Append("&feeAccount=").Append(UnityWebRequest.EscapeURL(feeAccount));
            }

            TraceEndpointOnce();
            TrackQuoteRequested("ExactOut", input, inputMint, outUnits, slippageBps);
            using var req = UnityWebRequest.Get(sb.ToString());
            req.SetRequestHeader("Accept", "application/json");
            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();
            if (req.result != UnityWebRequest.Result.Success)
            {
                string detail = HttpFailureDetail(req, QuoteUrl);
                FlowTrace.Warn("Swap", "ExactOut quote FAILED (" + SymbolFor(input) + "): " + detail);
                TrackQuoteResult("ExactOut", input, inputMint, outUnits, req.responseCode, null, detail);
                return null;
            }
            // ParseQuote reads the real inAmount / otherAmountThreshold off the response; the
            // skrNeeded figure is only the last-resort divisor when the body carries neither.
            var parsed = ParseQuote(req.downloadHandler.text, skrNeeded, inputDecimals, slippageBps,
                                    input, inputMint, exactOut: true);
            TrackQuoteResult("ExactOut", input, inputMint, outUnits, req.responseCode, parsed,
                             parsed == null ? "parse failed" : null);
            return parsed;
        }

        private string ResolvedSkrMint()
        {
            var wallet = ResolveWallet();
            var net = wallet != null ? wallet.Network : WalletService.DefaultNetwork;
            string mint = WalletEndpoints.SkrMint(net);
            if (!string.IsNullOrEmpty(mint) && mint != "REPLACE_WITH_SKR_MINT_ADDRESS")
                return mint;
            if (!string.IsNullOrEmpty(_skrMint) && _skrMint != "REPLACE_WITH_SKR_MINT_ADDRESS")
                return _skrMint;
            return WalletEndpoints.SkrMintMainnet;
        }

        // =====================================================================
        //  Helpers
        // =====================================================================

        private void SetPanelVisible(bool visible)
        {
            if (_document != null && _document.rootVisualElement != null)
                _document.rootVisualElement.style.display =
                    visible ? DisplayStyle.Flex : DisplayStyle.None;
        }

        // ── JSON DTOs ────────────────────────────────────────────────────────

        [Serializable]
        private sealed class QuoteResponseDto
        {
            // Jupiter returns these amounts as strings of base units.
            public string outAmount;
            // WO-1948: the input side (inAmount) and, on ExactOut, the slippage-inclusive
            // maximum input (otherAmountThreshold) the wallet must be able to cover.
            public string inAmount;
            public string otherAmountThreshold;
            public PlatformFeeDto platformFee;
        }

        [Serializable]
        private sealed class PlatformFeeDto
        {
            public string amount;
            public int feeBps;
        }
    }
}
