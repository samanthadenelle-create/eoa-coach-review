// =============================================================================
// BattleHudVMTests — §2c permission-gate for the WO-744 MVVM landmine-1 conversion.
// -----------------------------------------------------------------------------
// Locks the BattleHudVM snapshot projection (active hero class + usable abilities /
// items off Defs.HERO_ABILITIES / Defs.ITEM_DEFS) over a fake BattleState, and
// asserts the VM is PURE DATA with NO ATB feel-sim coupling — the risk-register
// invariant that the split must never drag the _visualAtb / TickVisualAtb feel-sim
// into the discrete data VM.
// =============================================================================

using System.Linq;
using System.Reflection;
using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB;
using DeNelle.BattleATB.Engine;

namespace DeNelle.BattleATB.Tests
{
    public class BattleHudVMTests
    {
        // A Knight hero as the active unit, an enemy present, plus a mixed inventory.
        private static BattleState MakeState(string activeId)
        {
            var hero = BattleStateOps.BuildHeroUnit(
                HeroClass.Knight, "Knight", "hero", ControlMode.Player, reinforced: false);
            var enemy = TestSupport.Dummy(id: "enemy-0", side: Side.Enemy);
            return new BattleState
            {
                Units = new List<BattleUnit> { hero, enemy },
                ActiveUnitId = activeId,
                Inventory = new Dictionary<ItemKind, int>
                {
                    { ItemKind.Potion, 2 },
                    { ItemKind.ManaCrystal, 0 },   // filtered out (count 0)
                    { ItemKind.Cleanse, 1 },
                },
            };
        }

        [Test]
        public void Projects_active_hero_class_and_full_ability_kit()
        {
            var vm = new BattleHudVM();
            vm.PushSnapshot(MakeState("hero"));

            Assert.That(vm.ActiveUnitId, Is.EqualTo("hero"));
            Assert.That(vm.ActiveHeroClass, Is.EqualTo(HeroClass.Knight));

            // Mirrors the View's old GetAbilitiesForActiveHero: the class kit off HERO_ABILITIES.
            var expected = Defs.HERO_ABILITIES[HeroClass.Knight];
            Assert.That(vm.UsableAbilities.Count, Is.EqualTo(expected.Length));
            CollectionAssert.AreEqual(
                expected.Select(a => a.Name).ToList(),
                vm.UsableAbilities.Select(a => a.Name).ToList());
        }

        [Test]
        public void Usable_items_filter_zero_counts_and_resolve_names()
        {
            var vm = new BattleHudVM();
            vm.PushSnapshot(MakeState("hero"));

            var items = vm.UsableItems;
            Assert.That(items.Count, Is.EqualTo(2), "count-0 items are filtered out");
            var byKind = items.ToDictionary(i => i.Kind);
            Assert.That(byKind.ContainsKey(ItemKind.ManaCrystal), Is.False);

            Assert.That(byKind[ItemKind.Potion].Count, Is.EqualTo(2));
            Assert.That(byKind[ItemKind.Potion].Name, Is.EqualTo(Defs.ITEM_DEFS[ItemKind.Potion].Name));
            Assert.That(byKind[ItemKind.Cleanse].Count, Is.EqualTo(1));
            Assert.That(byKind[ItemKind.Cleanse].Name, Is.EqualTo(Defs.ITEM_DEFS[ItemKind.Cleanse].Name));
        }

        [Test]
        public void Non_hero_active_unit_yields_no_class_or_abilities()
        {
            var vm = new BattleHudVM();
            vm.PushSnapshot(MakeState("enemy-0"));   // active unit is the enemy dummy (no HeroClass)

            Assert.That(vm.ActiveUnitId, Is.EqualTo("enemy-0"));
            Assert.That(vm.ActiveHeroClass, Is.Null);
            Assert.That(vm.UsableAbilities.Count, Is.EqualTo(0));
        }

        [Test]
        public void Null_or_empty_active_yields_empty_projection()
        {
            var vm = new BattleHudVM();
            vm.PushSnapshot(new BattleState { Units = new List<BattleUnit>(), ActiveUnitId = null, Inventory = null });
            Assert.That(vm.ActiveHeroClass, Is.Null);
            Assert.That(vm.UsableAbilities.Count, Is.EqualTo(0));
            Assert.That(vm.UsableItems.Count, Is.EqualTo(0));

            // A null state must not throw and must project empty.
            Assert.DoesNotThrow(() => vm.PushSnapshot(null));
            Assert.That(vm.ActiveHeroClass, Is.Null);
            Assert.That(vm.UsableAbilities.Count, Is.EqualTo(0));
        }

        [Test]
        public void Projection_ignores_atb_fill_no_feel_sim_coupling()
        {
            // The VM is PURE DATA: changing a unit's ATB fill must NOT alter the discrete
            // projection (the feel-sim lives only in the View's _visualAtb / TickVisualAtb).
            var vm = new BattleHudVM();
            var s1 = MakeState("hero");
            s1.Units.First(u => u.Id == "hero").Atb = 0.0;
            vm.PushSnapshot(s1);
            var abilities1 = vm.UsableAbilities.Select(a => a.Name).ToList();

            var s2 = MakeState("hero");
            s2.Units.First(u => u.Id == "hero").Atb = 100.0;
            vm.PushSnapshot(s2);
            var abilities2 = vm.UsableAbilities.Select(a => a.Name).ToList();

            CollectionAssert.AreEqual(abilities1, abilities2);

            // Structural proof: the VM declares NO feel-sim members (no _visualAtb field,
            // no TickVisualAtb method) — the split kept the feel-sim out of the data VM.
            var t = typeof(BattleHudVM);
            const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.Instance | BindingFlags.Static;
            Assert.That(t.GetMethod("TickVisualAtb", All), Is.Null, "VM must carry no feel-sim tick");
            foreach (var f in t.GetFields(All))
                Assert.That(f.Name.ToLowerInvariant().Contains("visual"), Is.False,
                    "VM must carry no visual/feel-sim field: " + f.Name);
        }
    }
}
