// =============================================================================
// Battle difficulty scaling — C# port of src/data/battleScaling.ts
// -----------------------------------------------------------------------------
// Single source of truth for how hard the endless wave loop gets. The ATB
// engine imports waveScaling / isBossWave / bossHpMul. Every function is pure.
// =============================================================================

using System;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>The full difficulty profile for a wave. Not mutated — a struct.</summary>
    public struct WaveScaling
    {
        /// <summary>Enemies released this wave (boss waves ignore this).</summary>
        public int EnemyCount;
        /// <summary>Multiplier on every enemy's max HP.</summary>
        public double HpMul;
        /// <summary>Multiplier on enemy movement speed.</summary>
        public double SpeedMul;
        /// <summary>Multiplier on the Heart damage each enemy hit deals.</summary>
        public double HeartDmgMul;
    }

    /// <summary>Endless-wave difficulty curve.</summary>
    public static class BattleScaling
    {
        /// <summary>A boss leads every Nth wave.</summary>
        public const int BOSS_EVERY = 6;

        /// <summary>Wave 1 enemies move slower — a gentle on-ramp.</summary>
        private const double FIRST_WAVE_SPEED_MUL = 0.85;

        /// <summary>True when wave N is led by a boss (every BOSS_EVERY waves).</summary>
        public static bool IsBossWave(int wave)
        {
            return wave > 0 && wave % BOSS_EVERY == 0;
        }

        /// <summary>1 for the first boss (wave 6), 2 for the second (wave 12), etc.</summary>
        public static int BossOrdinal(int wave)
        {
            return Math.Max(1, (int)Math.Floor(wave / (double)BOSS_EVERY));
        }

        /// <summary>HP multiplier for the boss leading wave N — +60% per successive boss.</summary>
        public static double BossHpMul(int wave)
        {
            return 1 + 0.6 * (BossOrdinal(wave) - 1);
        }

        /// <summary>The full difficulty profile for wave N.</summary>
        public static WaveScaling WaveScaling(int wave)
        {
            int w = Math.Max(1, (int)Math.Floor((double)wave));
            int steps = w - 1;
            return new WaveScaling
            {
                EnemyCount = w <= 1 ? 8 : Math.Min(8 + steps * 2, 12),
                HpMul = 1 + 0.16 * steps,
                SpeedMul = w <= 1 ? FIRST_WAVE_SPEED_MUL : Math.Min(1 + 0.012 * steps, 1.28),
                HeartDmgMul = 1 + 0.05 * steps,
            };
        }
    }
}
