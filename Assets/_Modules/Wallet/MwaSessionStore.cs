// =============================================================================
// MwaSessionStore - persistence for the Mobile Wallet Adapter auth_token, so a
// returning player is SILENTLY REAUTHORIZED instead of re-prompted to connect.
// -----------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR (owner-reproduced on a real Seeker, 2026-08-17):
// she connected her wallet, played, force-quit, relaunched - and was asked to
// connect again. Her save DID come back (GameState.BoundWallet is persisted and
// is the save key), so IDENTITY survived a restart; only the wallet SESSION did
// not. SolanaWalletProvider._authToken was a plain private field commented
// "Session-scoped only - never persisted", so on relaunch there was no grant to
// REAUTHORIZE against and MWA had to run a full `authorize` - which IS the
// connect prompt. The reauthorize path was already implemented (see
// TargetedLocalAssociationScenario.SignMessage); it simply never survived a
// process restart. This class is the missing half.
//
// =============================================================================
//  SECURITY - WHY THE TOKEN IS ENCRYPTED AND NOT JUST PUT IN PlayerPrefs
// =============================================================================
// An MWA auth_token is a CAPABILITY GRANT, not an identifier. Whoever holds it
// can `reauthorize` and then ask that wallet to sign for our dapp identity
// without the player being prompted to grant access again. It is therefore
// treated as a credential, on the same footing as the guest save id that the
// 2026-08-15 audit forced us to redact out of the trace pipe.
//
// WHAT THE PROJECT'S NORMAL STORE WOULD HAVE COST US. PlayerPrefs on Android is
// SharedPreferences in the app's private data dir (MODE_PRIVATE), so it is NOT
// readable by other apps on a healthy device. Two real exposures remain, and the
// second is the decisive one:
//   1. ROOT / adb backup: anything plaintext in shared_prefs is readable.
//   2. ANDROID AUTO-BACKUP. This project ships NO app AndroidManifest (Unity
//      generates it; the only authored manifests are the two .androidlib merge
//      fragments) and nothing sets android:allowBackup="false" or an
//      android:dataExtractionRules, so AGP's default allowBackup=true applies:
//      shared_prefs are copied OFF THE DEVICE into the user's Google backup and
//      restored onto whatever device they next sign into. A plaintext auth_token
//      would be a wallet capability grant leaving the phone. The MWA spec is
//      explicit that auth tokens must not be backed up or transferred between
//      devices.
//
// WHAT WE DO INSTEAD. The token is sealed with AES-256/GCM under a key generated
// in the ANDROID KEYSTORE ("AndroidKeyStore" provider, alias below). The key
// material never leaves the TEE/StrongBox - it cannot be read by our own process,
// let alone extracted by a backup - so the ciphertext that lands in PlayerPrefs
// is inert off-device: restore it onto a new phone and the decrypt simply fails
// (handled as the ordinary "no session, authorize fresh" path). No new Gradle
// dependency is needed: this is the platform API (API 23+; the project's minSdk
// is 26), unlike androidx.security EncryptedSharedPreferences, which would mean
// editing mainTemplate.gradle's resolver-managed dependency block on a PUBLISHED
// app for the same protection.
//
// FAIL CLOSED, ALWAYS. If keystore generation, encryption, or decryption fails
// for ANY reason we persist NOTHING and return null - never a plaintext
// fallback. The cost of that is exactly today's behaviour (one connect prompt);
// the cost of the other choice would be a credential in a cloud backup. Every
// branch says which one it took in the trace, so a device capture tells us
// immediately whether the silent path was taken or fell back.
//
// WHAT AN ATTACKER WITH THE TOKEN STILL CANNOT DO. MWA wallets verify the
// CALLING PACKAGE against /.well-known/assetlinks.json for the identity URI in
// the request (that verification is the whole reason DappIdentityUri exists - see
// SolanaWalletProvider). A rogue app cannot present our identity, so a stolen
// token is not usable as us from another app. It also authorizes nothing by
// itself: the grant covers re-establishing the dapp<->account link, and our only
// uses of it are gasless (identity + the dotr-save:v1 message challenge). The
// player can revoke it wallet-side at any time, which surfaces here as an
// ordinary reauthorize failure. That is the reason this is a "seal it properly"
// problem and not a "never persist it" problem.
//
// NEVER LOG THE VALUE. Nothing in this file ever prints the token, or any
// substring of it, to FlowTrace / Debug / the F8 break-log. FlowTrace lines ride
// WebTraceSink -> api/trace.js into analytics_events AND into plaintext Vercel
// logs, and F8 captures get shared with other seats - a token in either is a real
// leak. Addresses are logged MASKED (4...4), matching the privacy rule already
// applied at WalletService.Connect. WalletSessionPersistenceRegression pins this.
//
// NOT A CONNECTION CLAIM. This store hands back a token to TRY a reauthorize
// with; it never marks anything connected. A connection only ever results from a
// wallet's own response, and the address in that response is checked against the
// address stored beside the token before it is accepted. StubWalletProvider does
// not touch this class at all (pinned by the regression), so a persisted session
// can never make a stub address look like a real signing wallet.
// =============================================================================

