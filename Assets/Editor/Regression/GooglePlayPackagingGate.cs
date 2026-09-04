using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using UnityEngine;

namespace DeNelle.Editor
{
    /// <summary>
    /// WO-1255 Gate 0. Google Play compliance is a property of the shipped AAB,
    /// not of a hidden button. This gate deliberately rejects the current source
    /// graph until the storefront has been split out of Wallet and the MWA Android
    /// library has a real per-artifact exclusion mechanism.
    ///
    /// WO-1364: the artifact half of this gate used to run TWO token vocabularies -
    /// a strict one for .json/.txt/.html/.xml/.uxml and a deliberately weakened one
    /// for everything else. Every C# string literal in an IL2CPP player lands in
    /// base/assets/bin/Data/Managed/Metadata/global-metadata.dat, which is
    /// "everything else", so the weak list is what actually decided whether the AAB
    /// was clean. It dropped solana, jupiter, usdc, blockchain, crypto and web3, and
    /// neither list ever carried the USDC mint or a bare skr. Result:
    /// Builds/ui-reskin-final-google-play-aab-v2.log:38188 emitted
    /// PLAY_ARTIFACT_CLEAN_OK on an artifact carrying solana x74, SKR x35,
    /// Jupiter x12 and EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
    ///
    /// There is now ONE vocabulary (<see cref="ForbiddenTokens"/>) applied to every
    /// entry. The old tier split is replaced by an EVIDENCE-QUALITY rule instead of a
    /// vocabulary rule: in a binary payload a very short token would collide with
    /// random bytes, so short tokens additionally require a printable-ASCII run
    /// around the hit (<see cref="ShortTokensRequiringTextContext"/>), and the
    /// genuine false positives the old comment named are suppressed by name, with a
    /// reason, in <see cref="FalsePositiveAllowlist"/>.
    ///
    /// The three arrays below are the SINGLE SOURCE OF TRUTH for this policy:
    /// tools/android/assert-google-play-aab-clean.ps1 parses them out of this file at
    /// run time rather than keeping a second copy (the two copies had drifted before).
    /// Keep each array a plain string[] of simple literals, and keep the comments free
    /// of double quotes, or that parser will fail closed and the scanner will throw.
    /// </summary>
    public static class GooglePlayPackagingGate
    {
        // The whole forbidden vocabulary. Applied to EVERY entry in the AAB - readable
        // authoring content, IL2CPP metadata, dex, native libraries, asset bundles.
        // Redundant-but-kept entries (solana-wallet, Solana.Unity., stake.solanamobile)
        // are subsumed by 'solana' and are retained because a precise token makes the
        // PLAY_ARTIFACT_DIRTY line name the actual offender.
        private static readonly string[] ForbiddenTokens =
        {
            "solana", "mobilewalletadapter", "mobile_wallet_adapter", "defenders/mwa/",
            "jupiter", "jup.ag", "skrvaluation", "walletadapter", "solana-wallet",
            "phantom wallet", "app.phantom", "solflare", "seed vault", "connect wallet",
            "$skr", "spend $skr", "skr", "skr is a real", "stake.solanamobile",
            "usdc", "blockchain", "crypto", "web3",
            "Solana.Unity.",
            "pi network", "sign in with pi", "api.minepi.com", "sdk.minepi.com",
            // Live mints. Long and unambiguous: safe in any payload, no context rule needed.
            "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
            "3BwWSAUZmyngXDSZiCawEnP7iLgY5ANNopBDz94AB77N",
            // WO-1364: the USDC mint was in NEITHER of the old tiers.
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        };

        // Tokens too short to be trusted on their own inside a binary payload. A 3-4
        // character token collides with random bytes many times over a 500 MB artifact
        // (a 4-byte match is ~1 in 2^30 per offset case-insensitively, which is several
        // expected hits at that size; a 3-byte one is dozens). In a NON-text entry these
        // must therefore sit inside a run of printable ASCII at least
        // MinPrintableRunForShortTokens characters long - which a real C# string literal
        // such as Balance: {0} SKR always is, and random bytes essentially never are -
        // and must have a word boundary on BOTH sides. In a readable text entry
        // (.json/.txt/.html/.xml/.uxml, Data/Canonical) no run is required: the whole
        // entry is text.
        private static readonly string[] ShortTokensRequiringTextContext =
        {
            "skr", "$skr", "usdc", "web3"
        };

