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
// The VM talks to the wallet/quote backend through the narrow <see cref="ISwapBackend"/>
// seam so it is unit-testable with a fake (a real Jupiter swap cannot be exercised
// in EditMode). Production wraps JupiterSwapService via JupiterSwapBackendAdapter —
// zero transaction behaviour changes; this is a reskin of the seam only.
// =============================================================================

using System;
using System.Threading;
using System.Threading.Tasks;
using DeNelle.Core.Web3;
using DeNelle.Core.Diagnostics;

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
            SetStatus("Enter an amount to see the rate.", isError: false);
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
                SetStatus("Enter a valid amount.", isError: false);
                return;
            }

            _currentInput = amount;
            SetStatus("Getting rate...", isError: false);

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

            _quoteLoading = true;
            SwapQuote quote = await _backend.GetQuoteAsync(SwapInputToken.USDC, _currentInput);
            _quoteLoading = false;

            if (ct.IsCancellationRequested) return;

            if (quote == null)
            {
                FlowTrace.Warn("Swap", $"DebounceQuote: GetQuoteAsync returned null for {_currentInput} USDC — rate unavailable.");
                SetStatus("Could not fetch rate. Check connection.", isError: true);
                return;
            }

            _latestQuote = quote;
            RefreshQuoteDisplay(quote);

            bool walletConnected = !string.IsNullOrEmpty(_backend.ConnectedWalletKey);
            SetConfirmEnabled(walletConnected);
            SetStatus(walletConnected ? string.Empty : "Connect your wallet to swap.", isError: false);
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
                SetStatus("Connect your wallet to swap.", isError: true);
                return;
            }

            SetConfirmEnabled(false);
            SetStatus("Sending to wallet for approval...", isError: false);

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
                SetStatus("Swap failed. Please try again.", isError: true);
                SetConfirmEnabled(true);
                return;
            }

            if (!ok)
            {
                FlowTrace.Fail("Swap", "OnConfirmTapped: ExecuteSwapAsync returned FALSE — swap failed.");
                SetStatus("Swap failed. Please try again.", isError: true);
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
            SkrOutText = $"~ {q.SkrOut:F2} SKR";
            RateText = $"1 USDC = {q.Rate:F4} SKR";
            decimal feePct = _platformFeeBps / 100m;
            PlatformFeeText = $"{q.PlatformFee:F4} USDC ({feePct:F1}%)";
            NetworkFeeText = $"~{q.NetworkFee:F6} SOL";
            Raise();
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
