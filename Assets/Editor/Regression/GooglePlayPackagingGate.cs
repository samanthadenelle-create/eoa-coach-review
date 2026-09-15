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
    /// The FOUR arrays below are the SINGLE SOURCE OF TRUTH for this policy:
    /// tools/android/assert-google-play-aab-clean.ps1 parses them out of this file at
    /// run time rather than keeping a second copy (the two copies had drifted before).
    /// Keep each array a plain string[] of simple literals, and keep the comments free
    /// of double quotes, or that parser will fail closed and the scanner will throw.
    /// WO-1754 added the fourth, <see cref="ExactIdentifierAllowlist"/>. It was THREE
    /// until 2026-09-15; the count is stated here only because the mirror parses a
    /// fixed set of array NAMES, and a new array nobody taught it about is exactly the
    /// drift this paragraph exists to prevent.
    ///
    /// WO-1754 also closed the CHUNK SEAM in <see cref="ScanStream"/>. That scan reads
    /// an entry in fixed-size chunks, and both the allowlist window and the printable
    /// run read context on BOTH sides of a hit, so a chunk edge used to truncate the
    /// very evidence that suppresses a false positive. See ScanStream for the rule.
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
            "cryptofthecount",
            // -- OWNER RULING 2026-09-15 (WO-1741): the vendored UniTask SOURCE PATHS. -----
            // WHAT UNITASK IS. UniTask is a general-purpose zero-allocation async/await
            // library for Unity (Cysharp). It is not crypto code, it has no wallet, chain,
            // token or payment surface, and it has nothing to do with Solana beyond WHERE ITS
            // FILES SIT ON DISK: the Solana SDK vendors it INSIDE its own package folder, so
            // every UniTask source path reads
            // Packages/com.solana.unity_sdk/Runtime/Plugins/UniTask/Runtime/<File>.cs.
            // Sixteen first-party asmdefs - DeNelle.Core and DeNelle.Village among them -
            // reference the UniTask assembly, so it compiles into the GOOGLE_PLAY player by
            // design, and IL2CPP writes each source file PATH into global-metadata.dat.
            //
            // WHY A VENDORED PATH STRING IS NOT A POLICY SURFACE. The token here is a
            // DIRECTORY NAME carried by a debug-metadata path, not a feature, not a string a
            // player or a reviewer can reach through the app, and not code that can talk to a
            // chain. Nothing in the artifact behaves differently for its presence. No build
            // callback can strip it either: the path is baked by IL2CPP from the file's
            // location on disk, so the only true removal is un-vendoring UniTask
            // (com.cysharp.unitask + dropping the SDK from the Play manifest), which needs a
            // manifest swap, a package resolve and a full recompile - see WO-1740 s5 Q1(i).
            // This entry is the owner's ruling of 2026-09-15 on that ceiling: allowlist the
            // UniTask paths, with the reason written down, rather than leave the Play lane
            // permanently red on a folder name.
            //
            // WHY IT IS SCOPED TO .../Plugins/UniTask AND NOT TO THE PACKAGE. MEASURED
            // 2026-09-15 by listing Packages/com.solana.unity_sdk/Runtime/: its children are
            // codebase/ (IWalletBase, InGameWallet, DeepLinkWallets, Metaplex) and Plugins/,
            // and UniTask's OWN SIBLINGS inside Plugins/ are SolanaWalletAdapterWebGL/ and
            // Web3AuthSDK/. Those are real crypto surfaces. An allowlist on the package - or
            // even on Runtime/Plugins/ - would suppress them too. Scoped as written, a leak
            // from any of them still fires, because IsAllowlistedOccurrence suppresses a hit
            // ONLY when the matched occurrence lies INSIDE the phrase below.
            //
            // The phrase contains exactly one forbidden token, 'solana'. It cannot mask a
            // second: 'Solana.Unity.' does not occur in it (the following character is an
            // underscore, not a dot), and no other entry of the vocabulary is a substring.
            // Both separators are listed because global-metadata.dat carries Windows-built
            // paths with backslashes while the same path appears forward-slashed elsewhere.
            "com.solana.unity_sdk/runtime/plugins/unitask",
            @"com.solana.unity_sdk\runtime\plugins\unitask",
            // -- WO-1754 (2026-09-15): Unity's PERFORMANCE-TEST BUILD RECEIPT. -------------
            // MEASURED in Builds/Android/rejected/EchoesOfElarion-GooglePlay-20260915-141458
            // .REJECTED.aab: the entry base/assets/bin/Data/437e022738512714fb6002270c4a6d2e
            // (3,648 bytes) is a PerformanceTestRunInfo blob written by
            // com.unity.test-framework.performance (Packages/manifest.json:33). It carries
            // exactly ONE solana occurrence, inside the resolved-package listing
            // Dependencies: [ com.solana.unity_sdk@1.2.9, com.unity.2d.sprite@1.0.0, ... ].
            //
            // WHY THIS IS THE SAME CLASS AS dependencies.pb. A resolved-manifest receipt
            // records which packages the RESOLVER saw, not which assemblies the PLAYER
            // contains - every Solana assembly and managed plugin is constrained
            // !GOOGLE_PLAY and InspectSourceIsolation above proves it. The gate already
            // skips BUNDLE-METADATA/com.unity/dependencies.pb by exact name at
            // ShouldSkipProvenanceEntry for precisely this reason.
            //
            // WHY AN ALLOWLIST PHRASE AND NOT A FILENAME SKIP. The receipt's NAME is a
            // per-build content hash - WO-1740 s2(D) saw the same receipt as 8db145c316dd...
            // - so a name-based skip would have to match bin/Data/<32 hex>, which is Unity's
            // GENERIC content-addressed asset naming. Skipping that class would blind the
            // gate to real shipped content, which is a weakening, not a fix. The phrase
            // below suppresses a single occurrence form instead.
            //
            // WHY THE TRAILING @ IS LOAD-BEARING. It binds the phrase to the package-VERSION
            // form only. A real leak reads com.solana.unity_sdk/ (a source or asset path) or
            // Solana.Unity. (a type name); neither contains this phrase, so neither is
            // suppressed. The phrase holds exactly one forbidden token, solana: the token
            // Solana.Unity. does not occur in it because the character after unity is an
            // underscore, not a dot, and no other vocabulary entry is a substring of it.
            //
            // THIS IS THE FALLBACK, NOT THE FIX. The root disposition is to drop
            // com.unity.test-framework.performance from the shipping manifest - a performance
            // TEST package has no business writing a receipt into a shipping player, and
            // grep -rn Unity.PerformanceTesting Assets returns nothing. That is a manifest
            // change outside this lane; see WO-1740 RCA 2026-09-15 item 2.
            "com.solana.unity_sdk@"
        };

        // OWNER-RULED IDENTIFIERS THAT MUST SHIP, suppressed by WHOLE-IDENTITY match only.
        //
        // WO-1754. This array exists because the phrase-containment rule in
        // FalsePositiveAllowlist above is too blunt for an IDENTIFIER. A phrase entry
        // reading SolanaWallet would also suppress the solana inside
        // SolanaWalletAdapterWebGL - a REAL crypto surface the UniTask comment above
        // explicitly says must keep firing - and that backstop cannot be delegated to the
        // walletadapter token, because MatchesTokenInPayload requires a LEADING word
        // boundary and the character before WalletAdapter in that identifier is the a of
        // Solana, so walletadapter never fires there. Verified by reading the matcher at
        // MatchesTokenInWindow below, not assumed.
        //
        // The rule here is therefore STRICTER: a hit is dropped only when the matched
        // occurrence lies inside an occurrence of the WHOLE string below that is itself
        // bounded by a NON-alphanumeric character on both sides - i.e. the identifier
        // stands alone in the payload. SolanaWalletAdapterWebGL fails that test on its
        // trailing A and keeps firing. See IsExactIdentifierAllowlisted.
        //
        // WHY NOT A NUL-BOUNDED PHRASE. IL2CPP packs these as NUL-terminated name-table
        // entries, so the precise scope is a NUL on each side. That cannot be written
        // here: tools/android/assert-google-play-aab-clean.ps1 parses these arrays with
        // the regex for a quoted run, and would read a backslash-zero escape as TWO
        // LITERAL CHARACTERS, giving the two scanners different vocabularies - the exact
        // duplicated-state drift the header paragraph forbids. The both-side
        // non-alphanumeric rule is expressible in BOTH scanners from plain literals, and
        // a NUL satisfies it, so it covers the name-table case without the escape.
        //
        // EACH ENTRY IS AN OWNER RULING, CITED. Nothing may be added here without one.
        // WO-1754 2026-09-15 remove-by 2026-12-15 - each entry below is an OWNER RULING that an
        // identifier may never be renamed, cited inline. Re-read then: if a ruling has been
        // withdrawn, or the identifier no longer exists, the entry goes rather than lingering as
        // a hiding place. NOT a convenience list - nothing is added here without a ruling.
        private static readonly string[] ExactIdentifierAllowlist =
        {
            // WO-1377, owner ruling 2026-09-09, recorded verbatim at
            // Assets/Editor/Regression/PlayMetadataIdentifierRegression.cs:41-51 under
            // RESIDUALS, ACCEPTED BY THE OWNER. PaymentChannel.SolanaDappStore is a live
            // un-ifdefd switch case in DeNelle.Core at
            // CurrencySkinResolver.ResolveWagerCurrency; the owner's Arena ruling is ONE
            // code path with the currency injected per channel, explicitly NOT a
            // GOOGLE_PLAY ifdef inside Arena, so compiling the member out would break that
            // switch on Play. The ruling's closing line: neither may be RENAMED or
            // REORDERED regardless. A gate that rejects an artifact for an identifier the
            // owner has ruled must stay is a gate contradicting canon.
            "SolanaDappStore",
            // Same ruling. SkinAuthMode.SolanaWallet is NAME-BOUND to shipped canonical
            // data - Assets/Resources/Data/Canonical/skin.json:30 carries the authoring
            // value SolanaWallet, read back through CurrencySkinResolver.ParseAuth - so the
            // identifier and the data string must stay spelled identically.
            "SolanaWallet",
            // WO-1366 section 4, recorded in code at
            // Assets/_Modules/Village/Arena/ArenaWalletService.cs:48-50: UNCHANGED on
            // purpose - a renamed key would read as a fresh 500 seed. This is a LIVE
            // PlayerPrefs save key on the revenue artifact, so a rename is a data-loss
            // change, not a spelling change. Holds the token skr at offset 12; the
            // surrounding characters are hyphens, so the whole-identity rule is what scopes
            // it, and no other vocabulary entry is a substring of it.
            "dotr-arena-skr-balance"
        };

        // Tokens the PLAY-NEUTRAL AUTHORING SWEEP polices that the ARTIFACT scan deliberately
        // does not. Bare 'wallet' is too common in engine/third-party binaries to be evidence
        // in an AAB entry, but in hand-authored catalog COPY it is exactly the word that must
        // not reach a Play shelf - MEASURED 2026-09-15: canon-strings storeBuyWalletRequired
        // reads 'need a connected wallet', which the artifact token 'connect wallet' does NOT
        // match ('connected' is not 'connect '). Kept here, beside the vocabulary it extends,
        // so the sweep still has ONE source of truth and not a second copy (WO-1740 s3).
        private static readonly string[] AuthoringOnlyTokens =
        {
            "wallet"
        };

        /// <summary>
        /// WO-1741. The ONE entry point the Play-neutral catalog sweep
        /// (<c>GooglePlayContentExclusion.ContainsForbiddenAuthoringToken</c>) uses, so the
        /// sweep consumes this class's vocabulary AND this class's matcher instead of keeping
        /// a third copy of the policy.
        ///
        /// It replaced a hand-maintained list that held <c>" skr"</c> WITH A LEADING SPACE,
        /// so a value STARTING with the token - canon-strings <c>storeBalanceUnavailable</c> =
        /// <c>SKR: unavailable in this build</c> - was never detected, its already-authored
        /// neutral replacement was never consulted, and the Seeker copy shipped in every Play
        /// AAB ever produced (WO-1739 s3b). Bare <c>skr</c> under the word-boundary rule here
        /// catches it.
        ///
        /// Text, not binary: <c>readableEntry: true</c>, so no printable-run corroboration is
        /// required and the documented false-positive suppressions still apply.
        /// </summary>
        public static bool ContainsForbiddenAuthoringToken(string value)
        {
            string text = value ?? string.Empty;
            if (text.Length == 0) return false;
            foreach (string token in ForbiddenTokens)
                if (MatchesTokenInPayload(text, token, readableEntry: true)) return true;
            foreach (string token in AuthoringOnlyTokens)
                if (MatchesTokenInPayload(text, token, readableEntry: true)) return true;
            return false;
        }

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

        // The scan chunk. Internal so the straddle regression derives its test offsets from
        // the implementation instead of hard-coding 65536 and going stale (WO-1754).
        internal const int ScanChunkSize = 64 * 1024;

        /// <summary>
        /// WO-1754. Characters of context a SINGLE hit can need on EITHER side before it can
        /// be judged: the longest token, the longest allowlist phrase (IsAllowlistedOccurrence
        /// searches hit +/- allow.Length, which the pre-WO-1754 overlap never accounted for at
        /// all), the printable-run reach, and headroom. Measured in CHARACTERS, not bytes,
        /// because both the Latin-1 and the UTF-16 view are indexed in characters.
        /// </summary>
        internal static int ScanMarginChars(string[] tokens)
        {
            int longestToken = 0;
            if (tokens != null)
                foreach (string t in tokens)
                    if (!string.IsNullOrEmpty(t) && t.Length > longestToken) longestToken = t.Length;

            int longestPhrase = 0;
            foreach (string a in FalsePositiveAllowlist)
                if (a != null && a.Length > longestPhrase) longestPhrase = a.Length;
            foreach (string a in ExactIdentifierAllowlist)
                if (a != null && a.Length > longestPhrase) longestPhrase = a.Length;

            return longestToken + longestPhrase + 4 * MinPrintableRunForShortTokens + 128;
        }

        /// <summary>
        /// WO-1754. Bytes carried forward across a chunk seam. SIX margins, not one, and the
        /// arithmetic is the whole point, so it is written down:
        ///
        /// A chunk decides only hits that have a full margin of context on both sides, and
        /// defers the rest. Its decision range is therefore [retainedChars - m - len,
        /// count - m - len), which must TILE with the next chunk's - no gap (a missed leak)
        /// and no overlap (a duplicate, and the seam false positive this fixes). The stream
        /// advances by ScanChunkSize bytes per chunk, so each chunk must be able to decide a
        /// full ScanChunkSize worth of positions IN BOTH VIEWS. The UTF-16 view holds half as
        /// many characters per byte, so it is the binding constraint: retain 6m bytes gives
        /// the UTF-16 view 3m characters of head, of which m is spent on left context, and
        /// leaves 2m - len characters of tiling slack against a stride of ScanChunkSize / 2.
        /// One margin of retention - what the pre-WO-1754 code kept - leaves NEGATIVE slack,
        /// which is why the old scanner re-judged the same bytes twice with half the context
        /// instead of judging them once with all of it.
        /// </summary>
        internal static int ScanRetainBytes(string[] tokens)
        {
            int retain = 6 * ScanMarginChars(tokens);
            if ((retain & 1) != 0) retain++;   // keep the UTF-16 view on one parity across chunks
            return retain;
        }

        /// <summary>
        /// WO-1754. Scan one entry in ScanChunkSize chunks WITHOUT letting a chunk edge decide
        /// anything. Measured defect this replaces: in the 2026-09-15 AAB the token crypto sat
        /// at offset 1,900,536 and its suppressing phrase cryptography ran to 1,900,547, while
        /// chunk 29 ended at 1,900,544 - so the phrase was cut three bytes short, the hit was
        /// recorded LIVE, and a clean artifact was rejected on a BCL type name. Because bundle
        /// content is hashed, those offsets move every build, so the defect presented as
        /// FLAKINESS: the same tree passing and failing on consecutive runs.
        ///
        /// Three distinct vectors, all three closed by the same decision-range rule:
        ///   (a) TAIL - a hit near the chunk end loses its RIGHT context, so the suppressing
        ///       phrase is truncated and the hit fires. Deferred now to the next chunk.
        ///   (b) HEAD - the retained bytes are re-scanned at the front of the next chunk, where
        ///       a hit whose phrase starts to its LEFT has that start cut off and fires, EVEN
        ///       THOUGH the previous chunk judged it correctly. A tail-only bound leaves this
        ///       open, which is why the fix is a range and not a right bound.
        ///   (c) FALSE TRAILING BOUNDARY - MatchesTokenInWindow treated the end of the TEXT as
        ///       a word end, and a chunk end is not a word end. Now passed in explicitly.
        ///
        /// Nothing here removes a token, a phrase or an entry from the scan: every byte of the
        /// entry is still judged exactly once, with MORE context than before, never less.
        /// </summary>
        internal static void ScanStream(Stream stream, string entryName, string[] tokens, bool readableEntry, List<string> hits)
        {
            if (stream == null || tokens == null || tokens.Length == 0 || hits == null) return;

            int marginChars = ScanMarginChars(tokens);
            int retainBytes = ScanRetainBytes(tokens);
            var buffer = new byte[ScanChunkSize + retainBytes];
            int retained = 0;
            bool firstChunk = true;

            while (true)
            {
                int read = ReadFully(stream, buffer, retained, ScanChunkSize);
                if (read <= 0)
                {
                    // The previous chunk deferred its tail and there is no next chunk to judge
                    // it. Without this pass an entry whose length is an exact multiple of
                    // ScanChunkSize silently drops its last margin of bytes - and
                    // globalgamemanagers.assets.split0 is exactly 1,048,576 bytes, 16 chunks
                    // with no remainder, in the very artifact this fix was measured on.
                    if (!firstChunk && retained > 0)
                        JudgeChunk(buffer, retained, entryName, tokens, readableEntry, hits,
                                   marginChars, retained, startIsStreamStart: false, endIsStreamEnd: true);
                    break;
                }

                int count = retained + read;
                bool finalChunk = read < ScanChunkSize;
                JudgeChunk(buffer, count, entryName, tokens, readableEntry, hits,
                           marginChars, retained, startIsStreamStart: firstChunk, endIsStreamEnd: finalChunk);
                if (finalChunk) break;

                retained = Math.Min(retainBytes, count);
                Buffer.BlockCopy(buffer, count - retained, buffer, 0, retained);
                firstChunk = false;
            }
        }

        /// <summary>
        /// Judge one buffered chunk in both views. Hits are SEARCHED across the whole chunk so
        /// context is read at full width, but only REPORTED inside the decision range, so each
        /// absolute position is judged by exactly one chunk - the one that holds its context.
        /// </summary>
        private static void JudgeChunk(byte[] buffer, int count, string entryName, string[] tokens,
                                       bool readableEntry, List<string> hits, int marginChars, int retainedBytes,
                                       bool startIsStreamStart, bool endIsStreamEnd)
        {
            if (count <= 0) return;

            string asciiText = Latin1(buffer, count);
            int utf16Chars = (count - (count % 2)) / 2;
            string utf16Text = utf16Chars > 0 ? Encoding.Unicode.GetString(buffer, 0, utf16Chars * 2) : string.Empty;

            foreach (string token in tokens)
            {
                if (string.IsNullOrEmpty(token)) continue;
                int len = token.Length;

                int asciiLo = startIsStreamStart ? 0 : Math.Max(0, retainedBytes - marginChars - len);
                int asciiHi = endIsStreamEnd ? asciiText.Length : asciiText.Length - marginChars - len;

                int utf16Lo = startIsStreamStart ? 0 : Math.Max(0, (retainedBytes / 2) - marginChars - len);
                int utf16Hi = endIsStreamEnd ? utf16Text.Length : utf16Text.Length - marginChars - len;

                if (MatchesTokenInWindow(asciiText, token, readableEntry, asciiLo, asciiHi, startIsStreamStart, endIsStreamEnd) ||
                    MatchesTokenInWindow(utf16Text, token, readableEntry, utf16Lo, utf16Hi, startIsStreamStart, endIsStreamEnd))
                    hits.Add($"content:{entryName} token:{token}");
            }
        }

        /// <summary>
        /// Stream.Read is allowed to return fewer bytes than asked for without being at the
        /// end. The seam rule reads a short read as END OF STREAM, so a partial read would
        /// have turned every deferred hit into an immediate one - reintroducing the very
        /// defect this change removes. Fill the chunk or prove EOF.
        /// </summary>
        private static int ReadFully(Stream stream, byte[] buffer, int offset, int count)
        {
            int total = 0;
            while (total < count)
            {
                int read = stream.Read(buffer, offset + total, count - total);
                if (read <= 0) break;
                total += read;
            }
            return total;
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
        internal static bool MatchesTokenInPayload(string text, string token, bool readableEntry) =>
            MatchesTokenInWindow(text, token, readableEntry,
                                 windowStart: 0, windowEnd: text?.Length ?? 0,
                                 textStartIsStreamStart: true, textEndIsStreamEnd: true);

        /// <summary>
        /// WO-1754. The matcher, with the two facts a chunked caller has and the text does not:
        /// WHICH occurrences this caller is responsible for deciding (windowStart..windowEnd),
        /// and whether the text's own edges are the STREAM's edges. Context - boundaries, the
        /// printable run, both allowlists - is still read across the WHOLE text, so a hit is
        /// judged with every byte the caller has; the window only decides which hits are this
        /// caller's to report. A whole-text caller passes the full window and both edges true,
        /// which is byte-for-byte the pre-WO-1754 behaviour.
        /// </summary>
        internal static bool MatchesTokenInWindow(string text, string token, bool readableEntry,
                                                  int windowStart, int windowEnd,
                                                  bool textStartIsStreamStart, bool textEndIsStreamEnd)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(token)) return false;
            if (windowStart < 0) windowStart = 0;
            if (windowEnd > text.Length) windowEnd = text.Length;
            if (windowStart >= windowEnd) return false;

            bool shortToken = !readableEntry && IsShortToken(token);
            int start = windowStart;
            while (start < windowEnd)
            {
                int hit = text.IndexOf(token, start, StringComparison.OrdinalIgnoreCase);
                if (hit < 0 || hit >= windowEnd) return false;
                start = hit + 1;

                bool needsLeadingBoundary = char.IsLetterOrDigit(token[0]);
                if (needsLeadingBoundary && hit != 0 && char.IsLetterOrDigit(text[hit - 1]))
                    continue;
                // Vector (c), leading half: the start of a mid-stream buffer is not a word
                // start. Unreachable while the caller keeps a full margin of head, and stated
                // anyway so the matcher's contract is honest for any caller.
                if (needsLeadingBoundary && hit == 0 && !textStartIsStreamStart) continue;

                if (shortToken)
                {
                    int after = hit + token.Length;
                    if (after < text.Length && char.IsLetterOrDigit(text[after])) continue;
                    // Vector (c): a chunk end is NOT a word end. Before WO-1754 a short token
                    // ending exactly at a chunk tail passed the trailing-boundary test no
                    // matter what the next byte was.
                    if (after >= text.Length && !textEndIsStreamEnd) continue;
                    if (!HasPrintableRun(text, hit, token.Length, MinPrintableRunForShortTokens)) continue;
                }

                if (IsAllowlistedOccurrence(text, hit, token)) continue;
                if (IsExactIdentifierAllowlisted(text, hit, token, textStartIsStreamStart, textEndIsStreamEnd)) continue;

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
        /// WO-1754. A character that can be part of a NAME in this artifact: a C# identifier,
        /// an addressable id, or a hyphen-separated PlayerPrefs save key. Used only by
        /// IsExactIdentifierAllowlisted, to decide whether a ruled identifier STANDS ALONE or
        /// is merely the prefix of a longer one.
        /// </summary>
        private static bool IsIdentifierChar(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '-';

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

        /// <summary>
        /// WO-1754. True when this occurrence lies inside a STANDALONE occurrence of an
        /// owner-ruled identifier: the whole entry must be present AND bounded by a
        /// NON-IDENTIFIER character on both sides, so a longer name that merely STARTS with
        /// it is not suppressed. SolanaWalletAdapterWebGL fails on its trailing A and keeps
        /// firing; a NUL-packed name-table entry passes, because NUL is not an identifier
        /// character. That is how this rule reaches the IL2CPP metadata case without a
        /// backslash-zero escape the PowerShell mirror could not parse.
        ///
        /// ⛔ IDENTIFIER CHARACTER, NOT ALPHANUMERIC - the difference was MEASURED, not
        /// styled. A plain alphanumeric test reads the hyphen in dotr-arena-skr-balance-v2
        /// as a boundary and suppresses that key too, because the ruled key is a prefix of
        /// it and a hyphen is not a letter. Save keys and asset ids in this project are
        /// hyphen-separated, so that is a live shape, not a hypothetical. Hyphen and
        /// underscore therefore COUNT as identifier characters and end the match; the dot
        /// deliberately does not, so a fully-qualified reference to the ruled member is
        /// still the ruled member.
        ///
        /// An edge of the TEXT counts as a boundary only when it is an edge of the STREAM -
        /// otherwise the identifier might continue into bytes this caller cannot see, and a
        /// chunk seam would once again decide a question it has no evidence for. A hit that
        /// cannot be judged here simply is not suppressed here: the caller's decision range
        /// gives that position to the chunk that holds the whole identifier.
        /// </summary>
        internal static bool IsExactIdentifierAllowlisted(string text, int hit, string token,
                                                          bool textStartIsStreamStart, bool textEndIsStreamEnd)
        {
            foreach (string identifier in ExactIdentifierAllowlist)
            {
                if (string.IsNullOrEmpty(identifier)) continue;
                if (identifier.IndexOf(token, StringComparison.OrdinalIgnoreCase) < 0) continue;

                int windowStart = Math.Max(0, hit - identifier.Length);
                int windowEnd = Math.Min(text.Length, hit + token.Length + identifier.Length);
                int found = text.IndexOf(identifier, windowStart, windowEnd - windowStart, StringComparison.OrdinalIgnoreCase);
                while (found >= 0)
                {
                    bool containsHit = found <= hit && found + identifier.Length >= hit + token.Length;
                    if (containsHit)
                    {
                        int before = found - 1;
                        int after = found + identifier.Length;
                        bool leftClear = before < 0 ? textStartIsStreamStart : !IsIdentifierChar(text[before]);
                        bool rightClear = after >= text.Length ? textEndIsStreamEnd : !IsIdentifierChar(text[after]);
                        if (leftClear && rightClear) return true;
                    }
                    int next = found + 1;
                    if (next >= windowEnd) break;
                    found = text.IndexOf(identifier, next, windowEnd - next, StringComparison.OrdinalIgnoreCase);
                }
            }
            return false;
        }

        private static string Read(string path) => File.Exists(path) ? File.ReadAllText(path) : string.Empty;
    }
}
