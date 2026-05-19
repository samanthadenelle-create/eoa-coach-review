// =============================================================================
// ATB Battle Engine — Ai (action-choosing) tests (EditMode)
// =============================================================================

using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.Ai;
using static DeNelle.BattleATB.Engine.BattleStateOps;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class AiTest
    {
        private static BattleState NewState(int seed = TestSupport.DefaultSeed)
        {
            return CreateBattle(TestSupport.SampleSetup(seed));
        }

        [Test]
        public void choose_enemy_action_attacks_when_no_foes_remain()
        {
            BattleState state = NewState();
            // Wipe the party so foes.Count == 0.
            foreach (BattleUnit u in LivingUnits(state, Side.Party)) u.Alive = false;
            BattleUnit enemy = LivingUnits(state, Side.Enemy)[0];
            BattleAction action = ChooseEnemyAction(state, enemy);
            Assert.That(action.Kind, Is.EqualTo(ActionKind.Attack));
        }

        [Test]
        public void choose_enemy_action_returns_attack_or_ability()
        {
            BattleState state = NewState();
            BattleUnit enemy = LivingUnits(state, Side.Enemy)[0];
            BattleAction action = ChooseEnemyAction(state, enemy);
            Assert.That(
                action.Kind == ActionKind.Attack || action.Kind == ActionKind.Ability,
                Is.True);
        }

        [Test]
        public void pick_enemy_attack_target_tank_chooses_lowest_defense_foe()
        {
            BattleState state = NewState();
            BattleUnit tank = LivingUnits(state, Side.Enemy)[0];
            tank.Archetype = EnemyArchetype.Tank;
            List<BattleUnit> foes = LivingUnits(state, Side.Party);
            // Mage has the lowest defense (0.05) of the sample party.
            BattleUnit chosen = PickEnemyAttackTarget(state, tank, foes, state.Rng);
            BattleUnit lowest = foes[0];
            foreach (BattleUnit f in foes)
                if (f.Defense < lowest.Defense) lowest = f;
            Assert.That(chosen.Id, Is.EqualTo(lowest.Id));
        }

        [Test]
        public void pick_enemy_attack_target_returns_null_for_empty_foes()
        {
            BattleState state = NewState();
            BattleUnit enemy = LivingUnits(state, Side.Enemy)[0];
            Assert.That(
                PickEnemyAttackTarget(state, enemy, new List<BattleUnit>(), state.Rng),
                Is.Null);
        }

        [Test]
        public void choose_pet_action_defends_when_no_foes_remain()
        {
            BattleState state = NewState();
            foreach (BattleUnit u in LivingUnits(state, Side.Enemy)) u.Alive = false;
            BattleUnit pet = GetUnit(state, "pet-0");
            BattleAction action = ChoosePetAction(state, pet);
            Assert.That(action.Kind, Is.EqualTo(ActionKind.Defend));
        }

        [Test]
        public void choose_pet_action_aggressive_pet_leads_with_a_damage_ability()
        {
            BattleState state = NewState();
            // pet-0 is the flame-pup, bondRank 2 -> 2 abilities unlocked, both
            // damage abilities; aiMode aggressive -> never picks support first.
            BattleUnit pet = GetUnit(state, "pet-0");
            BattleAction action = ChoosePetAction(state, pet);
            Assert.That(action.Kind, Is.EqualTo(ActionKind.Ability));
            Assert.That(action.TargetId, Is.Not.Null);
        }

        [Test]
        public void choose_pet_action_is_deterministic_draws_no_rng()
        {
            // choosePetAction must not advance the RNG cursor.
            BattleState state = NewState();
            BattleUnit pet = GetUnit(state, "pet-1");
            uint seedBefore = state.Rng.Seed;
            ChoosePetAction(state, pet);
            Assert.That(state.Rng.Seed, Is.EqualTo(seedBefore));
        }
    }
}