        // Documented, justified suppressions. A hit is dropped ONLY when the matched
        // occurrence lies inside one of these longer phrases. Nothing here weakens the
        // vocabulary: the token stays live everywhere else.
        private static readonly string[] FalsePositiveAllowlist =
        {
            // 'crypto' inside the BCL. System.Security.Cryptography, CryptographicException,
            // CryptoConfig, CryptoStream and friends are in every IL2CPP metadata blob ever
            // produced; this is the false positive the pre-WO-1364 comment named.
            "cryptograph",
            "cryptoconfig",
            "cryptostream",
            "cryptoservice",
            // 'crypto' inside the Android/Java platform. javax.crypto is the JCE package,
            // present in every dex that touches TLS or keystores.
            "javax.crypto",
            "javax/crypto",
            // 'crypto' inside Jetpack Security (EncryptedSharedPreferences), pulled in by
            // Firebase/Play services rather than by us.
            "androidx.security.crypto",
            "androidx/security/crypto",
            // 'crypto' inside BouncyCastle, a transitive TLS dependency of the ad/network SDKs.
            "bouncycastle.crypto",
            "bouncycastle/crypto",
            // 'crypto' inside OpenSSL/BoringSSL native libraries shipped by the engine and
            // by third-party SDKs.
            "libcrypto",
            // -- Every entry below was MEASURED in Builds/Android/EchoesOfElarion-GooglePlay.aab
            //    on 2026-09-04 by enumerating the non-allowlisted 'crypto' occurrences, not
            //    guessed. Each is third-party or engine material we do not author.
            // Mono TLS stack in global-metadata.dat: Mono.Security CryptoConvert.
            "cryptoconvert",
            // Burst intrinsics source path: Runtime/Intrinsics/Arm/NEON_AArch64_crypto.cs.
            "aarch64_crypto",
            // Web Crypto API used by the ironSource/LevelPlay ad SDK web views for UUIDs:
            // crypto.getRandomValues, the 'return crypto&&crypto...' guard, and the DOM
            // structured-clone type name CryptoKey. Also covers Google KMS cryptoKeys /
            // cryptoKeyVersions resource paths in classes.dex.
            "crypto.getrandomvalues",
            "crypto&&",
            "cryptokey",
            // Android platform APIs in classes.dex: FingerprintManager$CryptoObject and
            // android/crypto/hpke.
            "cryptoobject",
            "android/crypto",
            // Google Tink and Firebase Auth/Installations, pulled in by Firebase, not by us.
            "google.crypto",
            "auth.api.crypto",
            "crypto setup",
            "storage_crypto",
            // mbedtls inside libunity.so: psa_crypto_init.
            "psa_crypto",
            // Art asset id 'ebc_cryptofthecount' - the icon for Crypt of the Count. The
            // letters 'crypt' + 'o' collide with the token; nothing to do with currency.
            "cryptofthecount"
        };

        // JAR signature listings hold nothing but entry names and base64 SHA digests, and a
        // base64 digest is a long printable run of arbitrary characters - the one place the
        // printable-run rule cannot separate signal from noise. MEASURED: META-INF/MANIFEST.MF
        // carries the digest '...I89IGK+USDc=', which matched the 'usdc' token with a clean
        // boundary on both sides. SHORT tokens are therefore not applied to these entries;
        // the full-length tokens (mints, solana, jupiter, wallet identifiers) still are, so a
        // forbidden FILE NAME in the listing is still caught.
        internal static bool IsSignatureDigestEntry(string entryName)
        {
            string name = (entryName ?? string.Empty).Replace('\\', '/').ToLowerInvariant();
            if (!name.StartsWith("meta-inf/", StringComparison.Ordinal)) return false;
            return name.EndsWith("/manifest.mf", StringComparison.Ordinal) ||
                   name.EndsWith(".sf", StringComparison.Ordinal);
        }

        // A real string literal around a short token is comfortably longer than this;
        // random binary almost never produces a printable run of this length.
        internal const int MinPrintableRunForShortTokens = 12;

