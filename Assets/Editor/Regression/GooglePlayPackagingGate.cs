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
        private static readonly string[] ForbiddenArtifactTokens =
        {
            "solana", "mobilewalletadapter", "mobile_wallet_adapter", "mwa/",
            "jupiter", "jup.ag", "skrvaluation", "walletadapter", "solana-wallet",
            "phantom", "solflare", "seed vault", "connect wallet",
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

            if (!wallet.Contains("!GOOGLE_PLAY"))
                failures.Add("DeNelle.Wallet has no !GOOGLE_PLAY assembly constraint.");
            if (!web3.Contains("!GOOGLE_PLAY"))
                failures.Add("DeNelle.Web3 has no !GOOGLE_PLAY assembly constraint.");
            if (village.Contains("\"DeNelle.Wallet\""))
                failures.Add("DeNelle.Village directly references DeNelle.Wallet; excluding Wallet would break the player compile. Split the rail-neutral store/grants first.");

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
                    foreach (string token in ForbiddenArtifactTokens)
                        if (name.Contains(token)) hits.Add($"entry:{entry.FullName} token:{token}");

                    using (var stream = entry.Open())
                        ScanStream(stream, entry.FullName, hits);
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

        private static void ScanStream(Stream stream, string entryName, List<string> hits)
        {
            const int chunkSize = 64 * 1024;
            int overlap = ForbiddenArtifactTokens.Max(t => Encoding.Unicode.GetByteCount(t));
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

                foreach (string token in ForbiddenArtifactTokens)
                {
                    if (asciiText.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        utf16Text.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                        hits.Add($"content:{entryName} token:{token}");
                }

                retained = Math.Min(overlap, count);
                Buffer.BlockCopy(buffer, count - retained, buffer, 0, retained);
            }
        }

        private static string Read(string path) => File.Exists(path) ? File.ReadAllText(path) : string.Empty;
    }
}
