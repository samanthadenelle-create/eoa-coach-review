// =============================================================================
// SwapVM — the PURE ViewModel behind JupiterSwapPanelController (MVVM migration
// Silo G, WO "Jupiter swap"). DANGER / MONEY PATH.
// -----------------------------------------------------------------------------
// Assembly: DeNelle.Web3   Namespace: DeNelle.Web3
//
// Owns the swap seam's LOGIC: the keystroke debounce, the quote fetch, the quote
// DISPLAY projection, and the confirm/execute flow. The View (JupiterSwapPanel-
// Controller) becomes a dumb UXML skin that binds these string outputs + flags and
// forwards taps as commands; it reads no service/game state.
//
// ⚠ BEHAVIOUR-CRITICAL — this is a MONEY PATH. The confirm guards are PRESERVED
// VERBATIM from the original controller and MUST NOT change:
//   * quote-null / mid-load  -> ignored (no execute).
//   * no connected wallet    -> blocked, "player NOT charged", no execute.
//   * ExecuteSwapAsync THROWS -> Fail "swap outcome indeterminate", re-enable, return.
//   * ExecuteSwapAsync FALSE  -> Fail "swap failed", re-enable.
//   * ExecuteSwapAsync TRUE   -> Step "swap executed OK".
// The try/catch lives INSIDE ConfirmAsync so the View's async-void handler can
// never crash the frame on an unhandled throw (the original guarantee).
//
// WO-1948 (2026-09-22): the input token is no longer a hardcoded SwapInputToken.USDC.
// DebounceQuote reads the wallet's balances through the backend seam and runs the
// ONE SwapFundingSelector (DeNelle.Wallet) - the same arithmetic the store top-up
// uses - so a SOL-only wallet quotes SOL, a wallet that covers neither is refused
// with a per-token shortfall BEFORE any quote or sign, and confirm stays disabled.
//
// The VM talks to the wallet/quote backend through the narrow <see cref="ISwapBackend"/>
// seam so it is unit-testable with a fake (a real Jupiter swap cannot be exercised
// in EditMode). Production wraps JupiterSwapService via JupiterSwapBackendAdapter —
// zero transaction behaviour changes; this is a reskin of the seam only.
// =============================================================================

using System;
using System.Threading;
using System.Threading.Tasks;
using DeNelle.Core.Backend;
using DeNelle.Core.Diagnostics;
using DeNelle.Core.UI;   // LocalizedText - WO-1857; every swap status line already had a swap.* row
using DeNelle.Wallet;    // WO-1948: SwapFundingSelector (the ONE input-token decision) + the SOL reserve

namespace DeNelle.Web3
{
    /// <summary>Narrow backend seam the swap VM drives — quote fetch, execute, the
    /// connected-wallet lookup, and panel close. Implemented for production by
    /// <see cref="JupiterSwapBackendAdapter"/> over JupiterSwapService.</summary>
    public interface ISwapBackend
    {
        /// <summary>Connected wallet base58 address, or empty when no wallet is connected.</summary>
        string ConnectedWalletKey { get; }
        /// <summary>Fetches a live quote. Returns null on network error.</summary>
        Task<SwapQuote> GetQuoteAsync(SwapInputToken input, decimal inputAmount);
        /// <summary>WO-1948: the connected wallet's SOL / USDC / SKR (whole units). <c>known</c> is
        /// false when the read did not happen (no wallet / provider threw) - the VM then refuses
        /// rather than treating zeros as a balance. The VM feeds these to the ONE
        /// SwapFundingSelector so the manual panel and the store top-up decide the same way.</summary>
        Task<(decimal sol, decimal usdc, decimal skr, bool known)> ReadBalancesAsync();
        /// <summary>Requests + hands off the swap transaction. Returns whether the /swap
        /// request succeeded and was handed off (NOT that a real on-chain swap occurred).</summary>
        Task<bool> ExecuteSwapAsync(SwapQuote quote, string userPublicKey);
        /// <summary>Closes the swap panel.</summary>
        void CloseSwapPanel();
    }

