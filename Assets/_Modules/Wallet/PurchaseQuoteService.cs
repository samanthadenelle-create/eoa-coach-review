// =============================================================================
// PurchaseQuoteService — the client ASKS for the price. It never decides one.
// -----------------------------------------------------------------------------
// Assembly: DeNelle.Wallet   Namespace: DeNelle.Wallet   (WO-1158)
//
// ⛔ THE ONE RULE THIS FILE EXISTS TO ENFORCE: THERE IS NO PRICE ARITHMETIC ON
// THE CLIENT. A pack is priced in USD and paid in SKR, so the SKR amount depends
// on the market rate at purchase time. Before this file the CLIENT resolved that
// rate (SkrValuationOracle.SkrForUsd) while the SERVER verified the transfer
// against a hardcoded constant.
//
// A CLIENT-RESOLVED PRICE AND A SERVER-CHECKED CONSTANT CANNOT BOTH BE RIGHT.
// The moment the market moves the client sends N and the server expects M —
// and /verify runs AFTER the transfer settles, so the purchase fails with THE
// MONEY ALREADY GONE and nothing granted. The trigger is a MARKET MOVE, which is
// not a deploy, so nobody is watching when it fires. Same paid-but-not-granted
// family as the 6-vs-9 decimals near-miss, through a different door.
//
// So: the server resolves the rate, computes the integer base units, and hands
// back a short-lived, single-use quote. This file transports it and hands it to
// the store verbatim. It computes nothing. Where you see arithmetic below it is
// a GUARD — proving the number we are about to pay is bit-for-bit the number we
// were quoted — never a derivation.
//
// TWO CALLS, ONE ENDPOINT (api/purchases/quote.js):
//   RefreshPricesAsync  — the shelf's display prices. Binds nothing.
//   RequestQuoteAsync   — ONE binding quote for ONE purchase. Expires. Single-use.
//
// ⛔ FAILS CLOSED, EVERYWHERE. No rate → no price → no Buy button and a worded
// reason. A displayed price we invented is worse than no price at all, because
// the player acts on it.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Text;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;
using DeNelle.Core.Web3;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace DeNelle.Wallet
{
    /// <summary>One server-issued price. Everything in it came off the wire; nothing is derived.</summary>
    public sealed class PurchaseQuote
    {
        [JsonProperty("quoteId")] public string QuoteId;
        [JsonProperty("sku")] public string Sku;
        [JsonProperty("network")] public string Network;
        [JsonProperty("currency")] public string Currency;
        /// <summary>The EXACT integer base units to transfer, as a string (it can exceed int32).</summary>
        [JsonProperty("amountBaseUnits")] public string AmountBaseUnits;
        /// <summary>Whole SKR, for display. The base units are the authority.</summary>
        [JsonProperty("skrAmount")] public double SkrAmount;
        [JsonProperty("decimals")] public int Decimals;
        [JsonProperty("mint")] public string Mint;
        [JsonProperty("recipient")] public string Recipient;
        [JsonProperty("recipientAta")] public string RecipientAta;
        /// <summary>The authored USD ladder anchor (2.99, 4.99 ...). Displayed with a "≈".</summary>
        /// <summary>
        /// The authored USD ladder anchor (2.99, 4.99 ...). NULLABLE, and it must stay nullable.
        /// <para>
        /// ⛔ THIS FIELD WAS <c>double</c> AND IT BLANKED THE WHOLE STORE (fixed 2026-08-24). The
        /// server's LIST puts the PINNED CANARY row on the shelf beside the real ladder, and
        /// <c>wirePinned</c> sets <c>usdAnchor: usdAnchor(sku)</c> — which is legitimately NULL for
        /// the canary, because the canary is deliberately absent from USD_ANCHORS (it is a
        /// proof-of-rail, not a sale). Newtonsoft cannot put null into a non-nullable double, so it
        /// threw <c>JsonSerializationException</c> on the WHOLE RESPONSE.
        /// </para>
        /// <para>
        /// ⚠ ONE NULL ON ONE ROW THEREFORE PRICED NOTHING — every pack read "Price unavailable"
        /// because a single unpriceable canary poisoned the entire list. The row-level guard in
        /// RefreshPricesAsync exists so that can never again be an all-or-nothing failure.
        /// </para>
        /// </summary>
        [JsonProperty("usdAnchor")] public double? UsdAnchor;
        /// <summary>Server-issued basis points off the anchor; null means no discount.</summary>
        [JsonProperty("discountBps")] public int? DiscountBps;
        /// <summary>Server-authored display copy; the client performs no percentage arithmetic.</summary>
        [JsonProperty("discountLabel")] public string DiscountLabel;
        /// <summary>USD per SKR behind this quote. Null on a pinned canary.</summary>
        [JsonProperty("rate")] public double? Rate;
        /// <summary>WHICH oracle produced the rate — shown at the confirm step.</summary>
        [JsonProperty("rateSource")] public string RateSource;
        /// <summary>True for the two canaries: a protocol constant, not a sale. No expiry.</summary>
        [JsonProperty("pinned")] public bool Pinned;
        [JsonProperty("expiresAt")] public string ExpiresAt;

        /// <summary>Parsed base units, or 0 when the server sent something unusable.</summary>
        public long BaseUnits =>
            long.TryParse(AmountBaseUnits, out var v) && v > 0 ? v : 0L;

        /// <summary>
        /// The UI-unit amount the wallet transfer layer takes.
        /// <para>⚠ THIS IS A DECODE, NOT A PRICE. <see cref="BaseUnits"/> is the authority; the
        /// wallet provider's <c>UiToBaseUnits</c> re-scales this by the same power of ten, and
        /// <see cref="MatchesBaseUnits"/> proves the round-trip lands on the quoted integer before
        /// a single token moves.</para>
        /// </summary>
        public double UiAmount => BaseUnits <= 0 ? 0d : BaseUnits / Math.Pow(10d, Decimals);

        /// <summary>
        /// ⛔ THE PAY-TIME GUARD. True only when re-encoding <see cref="UiAmount"/> at this quote's
        /// decimals reproduces the quoted integer EXACTLY. A false here means the transfer we are
        /// about to build is not the transfer the server will check — which is a purchase that
        /// fails after settlement. Refuse instead.
        /// </summary>
        public bool MatchesBaseUnits =>
            BaseUnits > 0 && (long)Math.Round(UiAmount * Math.Pow(10d, Decimals),
                MidpointRounding.AwayFromZero) == BaseUnits;

        /// <summary>Server-side expiry as UTC, or <c>DateTime.MaxValue</c> for a pinned canary.</summary>
        public DateTime ExpiresAtUtc
        {
            get
            {
                if (Pinned || string.IsNullOrEmpty(ExpiresAt)) return DateTime.MaxValue;
                return DateTime.TryParse(ExpiresAt, null,
                    System.Globalization.DateTimeStyles.AdjustToUniversal |
                    System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                    ? parsed : DateTime.MinValue;
            }
        }

        /// <summary>
        /// Still safe to pay against? ⛔ A quote is checked HERE before the wallet prompt so an
        /// expired one never reaches the chain — the server's own check runs after the money moved
        /// and can only refuse, not undo.
        /// </summary>
        public bool IsFresh(double marginSeconds = 20d) =>
            BaseUnits > 0 && DateTime.UtcNow.AddSeconds(marginSeconds) < ExpiresAtUtc;

        /// <summary>The exact SKR, stated as digits. Never rounded for looks.</summary>
        public string ExactSkrLabel =>
            BaseUnits <= 0 ? StoreStringsUnavailable : $"{UiAmount:0.######} SKR";

        /// <summary>The USD anchor, marked APPROXIMATE — the dollars float, the SKR does not.</summary>
        // A null anchor is the pinned canary, which has no USD price by design — render nothing
        // rather than "~ $0.00", which would read as free.
        public string UsdApproxLabel =>
            UsdAnchor.HasValue && UsdAnchor.Value > 0d ? $"~ ${UsdAnchor.Value:0.00}" : string.Empty;

        internal const string StoreStringsUnavailable = "Price unavailable";
    }

    /// <summary>The outcome of asking for a binding quote. A failure always carries a WORDED reason.</summary>
    public readonly struct PurchaseQuoteResult
    {
        public readonly PurchaseQuote Quote;
        public readonly string Error;
        public bool Ok => Quote != null && Quote.BaseUnits > 0 && string.IsNullOrEmpty(Error);

        public PurchaseQuoteResult(PurchaseQuote quote, string error = null)
        { Quote = quote; Error = error; }

        public static PurchaseQuoteResult Refused(string reason) =>
            new PurchaseQuoteResult(null, reason);
    }

    /// <summary>
    /// Fetches server-issued prices. Static because there is exactly ONE price authority per run
    /// and it is not this process — a second instance would be a second opinion about money.
    /// </summary>
    public static class PurchaseQuoteService
    {
        private const string QuoteUrl = BackendRequestSigner.BackendBase + "/api/purchases/quote";
        private const int TimeoutSeconds = 15;

        /// <summary>Worded refusals. ⛔ Never a bare code and never silence: the player is mid-purchase.</summary>
        public const string RateUnavailableMessage =
            "We could not read a live SKR price just now, so we will not quote one. " +
            "Nothing has been charged. Try again in a moment.";
        public const string QuoteUnavailableMessage =
            "We could not price this pack right now. Nothing has been charged.";
        public const string WalletRequiredMessage =
            "Connect a signing wallet before we can quote a price.";

        // The last LIST response, keyed by sku. Display only — never paid against.
        private static readonly Dictionary<string, PurchaseQuote> _displayPrices =
            new Dictionary<string, PurchaseQuote>(StringComparer.Ordinal);
        private static string _displayNetwork = string.Empty;

        /// <summary>True when the shelf has server prices to draw. False ⇒ cards say so in WORDS.</summary>
        public static bool HasDisplayPrices => _displayPrices.Count > 0;

        /// <summary>The network the cached display prices were issued for ("devnet"/"mainnet-beta").
        /// A price from the other network is not this network's price — the caller re-fetches.</summary>
        public static string DisplayNetwork => _displayNetwork;

        /// <summary>The server's display price for a SKU, or null. NEVER computed locally.</summary>
        public static PurchaseQuote DisplayPrice(string sku) =>
            !string.IsNullOrEmpty(sku) && _displayPrices.TryGetValue(sku, out var q) ? q : null;

        /// <summary>
        /// The SKR amount to SHOW for a SKU, or 0 when the server has not priced it.
        /// <para>⛔ ZERO IS THE HONEST ANSWER when we have no quote — it is not a free pack, and the
        /// callers render it as the WORDS "Price unavailable". Substituting the authored packs.json
        /// SKR figure here is exactly the invented number this WO removed.</para>
        /// </summary>
        public static double SkrAmountFor(string sku)
        {
            var quote = DisplayPrice(sku);
            return quote != null ? quote.UiAmount : 0d;
        }

        /// <summary>The server's USD anchor for a SKU, or 0. §5: when they disagree, the server wins.</summary>
        public static double UsdAnchorFor(string sku)
        {
            var quote = DisplayPrice(sku);
            // A null anchor (the pinned canary) reads as 0 here, same as "no quote" — callers
            // already treat 0 as "the server did not price this", so the meaning is unchanged.
            return quote != null && quote.UsdAnchor.HasValue ? quote.UsdAnchor.Value : 0d;
        }

        /// <summary>
        /// The list response with its rows still UNPARSED, so each can be converted individually.
        /// The envelope is strongly typed; only the rows are deferred — a malformed envelope is a
        /// genuine refusal, while a malformed ROW should cost only that row.
        /// </summary>
        private sealed class ListEnvelope
        {
            [JsonProperty("success")] public bool Success;
            [JsonProperty("rate")] public double Rate;
            [JsonProperty("rateSource")] public string RateSource;
            [JsonProperty("prices")] public List<Newtonsoft.Json.Linq.JObject> Prices;
        }

        private sealed class ListResponse
        {
            [JsonProperty("success")] public bool Success;
            [JsonProperty("rate")] public double Rate;
            [JsonProperty("rateSource")] public string RateSource;
            [JsonProperty("prices")] public List<PurchaseQuote> Prices;
        }

        private sealed class QuoteResponse
        {
            [JsonProperty("success")] public bool Success;
            [JsonProperty("quote")] public PurchaseQuote Quote;
            [JsonProperty("code")] public string Code;
            [JsonProperty("message")] public string Message;
        }

        private static string WireNetwork(WalletNetwork network) =>
            network == WalletNetwork.Mainnet ? "mainnet-beta" : "devnet";

        /// <summary>
        /// Refreshes the shelf's display prices from the server. Binds nothing and charges nothing.
        /// Returns false (and leaves the cache alone) whenever the server would not price — the
        /// caller keeps showing whatever honest state it already had.
        /// </summary>
        public static async UniTask<bool> RefreshPricesAsync(WalletService wallet)
        {
            using var _ = FlowTrace.Enter("Store", "PurchaseQuote.RefreshPrices (display only)");
            if (wallet == null || !wallet.IsRealSigningWallet)
            {
                FlowTrace.Step("Store", "quote list skipped: no signing wallet — the shelf shows no SKR figure rather than an invented one.");
                return false;
            }

            string playerId = wallet.Account.Address;
            string network = WireNetwork(wallet.Network);
            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new { playerId, network }));

            var text = await PostAsync(body, playerId, "price list");
            if (text == null) return false;

            // ⛔ ROW-LEVEL, NOT ALL-OR-NOTHING (2026-08-24). This used to deserialize the whole
            // response in one call, so ONE unreadable row threw and priced NOTHING. That is exactly
            // what happened: the server's LIST carries the pinned canary beside the real ladder, the
            // canary's usdAnchor is legitimately null, the client field was a non-nullable double,
            // and the resulting JsonSerializationException blanked EVERY pack on the shelf.
            //
            // The field is nullable now, so that specific throw is gone — but the SHAPE of the
            // failure is the real defect and it is the one CLAUDE.md §12 names: "one bad object logs
            // and is skipped, never silently blanks a screen". A future field the server adds, or a
            // SKU with an odd value, must cost its own row and nothing more.
            ListEnvelope envelope = null;
            try { envelope = JsonConvert.DeserializeObject<ListEnvelope>(text); }
            catch (Exception ex)
            {
                FlowTrace.Warn("Store", $"quote list envelope unreadable: {ex.GetType().Name} — " +
                                        "no display prices this pass.");
            }
            if (envelope == null || !envelope.Success || envelope.Prices == null)
            {
                FlowTrace.Warn("Store", "quote list REFUSED by the server — no display prices this pass.");
                return false;
            }

            // Convert each row on its own so a single bad one is logged and skipped.
            var response = new ListResponse
            {
                Success = envelope.Success,
                Rate = envelope.Rate,
                RateSource = envelope.RateSource,
                Prices = new List<PurchaseQuote>(envelope.Prices.Count),
            };
            int skipped = 0;
            for (int i = 0; i < envelope.Prices.Count; i++)
            {
                try
                {
                    var parsed = envelope.Prices[i]?.ToObject<PurchaseQuote>();
                    if (parsed != null) response.Prices.Add(parsed);
                }
                catch (Exception ex)
                {
                    skipped++;
                    // NEVER SILENT: name the row AND the reason, so the next contract drift is one
                    // read away instead of a blank shelf with no explanation.
                    string sku = null;
                    try { sku = envelope.Prices[i]?["sku"]?.ToString(); } catch { /* best effort */ }
                    FlowTrace.Warn("Store", $"quote row {i} (sku='{sku ?? "?"}') unreadable: " +
                                            $"{ex.GetType().Name} — skipped; the rest of the shelf still prices.");
                }
            }
            if (skipped > 0)
                FlowTrace.Warn("Store", $"{skipped} of {envelope.Prices.Count} quote row(s) were skipped.");

            _displayPrices.Clear();
            _displayNetwork = network;
            foreach (var row in response.Prices)
            {
                if (row == null || string.IsNullOrEmpty(row.Sku) || row.BaseUnits <= 0) continue;
                _displayPrices[row.Sku] = row;
            }
            FlowTrace.Step("Store", $"quote list ISSUED: {_displayPrices.Count} priced SKUs on {network} " +
                                    $"at ${response.Rate:0.########}/SKR ({response.RateSource}).");
            return _displayPrices.Count > 0;
        }

        /// <summary>
        /// Asks for ONE binding quote, immediately before the wallet prompt.
        ///
        /// <para>⛔ CALL THIS AS LATE AS POSSIBLE. The quote's clock starts here, and the wallet
        /// approval that follows is a HUMAN action with no countdown. A quote fetched when the store
        /// opened and paid against ten minutes later is the expired-after-payment case, which costs
        /// the player real money and us a manual review.</para>
        /// </summary>
        public static async UniTask<PurchaseQuoteResult> RequestQuoteAsync(PackDef pack, WalletService wallet,
            string reason = null)
        {
            using var _ = FlowTrace.Enter("Store", $"PurchaseQuote.Request '{pack?.Sku ?? "<null>"}'");
            if (pack == null || string.IsNullOrEmpty(pack.Sku))
                return PurchaseQuoteResult.Refused(QuoteUnavailableMessage);
            if (wallet == null || !wallet.IsRealSigningWallet)
            {
                FlowTrace.Warn("Store", "quote REFUSED: no signing wallet to issue it to.");
                return PurchaseQuoteResult.Refused(WalletRequiredMessage);
            }

            string playerId = wallet.Account.Address;
            string network = WireNetwork(wallet.Network);
            byte[] body = Encoding.UTF8.GetBytes(
                JsonConvert.SerializeObject(new { playerId, network, sku = pack.Sku, reason }));

            FlowTrace.Step("Store", $"quote REQUESTED for '{pack.Sku}' on {network}.");
            var text = await PostAsync(body, playerId, $"quote '{pack.Sku}'");
            if (text == null) return PurchaseQuoteResult.Refused(RateUnavailableMessage);

            QuoteResponse response = null;
            try { response = JsonConvert.DeserializeObject<QuoteResponse>(text); }
            catch (Exception ex)
            {
                FlowTrace.Fail("Store", $"quote '{pack.Sku}' unreadable: {ex.GetType().Name} — refusing rather than guessing a price.");
                return PurchaseQuoteResult.Refused(QuoteUnavailableMessage);
            }

            if (response == null || !response.Success || response.Quote == null)
            {
                string worded = !string.IsNullOrEmpty(response?.Message) ? response.Message
                    : string.Equals(response?.Code, "PURCHASE_RATE_UNAVAILABLE", StringComparison.Ordinal)
                        ? RateUnavailableMessage : QuoteUnavailableMessage;
                FlowTrace.Warn("Store", $"quote '{pack.Sku}' REFUSED by the server: {response?.Code ?? "no body"}.");
                return PurchaseQuoteResult.Refused(worded);
            }

            var quote = response.Quote;
            // ── The three guards. Each one is a purchase we refuse to start. ──
            if (!string.Equals(quote.Sku, pack.Sku, StringComparison.Ordinal) ||
                !string.Equals(quote.Network, network, StringComparison.Ordinal))
            {
                FlowTrace.Fail("Store", $"quote TAMPERED/mismatched: asked '{pack.Sku}'@{network}, " +
                                        $"got '{quote.Sku}'@{quote.Network} — refusing.");
                return PurchaseQuoteResult.Refused(QuoteUnavailableMessage);
            }
            if (!quote.MatchesBaseUnits)
            {
                // The amount cannot survive the wallet layer's UI-unit round trip, so the transfer
                // we would build is NOT the one the server will check. Refuse before it settles.
                FlowTrace.Fail("Store", $"quote '{pack.Sku}' base units {quote.AmountBaseUnits} @{quote.Decimals}dp " +
                                        "do not round-trip through the wallet's UI amount — refusing (nothing charged).");
                return PurchaseQuoteResult.Refused(QuoteUnavailableMessage);
            }
            if (!quote.Pinned && !quote.IsFresh())
            {
                FlowTrace.Warn("Store", $"quote '{pack.Sku}' arrived already EXPIRED ({quote.ExpiresAt}) — refusing.");
                return PurchaseQuoteResult.Refused(
                    "That price expired before we could use it. Nothing has been charged; try again.");
            }

            _displayPrices[quote.Sku] = quote;   // the shelf now shows the number we will actually charge
            FlowTrace.Step("Store", $"quote ISSUED '{quote.Sku}': {quote.AmountBaseUnits} base units " +
                                    $"({quote.ExactSkrLabel}) anchor ${quote.UsdAnchor:0.00} " +
                                    $"rate {(quote.Rate.HasValue ? quote.Rate.Value.ToString("0.########") : "pinned")} " +
                                    $"src '{quote.RateSource}' id {quote.QuoteId ?? "<pinned>"} expires {quote.ExpiresAt ?? "never"}.");
            return new PurchaseQuoteResult(quote);
        }

        /// <summary>POST + wallet-proof, shared by both modes. Returns the body text, or null.</summary>
        private static async UniTask<string> PostAsync(byte[] body, string playerId, string what)
        {
            using var req = new UnityWebRequest(QuoteUrl, "POST")
            {
                uploadHandler = new UploadHandlerRaw(body),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = TimeoutSeconds,
            };
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");
            if (!await BackendRequestSigner.TryAttachAsync(req, playerId, body))
            {
                FlowTrace.Warn("Store", $"{what}: could not authenticate the request — no price fetched.");
                return null;
            }

            try { await req.SendWebRequest(); }
            catch (Exception ex)
            {
                // A UnityWebRequest throws on any non-2xx as well as on transport failure, and the
                // 503 body carries the server's WORDED reason — so read it either way.
                FlowTrace.Warn("Store", $"{what}: {ex.GetType().Name} (HTTP {req.responseCode}).");
            }
            string text = req.downloadHandler != null ? req.downloadHandler.text : null;
            if (req.responseCode >= 200 && req.responseCode < 300) return text;
            FlowTrace.Warn("Store", $"{what}: server answered HTTP {req.responseCode} — failing closed.");
            return string.IsNullOrEmpty(text) ? null : text;
        }

        /// <summary>Test/teardown hook: forget every cached display price.</summary>
        public static void ClearDisplayPrices()
        {
            _displayPrices.Clear();
            _displayNetwork = string.Empty;
        }
    }
}
