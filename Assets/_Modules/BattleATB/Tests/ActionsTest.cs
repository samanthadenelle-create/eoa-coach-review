// =============================================================================
// ATB Battle Engine — Actions resolution tests (EditMode)
// =============================================================================

using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.Actions;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Turn;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class ActionsTest
    {
        private static BattleState NewStarted(int seed = TestSupport.DefaultSeed)
        {
            return StartBattle(CreateBattle(TestSupport.SampleSetup(seed)));
        }

        [Test]
        public void resolve_attack_damages_a_living_enemy_target()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            BattleUnit foe = LivingUnits(state, Side.Enemy)[0];
            int hpBefore = foe.Hp;
            ResolveAttack(state, hero, foe.Id);
            Assert.That(foe.Hp, Is.LessThan(hpBefore));
        }

        [Test]
        public void resolve_defend_sets_defending_and_restores_resource()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            hero.Resource = 0;
            ResolveDefend(state, hero);
            Assert.That(hero.Defending, Is.True);
            Assert.That(hero.Resource, Is.EqualTo(8)); // literal +8 in resolveDefend.
        }

        [Test]
        public void resolve_item_consumes_inventory_and_heals_the_target()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            hero.Hp = 10;
            int potionsBefore = state.Inventory[ItemKind.Potion];
            bool ok = ResolveItem(state, hero, ItemKind.Potion, "hero");
            Assert.That(ok, Is.True);
            Assert.That(state.Inventory[ItemKind.Potion], Is.EqualTo(potionsBefore - 1));
            Assert.That(hero.Hp, Is.GreaterThan(10));
        }

        [Test]
        public void resolve_item_returns_false_when_inventory_is_empty()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            state.Inventory[ItemKind.Potion] = 0;
            Assert.That(ResolveItem(state, hero, ItemKind.Potion, "hero"), Is.False);
        }

        [Test]
        public void resolve_ability_charges_cost_and_sets_cooldown()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero"); // mage
            hero.Resource = 80;
            // Mage W "Flameblast": cost 35, cooldown 2.
            BattleUnit foe = LivingUnits(state, Side.Enemy)[0];
            ResolveAbility(state, hero, AbilitySlot.W, foe.Id);
            Assert.That(hero.Resource, Is.EqualTo(80 - 35));
            Assert.That(CooldownOf(hero, AbilitySlot.W), Is.EqualTo(2));
        }

        [Test]
        public void resolve_rally_pulls_a_benched_pet_and_empties_reserve()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            int partyBefore = LivingUnits(state, Side.Party).Count;
            bool ok = ResolveRally(state, hero, 0);
            Assert.That(ok, Is.True);
            Assert.That(state.Reserve.Count, Is.EqualTo(0));
            Assert.That(LivingUnits(state, Side.Party).Count, Is.EqualTo(partyBefore + 1));
        }

        [Test]
        public void resolve_rally_returns_false_for_an_out_of_range_index()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            Assert.That(ResolveRally(state, hero, 99), Is.False);
            Assert.That(ResolveRally(state, hero, -1), Is.False);
        }

        [Test]
        public void apply_action_unusable_ability_falls_back_to_a_basic_attack()
        {
            BattleState state = NewStarted();
            BattleUnit hero = GetUnit(state, "hero");
            hero.Resource = 0; // can't afford any ability.
            BattleUnit foe = LivingUnits(state, Side.Enemy)[0];
            int totalHpBefore = 0;
            foreach (BattleUnit f in LivingUnits(state, Side.Enemy)) totalHpBefore += f.Hp;
            // Mage R "Tempest" is unaffordable -> fallback basic attack on a foe.
            ApplyAction(state, hero, BattleAction.MakeAbility(AbilitySlot.R, foe.Id));
            int totalHpAfter = 0;
            foreach (BattleUnit f in LivingUnits(state, Side.Enemy)) totalHpAfter += f.Hp;
            Assert.That(totalHpAfter, Is.LessThan(totalHpBefore));
        }

        [Test]
        public void resolve_enemy_special_self_heal_recovers_the_caster_hp()
        {
            BattleState state = NewStarted();
            // bruiser's Patch Up heals 40 and does nothing else.
            BattleUnit bruiser = BuildEnemyUnit(
                new BreachEnemySpec { DefId = "bruiser" }, 9, 7);
            bruiser.Hp = 10;
            state.Units.Add(bruiser);
            ResolveEnemySpecial(state, bruiser);
            Assert.That(bruiser.Hp, Is.GreaterThan(10));
        }
    }
}
