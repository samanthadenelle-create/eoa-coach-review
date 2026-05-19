// =============================================================================
// ATB Battle Engine — BattleState construction + helper tests (EditMode)
// Mirrors atbEngine.test.ts "createBattle" and "pet bond scaling" describes.
// =============================================================================

using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.BattleStateOps;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class BattleStateTest
    {
        [Test]
        public void create_battle_builds_three_party_units_and_five_enemies()
        {
            BattleState state = CreateBattle(TestSupport.SampleSetup());
            Assert.That(LivingUnits(state, Side.Party).Count, Is.EqualTo(3));
            Assert.That(LivingUnits(state, Side.Enemy).Count, Is.EqualTo(5));
            // The benched ice-wolf is in reserve, not on the field.
            Assert.That(state.Reserve.Count, Is.EqualTo(1));
            Assert.That(state.Reserve[0].Species, Is.EqualTo(PetSpecies.IceWolf));
            Assert.That(state.Phase, Is.EqualTo(BattlePhase.Intro));
            TestSupport.AssertConsistent(state);
        }

        [Test]
        public void create_battle_hero_stats_match_the_chosen_class()
        {
            BattleState state = CreateBattle(TestSupport.SampleSetup());
            BattleUnit hero = GetUnit(state, "hero");
            Assert.That(hero.HeroClass, Is.EqualTo(HeroClass.Mage));
            Assert.That(hero.MaxHp, Is.EqualTo(90)); // mage base HP
            Assert.That(hero.Element, Is.EqualTo(ElementType.Aether));
        }

        [Test]
        public void create_battle_enemy_hp_scales_up_with_the_wave_number()
        {
            BattleSetup low = TestSupport.SampleSetup();
            low.Wave = 1;
            BattleSetup high = TestSupport.SampleSetup();
            high.Wave = 20;
            BattleState lowState = CreateBattle(low);
            BattleState highState = CreateBattle(high);
            BattleUnit lowGoblin = lowState.Units.Find(u => u.EnemyDefId == "goblin");
            BattleUnit highGoblin = highState.Units.Find(u => u.EnemyDefId == "goblin");
            Assert.That(highGoblin.MaxHp, Is.GreaterThan(lowGoblin.MaxHp));
        }

        [Test]
        public void create_battle_reinforcements_buff_inflates_party_hp()
        {
            BattleState normal = CreateBattle(TestSupport.SampleSetup());
            BattleSetup buffedSetup = TestSupport.SampleSetup();
            buffedSetup.Reinforcements = true;
            BattleState buffed = CreateBattle(buffedSetup);
            Assert.That(GetUnit(buffed, "hero").MaxHp,
                Is.GreaterThan(GetUnit(normal, "hero").MaxHp));
            Assert.That(buffed.ReinforcementsApplied, Is.True);
        }

        [Test]
        public void create_battle_caps_the_party_at_eight_and_enemies_at_eight()
        {
            BattleSetup setup = TestSupport.SampleSetup();
            setup.Pets = new List<PartyPetSpec>();
            for (int i = 0; i < 12; i++)
            {
                setup.Pets.Add(new PartyPetSpec
                {
                    Species = PetSpecies.FlamePup,
                    Name = $"Pup{i}",
                    BondRank = 0,
                    AiMode = PetAiMode.Balanced,
                    JoinsImmediately = true,
                });
            }
            setup.Enemies = new List<BreachEnemySpec>();
            for (int i = 0; i < 14; i++)
                setup.Enemies.Add(new BreachEnemySpec { DefId = "goblin" });

            BattleState state = CreateBattle(setup);
            Assert.That(LivingUnits(state, Side.Party).Count, Is.LessThanOrEqualTo(8));
            Assert.That(LivingUnits(state, Side.Enemy).Count, Is.LessThanOrEqualTo(8));
        }

        [Test]
        public void pet_bond_damage_mul_increases_with_rank()
        {
            Assert.That(PetBondDamageMul(4), Is.GreaterThan(PetBondDamageMul(0)));
        }

        [Test]
        public void pet_unlocked_ability_count_gates_on_bond_rank()
        {
            Assert.That(PetUnlockedAbilityCount(0), Is.EqualTo(0));
            Assert.That(PetUnlockedAbilityCount(1), Is.EqualTo(1));
            Assert.That(PetUnlockedAbilityCount(2), Is.EqualTo(2));
            Assert.That(PetUnlockedAbilityCount(4), Is.EqualTo(2));
        }

        [Test]
        public void clone_battle_produces_an_independent_deep_copy()
        {
            BattleState original = CreateBattle(TestSupport.SampleSetup());
            BattleState copy = CloneBattle(original);
            // Mutating the copy must not touch the original.
            copy.Units[0].Hp = 1;
            copy.Units[0].Statuses.Add(new StatusEffect
            {
                Kind = StatusKind.Burn,
                Turns = 3,
                Potency = 6,
            });
            Assert.That(original.Units[0].Hp, Is.Not.EqualTo(1));
            Assert.That(original.Units[0].Statuses.Count, Is.EqualTo(0));
            // Rng is also a fresh reference.
            Assert.That(ReferenceEquals(copy.Rng, original.Rng), Is.False);
        }

        [Test]
        public void build_enemy_unit_throws_on_unknown_def_id()
        {
            Assert.That(
                () => BuildEnemyUnit(new BreachEnemySpec { DefId = "dragon" }, 0, 1),
                Throws.Exception);
        }
    }
}
