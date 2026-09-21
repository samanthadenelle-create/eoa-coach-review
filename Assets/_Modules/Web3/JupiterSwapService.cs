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
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using DeNelle.Core;
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
            string inputMint = input == SwapInputToken.SOL
                ? WrappedSolMint
                : WalletEndpoints.UsdcMint(WalletService.DefaultNetwork);
            int decimals = input == SwapInputToken.SOL ? SolDecimals : UsdcDecimals;

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
            using var req = UnityWebRequest.Get(sb.ToString());
            req.SetRequestHeader("Accept", "application/json");

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
            {
                string detail = HttpFailureDetail(req, QuoteUrl);
                FlowTrace.Warn("Swap", "Quote request FAILED: " + detail);
                Debug.LogWarning("[JupiterSwapService] Quote request failed: " + detail);
                return null;
            }

            FlowTrace.Step("Swap", "quote HTTP ok — parsing");
            return ParseQuote(req.downloadHandler.text, inputAmount, decimals, slippageBps);
        }

        // =====================================================================
        //  Quote parsing (JsonUtility — no third-party JSON dependency)
        // =====================================================================

        /// <summary>
        /// Parses the Jupiter /quote JSON response into a <see cref="SwapQuote"/>.
        /// Uses <see cref="JsonUtility"/> with a private DTO to avoid pulling a
        /// JSON library into the DeNelle.Web3 asmdef.
        /// </summary>
        private SwapQuote ParseQuote(string json, decimal inputAmount, int inputDecimals, int slippageBps)
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
                decimal rate = inputAmount > 0 ? skrOut / inputAmount : 0m;

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
                    RoutePlan = json          // forwarded verbatim to /swap
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
        }

        public async Task<bool> ExecuteSwapAsync(SwapQuote quote, string userPublicKey)
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

            var wallet = ResolveWallet();
            if (wallet == null)
            {
                FlowTrace.Fail("Swap", "ExecuteSwapAsync: no WalletService — cannot sign.");
                return false;
            }

            FlowTrace.Step("Swap", "/swap ok — opaque swapTransaction to wallet (no Transaction.Deserialize; Jupiter v0).");
            var sent = await wallet.SignAndSendSwapTransaction(dto.swapTransaction);
            if (!sent.ok)
            {
                FlowTrace.Fail("Swap", "wallet SignAndSendSwap FAILED: " + (sent.error ?? "unknown"));
                return false;
            }
            FlowTrace.Step("Swap", "swap submitted sig=" + sent.signature);
            CloseSwapPanel();
            return true;
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

            var quote = await GetQuoteExactOutAsync(minimumSkr);
            if (quote == null)
            {
                FlowTrace.Fail("Swap", "TopUpSkrAsync: ExactOut quote failed.");
                return false;
            }
            return await ExecuteSwapAsync(quote, walletKey);
        }

        private async Task<SwapQuote> GetQuoteExactOutAsync(decimal skrNeeded)
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
            string usdc = WalletEndpoints.UsdcMint(net);

            var sb = new StringBuilder(QuoteUrl);
            sb.Append("?inputMint=").Append(UnityWebRequest.EscapeURL(usdc));
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
            using var req = UnityWebRequest.Get(sb.ToString());
            req.SetRequestHeader("Accept", "application/json");
            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();
            if (req.result != UnityWebRequest.Result.Success)
            {
                FlowTrace.Warn("Swap", "ExactOut quote FAILED: " + HttpFailureDetail(req, QuoteUrl));
                return null;
            }
            decimal inAmountGuess = skrNeeded; // ParseQuote uses this as the input display divisor
            return ParseQuote(req.downloadHandler.text, inAmountGuess, UsdcDecimals, slippageBps);
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
