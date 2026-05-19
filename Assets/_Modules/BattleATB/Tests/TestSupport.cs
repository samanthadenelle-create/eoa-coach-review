// =============================================================================
// ATB Battle Engine — EditMode test support
// -----------------------------------------------------------------------------
// Shared helpers mirroring atbEngine.test.ts: `sampleSetup` (the deterministic
// 3v5 encounter) and `assertConsistent` (the battle-state invariant checker).
// =============================================================================

using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB.Engine;

namespace DeNelle.BattleATB.Tests
{
    /// <summary>Shared fixtures + assertions for the ATB engine tests.</summary>
    public static class TestSupport
    {
        /// <summary>Default sample seed (TS `sampleSetup` default 0xa11ce).</summary>
        public const int DefaultSeed = 0xA11CE;

        /// <summary>A fixed 3v5 setup: a Mage + 2 pets vs. 5 breached enemies, wave 7.</summary>
        public static BattleSetup SampleSetup(int seed = DefaultSeed)
        {
            return new BattleSetup
            {
                Wave = 7,
                Seed = seed,
                HeroClass = HeroClass.Mage,
                HeroName = "Test Mage",
                Pets = new List<PartyPetSpec>
                {
                    new PartyPetSpec
                    {
                        Species = PetSpecies.FlamePup,
                        Name = "Cinder",
                        BondRank = 2,
                        AiMode = PetAiMode.Aggressive,
                        JoinsImmediately = true,
                    },
                    new PartyPetSpec
                    {
                        Species = PetSpecies.AetherSprite,
                        Name = "Spark",
                        BondRank = 3,
                        AiMode = PetAiMode.Defensive,
                        JoinsImmediately = true,
                    },
                    // A benched pet to exercise Rally.
                    new PartyPetSpec
                    {
                        Species = PetSpecies.IceWolf,
                        Name = "Frost",
                        BondRank = 1,
                        AiMode = PetAiMode.Balanced,
                        JoinsImmediately = false,
                    },
                },
                Enemies = new List<BreachEnemySpec>
                {
                    new BreachEnemySpec { DefId = "goblin" },
                    new BreachEnemySpec { DefId = "goblin" },
                    new BreachEnemySpec { DefId = "skeleton" },
                    new BreachEnemySpec { DefId = "skeleton" },
                    new BreachEnemySpec { DefId = "necromancer" },
                },
                Inventory = new Dictionary<ItemKind, int>
                {
                    { ItemKind.Potion, 2 },
                    { ItemKind.ManaCrystal, 1 },
                    { ItemKind.Cleanse, 1 },
                },
            };
        }

        /// <summary>Every invariant a healthy battle state must satisfy.</summary>
        public static void AssertConsistent(BattleState state)
        {
            foreach (BattleUnit u in state.Units)
            {
                Assert.That(u.Hp, Is.GreaterThanOrEqualTo(0));
                Assert.That(u.Hp, Is.LessThanOrEqualTo(u.MaxHp));
                // A unit with 0 HP must be marked dead, and vice-versa.
                if (u.Hp == 0) Assert.That(u.Alive, Is.False);
                if (u.Alive) Assert.That(u.Hp, Is.GreaterThan(0));
                Assert.That(u.Resource, Is.GreaterThanOrEqualTo(0));
                Assert.That(u.Resource, Is.LessThanOrEqualTo(u.MaxResource));
                Assert.That(u.Atb, Is.GreaterThanOrEqualTo(0));
                Assert.That(u.Atb, Is.LessThanOrEqualTo(Defs.ATB_FULL));
            }
        }

        /// <summary>Build a bare combat dummy (mirrors the TS `dummy` factory).</summary>
        public static BattleUnit Dummy(
            string id = "dummy",
            Side side = Side.Enemy,
            int hp = 100,
            double defense = 0,
            bool defending = false,
            bool alive = true,
            int attack = 20,
            ElementType element = ElementType.Physical)
        {
            return new BattleUnit
            {
                Id = id,
                Side = side,
                Name = "Dummy",
                Kind = UnitKind.Enemy,
                Hp = hp,
                MaxHp = 100,
                Resource = 0,
                MaxResource = 0,
                ResourceRegen = 0,
                Atb = 0,
                Speed = 1,
                Defense = defense,
                Attack = attack,
                Element = element,
                Statuses = new List<StatusEffect>(),
                Cooldowns = new Dictionary<AbilitySlot, int>(),
                Defending = defending,
                Alive = alive,
            };
        }
    }
}
