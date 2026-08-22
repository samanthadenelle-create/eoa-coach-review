using System;
using System.Text;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Web3;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace DeNelle.Wallet
{
    public enum EntitlementVerificationState { Verified, Pending, Rejected, Unavailable }

    public readonly struct EntitlementVerificationResult
    {
        public readonly EntitlementVerificationState State;
        public readonly string TransactionSignature;
        public readonly string EntitlementId;
        public readonly string Error;

        public EntitlementVerificationResult(EntitlementVerificationState state, string signature,
                                             string entitlementId = null, string error = null)
        {
            State = state;
            TransactionSignature = signature;
            EntitlementId = entitlementId;
            Error = error;
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
        }

        private sealed class VerifyResponse
        {
            [JsonProperty("success")] public bool Success;
            [JsonProperty("state")] public string State;
            [JsonProperty("txSignature")] public string TxSignature;
            [JsonProperty("entitlementId")] public string EntitlementId;
            [JsonProperty("code")] public string Code;
        }

        public static bool HasPending(string sku) =>
            !string.IsNullOrEmpty(PlayerPrefs.GetString(PendingPrefix + sku, string.Empty));

        public static void Remember(PackDef pack, PaymentResult payment, WalletService wallet)
        {
            if (pack == null || !payment.Ok || string.IsNullOrEmpty(payment.TxSignature) || wallet == null)
                return;
            var row = new PendingPurchase
            {
                playerId = wallet.Account.Address,
                sku = pack.Sku,
                txSignature = payment.TxSignature,
                network = wallet.Network == WalletNetwork.Devnet ? "devnet" : "mainnet",
                currency = payment.Currency.ToString().ToUpperInvariant(),
            };
            PlayerPrefs.SetString(PendingPrefix + pack.Sku, JsonConvert.SerializeObject(row));
            PlayerPrefs.Save();
        }

        public static async UniTask<EntitlementVerificationResult> VerifyPendingAsync(
            PackDef pack, WalletService wallet)
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
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null,
                    error: "The pending purchase record is unreadable; contact support before paying again.");
            }

            if (pending == null || string.IsNullOrEmpty(pending.txSignature))
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null,
                    error: "No pending payment exists.");
            if (!string.Equals(pending.playerId, wallet.Account.Address, StringComparison.Ordinal))
                return new EntitlementVerificationResult(EntitlementVerificationState.Rejected,
                    pending.txSignature, error: "Connect the wallet that made this payment.");

            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                playerId = pending.playerId,
                sku = pending.sku,
                txSignature = pending.txSignature,
                network = pending.network,
                currency = pending.currency,
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
            catch { /* handled as unavailable below */ }

            if (req.responseCode == 202 || string.Equals(response?.State, "pending", StringComparison.Ordinal))
                return new EntitlementVerificationResult(EntitlementVerificationState.Pending,
                    pending.txSignature, error: response?.Code);

            if (req.result == UnityWebRequest.Result.Success && response != null && response.Success &&
                (response.State == "verified" || response.State == "fulfilled"))
            {
                return new EntitlementVerificationResult(EntitlementVerificationState.Verified,
                    pending.txSignature, response.EntitlementId);
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
            catch { return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null); }
            if (req.result != UnityWebRequest.Result.Success)
                return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null);

            VerifyResponse response = null;
            try { response = JsonConvert.DeserializeObject<VerifyResponse>(req.downloadHandler.text); }
            catch { return new EntitlementVerificationResult(EntitlementVerificationState.Unavailable, null); }
            if (response != null && response.Success &&
                (response.State == "verified" || response.State == "fulfilled") &&
                !string.IsNullOrEmpty(response.TxSignature))
                return new EntitlementVerificationResult(EntitlementVerificationState.Verified,
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
                    !string.Equals(pending.playerId, wallet.Account.Address, StringComparison.Ordinal))
                    return false;
            }
            catch { return false; }

            byte[] body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new
            {
                playerId = pending.playerId,
                sku,
                txSignature = transactionSignature,
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
            catch { return false; }

            VerifyResponse response = null;
            try { response = JsonConvert.DeserializeObject<VerifyResponse>(req.downloadHandler.text); }
            catch { return false; }
            if (req.responseCode != 200 || req.result != UnityWebRequest.Result.Success ||
                response == null || !response.Success || response.State != "fulfilled") return false;

            PlayerPrefs.DeleteKey(PendingPrefix + sku);
            PlayerPrefs.Save();
            return true;
        }
    }
}