    /// <summary>Bridges the concrete JupiterSwapService to the pure
    /// <see cref="ISwapBackend"/> seam so the VM never references the MonoBehaviour.
    /// Pure delegation — no transaction behaviour is added or changed.</summary>
    public sealed class JupiterSwapBackendAdapter : ISwapBackend
    {
        private readonly JupiterSwapService _service;
        public JupiterSwapBackendAdapter(JupiterSwapService service) { _service = service; }
        public string ConnectedWalletKey => _service != null ? _service.ConnectedWalletKey : string.Empty;
        public Task<SwapQuote> GetQuoteAsync(SwapInputToken input, decimal inputAmount) =>
            _service.GetQuoteAsync(input, inputAmount);
        public Task<(decimal sol, decimal usdc, decimal skr, bool known)> ReadBalancesAsync() =>
            _service != null ? _service.ReadBalancesAsync() : Task.FromResult((0m, 0m, 0m, false));
        public Task<bool> ExecuteSwapAsync(SwapQuote quote, string userPublicKey) =>
            _service.ExecuteSwapAsync(quote, userPublicKey);
        public void CloseSwapPanel() { if (_service != null) _service.CloseSwapPanel(); }
    }

    /// <summary>
    /// Pure ViewModel for the Jupiter swap panel. Debounces input, fetches quotes,
    /// projects the fee breakdown as display strings, and runs the guarded confirm.
    /// </summary>
    public sealed class SwapVM
    {
        // How long to wait after the last keystroke before firing a quote request.
        public const float QuoteDebounceSeconds = 0.6f;

        /// <summary>Debounce window in seconds. Defaults to <see cref="QuoteDebounceSeconds"/>;
        /// settable so EditMode tests can drive the quote path with a zero delay (production
        /// value is unchanged).</summary>
        public float DebounceSeconds { get; set; } = QuoteDebounceSeconds;

        /// <summary>The in-flight debounced-quote task (or the last one). Lets tests await
        /// the fire-and-forget quote path deterministically. Null until the first input.</summary>
        public Task PendingQuoteTask { get; private set; }

        private readonly ISwapBackend _backend;

        // ── State (moved verbatim from the controller) ───────────────────────
        private SwapQuote _latestQuote;
        private decimal _currentInput;
        private bool _quoteLoading;
        private int _platformFeeBps = 20;
        private CancellationTokenSource _debounceCts;

        /// <summary>Raised whenever a projected display value changes; the View repaints.</summary>
        public event Action Changed;

        /// <summary>Resolution site — wraps the concrete swap service in the seam.</summary>
        public static SwapVM CreateDefault(JupiterSwapService service) =>
            new SwapVM(new JupiterSwapBackendAdapter(service));

        public SwapVM(ISwapBackend backend)
        {
            _backend = backend;
        }

        // ── Read-only display projections the View paints ────────────────────
        public string SkrOutText { get; private set; } = "-";
        public string RateText { get; private set; } = "-";
        public string PlatformFeeText { get; private set; } = "-";
        public string NetworkFeeText { get; private set; } = "-";
        public string StatusText { get; private set; } = string.Empty;
        public bool StatusIsError { get; private set; }
        public bool ConfirmEnabled { get; private set; }

        // ── Initialise (mirrors the controller's reset sequence) ─────────────

        /// <summary>Resets the swap state + the platform-fee percentage source for a
        /// fresh open (the fee-display divisor + latest quote / current input). Cancels
        /// any in-flight debounce. Display baseline is applied via
        /// <see cref="ApplyInitialiseBaseline"/> to preserve the original ordering.</summary>
        public void BeginInitialise(int platformFeeBps)
        {
            _platformFeeBps = platformFeeBps;
            _latestQuote = null;
            _currentInput = 0m;
            CancelPendingQuote();
        }

        /// <summary>Applies the open-time display baseline: cleared quote, the
        /// "enter an amount" prompt, confirm disabled. Raises Changed.</summary>
        public void ApplyInitialiseBaseline()
        {
            ClearQuoteDisplay();
            SetStatus(new LocalizedText("swap.statusEnter").Resolve(), isError: false);
            SetConfirmEnabled(false);
        }

        // ── Input -> debounced quote (moved verbatim) ────────────────────────

        /// <summary>Handles an amount-field change: clears the quote, validates, and
        /// starts a debounced quote request.</summary>
        public void OnInputChanged(string newValue)
        {
            SetConfirmEnabled(false);
            ClearQuoteDisplay();

            if (!decimal.TryParse(newValue, out decimal amount) || amount <= 0)
            {
                SetStatus(new LocalizedText("swap.status_invalid_amount").Resolve(), isError: false);
                return;
            }

            _currentInput = amount;
            SetStatus(new LocalizedText("swap.statusLoading").Resolve(), isError: false);

            // Cancel any in-flight debounce and start a new one.
            if (_debounceCts != null)
            {
                _debounceCts.Cancel();
                _debounceCts.Dispose();
            }
            _debounceCts = new CancellationTokenSource();
            PendingQuoteTask = DebounceQuote(_debounceCts.Token);
        }

