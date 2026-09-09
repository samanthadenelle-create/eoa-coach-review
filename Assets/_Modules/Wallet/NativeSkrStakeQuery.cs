// =============================================================================
// NativeSkrStakeQuery - logged-in wallet -> public SKR staking accounts (read-only)
// -----------------------------------------------------------------------------
// Source contract: Solana Mobile's official react-native-samples/skr-staking sample.
// The logged-in MWA address is only the lookup key. No signature, token movement, or
// custody occurs. The program/account constants and PDA seeds below match that sample.
// =============================================================================

using System;
using System.Numerics;
using System.Text;
using Cysharp.Threading.Tasks;
using DeNelle.Core.Diagnostics;
using DeNelle.Core.Platform;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Types;
using Solana.Unity.Wallet;
using UnityEngine;

namespace DeNelle.Wallet
{
    /// <summary>Cached synchronous facade over an asynchronous, read-only mainnet account query.</summary>
    public sealed class NativeSkrStakeQuery : IStakeQuery
    {
        public const string ProgramAddress = "SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ";
        public const string StakeConfigAddress = "4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw";
        public const string GuardianPoolAddress = "DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr";
        private const long SharePriceScale = 1_000_000_000L;
        private const long SkrBaseUnits = 1_000_000L;
        private static readonly byte[] UserStakeDiscriminator = { 102, 53, 163, 107, 9, 138, 87, 153 };
        private static readonly byte[] StakeConfigDiscriminator = { 238, 151, 43, 3, 11, 151, 63, 176 };

        private long _activeStake;
        private bool _known;

        public bool TryGetActiveStake(out long stakedSkr)
        {
            stakedSkr = _activeStake;
            return _known;
        }

        public async UniTask RefreshAsync(string walletAddress)
        {
            walletAddress = (walletAddress ?? string.Empty).Trim();
            if (walletAddress.Length == 0) return;
            try
            {
                var program = new PublicKey(ProgramAddress);
                var config = new PublicKey(StakeConfigAddress);
                var user = new PublicKey(walletAddress);
                var guardian = new PublicKey(GuardianPoolAddress);
                if (!PublicKey.TryFindProgramAddress(
                        new[] { Encoding.UTF8.GetBytes("user_stake"), config.KeyBytes, user.KeyBytes, guardian.KeyBytes },
                        program, out PublicKey userStake, out _))
                    throw new InvalidOperationException("could not derive UserStake PDA");

                IRpcClient rpc = ClientFactory.GetClient(WalletEndpoints.MainnetRpcUrl);
                var configResult = await rpc.GetAccountInfoAsync(config.Key, Commitment.Confirmed);
                if (configResult == null || !configResult.WasSuccessful || configResult.Result?.Value?.Data?[0] == null)
                    throw new InvalidOperationException("stake config account was unavailable");

                byte[] configData = Convert.FromBase64String(configResult.Result.Value.Data[0]);
                RequireDiscriminator(configData, StakeConfigDiscriminator, "StakeConfig");
                // Anchor discriminator (8), bump (1), three pubkeys (96), two u64 (16), total_shares u128 (16).
                BigInteger sharePrice = ReadU128(configData, 137);

                var userResult = await rpc.GetAccountInfoAsync(userStake.Key, Commitment.Confirmed);
                long active = 0;
                if (userResult != null && userResult.WasSuccessful && userResult.Result?.Value?.Data?[0] != null)
                {
                    byte[] userData = Convert.FromBase64String(userResult.Result.Value.Data[0]);
                    RequireDiscriminator(userData, UserStakeDiscriminator, "UserStake");
                    // Anchor discriminator (8), bump (1), stake_config/user/guardian pubkeys (96).
                    BigInteger shares = ReadU128(userData, 105);
                    BigInteger rawTokens = shares * sharePrice / SharePriceScale;
                    BigInteger wholeSkr = rawTokens / SkrBaseUnits;
                    active = wholeSkr > long.MaxValue ? long.MaxValue : (long)wholeSkr;
                }

                bool changed = !_known || _activeStake != active;
                _activeStake = Math.Max(0, active);
                _known = true;
                FlowTrace.Step("Stake", $"official SKR program read for logged-in wallet: active={_activeStake:N0} SKR, " +
                                        $"userStake={userStake.Key}; read-only, no signature requested.");
                if (changed) StakeRewardsResolver.NotifyStakeChanged();
            }
            catch (Exception ex)
            {
                _known = false;
                _activeStake = 0;
                FlowTrace.Warn("Stake", "native SKR stake read failed closed: " + ex.Message +
                                        ". No Jeweler re-roll was granted.");
                StakeRewardsResolver.NotifyStakeChanged();
            }
        }

        private static BigInteger ReadU128(byte[] data, int offset)
        {
            if (data == null || data.Length < offset + 16)
                throw new InvalidOperationException("staking account was shorter than its official IDL layout");
            var unsignedLittleEndian = new byte[17];
            Buffer.BlockCopy(data, offset, unsignedLittleEndian, 0, 16);
            return new BigInteger(unsignedLittleEndian);
        }

        private static void RequireDiscriminator(byte[] data, byte[] expected, string accountName)
        {
            if (data == null || data.Length < expected.Length)
                throw new InvalidOperationException(accountName + " account data was missing");
            for (int i = 0; i < expected.Length; i++)
                if (data[i] != expected[i])
                    throw new InvalidOperationException(accountName + " discriminator did not match the official IDL");
        }
    }

    internal sealed class NativeSkrStakeQueryDriver : MonoBehaviour
    {
        private NativeSkrStakeQuery _query;
        private string _wallet;
        private float _nextRefresh;
        private bool _refreshing;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Bootstrap()
        {
            var go = new GameObject("[NativeSkrStakeQuery]");
            DontDestroyOnLoad(go);
            go.AddComponent<NativeSkrStakeQueryDriver>();
        }

        private void Awake()
        {
            _query = new NativeSkrStakeQuery();
            StakeRewardsResolver.Query = _query;
        }

        private void Update()
        {
            if (_refreshing || Time.unscaledTime < _nextRefresh) return;
            string current = WalletPreferenceStore.CurrentSessionWalletAddress;
            if (string.IsNullOrWhiteSpace(current))
            {
                _nextRefresh = Time.unscaledTime + 2f;
                return;
            }
            if (!string.Equals(current, _wallet, StringComparison.Ordinal) || Time.unscaledTime >= _nextRefresh)
                Refresh(current).Forget();
        }

        private async UniTaskVoid Refresh(string wallet)
        {
            _refreshing = true;
            _wallet = wallet;
            await _query.RefreshAsync(wallet);
            _nextRefresh = Time.unscaledTime + 300f;
            _refreshing = false;
        }
    }
}