using System;
using DeNelle.Core.Diagnostics;
using UnityEngine;

namespace DeNelle.Wallet
{
    /// <summary>
    /// Encrypted, wallet-bound persistence for the Mobile Wallet Adapter
    /// <c>auth_token</c>. See the file header for the full security rationale.
    /// </summary>
    public static class MwaSessionStore
    {
        /// <summary>PlayerPrefs key holding the SEALED token (AES-GCM ciphertext, base64). Never plaintext.</summary>
        public const string TokenPrefsKey = "dotr.mwa.authtoken.v1";

        /// <summary>
        /// PlayerPrefs key holding the base58 wallet address the token was issued
        /// for. This is PUBLIC data (it is the on-chain identity, already the save
        /// key) and is stored in the clear on purpose: it is the binding that makes
        /// a cross-wallet reuse detectable without decrypting anything.
        /// </summary>
        public const string AddressPrefsKey = "dotr.mwa.address.v1";

        /// <summary>AndroidKeyStore alias for the AES-256 key that seals the token.</summary>
        public const string KeyAlias = "dotr.mwa.session.v1";

        /// <summary>Marks the stored blob format so a future scheme change can be detected, not mis-parsed.</summary>
        private const string BlobPrefix = "v1:";

        /// <summary>
        /// One ASCII line describing what the last store operation did. Diagnostics
        /// only - it NEVER contains the token. Surfaced in traces so a device
        /// capture answers "did the silent path run?" without another build.
        /// </summary>
        public static string LastStatus { get; private set; } = "unused";

        /// <summary>
        /// True only where the token can be SEALED before it is written. Off-device
        /// (Editor, desktop, WebGL) there is no AndroidKeyStore, so we persist
        /// nothing at all rather than fall back to plaintext. Those platforms run
        /// StubWalletProvider anyway and have no real session to keep.
        /// </summary>
        public static bool SecureStorageAvailable
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            get => true;
#else
            get => false;
#endif
        }

        /// <summary>The base58 address the stored token was issued for, or empty.</summary>
        public static string StoredAddress => PlayerPrefs.GetString(AddressPrefsKey, string.Empty);

        /// <summary>True when both halves of a session (sealed token + its address) are present.</summary>
        public static bool HasStoredSession =>
            !string.IsNullOrEmpty(StoredAddress) &&
            !string.IsNullOrEmpty(PlayerPrefs.GetString(TokenPrefsKey, string.Empty));

        /// <summary>
        /// THE BINDING TEST. True when a stored session exists and may be used for
        /// <paramref name="address"/>.
        /// <para>
        /// An empty/unknown <paramref name="address"/> returns true because the
        /// caller simply has no binding to compare against yet (e.g. the save is
        /// still on its local guest key). That is NOT a hole: the token is stored
        /// beside the address it was issued for, and the address the WALLET returns
        /// from the reauthorize is checked against that stored address before the
        /// connection is accepted (SolanaWalletProvider.Connect). So the token can
        /// never be silently reused for a different wallet - the worst an unknown
        /// binding can do is spend one reauthorize round-trip that then falls back
        /// to a full authorize.
        /// </para>
        /// </summary>
        public static bool MatchesStoredWallet(string address)
        {
            var stored = StoredAddress;
            if (string.IsNullOrEmpty(stored)) return false;      // nothing stored - nothing matches
            if (string.IsNullOrEmpty(address)) return true;      // caller has no binding to compare
            return string.Equals(stored, address, StringComparison.Ordinal);
        }