        public static bool AssertSourceIsolation()
        {
            var failures = InspectSourceIsolation();
            if (failures.Count == 0)
            {
                Debug.Log("[GooglePlayPackagingGate] PLAY_SOURCE_ISOLATION_OK");
                return true;
            }

            Debug.LogError("[GooglePlayPackagingGate] PLAY_SOURCE_ISOLATION_FAIL — AAB NOT BUILT:\n - " +
                           string.Join("\n - ", failures));
            return false;
        }

        public static List<string> InspectSourceIsolation()
        {
            var failures = new List<string>();
            string wallet = Read("Assets/_Modules/Wallet/DeNelle.Wallet.asmdef");
            string web3 = Read("Assets/_Modules/Web3/DeNelle.Web3.asmdef");
            string village = Read("Assets/_Modules/Village/DeNelle.Village.asmdef");
            string manifest = Read("Packages/manifest.json");
            string sdkRuntime = Read("Packages/com.solana.unity_sdk/Runtime/com.solana.unity_sdk.asmdef");
            string projectSettings = Read("ProjectSettings/ProjectSettings.asset");

            int definesStart = projectSettings.IndexOf("scriptingDefineSymbols:", StringComparison.Ordinal);
            int definesEnd = definesStart < 0
                ? -1
                : projectSettings.IndexOf("additionalCompilerArguments:", definesStart, StringComparison.Ordinal);
            string defineBlock = definesStart >= 0 && definesEnd > definesStart
                ? projectSettings.Substring(definesStart, definesEnd - definesStart)
                : string.Empty;
            string androidDefines = defineBlock
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => line.Trim())
                .FirstOrDefault(line => line.StartsWith("Android:", StringComparison.Ordinal))
                ?? string.Empty;
            foreach (string forbiddenPersistentDefine in new[] { "DAPP_STORE", "GOOGLE_PLAY", "SOLANA_SDK" })
            {
                string[] symbols = androidDefines.Substring(androidDefines.IndexOf(':') + 1)
                    .Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                if (symbols.Any(symbol => string.Equals(symbol.Trim(), forbiddenPersistentDefine, StringComparison.Ordinal)))
                    failures.Add($"Android PlayerSettings persist artifact symbol {forbiddenPersistentDefine}; AndroidBuild must supply channel/capability symbols per artifact.");
            }

            if (!wallet.Contains("!GOOGLE_PLAY"))
                failures.Add("DeNelle.Wallet has no !GOOGLE_PLAY assembly constraint.");
            if (!web3.Contains("!GOOGLE_PLAY"))
                failures.Add("DeNelle.Web3 has no !GOOGLE_PLAY assembly constraint.");
            if (village.Contains("\"DeNelle.Wallet\""))
                failures.Add("DeNelle.Village directly references DeNelle.Wallet; excluding Wallet would break the player compile. Split the rail-neutral store/grants first.");

            if (!manifest.Contains("\"com.solana.unity_sdk\": \"file:com.solana.unity_sdk\""))
                failures.Add("Solana SDK is not embedded; Play-specific package constraints cannot be trusted.");
            if (!sdkRuntime.Contains("!GOOGLE_PLAY"))
                failures.Add("Embedded Solana SDK runtime assembly has no !GOOGLE_PLAY constraint.");

            string sdkDllFolder = "Packages/com.solana.unity_sdk/Packages";
            if (!Directory.Exists(sdkDllFolder))
            {
                failures.Add("Embedded Solana SDK managed-plugin folder is missing.");
            }
            else
            {
                foreach (string meta in Directory.GetFiles(sdkDllFolder, "*.dll.meta"))
                    if (!Read(meta).Contains("defineConstraints: [!GOOGLE_PLAY]"))
                        failures.Add($"Embedded Solana managed plugin is unconditional: {meta}");
            }

            string uniTask = Read("Packages/com.solana.unity_sdk/Runtime/Plugins/UniTask/Runtime/UniTask.asmdef");
            if (string.IsNullOrEmpty(uniTask) || uniTask.Contains("!GOOGLE_PLAY"))
                failures.Add("Vendored UniTask must remain available to GOOGLE_PLAY first-party assemblies.");

            string mwaMeta = "Assets/Plugins/Android/MobileWalletAdapter.androidlib.meta";
            if (File.Exists(mwaMeta) && !Read(mwaMeta).Contains("GOOGLE_PLAY"))
                failures.Add("MobileWalletAdapter.androidlib is an unconditional Android plugin; no Play-artifact exclusion is configured.");

