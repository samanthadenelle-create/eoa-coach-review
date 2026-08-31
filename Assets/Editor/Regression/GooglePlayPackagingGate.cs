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
    /// </summary>
    public static class GooglePlayPackagingGate
    {
        // Readable player/content payloads: policy vocabulary itself is relevant.
        private static readonly string[] UserFacingContentTokens =
        {
            "solana", "mobilewalletadapter", "mobile_wallet_adapter", "defenders/mwa/",
            "jupiter", "jup.ag", "skrvaluation", "walletadapter", "solana-wallet",
            "phantom wallet", "app.phantom", "solflare", "seed vault", "connect wallet",
            "$skr", "spend $skr", "skr is a real", "stake.solanamobile",
            "usdc", "blockchain", "crypto", "web3",
            "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
            "3BwWSAUZmyngXDSZiCawEnP7iLgY5ANNopBDz94AB77N"
        };

        // Opaque executable/native/Unity metadata: broad substrings such as "crypto"
        // match System.Security.Cryptography and ad/network dependencies. Require a
        // high-signal wallet/SDK identifier instead.
        private static readonly string[] OpaqueExecutableTokens =
        {
            "mobilewalletadapter", "mobile_wallet_adapter", "defenders/mwa/",
            "walletadapter", "solana-wallet", "phantom wallet", "app.phantom",
            "solflare", "seed vault", "connect wallet", "stake.solanamobile",
            "skr is a real", "spend $skr",
            "Solana.Unity.",
            "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
            "3BwWSAUZmyngXDSZiCawEnP7iLgY5ANNopBDz94AB77N"
        };

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

                    // Unity records resolved package provenance here even when every SDK
                    // assembly/plugin is excluded from the player. Executable leakage is
                    // proven by the opaque tier in actual player entries, not by this receipt.
                    if (ShouldSkipProvenanceEntry(entry.FullName))
                        continue;

                    foreach (string token in tokens)
                        if (MatchesTokenForAudit(name, token)) hits.Add($"entry:{entry.FullName} token:{token}");

                    using (var stream = entry.Open())
                        ScanStream(stream, entry.FullName, tokens, hits);
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

        internal static string[] TokensForEntry(string entryName) =>
            IsUserFacingContentEntry(entryName) ? UserFacingContentTokens : OpaqueExecutableTokens;

        internal static bool ShouldSkipProvenanceEntry(string entryName) =>
            string.Equals((entryName ?? string.Empty).Replace('\\', '/'),
                "BUNDLE-METADATA/com.unity/dependencies.pb", StringComparison.OrdinalIgnoreCase);

        private static void ScanStream(Stream stream, string entryName, string[] tokens, List<string> hits)
        {
            const int chunkSize = 64 * 1024;
            int overlap = tokens.Max(t => Encoding.Unicode.GetByteCount(t));
            if ((overlap & 1) != 0) overlap++;
            var buffer = new byte[chunkSize + overlap];
            int retained = 0;

            while (true)
            {
                int read = stream.Read(buffer, retained, chunkSize);
                if (read <= 0) break;
                int count = retained + read;
                string asciiText = Encoding.ASCII.GetString(buffer, 0, count);
                string utf16Text = Encoding.Unicode.GetString(buffer, 0, count - (count % 2));

                foreach (string token in tokens)
                {
                    if (MatchesTokenForAudit(asciiText, token) ||
                        MatchesTokenForAudit(utf16Text, token))
                        hits.Add($"content:{entryName} token:{token}");
                }

                retained = Math.Min(overlap, count);
                Buffer.BlockCopy(buffer, count - retained, buffer, 0, retained);
            }
        }

        internal static bool MatchesTokenForAudit(string text, string token)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(token)) return false;
            int start = 0;
            while (start < text.Length)
            {
                int hit = text.IndexOf(token, start, StringComparison.OrdinalIgnoreCase);
                if (hit < 0) return false;
                bool needsLeadingBoundary = char.IsLetterOrDigit(token[0]);
                if (!needsLeadingBoundary || hit == 0 || !char.IsLetterOrDigit(text[hit - 1]))
                    return true;
                start = hit + 1;
            }
            return false;
        }

        private static string Read(string path) => File.Exists(path) ? File.ReadAllText(path) : string.Empty;
    }
}