        /// <summary>
        /// Seals and persists <paramref name="authToken"/> bound to
        /// <paramref name="walletAddress"/>. Returns false (and stores NOTHING)
        /// when the platform cannot seal it - never a plaintext fallback.
        /// </summary>
        public static bool Save(string authToken, string walletAddress)
        {
            if (string.IsNullOrEmpty(authToken) || string.IsNullOrEmpty(walletAddress))
            {
                Clear("nothing to persist (wallet returned no token or no address)");
                return false;
            }

            if (!SecureStorageAvailable)
            {
                LastStatus = "not persisted - no secure storage on this platform";
                FlowTrace.Step("Wallet",
                    "MWA session NOT persisted - no AndroidKeyStore on this platform (by design; " +
                    "we never write the grant in plaintext).");
                return false;
            }

            var cipherBlob = Guard.Try("Wallet", "seal MWA session", () => Encrypt(authToken), (string)null);
            if (string.IsNullOrEmpty(cipherBlob))
            {
                // Fail CLOSED: drop any older session too, so we never leave a stale
                // grant paired with a wallet that has since changed.
                Clear("could not seal the grant (keystore unavailable) - persisting nothing");
                return false;
            }

            PlayerPrefs.SetString(TokenPrefsKey, cipherBlob);
            PlayerPrefs.SetString(AddressPrefsKey, walletAddress);
            PlayerPrefs.Save();

            LastStatus = "persisted (sealed)";
            FlowTrace.Step("Wallet",
                $"MWA session SEALED and persisted for {Mask(walletAddress)} - next launch can reauthorize silently.");
            return true;
        }

        /// <summary>
        /// Returns the stored auth token for <paramref name="expectedWalletAddress"/>,
        /// or null when there is none / it belongs to another wallet / it cannot be
        /// unsealed. Any of those cases CLEARS the stored session so the caller falls
        /// back to a clean full authorize.
        /// </summary>
        /// <param name="expectedWalletAddress">
        /// The wallet the caller believes it is resuming - GameState.BoundWallet when
        /// that is wallet-shaped, otherwise empty. There is deliberately no second
        /// notion of "the current wallet" in this module.
        /// </param>
        public static string Load(string expectedWalletAddress)
        {
            var stored = StoredAddress;
            var blob = PlayerPrefs.GetString(TokenPrefsKey, string.Empty);

            if (string.IsNullOrEmpty(stored) || string.IsNullOrEmpty(blob))
            {
                LastStatus = "no stored session";
                FlowTrace.Step("Wallet", "MWA session: none stored - a full authorize is required.");
                return null;
            }

            if (!MatchesStoredWallet(expectedWalletAddress))
            {
                // The single worst outcome in this system is a token silently reused
                // for a DIFFERENT wallet - that cross-keys a cloud save row. Discard.
                Clear($"stored session is for {Mask(stored)} but the bound save key is " +
                      $"{Mask(expectedWalletAddress)} - DIFFERENT wallet, discarding");
                return null;
            }

            if (!SecureStorageAvailable)
            {
                Clear("a sealed session exists but this platform cannot unseal it - discarding");
                return null;
            }

            var token = Guard.Try("Wallet", "unseal MWA session", () => Decrypt(blob), (string)null);
            if (string.IsNullOrEmpty(token))
            {
                // Normal, expected paths land here: the keystore key was reset, the
                // app was restored onto a new device from backup, or the blob format
                // moved on. None of them is exceptional - authorize fresh.
                Clear("stored session could not be unsealed (keystore reset, restored to a new device, " +
                      "or format change) - discarding");
                return null;
            }

            LastStatus = "loaded";
            FlowTrace.Step("Wallet",
                $"MWA session found for {Mask(stored)} - attempting SILENT reauthorize (no prompt expected).");
            return token;
        }