        private async Task DebounceQuote(CancellationToken ct)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(DebounceSeconds), ct);
            }
            catch (OperationCanceledException)
            {
                return; // superseded by a newer keystroke.
            }

            if (ct.IsCancellationRequested) return;

            // ── WO-1948: the input token comes from the ONE selector over live balances, never a
            //    hardcoded USDC. The typed amount is an ExactIn spend, so each candidate's cost IS
            //    that amount in its own token; SOL keeps the rent/fee reserve back. With no wallet
            //    connected there is nothing to select over: quote USDC for the rate display only
            //    (confirm stays disabled by the connect guard below, exactly as before).
            SwapInputToken inputToken = SwapInputToken.USDC;
            bool walletPresent = !string.IsNullOrEmpty(_backend.ConnectedWalletKey);
            if (walletPresent)
            {
                var balances = await _backend.ReadBalancesAsync();
                if (ct.IsCancellationRequested) return;
                if (!balances.known)
                {
                    // An UNREAD wallet is neither rich nor empty (WO-1948 review add-on 3): no quote,
                    // no sign, the existing error status, confirm stays disabled.
                    FlowTrace.Warn("Swap", "DebounceQuote: wallet balance UNKNOWN (read failed) - refusing before any quote (player NOT charged).");
                    SetStatus(new LocalizedText("swap.statusError").Resolve(), isError: true);
                    return;
                }
                var decision = SwapFundingSelector.Select(new[]
                {
                    new SwapFundingCandidate { Token = SwapInputToken.SOL,  Symbol = "SOL",  Balance = balances.sol,
                                               Reserve = WalletEndpoints.SolReserveForRentAndFees, Cost = _currentInput, Quoted = true },
                    new SwapFundingCandidate { Token = SwapInputToken.USDC, Symbol = "USDC", Balance = balances.usdc,
                                               Reserve = 0m, Cost = _currentInput, Quoted = true }
                });
                FlowTrace.Step("Swap", "DebounceQuote balances: sol=" + SwapFundingSelector.F(balances.sol) +
                                       " usdc=" + SwapFundingSelector.F(balances.usdc) +
                                       " skr=" + SwapFundingSelector.F(balances.skr) +
                                       " amount=" + SwapFundingSelector.F(_currentInput) +
                                       " -> " + decision.Outcome + " - " + decision.Why);
                if (decision.Outcome == SwapFundingOutcome.Refused)
                {
                    // Never quote-then-sign a spend the wallet cannot make: refuse here, with the
                    // per-token shortfall, and keep confirm disabled.
                    FlowTrace.Warn("Swap", "DebounceQuote: no token covers " + SwapFundingSelector.F(_currentInput) +
                                           " - refusing before any quote/sign. " +
                                           SwapFundingSelector.ShortfallSummary(decision.Considered));
                    SetStatus(ShortfallStatus(decision), isError: true);
                    return;
                }
                // Auto -> that token. Picker (both cover) -> the panel's v1 default stays USDC: this
                // surface has one amount field and no token toggle, so a modal here would be a
                // second picker owner; the store top-up (JupiterSwapService.TopUpSkrAsync) is the
                // surface that shows the one-tap picker.
                inputToken = decision.Outcome == SwapFundingOutcome.Auto ? decision.Chosen.Token : SwapInputToken.USDC;
                FlowTrace.Step("Swap", "DebounceQuote input token selected: " + inputToken +
                                       " (" + (decision.Outcome == SwapFundingOutcome.Auto ? "auto" : "both cover; v1 default") + ")");
            }

            _quoteLoading = true;
            SwapQuote quote = await _backend.GetQuoteAsync(inputToken, _currentInput);
            _quoteLoading = false;

            if (ct.IsCancellationRequested) return;

            if (quote == null)
            {
                FlowTrace.Warn("Swap", $"DebounceQuote: GetQuoteAsync returned null for {_currentInput} {inputToken} — rate unavailable.");
                SetStatus(new LocalizedText("swap.statusError").Resolve(), isError: true);
                return;
            }

            _latestQuote = quote;
            RefreshQuoteDisplay(quote);

            bool walletConnected = !string.IsNullOrEmpty(_backend.ConnectedWalletKey);
            SetConfirmEnabled(walletConnected);
            SetStatus(walletConnected
                ? string.Empty
                : new LocalizedText("swap.statusConnect").Resolve(), isError: false);
        }

        // ── Confirm — the MONEY PATH (guards preserved VERBATIM) ─────────────

        /// <summary>
        /// The guarded confirm. Behaviour-critical — the "not charged" guarantees and
        /// the indeterminate-outcome Fail path are IDENTICAL to the original controller.
        /// The try/catch is internal so the View's async-void caller never throws.
        /// </summary>
        public async Task ConfirmAsync()
        {
            using var _ = FlowTrace.Enter("Swap", "OnConfirmTapped");

            if (_latestQuote == null || _quoteLoading)
            {
                FlowTrace.Warn("Swap", $"OnConfirmTapped: ignored — quote {(_latestQuote == null ? "null" : "present")}, loading={_quoteLoading}.");
                return;
            }

            string walletKey = _backend.ConnectedWalletKey;
            if (string.IsNullOrEmpty(walletKey))
            {
                FlowTrace.Warn("Swap", "OnConfirmTapped: no connected wallet — swap blocked (player NOT charged).");
                SetStatus(new LocalizedText("swap.statusConnect").Resolve(), isError: true);
                return;
            }

            SetConfirmEnabled(false);
            SetStatus(new LocalizedText("swap.statusSigning").Resolve(), isError: false);

            bool ok;
            try
            {
                ok = await _backend.ExecuteSwapAsync(_latestQuote, walletKey);
            }
            catch (Exception ex)
            {
                // async void: an unhandled throw would otherwise crash the frame silently. Catch,
                // Fail loudly (outcome indeterminate = possible partial/charged swap), and re-enable.
                FlowTrace.Fail("Swap",
                    $"OnConfirmTapped: ExecuteSwapAsync THREW: {ex.GetType().Name}: {ex.Message} — swap outcome indeterminate.");
                SetStatus(new LocalizedText("swap.statusFailed").Resolve(), isError: true);
                SetConfirmEnabled(true);
                return;
            }

            if (!ok)
            {
                FlowTrace.Fail("Swap", "OnConfirmTapped: ExecuteSwapAsync returned FALSE — swap failed.");
                SetStatus(new LocalizedText("swap.statusFailed").Resolve(), isError: true);
                SetConfirmEnabled(true);
            }
            else
            {
                FlowTrace.Step("Swap", "OnConfirmTapped: swap executed OK.");
            }
        }

        /// <summary>The universal close command — routes to the backend's panel close.</summary>
        public void Close() => _backend?.CloseSwapPanel();

        // ── Display helpers (moved verbatim; now update projected state + Raise) ──

        private void RefreshQuoteDisplay(SwapQuote q)
        {
            // WO-1948: the symbol is the quote's own input token, not a fixed USDC.
            string sym = q.InputToken == SwapInputToken.SOL ? "SOL" : "USDC";
            SkrOutText = $"~ {q.SkrOut:F2} SKR";
            RateText = $"1 {sym} = {q.Rate:F4} SKR";
            decimal feePct = _platformFeeBps / 100m;
            PlatformFeeText = $"{q.PlatformFee:F4} {sym} ({feePct:F1}%)";
            NetworkFeeText = $"~{q.NetworkFee:F6} SOL";
            Raise();
        }

        /// <summary>"{shortfallHeader} {token}: need {needed}, have {have}; ..." from the swap.* keys.</summary>
        private static string ShortfallStatus(SwapFundingDecision decision)
        {
            var sb = new System.Text.StringBuilder(new LocalizedText("swap.shortfallHeader").Resolve());
            var line = new LocalizedText<object>("swap.shortfallLine");
            for (int i = 0; i < decision.Considered.Count; i++)
            {
                var c = decision.Considered[i];
                sb.Append(' ').Append(line.Resolve(new
                {
                    token = c.Symbol,
                    needed = SwapFundingSelector.F(c.Cost),
                    have = SwapFundingSelector.F(c.Spendable)
                }));
            }
            return sb.ToString();
        }

        /// <summary>Blanks the quote readout to "-". Public: the View re-clears it on
        /// each input change, matching the original controller's ordering.</summary>
        public void ClearQuoteDisplay()
        {
            SkrOutText = "-";
            RateText = "-";
            PlatformFeeText = "-";
            NetworkFeeText = "-";
            Raise();
        }

        private void SetStatus(string msg, bool isError)
        {
            StatusText = msg ?? string.Empty;
            StatusIsError = isError;
            Raise();
        }

        private void SetConfirmEnabled(bool enabled)
        {
            ConfirmEnabled = enabled;
            Raise();
        }

        /// <summary>Cancels any pending debounced quote (call from OnDisable).</summary>
        public void CancelPendingQuote()
        {
            if (_debounceCts != null)
            {
                _debounceCts.Cancel();
                _debounceCts.Dispose();
                _debounceCts = null;
            }
        }

        public void Dispose() => CancelPendingQuote();

        private void Raise() => Changed?.Invoke();
    }
}
