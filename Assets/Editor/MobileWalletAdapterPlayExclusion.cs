// =============================================================================
// MobileWalletAdapterPlayExclusion — WO-1282 Lane B. Keeps the Solana Mobile
// Wallet Adapter Android Library Project OUT of a GOOGLE_PLAY artifact, and IN
// the DAPP_STORE (Seeker) artifact, from ONE declaration.
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL
// GooglePlayPackagingGate.InspectSourceIsolation() refuses to build the Play AAB
// while "Assets/Plugins/Android/MobileWalletAdapter.androidlib.meta" carries no
// Play exclusion. That check is a SUBSTRING test, so it can be satisfied by text
// Unity ignores — which would leave the wallet rail inside an artifact bound for
// Play review while every marker went green. This file therefore does NOT write
// the meta by hand: it configures the importer THROUGH THE API, and then ENFORCES
// that configuration itself at build time.
//
// ⛔ THE MECHANISM, AND THE EVIDENCE FOR IT (§12 — do not "simplify" this away)
//
// 1. An .androidlib IS a PluginImporter asset, not a plain folder. PROOF from a
//    first-party Unity package in this very project's PackageCache:
//      Library/PackageCache/com.unity.mobile.notifications@53b584f4d5cd/
//        Runtime/Android/Plugins/mobilenotifications.androidlib.meta
//    — it carries a full "PluginImporter:" block with "defineConstraints: []" and
//    a platformData row "Android: Android / enabled: 1". So
//    AssetImporter.GetAtPath(...) as PluginImporter resolves, and both
//    DefineConstraints and platform compatibility are real, serialized state.
//    (Our three .androidlib metas are BARE — fileFormatVersion + guid only —
//    because nothing has ever changed an importer setting on them. Unity writes
//    the block on the first SaveAndReimport; that is what Configure() does.)
//
// 2. Define constraints ALONE are NOT trustworthy for this asset class. Unity's
//    own issue tracker records "Define Constraints are available for Native
//    Plugins even though they only work for Managed Plugins", and
//    UnityEditor.Android.Extensions.dll does NOT reference the internal
//    PluginImporter.IsCompatibleWithDefines binding at all (that string appears
//    only in Managed/UnityEditor.dll and UnityEditor.CoreModule.dll — verified by
//    scanning the 6000.4.8f1 install). It DOES reference GetCompatiblePlugins,
//    which per UnityCsReference's DefaultPluginImporterExtension filters on
//    DefineConstraintsHelper.IsDefineConstraintsCompatible — so the constraint
//    MIGHT be honoured natively for an androidlib. "Might" is not a gate.
//
// 3. PLATFORM COMPATIBILITY is not ambiguous. PluginImporter.GetImporters(target)
//    returns only importers compatible with that target, so a plugin marked
//    incompatible with Android never reaches the Gradle project the Android
//    extension generates. That is the layer this file leans on.
//
// So: the .meta DECLARES the rule (DefineConstraints = ["!GOOGLE_PLAY"]) and this
// file's BuildPlayerProcessor ENFORCES it by READING that same declaration off the
// importer and flipping Android compatibility off for the one build whose defines
// fail it. The string the gate greps is the string the enforcer obeys — it cannot
// go decorative. If Unity also honours the constraint natively, both agree.
//
// ⛔ SEEKER SAFETY — the failure mode that would be WORSE than the one we close.
// A Seeker/dApp-Store build must still carry the wallet. Three guarantees:
//   a. State is DERIVED on every Android build from that build's defines, never
//      toggled blind — a Seeker build re-asserts "compatible" whatever it found.
//   b. OnPostprocessBuild restores the committed default (Android = true).
//   c. If a build dies between the two, RepairAfterInterruptedBuild() restores it
//      on the next editor domain load and says so LOUDLY.
// The committed meta therefore always reads Android-compatible; a Play build is
// the only moment it is not, and only in memory + a transient reimport.
//
// Run: Defenders > Build > Configure MWA Play Exclusion
//   or headless -executeMethod DeNelle.Editor.MobileWalletAdapterPlayExclusion.Configure
// EDITOR-ONLY. Idempotent. Does not build, does not commit.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace DeNelle.Editor
{
    /// <summary>
    /// Owns the per-artifact inclusion of <c>MobileWalletAdapter.androidlib</c>:
    /// declares <c>!GOOGLE_PLAY</c> on the plugin importer, and enforces that
    /// declaration during the Android build by platform compatibility.
    /// </summary>
    public static class MobileWalletAdapterPlayExclusion
    {
        /// <summary>The Android Library Project that carries the Solana Mobile Wallet Adapter.
        /// A folder path — an .androidlib is imported as a PluginImporter folder asset.</summary>
        public const string PluginPath = "Assets/Plugins/Android/MobileWalletAdapter.androidlib";

        /// <summary>The single define constraint written to the importer. Read back by the
        /// build processor, so this string is load-bearing in BOTH directions: it is what
        /// GooglePlayPackagingGate greps for, and what decides the build-time exclusion.</summary>
        public const string PlayExclusionConstraint = "!GOOGLE_PLAY";

        private const string LogTag = "[MWAPlayExclusion]";

        /// <summary>Set while a build has the plugin deliberately excluded, so the
        /// domain-reload repair does not fight an in-flight build.</summary>
        private const string ExclusionActiveKey = "MobileWalletAdapterPlayExclusion.Active";

        // -------------------------------------------------------------------------
        // Configuration (one-shot, idempotent)
        // -------------------------------------------------------------------------

        [MenuItem("Defenders/Build/Configure MWA Play Exclusion")]
        public static void Configure()
        {
            var importer = ResolveImporter();
            if (importer == null)
                return;

            string[] wanted = { PlayExclusionConstraint };
            string[] current = importer.DefineConstraints ?? Array.Empty<string>();

            bool constraintsMatch = current.Length == wanted.Length &&
                                    current.SequenceEqual(wanted, StringComparer.Ordinal);
            bool androidOn = importer.GetCompatibleWithPlatform(BuildTarget.Android);

            if (constraintsMatch && androidOn)
            {
                Debug.Log($"{LogTag} MWA_PLAY_EXCLUSION_CONFIGURED (no-op) — {PluginPath} already " +
                          $"declares [{string.Join(", ", current)}] and is Android-compatible.");
                return;
            }

            importer.DefineConstraints = wanted;

            // An Android Library Project is Android-only by construction; make that explicit so
            // the build-time toggle has a single, unambiguous axis to move. "Any platform" must
            // be off or per-platform compatibility is ignored.
            importer.SetCompatibleWithAnyPlatform(false);
            importer.SetCompatibleWithPlatform(BuildTarget.Android, true);

            importer.SaveAndReimport();

            Debug.Log($"{LogTag} MWA_PLAY_EXCLUSION_CONFIGURED — wrote defineConstraints " +
                      $"[{string.Join(", ", wanted)}] and Android=true onto {PluginPath}. " +
                      "Unity has re-serialized the .meta in its own format; commit it. " +
                      "The constraint is ENFORCED by MobileWalletAdapterPlayExclusionBuildProcessor, " +
                      "not assumed — see this file's header.");
        }

        // -------------------------------------------------------------------------
        // Enforcement
        // -------------------------------------------------------------------------

        /// <summary>
        /// Derives — never toggles — the plugin's Android compatibility from the define set
        /// this build will compile with, evaluated against the importer's OWN DefineConstraints.
        /// Returns true when the plugin is included, false when it is excluded.
        /// </summary>
        internal static bool ApplyForDefines(IReadOnlyList<string> defines)
        {
            var importer = ResolveImporter();
            if (importer == null)
                return true;

            string[] constraints = importer.DefineConstraints ?? Array.Empty<string>();
            bool include = ConstraintsSatisfied(constraints, defines);

            bool anyPlatform = importer.GetCompatibleWithAnyPlatform();
            bool androidNow = importer.GetCompatibleWithPlatform(BuildTarget.Android);

            if (anyPlatform || androidNow != include)
            {
                importer.SetCompatibleWithAnyPlatform(false);
                importer.SetCompatibleWithPlatform(BuildTarget.Android, include);
                importer.SaveAndReimport();
            }

            string verdict = include ? "INCLUDED" : "EXCLUDED";
            Debug.Log($"{LogTag} MWA_PLUGIN_{verdict} — {PluginPath}; " +
                      $"constraints=[{string.Join(", ", constraints)}]; " +
                      $"defines=[{string.Join(", ", defines ?? Array.Empty<string>())}]. " +
                      "Android compatibility is now " + include + ".");

            SessionState.SetBool(ExclusionActiveKey, !include);
            return include;
        }

        /// <summary>Restores the committed default: Android-compatible. Deterministic, so it
        /// repairs an interrupted Play build as well as ending a successful one.</summary>
        internal static void RestoreDefault(string reason)
        {
            var importer = ResolveImporter();
            SessionState.SetBool(ExclusionActiveKey, false);
            if (importer == null)
                return;

            if (!importer.GetCompatibleWithAnyPlatform() &&
                importer.GetCompatibleWithPlatform(BuildTarget.Android))
                return;

            importer.SetCompatibleWithAnyPlatform(false);
            importer.SetCompatibleWithPlatform(BuildTarget.Android, true);
            importer.SaveAndReimport();

            Debug.Log($"{LogTag} MWA_PLUGIN_RESTORED — {PluginPath} is Android-compatible again ({reason}).");
        }

        /// <summary>
        /// A Play build that dies between preprocess and postprocess would leave the plugin
        /// marked Android-incompatible in a TRACKED .meta — which would silently strip the
        /// wallet from the next Seeker APK. That is worse than the gap this WO closes, so the
        /// repair runs on every domain load and is deliberately loud.
        /// </summary>
        [InitializeOnLoadMethod]
        private static void ScheduleRepairAfterInterruptedBuild()
        {
            // The asset database is not guaranteed usable during InitializeOnLoad, and a null
            // importer there would read as "nothing to repair" — a silent miss on exactly the
            // case this guard exists for. Defer one editor tick so GetAtPath is meaningful.
            EditorApplication.delayCall += RepairAfterInterruptedBuild;
        }

        private static void RepairAfterInterruptedBuild()
        {
            if (SessionState.GetBool(ExclusionActiveKey, false))
                return; // A build in this editor session owns the state right now.

            var importer = AssetImporter.GetAtPath(PluginPath) as PluginImporter;
            if (importer == null)
                return;

            if (importer.GetCompatibleWithPlatform(BuildTarget.Android) &&
                !importer.GetCompatibleWithAnyPlatform())
                return;

            Debug.LogWarning($"{LogTag} MWA_PLUGIN_REPAIRED — {PluginPath} was left " +
                             "Android-INCOMPATIBLE outside a build (an interrupted GOOGLE_PLAY build, " +
                             "or a stale commit). Restoring it: a Seeker/dApp-Store APK MUST ship the " +
                             "Mobile Wallet Adapter. Re-check the .meta before committing.");
            RestoreDefault("interrupted-build repair");
        }

        // -------------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------------

        /// <summary>
        /// Unity define-constraint semantics: every entry must hold (logical AND); an entry is
        /// either <c>SYMBOL</c> (must be defined) or <c>!SYMBOL</c> (must not be defined).
        /// Anything richer is REFUSED rather than guessed — a mis-evaluated constraint here
        /// ships a wallet into Play review.
        /// </summary>
        internal static bool ConstraintsSatisfied(IReadOnlyList<string> constraints, IReadOnlyList<string> defines)
        {
            if (constraints == null || constraints.Count == 0)
                return true;

            var defined = new HashSet<string>(defines ?? Array.Empty<string>(), StringComparer.Ordinal);

            foreach (string raw in constraints)
            {
                string entry = (raw ?? string.Empty).Trim();
                if (entry.Length == 0)
                    continue;

                bool negated = entry[0] == '!';
                string symbol = negated ? entry.Substring(1).Trim() : entry;

                if (symbol.Length == 0 || symbol.Any(c => !char.IsLetterOrDigit(c) && c != '_'))
                {
                    string message = $"{LogTag} UNSUPPORTED_DEFINE_CONSTRAINT '{raw}' on {PluginPath}. " +
                                     "This enforcer understands only 'SYMBOL' and '!SYMBOL'. Refusing the " +
                                     "build rather than guessing — a wrong answer here puts the Solana " +
                                     "wallet rail inside a Google Play artifact.";
                    Debug.LogError(message);
                    throw new BuildFailedException(message);
                }

                if (defined.Contains(symbol) == negated)
                    return false;
            }

            return true;
        }

        private static PluginImporter ResolveImporter()
        {
            var asset = AssetImporter.GetAtPath(PluginPath);
            if (asset == null)
            {
                Debug.LogError($"{LogTag} MWA_PLUGIN_MISSING — no asset importer at '{PluginPath}'. " +
                               "The Mobile Wallet Adapter Android Library Project is absent or renamed; " +
                               "GooglePlayPackagingGate's fourth condition is meaningless until it is back.");
                return null;
            }

            if (!(asset is PluginImporter importer))
            {
                Debug.LogError($"{LogTag} MWA_PLUGIN_WRONG_IMPORTER — '{PluginPath}' imported as " +
                               $"{asset.GetType().Name}, not PluginImporter. An Android Library Project " +
                               "must import as a PluginImporter for platform exclusion to exist at all; " +
                               "check the folder still ends in '.androidlib' and reimport it.");
                return null;
            }

            return importer;
        }

        /// <summary>The full define set a player build compiles with: the Android player defines
        /// from PlayerSettings plus the per-artifact extras BuildPlayerOptions carries
        /// (AndroidBuild stamps GOOGLE_PLAY / DAPP_STORE there, not in PlayerSettings).</summary>
        internal static string[] ComposeBuildDefines(string[] extraScriptingDefines)
        {
            string configured = PlayerSettings.GetScriptingDefineSymbols(NamedBuildTarget.Android) ?? string.Empty;

            return configured
                .Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(value => value.Trim())
                .Concat((extraScriptingDefines ?? Array.Empty<string>()).Select(value => (value ?? string.Empty).Trim()))
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
        }
    }

    /// <summary>
    /// Applies <see cref="MobileWalletAdapterPlayExclusion"/> before the player is built.
    /// BuildPlayerProcessor is used rather than IPreprocessBuildWithReport because it is the
    /// only build hook that exposes <c>BuildPlayerOptions.extraScriptingDefines</c> — and
    /// GOOGLE_PLAY lives there, not in PlayerSettings (AndroidBuild.ArtifactScriptingDefines).
    /// </summary>
    public sealed class MobileWalletAdapterPlayExclusionBuildProcessor : BuildPlayerProcessor
    {
        // Early: the plugin set must be settled before the Android Gradle project is generated.
        public override int callbackOrder => -1000;

        public override void PrepareForBuild(BuildPlayerContext context)
        {
            BuildPlayerOptions options = context.BuildPlayerOptions;
            if (options.target != BuildTarget.Android)
                return;

            string[] defines = MobileWalletAdapterPlayExclusion.ComposeBuildDefines(options.extraScriptingDefines);
            MobileWalletAdapterPlayExclusion.ApplyForDefines(defines);
        }
    }

    /// <summary>Returns the importer to its committed default after the build, so the tracked
    /// .meta never carries a transient exclusion.</summary>
    public sealed class MobileWalletAdapterPlayExclusionRestore : IPostprocessBuildWithReport
    {
        public int callbackOrder => 1000;

        public void OnPostprocessBuild(BuildReport report)
        {
            if (report != null && report.summary.platform != BuildTarget.Android)
                return;

            MobileWalletAdapterPlayExclusion.RestoreDefault("post-build");
        }
    }
}
