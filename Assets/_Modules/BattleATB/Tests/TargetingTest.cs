// =============================================================================
// ATB Battle Engine — Targeting tests (EditMode)
// =============================================================================

using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.RngOps;
using static DeNelle.BattleATB.Engine.Targeting;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class TargetingTest
    {
        private static BattleState NewState()
        {
            return CreateBattle(TestSupport.SampleSetup());
        }

        [Test]
        public void single_enemy_with_explicit_id_returns_that_unit()
        {
            BattleState state = NewState();
            BattleUnit hero = GetUnit(state, "hero");
            BattleUnit foe = LivingUnits(state, Side.Enemy)[2];
            List<BattleUnit> targets = ResolveTargets(
                state, hero, TargetMode.SingleEnemy, foe.Id, state.Rng, 1);
            Assert.That(targets.Count, Is.EqualTo(1));
            Assert.That(targets[0].Id, Is.EqualTo(foe.Id));
        }

        [Test]
        public void all_enemies_returns_every_living_foe()
        {
            BattleState state = NewState();
            BattleUnit hero = GetUnit(state, "hero");
            List<BattleUnit> targets = ResolveTargets(
                state, hero, TargetMode.AllEnemies, null, state.Rng, 1);
            Assert.That(targets.Count, Is.EqualTo(5));
        }

        [Test]
        public void random_enemies_pool_allows_repeats_across_hits()
        {
            // F-TARG-2: the pool is not removed-from — Volley's 3 hits can land
            // on the same foe. The pick count must equal the requested hits.
            BattleState state = NewState();
            BattleUnit hero = GetUnit(state, "hero");
            List<BattleUnit> targets = ResolveTargets(
                state, hero, TargetMode.RandomEnemies, null, state.Rng, 3);
            Assert.That(targets.Count, Is.EqualTo(3));
            foreach (BattleUnit t in targets)
                Assert.That(t.Side, Is.EqualTo(Side.Enemy));
        }

        [Test]
        public void self_returns_the_actor()
        {
            BattleState state = NewState();
            BattleUnit hero = GetUnit(state, "hero");
            List<BattleUnit> targets = ResolveTargets(
                state, hero, TargetMode.Self, null, state.Rng, 1);
            Assert.That(targets.Count, Is.EqualTo(1));
            Assert.That(targets[0].Id, Is.EqualTo("hero"));
        }

        [Test]
        public void single_ally_for_enemy_actor_with_no_id_targets_itself()
        {
            // F-TARG-1: an enemy special with target single-ally and no explicit
            // id falls through to [actor] — the enemy targets ITSELF. Faithful.
            BattleState state = NewState();
            BattleUnit enemy = LivingUnits(state, Side.Enemy)[0];
            List<BattleUnit> targets = ResolveTargets(
                state, enemy, TargetMode.SingleAlly, null, state.Rng, 1);
            Assert.That(targets.Count, Is.EqualTo(1));
            Assert.That(targets[0].Id, Is.EqualTo(enemy.Id));
        }

        [Test]
        public void single_enemy_with_empty_string_id_falls_back_to_random_pick()
        {
            // TS treats "" as falsy — empty explicitTargetId must NOT short out.
            BattleState state = NewState();
            BattleUnit hero = GetUnit(state, "hero");
            List<BattleUnit> targets = ResolveTargets(
                state, hero, TargetMode.SingleEnemy, "", state.Rng, 1);
            Assert.That(targets.Count, Is.EqualTo(1));
            Assert.That(targets[0].Side, Is.EqualTo(Side.Enemy));
        }

        [Test]
        public void adjacent_unit_ids_returns_left_then_right_neighbour()
        {
            BattleState state = NewState();
            // party order: hero, pet-0, pet-1. pet-0's neighbours are hero, pet-1.
            BattleUnit pet0 = GetUnit(state, "pet-0");
            List<string> adj = AdjacentUnitIds(state, pet0);
            Assert.That(adj, Is.EqualTo(new[] { "hero", "pet-1" }));

            // hero is left-most — only a right neighbour.
            BattleUnit hero = GetUnit(state, "hero");
            Assert.That(AdjacentUnitIds(state, hero), Is.EqualTo(new[] { "pet-0" }));
        }
    }
}