        /// <summary>
        /// Drops the stored session AND destroys the keystore key that sealed it, so
        /// the ciphertext left in any backup is permanently unrecoverable. Called on
        /// explicit disconnect (a player who disconnects is actually disconnected),
        /// on a wallet mismatch, and on any unseal failure.
        /// </summary>
        /// <param name="why">ASCII reason for the trace. NEVER contains the token.</param>
        public static void Clear(string why)
        {
            bool had = HasStoredSession;

            PlayerPrefs.DeleteKey(TokenPrefsKey);
            PlayerPrefs.DeleteKey(AddressPrefsKey);
            PlayerPrefs.Save();

            // Best effort - a keystore that will not delete must never block the
            // prefs wipe above, which is the part that actually revokes our use of it.
            Guard.Try("Wallet", "delete MWA session key", DeleteKeystoreEntry);

            LastStatus = "cleared";
            if (had || !string.IsNullOrEmpty(why))
                FlowTrace.Step("Wallet", $"MWA session CLEARED - {why}.");
        }

        /// <summary>4...4 masked address for logs (privacy rule from WalletService.Connect).</summary>
        internal static string Mask(string address)
        {
            if (string.IsNullOrEmpty(address)) return "<none>";
            if (address.Length < 8) return "<short>";
            return address.Substring(0, 4) + "..." + address.Substring(address.Length - 4);
        }

        // =====================================================================
        //  AndroidKeyStore AES-256/GCM sealing
        // ---------------------------------------------------------------------
        //  Everything below is best-effort by contract: every entry point is
        //  wrapped by Guard at the call site and returns null on any failure, and
        //  a null return means "persist nothing / authorize fresh". A JNI shape
        //  that differs on some OEM image therefore costs us the silent relaunch,
        //  never a crash and never a plaintext write.
        //
        //  AndroidJavaObject (not raw AndroidJNI) is used deliberately: it turns a
        //  Java-side throw into a C# AndroidJavaException instead of leaving a
        //  pending JNI exception that poisons later calls.
        // =====================================================================

#if UNITY_ANDROID && !UNITY_EDITOR
        private const int PurposeEncryptDecrypt = 1 | 2;   // KeyProperties.PURPOSE_ENCRYPT | PURPOSE_DECRYPT
        private const int EncryptMode = 1;                 // Cipher.ENCRYPT_MODE
        private const int DecryptMode = 2;                 // Cipher.DECRYPT_MODE
        private const int GcmTagBits = 128;
        private const string Transformation = "AES/GCM/NoPadding";

        /// <summary>Seals plaintext, returning "v1:&lt;b64 iv&gt;:&lt;b64 ciphertext&gt;", or null.</summary>
        private static string Encrypt(string plaintext)
        {
            using (var key = GetOrCreateKey())
            {
                if (key == null) return null;
                using (var cipherClass = new AndroidJavaClass("javax.crypto.Cipher"))
                using (var cipher = cipherClass.CallStatic<AndroidJavaObject>("getInstance", Transformation))
                {
                    cipher.Call("init", EncryptMode, key);
                    var iv = cipher.Call<byte[]>("getIV");
                    var ct = cipher.Call<byte[]>("doFinal", System.Text.Encoding.UTF8.GetBytes(plaintext));
                    if (iv == null || ct == null) return null;
                    return BlobPrefix + Convert.ToBase64String(iv) + ":" + Convert.ToBase64String(ct);
                }
            }
        }