            return failures;
        }

        public static bool AssertBuiltArtifact(string aabPath)
        {
            if (!File.Exists(aabPath))
            {
                Debug.LogError($"[GooglePlayPackagingGate] PLAY_ARTIFACT_MISSING — {aabPath}");
                return false;
            }

            var hits = new List<string>();
            using (var zip = ZipFile.OpenRead(aabPath))
            {
                foreach (var entry in zip.Entries)
                {
                    string name = entry.FullName.ToLowerInvariant();
                    string[] tokens = TokensForEntry(entry.FullName);
                    bool readable = IsUserFacingContentEntry(entry.FullName);
                    if (IsSignatureDigestEntry(entry.FullName))
                        tokens = tokens.Where(t => !IsShortToken(t)).ToArray();

                    // Unity records resolved package provenance here even when every SDK
                    // assembly/plugin is excluded from the player. Executable leakage is
                    // proven by scanning actual player entries, not by this receipt.
                    if (ShouldSkipProvenanceEntry(entry.FullName))
                        continue;

                    // An entry NAME is always text, so no printable-run rule applies to it.
                    foreach (string token in tokens)
                        if (MatchesTokenForAudit(name, token)) hits.Add($"entry:{entry.FullName} token:{token}");

                    using (var stream = entry.Open())
                        ScanStream(stream, entry.FullName, tokens, readable, hits);
                }
            }

            if (hits.Count > 0)
            {
                Debug.LogError("[GooglePlayPackagingGate] PLAY_ARTIFACT_DIRTY:\n - " +
                               string.Join("\n - ", hits.Distinct().Take(50)));
                return false;
            }

            Debug.Log("[GooglePlayPackagingGate] PLAY_ARTIFACT_CLEAN_OK");
            return true;
        }

        /// <summary>
        /// True when the entry is readable text end to end, so a short token needs no
        /// printable-run corroboration. Everything else - IL2CPP metadata, dex, .so,
        /// bundles, resources - is scanned with the SAME vocabulary under the binary
        /// evidence rule. This is no longer a vocabulary tier (WO-1364).
        /// </summary>
        private static bool IsUserFacingContentEntry(string entryName)
        {
            string name = (entryName ?? string.Empty).Replace('\\', '/').ToLowerInvariant();
            return name.StartsWith("base/assets/data/canonical/", StringComparison.Ordinal) ||
                   name.EndsWith(".json", StringComparison.Ordinal) ||
                   name.EndsWith(".txt", StringComparison.Ordinal) ||
                   name.EndsWith(".html", StringComparison.Ordinal) ||
                   name.EndsWith(".xml", StringComparison.Ordinal) ||
                   name.EndsWith(".uxml", StringComparison.Ordinal);
        }

        /// <summary>
        /// WO-1364: every entry gets the whole vocabulary. Kept as a seam so the source
        /// oracle can pin that readable and opaque entries are policed identically.
        /// </summary>
        internal static string[] TokensForEntry(string entryName)
        {
            _ = entryName;
            return ForbiddenTokens;
        }

        internal static bool IsShortToken(string token) =>
            Array.Exists(ShortTokensRequiringTextContext,
                t => string.Equals(t, token, StringComparison.OrdinalIgnoreCase));

        internal static bool ShouldSkipProvenanceEntry(string entryName) =>
            string.Equals((entryName ?? string.Empty).Replace('\\', '/'),
                "BUNDLE-METADATA/com.unity/dependencies.pb", StringComparison.OrdinalIgnoreCase);

        private static void ScanStream(Stream stream, string entryName, string[] tokens, bool readableEntry, List<string> hits)
        {
            const int chunkSize = 64 * 1024;
            int overlap = tokens.Max(t => Encoding.Unicode.GetByteCount(t));
            // Room for the printable-run and allowlist windows to survive a chunk seam.
            overlap += 4 * MinPrintableRunForShortTokens + 128;
            if ((overlap & 1) != 0) overlap++;
            var buffer = new byte[chunkSize + overlap];
            int retained = 0;

            while (true)
            {
                int read = stream.Read(buffer, retained, chunkSize);
                if (read <= 0) break;
                int count = retained + read;
                string asciiText = Latin1(buffer, count);
                string utf16Text = Encoding.Unicode.GetString(buffer, 0, count - (count % 2));

                foreach (string token in tokens)
                {
                    if (MatchesTokenInPayload(asciiText, token, readableEntry) ||
                        MatchesTokenInPayload(utf16Text, token, readableEntry))
                        hits.Add($"content:{entryName} token:{token}");
                }

                retained = Math.Min(overlap, count);
                Buffer.BlockCopy(buffer, count - retained, buffer, 0, retained);
            }
        }

