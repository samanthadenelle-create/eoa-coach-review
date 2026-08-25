using System;
using System.Text;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;
using DeNelle.Core.Web3;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace DeNelle.Wallet
{
    public enum EntitlementVerificationState { Verified, Fulfilled, Pending, Rejected, Unavailable }

    public readonly struct EntitlementVerificationResult
    {
        public readonly EntitlementVerificationState State;
        public readonly string TransactionSignature;
        public readonly string EntitlementId;
        public readonly string Error;

        /// <summary>
        /// The SERVER-ISSUED support reference for a settled-but-unrecorded payment (503
        /// <c>state: "record_failed"</c>), and the stage its write died at.
        /// <para>⛔ THEY ARE STRUCTURED FIELDS, NOT ONLY TEXT INSIDE <see cref="Error"/> (WO-1188).
        /// The give-up screen has to be able to PRINT the reference to the player, and a screen that
        /// had to substring it back out of a diagnostic sentence would silently stop printing it the
        /// first time that sentence was reworded. Empty when the server supplied none.</para>
        /// </summary>
        public readonly string Reference;
        public readonly string Stage;

        public EntitlementVerificationResult(EntitlementVerificationState state, string signature,
                                             string entitlementId = null, string error = null,
                                             string reference = null, string stage = null)
        {
            State = state;
            TransactionSignature = signature;
            EntitlementId = entitlementId;
            Error = error;
            Reference = reference;
            Stage = stage;
        }
    }

    /// <summary>
    /// Client half of MON-1147. It persists a submitted signature before asking the backend and
    /// clears it only after the backend returns a durable verified entitlement. The body contains
    /// claims for lookup only; BackendRequestSigner proves the wallet and the server owns price and
    /// recipient authority.
    /// </summary>
    public static class PurchaseEntitlementVerifier
    {
        private const string VerifyUrl = BackendRequestSigner.BackendBase + "/api/purchases/verify";
        private const string ReconcileUrl = BackendRequestSigner.BackendBase + "/api/purchases/reconcile";
        private const string FulfillUrl = BackendRequestSigner.BackendBase + "/api/purchases/fulfill";
        private const string PendingPrefix = "purchase.pending.";
        private const int TimeoutSeconds = 20;

        [Serializable]
        private sealed class PendingPurchase
        {
            public string playerId;
            public string sku;
            public string txSignature;
            public string network;
            public string currency;
            /// <summary>
            /// The SERVER-ISSUED quote this payment was made against (WO-1158). Empty for the two
            /// CANARY skus, whose amount is a pinned protocol constant that needs no quote.
            /// <para>⛔ IT IS PERSISTED WITH THE SIGNATURE, NOT RE-FETCHED. /verify checks the chain
            /// against the quote it issued; a retry after process death that asked for a FRESH quote
            /// would be checking a settled transfer against a price nobody agreed to - and the money
            /// has already moved by then. The quote id is part of the receipt.</para>
            /// </summary>
            public string quoteId;
        }

        private sealed class VerifyResponse
        {
            [JsonProperty("success")] public bool Success;
            [JsonProperty("state")] public string State;
            [JsonProperty("sku")] public string Sku;
            [JsonProperty("network")] public string Network;
            [JsonProperty("currency")] public string Currency;
            [JsonProperty("txSignature")] public string TxSignature;
            [JsonProperty("entitlementId")] public string EntitlementId;
            [JsonProperty("code")] public string Code;
            // WO-1076 wave, 2026-08-25: /verify's post-settlement DB guards answer 503 with
            // state 'record_failed' plus these two. They are the ONLY handle support has on a
            // payment that settled on chain and failed to write its entitlement row, so they
            // are carried into the error string rather than dropped.
            [JsonProperty("stage")] public string Stage;
            [JsonProperty("ref")] public string Ref;
        }

        public static bool HasPending(string sku) =>
            !string.IsNullOrEmpty(PlayerPrefs.GetString(PendingPrefix + sku, string.Empty));

        public static void Remember(PackDef pack, PaymentResult payment, WalletService wallet,
                                    string quoteId = null)
        {
            if (pack == null || string.IsNullOrEmpty(payment.TxSignature) || wallet == null)
                return;
            var row = new PendingPurchase
            {
                playerId = wallet.Account.Address,
                sku = pack.Sku,
                txSignature = payment.TxSignature,
                network = WireNetwork(wallet.Network),
                currency = payment.Currency.ToString().ToUpperInvariant(),
                quoteId = quoteId ?? string.Empty,
            };
            PlayerPrefs.SetString(PendingPrefix + pack.Sku, JsonConvert.SerializeObject(row));
            PlayerPrefs.Save();
        }

        public static async UniTask<EntitlementVerificationResult> VerifyPendingAsync(
            PackDef pack, CurrencyKind currency, WalletService wallet)
        {
            if (pack == null || wallet == null || !wallet.IsRealSigningWallet)
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null,
                    error: "A connected signing wallet is required to verify this payment.");

            PendingPurchase pending;
            try
            {
                pending = JsonConvert.DeserializeObject<PendingPurchase>(
                    PlayerPrefs.GetString(PendingPrefix + pack.Sku, string.Empty));
            }
            catch
            {
                FlowTrace.Fail("Store", "verify_pending: pending_record_parse_failed.");
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null,
                    error: "The pending purchase record is unreadable; contact support before paying again.");
            }

            if (pending == null || string.IsNullOrEmpty(pending.txSignature))
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null,
                    error: "No pending payment exists.");
            if (!string.Equals(pending.playerId, wallet.Account.Address, StringComparison.Ordinal))
                return new EntitlementVerificationResult(EntitlementVerificationState.Rejected,
                    pending.txSignature, error: "Connect the wallet that made this payment.");
            string expectedNetwork = WireNetwork(wallet.Network);
            string expectedCurrency = currency.ToString().ToUpperInvariant();
            if (!string.Equals(pending.sku, pack.Sku, StringComparison.Ordinal) ||
                !string.Equals(pending.network, expectedNetwork, StringComparison.Ordinal) ||
                !string.Equals(pending.currency, expectedCurrency, StringComparison.Ordinal))
                return new EntitlementVerificationResult(EntitlementVerificationState.Rejected,
                    pending.txSignature,
                    error: "The recorded payment does not match this SKU, network, and currency.");

            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                playerId = pending.playerId,
                sku = pending.sku,
                txSignature = pending.txSignature,
                network = pending.network,
                currency = pending.currency,
                // WO-1158: the id of the quote the SERVER issued. It is a LOOKUP KEY, never a
                // price - the amount lives on the server's own row and is not on this wire at all.
                quoteId = pending.quoteId ?? string.Empty,
            }));

            using var req = new UnityWebRequest(VerifyUrl, "POST")
            {
                uploadHandler = new UploadHandlerRaw(body),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = TimeoutSeconds,
            };
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");
            if (!await BackendRequestSigner.TryAttachAsync(req, pending.playerId, body))
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable,
                    pending.txSignature, error: "Could not authenticate the verification request.");

            try { await req.SendWebRequest(); }
            catch (Exception ex)
            {
                return new EntitlementVerificationResult(EntitlementVerificationState.Pending,
                    pending.txSignature, error: ex.GetType().Name);
            }

            VerifyResponse response = null;
            try { response = JsonConvert.DeserializeObject<VerifyResponse>(req.downloadHandler.text); }
            catch
            {
                FlowTrace.Fail("Store", "verify_pending: response_parse_failed.");
                /* handled as unavailable below */
            }

            if (req.responseCode == 202 || string.Equals(response?.State, "pending", StringComparison.Ordinal))
                return new EntitlementVerificationResult(EntitlementVerificationState.Pending,
                    pending.txSignature, error: response?.Code);

            if (req.result == UnityWebRequest.Result.Success && response != null && response.Success &&
                (response.State == "verified" || response.State == "fulfilled") &&
                string.Equals(response.Sku, pack.Sku, StringComparison.Ordinal) &&
                string.Equals(response.Network, expectedNetwork, StringComparison.Ordinal) &&
                string.Equals(response.Currency, expectedCurrency, StringComparison.Ordinal))
            {
                return new EntitlementVerificationResult(response.State == "fulfilled"
                        ? EntitlementVerificationState.Fulfilled : EntitlementVerificationState.Verified,
                    pending.txSignature, response.EntitlementId);
            }

            // The money moved and the server could not write its record. This lands as Pending
            // ANYWAY via the >= 500 branch below, but it is matched EXPLICITLY here for two
            // reasons: relying on "503 happens to be >= 500" is an implicit coupling that a
            // later status-code change would silently break into Rejected - i.e. into telling a
            // player who HAS paid that they have not - and the stage/ref are the only handle
            // support has for reconciling a settled transfer with no entitlement row.
            if (string.Equals(response?.State, "record_failed", StringComparison.Ordinal))
            {
                string reference = string.IsNullOrEmpty(response.Ref) ? "(no ref)" : response.Ref;
                FlowTrace.Warn("Store", "verify: payment SETTLED but the server could not record it. "
                    + "stage=" + (response.Stage ?? "?") + " ref=" + reference
                    + " tx=" + pending.txSignature + " - retryable, NEVER a rejection.");
                return new EntitlementVerificationResult(EntitlementVerificationState.Pending,
                    pending.txSignature, error: "record_failed ref " + reference,
                    reference: response.Ref, stage: response.Stage);
            }

            return new EntitlementVerificationResult(
                req.responseCode >= 400 && req.responseCode < 500
                    ? EntitlementVerificationState.Rejected
                    : EntitlementVerificationState.Pending,
                pending.txSignature, error: response?.Code ?? $"HTTP {req.responseCode}");
        }

        /// <summary>Restores a durable entitlement by authenticated wallet + SKU after local loss.</summary>
        public static async UniTask<EntitlementVerificationResult> ReconcileAsync(
            PackDef pack, WalletService wallet)
        {
            if (pack == null || wallet == null || !wallet.IsRealSigningWallet)
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);

            string playerId = wallet.Account.Address;
            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                playerId,
                sku = pack.Sku,
                network = WireNetwork(wallet.Network),
            }));
            using var req = new UnityWebRequest(ReconcileUrl, "POST")
            {
                uploadHandler = new UploadHandlerRaw(body),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = TimeoutSeconds,
            };
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");
            if (!await BackendRequestSigner.TryAttachAsync(req, playerId, body))
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);
            try { await req.SendWebRequest(); }
            catch
            {
                FlowTrace.Fail("Store", "reconcile: request_failed.");
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);
            }
            if (req.result != UnityWebRequest.Result.Success)
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);

            VerifyResponse response = null;
            try { response = JsonConvert.DeserializeObject<VerifyResponse>(req.downloadHandler.text); }
            catch
            {
                FlowTrace.Fail("Store", "reconcile: response_parse_failed.");
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);
            }
            string expectedNetwork = WireNetwork(wallet.Network);
            if (response != null && response.Success &&
                (response.State == "verified" || response.State == "fulfilled") &&
                !string.IsNullOrEmpty(response.TxSignature) &&
                string.Equals(response.Sku, pack.Sku, StringComparison.Ordinal) &&
                string.Equals(response.Network, expectedNetwork, StringComparison.Ordinal))
                return new EntitlementVerificationResult(response.State == "fulfilled"
                        ? EntitlementVerificationState.Fulfilled : EntitlementVerificationState.Verified,
                    response.TxSignature, response.EntitlementId);
            return new EntitlementVerificationResult(EntitlementVerificationState.Rejected, null,
                error: response?.Code ?? "No durable entitlement exists for this SKU.");
        }

        /// <summary>
        /// Clears recovery state only AFTER PackStore proves the local entitlement is owned/saved.
        /// Verification alone is deliberately insufficient: a crash between verification and grant
        /// must reopen onto the same signature rather than invite another charge.
        /// </summary>
        public static async UniTask<bool> MarkFulfilledAsync(
            string sku, string transactionSignature, WalletService wallet)
        {
            if (string.IsNullOrEmpty(sku) || string.IsNullOrEmpty(transactionSignature) ||
                wallet == null || !wallet.IsRealSigningWallet) return false;
            string raw = PlayerPrefs.GetString(PendingPrefix + sku, string.Empty);
            if (string.IsNullOrEmpty(raw)) return false;
            PendingPurchase pending;
            try
            {
                pending = JsonConvert.DeserializeObject<PendingPurchase>(raw);
                if (pending == null || !string.Equals(pending.txSignature, transactionSignature,
                        StringComparison.Ordinal) ||
                    !string.Equals(pending.sku, sku, StringComparison.Ordinal) ||
                    !string.Equals(pending.playerId, wallet.Account.Address, StringComparison.Ordinal))
                    return false;
            }
            catch
            {
                FlowTrace.Fail("Store", "mark_fulfilled: pending_record_parse_failed.");
                return false;
            }

            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                playerId = pending.playerId,
                sku,
                txSignature = transactionSignature,
                network = pending.network,
            }));
            using var req = new UnityWebRequest(FulfillUrl, "POST")
            {
                uploadHandler = new UploadHandlerRaw(body),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = TimeoutSeconds,
            };
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");
            if (!await BackendRequestSigner.TryAttachAsync(req, pending.playerId, body)) return false;
            try { await req.SendWebRequest(); }
            catch
            {
                FlowTrace.Fail("Store", "mark_fulfilled: request_failed.");
                return false;
            }

            VerifyResponse response = null;
            try { response = JsonConvert.DeserializeObject<VerifyResponse>(req.downloadHandler.text); }
            catch
            {
                FlowTrace.Fail("Store", "mark_fulfilled: response_parse_failed.");
                return false;
            }
            if (req.responseCode != 200 || req.result != UnityWebRequest.Result.Success ||
                response == null || !response.Success || response.State != "fulfilled" ||
                !string.Equals(response.Sku, sku, StringComparison.Ordinal) ||
                !string.Equals(response.Network, pending.network, StringComparison.Ordinal)) return false;

            PlayerPrefs.DeleteKey(PendingPrefix + sku);
            PlayerPrefs.Save();
            return true;
        }

        /// <summary>Backend/chain spelling. MWA uses solana:mainnet; purchase APIs use mainnet-beta.</summary>
        private static string WireNetwork(WalletNetwork network) =>
            network == WalletNetwork.Mainnet ? "mainnet-beta" : "devnet";
    }
}
