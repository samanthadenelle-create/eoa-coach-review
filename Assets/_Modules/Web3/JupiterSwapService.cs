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
using DeNelle.Core;
using DeNelle.Core.Web3;
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
        // ── Jupiter REST endpoints ───────────────────────────────────────────
        // OWNER-CONFIG: Jupiter aggregator API base. These are the public
        // mainnet endpoints. If/when a self-hosted or paid Jupiter API is used,
        // change the base here. NOTE the devnet/mainnet caveat in the file header.
        private const string QuoteUrl = "https://quote-api.jup.ag/v6/quote";
        private const string SwapUrl = "https://quote-api.jup.ag/v6/swap";

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
            if (_walletDialog == null)
                _walletDialog = FindAnyObjectByType<WalletConnectDialog>(FindObjectsInactive.Include);
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

            string inputMint = input == SwapInputToken.SOL
                ? WrappedSolMint
                : WalletEndpoints.UsdcMint(WalletService.DefaultNetwork);
            int decimals = input == SwapInputToken.SOL ? SolDecimals : UsdcDecimals;

            // Jupiter amounts are in the token's smallest unit.
            long amountUnits = (long)(inputAmount * (decimal)Math.Pow(10, decimals));
            if (amountUnits <= 0) { FlowTrace.Warn("Swap", $"GetQuoteAsync aborted: amountUnits<=0 ({amountUnits}) for input {inputAmount}"); return null; }

            var sb = new StringBuilder(QuoteUrl);
            sb.Append("?inputMint=").Append(UnityWebRequest.EscapeURL(inputMint));
            sb.Append("&outputMint=").Append(UnityWebRequest.EscapeURL(_skrMint));
            sb.Append("&amount=").Append(amountUnits.ToString(CultureInfo.InvariantCulture));
            sb.Append("&slippageBps=").Append(slippageBps.ToString(CultureInfo.InvariantCulture));
            sb.Append("&platformFeeBps=").Append(platformFeeBps.ToString(CultureInfo.InvariantCulture));
            if (!string.IsNullOrEmpty(feeAccount))
                sb.Append("&feeAccount=").Append(UnityWebRequest.EscapeURL(feeAccount));

            using var req = UnityWebRequest.Get(sb.ToString());
            req.SetRequestHeader("Accept", "application/json");

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
            {
                FlowTrace.Warn("Swap", $"Quote request FAILED: {req.error} (mainnet Jupiter vs devnet wallet — flag_12)");
                Debug.LogWarning($"[JupiterSwapService] Quote request failed: {req.error}");
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
            var tail = new SwapRequestTail { userPublicKey = userPublicKey, wrapAndUnwrapSol = true };
            string tailJson = JsonUtility.ToJson(tail);                  // {"userPublicKey":"...","wrapAndUnwrapSol":true}
            string tailInner = tailJson.Substring(1, tailJson.Length - 2); // strip the wrapping braces
            string body = "{\"quoteResponse\":" + quote.RoutePlan + "," + tailInner + "}";

            using var req = new UnityWebRequest(SwapUrl, "POST");
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
            {
                FlowTrace.Warn("Swap", $"/swap request FAILED: {req.error} — no transaction to sign");
                Debug.LogWarning($"[JupiterSwapService] Swap request failed: {req.error}");
                return false;
            }

            FlowTrace.Warn("Swap", "/swap ok — handing to WalletBridgeStub (NO real signing; stub fires a fake sig in editor/dev, hard-fails in release — flag_14)");
            // TODO(real-wallet): forward the serialised transaction to the real
            // Solana signer. The project's SolanaWalletProvider (DeNelle.Wallet,
            // behind the SOLANA_SDK define) signs SystemProgram/TokenProgram
            // transfers but has NO Jupiter-swap-deserialise-and-sign path yet.
            // Until that lands, hand off to the stub so the UI flow is testable.
            string swapJson = req.downloadHandler.text;
            WalletBridgeStub.SignAndSendTransaction(swapJson, onSuccess: sig =>
            {
                Debug.Log($"[JupiterSwapService] Swap handed off. Stub signature: {sig}");
                CloseSwapPanel();
                // TODO: refresh SKR balance via the wallet stack after a real swap.
            });

            return true;
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