        /// <summary>
        /// Byte-exact single-byte view of a buffer. NOT Encoding.ASCII: that maps every
        /// byte above 0x7F to '?', which is printable, so ~87% of random bytes would look
        /// like text and the printable-run corroboration below would be worthless.
        /// </summary>
        private static string Latin1(byte[] buffer, int count)
        {
            var chars = new char[count];
            for (int i = 0; i < count; i++) chars[i] = (char)buffer[i];
            return new string(chars);
        }

        /// <summary>
        /// Text-entry matching: word boundary at the front, allowlist suppression, no
        /// printable-run requirement. Also used for entry names.
        /// </summary>
        internal static bool MatchesTokenForAudit(string text, string token) =>
            MatchesTokenInPayload(text, token, readableEntry: true);

        /// <summary>
        /// The one matcher. <paramref name="readableEntry"/> false means a binary payload,
        /// where short tokens additionally need a both-side word boundary and a printable
        /// ASCII run so random bytes cannot manufacture a hit.
        /// </summary>
        internal static bool MatchesTokenInPayload(string text, string token, bool readableEntry)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(token)) return false;
            bool shortToken = !readableEntry && IsShortToken(token);
            int start = 0;
            while (start < text.Length)
            {
                int hit = text.IndexOf(token, start, StringComparison.OrdinalIgnoreCase);
                if (hit < 0) return false;
                start = hit + 1;

                bool needsLeadingBoundary = char.IsLetterOrDigit(token[0]);
                if (needsLeadingBoundary && hit != 0 && char.IsLetterOrDigit(text[hit - 1]))
                    continue;

                if (shortToken)
                {
                    int after = hit + token.Length;
                    if (after < text.Length && char.IsLetterOrDigit(text[after])) continue;
                    if (!HasPrintableRun(text, hit, token.Length, MinPrintableRunForShortTokens)) continue;
                }

                if (IsAllowlistedOccurrence(text, hit, token)) continue;

                return true;
            }
            return false;
        }

        /// <summary>
        /// True when the hit sits inside a contiguous run of printable ASCII at least
        /// <paramref name="minRun"/> characters long - i.e. inside a real string.
        /// </summary>
        internal static bool HasPrintableRun(string text, int hit, int length, int minRun)
        {
            int left = hit;
            while (left > 0 && IsPrintable(text[left - 1])) left--;
            int right = hit + length;
            while (right < text.Length && IsPrintable(text[right])) right++;
            for (int i = hit; i < hit + length && i < text.Length; i++)
                if (!IsPrintable(text[i])) return false;
            return right - left >= minRun;
        }

        private static bool IsPrintable(char c) => (c >= ' ' && c <= '~') || c == '\t';

        /// <summary>
        /// True when this occurrence lies inside one of the documented false positives.
        /// Only phrases that actually contain the token are considered, so the allowlist
        /// can never silently disable an unrelated token.
        /// </summary>
        internal static bool IsAllowlistedOccurrence(string text, int hit, string token)
        {
            foreach (string allow in FalsePositiveAllowlist)
            {
                if (allow.IndexOf(token, StringComparison.OrdinalIgnoreCase) < 0) continue;
                int windowStart = Math.Max(0, hit - allow.Length);
                int windowEnd = Math.Min(text.Length, hit + token.Length + allow.Length);
                int found = text.IndexOf(allow, windowStart, windowEnd - windowStart, StringComparison.OrdinalIgnoreCase);
                while (found >= 0)
                {
                    if (found <= hit && found + allow.Length >= hit + token.Length) return true;
                    int next = found + 1;
                    if (next >= windowEnd) break;
                    found = text.IndexOf(allow, next, windowEnd - next, StringComparison.OrdinalIgnoreCase);
                }
            }
            return false;
        }

        private static string Read(string path) => File.Exists(path) ? File.ReadAllText(path) : string.Empty;
    }
}
