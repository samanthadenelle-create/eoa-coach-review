// =============================================================================
// ATB Battle Engine — BattleScaling tests (EditMode)
// =============================================================================

using NUnit.Framework;
using DeNelle.BattleATB.Engine;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class BattleScalingTest
    {
        [Test]
        public void is_boss_wave_true_only_on_multiples_of_boss_every()
        {
            Assert.That(BattleScaling.IsBossWave(0), Is.False);
            Assert.That(BattleScaling.IsBossWave(5), Is.False);
            Assert.That(BattleScaling.IsBossWave(6), Is.True);
            Assert.That(BattleScaling.IsBossWave(12), Is.True);
            Assert.That(BattleScaling.IsBossWave(7), Is.False);
        }

        [Test]
        public void boss_ordinal_counts_successive_bosses_with_floor_of_one()
        {
            Assert.That(BattleScaling.BossOrdinal(1), Is.EqualTo(1));
            Assert.That(BattleScaling.BossOrdinal(6), Is.EqualTo(1));
            Assert.That(BattleScaling.BossOrdinal(12), Is.EqualTo(2));
            Assert.That(BattleScaling.BossOrdinal(18), Is.EqualTo(3));
        }

        [Test]
        public void boss_hp_mul_grows_60_percent_per_successive_boss()
        {
            Assert.That(BattleScaling.BossHpMul(6), Is.EqualTo(1.0).Within(1e-12));
            Assert.That(BattleScaling.BossHpMul(12), Is.EqualTo(1.6).Within(1e-12));
            Assert.That(BattleScaling.BossHpMul(18), Is.EqualTo(2.2).Within(1e-12));
        }

        [Test]
        public void wave_scaling_first_wave_uses_gentle_on_ramp_values()
        {
            WaveScaling w1 = BattleScaling.WaveScaling(1);
            Assert.That(w1.EnemyCount, Is.EqualTo(8));
            Assert.That(w1.HpMul, Is.EqualTo(1.0).Within(1e-12));
            Assert.That(w1.SpeedMul, Is.EqualTo(0.85).Within(1e-12));
            Assert.That(w1.HeartDmgMul, Is.EqualTo(1.0).Within(1e-12));
        }

        [Test]
        public void wave_scaling_hp_mul_climbs_monotonically_and_speed_caps()
        {
            WaveScaling w7 = BattleScaling.WaveScaling(7);
            WaveScaling w20 = BattleScaling.WaveScaling(20);
            // hpMul = 1 + 0.16 * (w - 1)
            Assert.That(w7.HpMul, Is.EqualTo(1 + 0.16 * 6).Within(1e-12));
            Assert.That(w20.HpMul, Is.GreaterThan(w7.HpMul));
            // speedMul caps at 1.28.
            Assert.That(w20.SpeedMul, Is.LessThanOrEqualTo(1.28));
            // enemyCount caps at 12.
            Assert.That(w20.EnemyCount, Is.EqualTo(12));
        }

        [Test]
        public void wave_scaling_clamps_waves_below_one_to_wave_one()
        {
            WaveScaling w0 = BattleScaling.WaveScaling(0);
            WaveScaling w1 = BattleScaling.WaveScaling(1);
            Assert.That(w0.HpMul, Is.EqualTo(w1.HpMul));
            Assert.That(w0.SpeedMul, Is.EqualTo(w1.SpeedMul));
        }
    }
}