        /// <summary>Unseals a blob written by <see cref="Encrypt"/>, or null.</summary>
        private static string Decrypt(string blob)
        {
            if (string.IsNullOrEmpty(blob) || !blob.StartsWith(BlobPrefix, StringComparison.Ordinal)) return null;
            var parts = blob.Substring(BlobPrefix.Length).Split(':');
            if (parts.Length != 2) return null;

            var iv = Convert.FromBase64String(parts[0]);
            var ct = Convert.FromBase64String(parts[1]);

            using (var key = LoadKey())
            {
                if (key == null) return null;
                using (var spec = new AndroidJavaObject("javax.crypto.spec.GCMParameterSpec", GcmTagBits, iv))
                using (var cipherClass = new AndroidJavaClass("javax.crypto.Cipher"))
                using (var cipher = cipherClass.CallStatic<AndroidJavaObject>("getInstance", Transformation))
                {
                    cipher.Call("init", DecryptMode, key, spec);
                    var pt = cipher.Call<byte[]>("doFinal", ct);
                    if (pt == null || pt.Length == 0) return null;
                    return System.Text.Encoding.UTF8.GetString(pt);
                }
            }
        }

        /// <summary>Opens the "AndroidKeyStore" provider. Caller disposes.</summary>
        private static AndroidJavaObject OpenKeyStore()
        {
            using (var ksClass = new AndroidJavaClass("java.security.KeyStore"))
            {
                var ks = ksClass.CallStatic<AndroidJavaObject>("getInstance", "AndroidKeyStore");
                // KeyStore.load(null): required before any entry access on this provider.
                ks.Call("load", (AndroidJavaObject)null);
                return ks;
            }
        }

        /// <summary>The existing sealing key, or null when the alias is absent/unreadable.</summary>
        private static AndroidJavaObject LoadKey()
        {
            using (var ks = OpenKeyStore())
            {
                if (ks == null) return null;
                if (!ks.Call<bool>("containsAlias", KeyAlias)) return null;
                return ks.Call<AndroidJavaObject>("getKey", KeyAlias, (AndroidJavaObject)null);
            }
        }

        /// <summary>The sealing key, generating a fresh AES-256 keystore key on first use.</summary>
        private static AndroidJavaObject GetOrCreateKey()
        {
            var existing = LoadKey();
            if (existing != null) return existing;

            using (var kgClass = new AndroidJavaClass("javax.crypto.KeyGenerator"))
            using (var kg = kgClass.CallStatic<AndroidJavaObject>("getInstance", "AES", "AndroidKeyStore"))
            using (var builder = new AndroidJavaObject(
                       "android.security.keystore.KeyGenParameterSpec$Builder", KeyAlias, PurposeEncryptDecrypt))
            {
                // setBlockModes / setEncryptionPaddings are String... varargs -> String[].
                builder.Call<AndroidJavaObject>("setBlockModes", new object[] { new[] { "GCM" } }).Dispose();
                builder.Call<AndroidJavaObject>("setEncryptionPaddings", new object[] { new[] { "NoPadding" } }).Dispose();
                builder.Call<AndroidJavaObject>("setKeySize", 256).Dispose();
                // NOT user-authentication-bound on purpose: the whole point is a
                // relaunch with no prompt, and a lock-screen requirement here would
                // simply trade the wallet prompt for a device prompt. The protection
                // we are buying is "the key cannot leave the device", which holds
                // regardless.
                using (var spec = builder.Call<AndroidJavaObject>("build"))
                {
                    kg.Call("init", spec);
                    kg.Call<AndroidJavaObject>("generateKey").Dispose();
                }
            }

            FlowTrace.Step("Wallet", "MWA session key generated in the Android keystore (AES-256/GCM, non-exportable).");
            return LoadKey();
        }

        /// <summary>Destroys the sealing key so any surviving ciphertext is unrecoverable.</summary>
        private static void DeleteKeystoreEntry()
        {
            using (var ks = OpenKeyStore())
            {
                if (ks == null) return;
                if (ks.Call<bool>("containsAlias", KeyAlias))
                    ks.Call("deleteEntry", KeyAlias);
            }
        }
#else
        // Off-device: no keystore, so no sealing and therefore no persistence.
        // Deliberately NOT a plaintext fallback - see the file header.
        private static string Encrypt(string plaintext) => null;
        private static string Decrypt(string blob) => null;
        private static void DeleteKeystoreEntry() { }
#endif
    }
}
