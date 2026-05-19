// =============================================================================
// ATB Battle Engine — Combat (damage + status) tests (EditMode)
// Mirrors atbEngine.test.ts "damage calculation" and "status effects" describes.
// =============================================================================

using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Combat;
using static DeNelle.BattleATB.Engine.RngOps;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class CombatTest
    {
        [Test]
        public void higher_defense_reduces_damage_taken()
        {
            BattleUnit attacker = TestSupport.Dummy(id: "a", side: Side.Party);
            BattleUnit soft = TestSupport.Dummy(id: "soft", defense: 0);
            BattleUnit tanky = TestSupport.Dummy(id: "tanky", defense: 0.5);
            DamageResult softDmg = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = soft, BasePower = 100,
                Element = ElementType.Physical, Rng = CreateRng(1),
            });
            DamageResult tankyDmg = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = tanky, BasePower = 100,
                Element = ElementType.Physical, Rng = CreateRng(1),
            });
            Assert.That(tankyDmg.Damage, Is.LessThan(softDmg.Damage));
        }

        [Test]
        public void aether_damage_ignores_armour_entirely()
        {
            BattleUnit attacker = TestSupport.Dummy(id: "a", side: Side.Party);
            BattleUnit tanky = TestSupport.Dummy(id: "tanky", defense: 0.5);
            DamageResult phys = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = tanky, BasePower = 100,
                Element = ElementType.Physical, Rng = CreateRng(5),
            });
            DamageResult aether = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = tanky, BasePower = 100,
                Element = ElementType.Aether, Rng = CreateRng(5),
            });
            Assert.That(aether.Damage, Is.GreaterThan(phys.Damage));
        }

        [Test]
        public void a_shield_negates_the_hit_and_is_consumed()
        {
            BattleUnit attacker = TestSupport.Dummy(id: "a", side: Side.Party);
            BattleUnit shielded = TestSupport.Dummy(id: "s");
            ApplyStatus(shielded, StatusKind.Shield);
            DamageResult result = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = shielded, BasePower = 80,
                Element = ElementType.Physical, Rng = CreateRng(2),
            });
            Assert.That(result.Shielded, Is.True);
            int lost = ApplyDamage(shielded, result);
            Assert.That(lost, Is.EqualTo(0));
            Assert.That(shielded.Hp, Is.EqualTo(100));
            Assert.That(HasStatus(shielded, StatusKind.Shield), Is.False);
        }

        [Test]
        public void defending_halves_incoming_damage()
        {
            BattleUnit attacker = TestSupport.Dummy(id: "a", side: Side.Party);
            BattleUnit open = TestSupport.Dummy(id: "open");
            BattleUnit guarding = TestSupport.Dummy(id: "guard", defending: true);
            DamageResult a = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = open, BasePower = 100,
                Element = ElementType.Physical, Rng = CreateRng(3),
            });
            DamageResult b = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = guarding, BasePower = 100,
                Element = ElementType.Physical, Rng = CreateRng(3),
            });
            Assert.That(b.Damage, Is.LessThan(a.Damage));
        }

        [Test]
        public void apply_heal_clamps_at_max_hp_and_never_revives_the_dead()
        {
            BattleUnit hurt = TestSupport.Dummy(id: "h", hp: 40);
            Assert.That(ApplyHeal(hurt, 1000), Is.EqualTo(60));
            Assert.That(hurt.Hp, Is.EqualTo(100));
            BattleUnit dead = TestSupport.Dummy(id: "d", hp: 0, alive: false);
            Assert.That(ApplyHeal(dead, 50), Is.EqualTo(0));
            Assert.That(dead.Hp, Is.EqualTo(0));
        }

        [Test]
        public void damage_is_never_below_one_and_kills_mark_the_unit_dead()
        {
            BattleUnit attacker = TestSupport.Dummy(id: "a", side: Side.Party, attack: 9999);
            BattleUnit victim = TestSupport.Dummy(id: "v", hp: 5);
            DamageResult result = CalculateDamage(new DamageInput
            {
                Attacker = attacker, Target = victim, BasePower = 9999,
                Element = ElementType.Physical, Rng = CreateRng(4),
            });
            Assert.That(result.Damage, Is.GreaterThanOrEqualTo(1));
            ApplyDamage(victim, result);
            Assert.That(victim.Hp, Is.EqualTo(0));
            Assert.That(victim.Alive, Is.False);
        }

        [Test]
        public void element_multiplier_follows_the_rps_table()
        {
            Assert.That(ElementMultiplier(ElementType.Flame, ElementType.Ice),
                Is.EqualTo(1.25).Within(1e-12));
            Assert.That(ElementMultiplier(ElementType.Ice, ElementType.Flame),
                Is.EqualTo(0.85).Within(1e-12));
            Assert.That(ElementMultiplier(ElementType.Physical, ElementType.Ice),
                Is.EqualTo(1.0).Within(1e-12));
        }

        [Test]
        public void cleanse_strips_debuffs_but_keeps_buffs()
        {
            BattleState state = BattleStateOps.CreateBattle(TestSupport.SampleSetup());
            BattleUnit hero = GetUnit(state, "hero");
            ApplyStatus(hero, StatusKind.Burn);
            ApplyStatus(hero, StatusKind.Poison);
            ApplyStatus(hero, StatusKind.Regen); // a buff — should survive.
            System.Collections.Generic.List<StatusKind> removed = CleanseStatuses(hero);
            removed.Sort();
            Assert.That(removed, Is.EqualTo(new[] { StatusKind.Burn, StatusKind.Poison }));
            Assert.That(HasStatus(hero, StatusKind.Regen), Is.True);
            Assert.That(HasStatus(hero, StatusKind.Burn), Is.False);
        }

        [Test]
        public void tick_statuses_applies_burn_damage_and_decrements_turns()
        {
            BattleState state = BattleStateOps.CreateBattle(TestSupport.SampleSetup());
            BattleUnit target = LivingUnits(state, Side.Enemy)[0];
            int hpBefore = target.Hp;
            ApplyStatus(target, StatusKind.Burn); // burn: 3 turns, potency 6.

            bool skip = TickStatuses(state, target);
            Assert.That(skip, Is.False);
            Assert.That(target.Hp, Is.EqualTo(hpBefore - 6));
            // 3 turns -> 2 turns remaining.
            StatusEffect burn = target.Statuses.Find(s => s.Kind == StatusKind.Burn);
            Assert.That(burn.Turns, Is.EqualTo(2));
        }

        [Test]
        public void tick_statuses_freeze_forces_a_skip_then_expires()
        {
            BattleState state = BattleStateOps.CreateBattle(TestSupport.SampleSetup());
            BattleUnit target = LivingUnits(state, Side.Enemy)[0];
            ApplyStatus(target, StatusKind.Freeze); // freeze: 1 turn.
            bool skip = TickStatuses(state, target);
            Assert.That(skip, Is.True);
            // 1 turn -> 0, so freeze should have fallen off.
            Assert.That(HasStatus(target, StatusKind.Freeze), Is.False);
        }

        [Test]
        public void apply_status_refreshes_and_keeps_higher_potency()
        {
            BattleUnit u = TestSupport.Dummy(id: "u");
            ApplyStatus(u, StatusKind.Bleed);
            StatusEffect bleed = u.Statuses.Find(s => s.Kind == StatusKind.Bleed);
            bleed.Turns = 1;
            bleed.Potency = 99; // grown by ticks.
            ApplyStatus(u, StatusKind.Bleed); // re-apply blueprint (turns 4, pot 3).
            Assert.That(u.Statuses.Count, Is.EqualTo(1), "must not stack duplicates");
            Assert.That(bleed.Turns, Is.EqualTo(4), "refresh to higher turns");
            Assert.That(bleed.Potency, Is.EqualTo(99.0), "keep the higher potency");
        }
    }
}
