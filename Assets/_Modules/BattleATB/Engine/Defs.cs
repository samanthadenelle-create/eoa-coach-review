// =============================================================================
// ATB Battle Engine — static definition tables + tuning constants
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/defs.ts. Pure static data: status blueprints, ATB
// constants, hero/pet/item/enemy tables, crit + party-size tuning. No logic.
//
// Port strategy (per port-notes §4, option A): plain static readonly tables —
// guarantees byte-identical values vs. the TS reference and trivially diffable.
// ScriptableObject mirrors for designers live at the bottom of this file
// (`CombatantDefSO` family); they are optional and the engine never reads them.
// =============================================================================

using System.Collections.Generic;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Default duration + potency per status.</summary>
    public struct StatusBlueprint
    {
        public int Turns;
        public double Potency;
        /// <summary>True for buffs (don't get cleansed).</summary>
        public bool Buff;
    }

    /// <summary>Hero base stats per class.</summary>
    public struct HeroClassStats
    {
        public int MaxHp;
        public int MaxResource;
        public int ResourceRegen;
        public double Speed;
        public double Defense;
        public int Attack;
        public ElementType Element;
    }

    /// <summary>A pet's species-level combat profile.</summary>
    public struct PetSpeciesStats
    {
        public int MaxHp;
        public int Attack;
        public double Speed;
        public ElementType Element;
        public int MaxResource;
        public int ResourceRegen;
    }

    /// <summary>Static definition tables + tuning constants.</summary>
    public static class Defs
    {
        // ---------------------------------------------------------------------
        // ATB tuning
        // ---------------------------------------------------------------------

        /// <summary>
        /// F-DEFS-1 (dead constant): exported for API parity but no engine file
        /// references it — advanceToNextTurn is an event-step simulation.
        /// </summary>
        public const int ATB_BASE_FILL = 12;
        /// <summary>ATB value at which a unit may act.</summary>
        public const int ATB_FULL = 100;
        /// <summary>A slowed unit fills at this fraction of normal.</summary>
        public const double SLOW_FILL_MUL = 0.5;
        /// <summary>A hasted unit fills at this multiple of normal.</summary>
        public const double HASTE_FILL_MUL = 1.5;
        /// <summary>After acting, a unit's ATB resets to 0.</summary>
        public const int ATB_RESET = 0;

        // ---------------------------------------------------------------------
        // Party / crit tuning
        // ---------------------------------------------------------------------

        /// <summary>Maximum units allowed on each side.</summary>
        public const int MAX_PARTY = 8;
        public const int MAX_ENEMIES = 8;

        /// <summary>Base critical-hit chance and multiplier.</summary>
        public const double CRIT_CHANCE = 0.12;
        public const double CRIT_MULT = 1.6;

        /// <summary>A boss leads every Nth wave (re-exported from BattleScaling).</summary>
        public const int BOSS_EVERY = BattleScaling.BOSS_EVERY;

        // ---------------------------------------------------------------------
        // Status blueprints
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<StatusKind, StatusBlueprint> STATUS_BLUEPRINTS =
            new Dictionary<StatusKind, StatusBlueprint>
            {
                { StatusKind.Burn, new StatusBlueprint { Turns = 3, Potency = 6, Buff = false } },
                { StatusKind.Poison, new StatusBlueprint { Turns = 4, Potency = 4, Buff = false } },
                { StatusKind.Bleed, new StatusBlueprint { Turns = 4, Potency = 3, Buff = false } },
                { StatusKind.Slow, new StatusBlueprint { Turns = 2, Potency = 0, Buff = false } },
                { StatusKind.Freeze, new StatusBlueprint { Turns = 1, Potency = 0, Buff = false } },
                { StatusKind.Stun, new StatusBlueprint { Turns = 1, Potency = 0, Buff = false } },
                { StatusKind.Regen, new StatusBlueprint { Turns = 3, Potency = 5, Buff = true } },
                { StatusKind.Haste, new StatusBlueprint { Turns = 3, Potency = 0, Buff = true } },
                { StatusKind.Shield, new StatusBlueprint { Turns = 1, Potency = 0, Buff = true } },
                { StatusKind.Mark, new StatusBlueprint { Turns = 3, Potency = 0.3, Buff = false } },
            };

        // ---------------------------------------------------------------------
        // Hero abilities
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<HeroClass, AbilityDef[]> HERO_ABILITIES =
            new Dictionary<HeroClass, AbilityDef[]>
            {
                {
                    HeroClass.Knight, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Shield Slam", Cost = 20,
                            CooldownTurns = 1, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Physical, Damage = 35,
                            ApplyStatus = StatusKind.Stun, StatusChance = 0.4,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Guard", Cost = 0,
                            CooldownTurns = 2, Target = TargetMode.Self,
                            Element = ElementType.Physical, Damage = 0,
                            SelfStatus = StatusKind.Shield,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.E, Name = "Whirlwind", Cost = 40,
                            CooldownTurns = 3, Target = TargetMode.AllEnemies,
                            Element = ElementType.Physical, Damage = 25,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.R, Name = "Last Stand", Cost = 80,
                            CooldownTurns = 6, Target = TargetMode.Self,
                            Element = ElementType.Physical, Damage = 0,
                            HealPctSelf = 0.5, SelfStatus = StatusKind.Haste,
                        },
                    }
                },
                {
                    HeroClass.Ranger, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Pierce Shot", Cost = 15,
                            CooldownTurns = 1, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Physical, Damage = 45,
                            ArmorPierce = 0.5,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Volley", Cost = 30,
                            CooldownTurns = 2, Target = TargetMode.RandomEnemies,
                            Element = ElementType.Physical, Damage = 25, Hits = 3,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.E, Name = "Hunter's Mark", Cost = 20,
                            CooldownTurns = 2, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Physical, Damage = 0,
                            ApplyStatus = StatusKind.Mark,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.R, Name = "Rain of Arrows", Cost = 50,
                            CooldownTurns = 5, Target = TargetMode.AllEnemies,
                            Element = ElementType.Physical, Damage = 35,
                            ApplyStatus = StatusKind.Bleed,
                        },
                    }
                },
                {
                    HeroClass.Mage, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Arcane Bolt", Cost = 12,
                            CooldownTurns = 0, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Aether, Damage = 30,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Flameblast", Cost = 35,
                            CooldownTurns = 2, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Flame, Damage = 50,
                            ApplyStatus = StatusKind.Burn,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.E, Name = "Frost Nova", Cost = 30,
                            CooldownTurns = 3, Target = TargetMode.AllEnemies,
                            Element = ElementType.Ice, Damage = 25,
                            ApplyStatus = StatusKind.Freeze, StatusChance = 0.5,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.R, Name = "Tempest", Cost = 70,
                            CooldownTurns = 5, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Aether, Damage = 80, Splash = 40,
                        },
                    }
                },
            };

        // ---------------------------------------------------------------------
        // Hero stats
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<HeroClass, HeroClassStats> HERO_STATS =
            new Dictionary<HeroClass, HeroClassStats>
            {
                {
                    HeroClass.Knight, new HeroClassStats
                    {
                        MaxHp = 180, MaxResource = 100, ResourceRegen = 6,
                        Speed = 0.85, Defense = 0.25, Attack = 24,
                        Element = ElementType.Physical,
                    }
                },
                {
                    HeroClass.Ranger, new HeroClassStats
                    {
                        MaxHp = 120, MaxResource = 60, ResourceRegen = 4,
                        Speed = 1.15, Defense = 0.1, Attack = 20,
                        Element = ElementType.Physical,
                    }
                },
                {
                    HeroClass.Mage, new HeroClassStats
                    {
                        MaxHp = 90, MaxResource = 80, ResourceRegen = 5,
                        Speed = 1.0, Defense = 0.05, Attack = 16,
                        Element = ElementType.Aether,
                    }
                },
            };

        // ---------------------------------------------------------------------
        // Pet stats
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<PetSpecies, PetSpeciesStats> PET_STATS =
            new Dictionary<PetSpecies, PetSpeciesStats>
            {
                {
                    PetSpecies.AetherSprite, new PetSpeciesStats
                    {
                        MaxHp = 70, Attack = 22, Speed = 1.0,
                        Element = ElementType.Aether, MaxResource = 40, ResourceRegen = 5,
                    }
                },
                {
                    PetSpecies.FlamePup, new PetSpeciesStats
                    {
                        MaxHp = 90, Attack = 28, Speed = 0.95,
                        Element = ElementType.Flame, MaxResource = 40, ResourceRegen = 5,
                    }
                },
                {
                    PetSpecies.IceWolf, new PetSpeciesStats
                    {
                        MaxHp = 110, Attack = 18, Speed = 0.85,
                        Element = ElementType.Ice, MaxResource = 40, ResourceRegen = 5,
                    }
                },
            };

        // ---------------------------------------------------------------------
        // Pet abilities
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<PetSpecies, AbilityDef[]> PET_ABILITIES =
            new Dictionary<PetSpecies, AbilityDef[]>
            {
                {
                    PetSpecies.AetherSprite, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Twinspark", Cost = 14,
                            CooldownTurns = 1, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Aether, Damage = 26,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Heartbloom", Cost = 18,
                            CooldownTurns = 2, Target = TargetMode.AllAllies,
                            Element = ElementType.Aether, Damage = 0, Heal = 22,
                            ApplyStatus = StatusKind.Regen,
                        },
                    }
                },
                {
                    PetSpecies.FlamePup, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Emberbite", Cost = 14,
                            CooldownTurns = 1, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Flame, Damage = 30,
                            ApplyStatus = StatusKind.Burn,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Pyre Bond", Cost = 20,
                            CooldownTurns = 3, Target = TargetMode.AllEnemies,
                            Element = ElementType.Flame, Damage = 22,
                            ApplyStatus = StatusKind.Burn, StatusChance = 0.6,
                        },
                    }
                },
                {
                    PetSpecies.IceWolf, new[]
                    {
                        new AbilityDef
                        {
                            Slot = AbilitySlot.Q, Name = "Frostbite", Cost = 14,
                            CooldownTurns = 1, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Ice, Damage = 20,
                            ApplyStatus = StatusKind.Slow,
                        },
                        new AbilityDef
                        {
                            Slot = AbilitySlot.W, Name = "Glacial Bond", Cost = 22,
                            CooldownTurns = 3, Target = TargetMode.SingleEnemy,
                            Element = ElementType.Ice, Damage = 28,
                            ApplyStatus = StatusKind.Freeze, StatusChance = 0.5,
                        },
                    }
                },
            };

        // ---------------------------------------------------------------------
        // Items
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<ItemKind, ItemDef> ITEM_DEFS =
            new Dictionary<ItemKind, ItemDef>
            {
                {
                    ItemKind.Potion, new ItemDef
                    {
                        Kind = ItemKind.Potion, Name = "Healing Potion",
                        Heal = 40, Target = TargetMode.SingleAlly,
                    }
                },
                {
                    ItemKind.ManaCrystal, new ItemDef
                    {
                        Kind = ItemKind.ManaCrystal, Name = "Mana Crystal",
                        RestoreResource = 25, Target = TargetMode.SingleAlly,
                    }
                },
                {
                    ItemKind.Cleanse, new ItemDef
                    {
                        Kind = ItemKind.Cleanse, Name = "Cleanse",
                        Cleanse = true, Target = TargetMode.SingleAlly,
                    }
                },
            };

        // ---------------------------------------------------------------------
        // Enemy defs — keyed by string id
        // ---------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<string, EnemyDef> ENEMY_DEFS =
            new Dictionary<string, EnemyDef>
            {
                {
                    "goblin", new EnemyDef
                    {
                        Id = "goblin", Name = "Goblin", Archetype = EnemyArchetype.Grunt,
                        BaseHp = 60, BaseAttack = 14, Speed = 1.0, Defense = 0.05,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Reckless Swing", Damage = 22,
                            Target = TargetMode.SingleAlly,
                        },
                    }
                },
                {
                    "skeleton", new EnemyDef
                    {
                        Id = "skeleton", Name = "Skeleton", Archetype = EnemyArchetype.Grunt,
                        BaseHp = 70, BaseAttack = 16, Speed = 0.95, Defense = 0.1,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Bone Shard", Damage = 18,
                            Target = TargetMode.SingleAlly, ApplyStatus = StatusKind.Bleed,
                        },
                    }
                },
                {
                    "hollow-warrior", new EnemyDef
                    {
                        Id = "hollow-warrior", Name = "Hollow Warrior",
                        Archetype = EnemyArchetype.Grunt,
                        BaseHp = 110, BaseAttack = 22, Speed = 1.0, Defense = 0.18,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Shield Bash", Damage = 22,
                            Target = TargetMode.SingleAlly, ApplyStatus = StatusKind.Bleed,
                        },
                    }
                },
                {
                    "bruiser", new EnemyDef
                    {
                        Id = "bruiser", Name = "Bruiser", Archetype = EnemyArchetype.Tank,
                        BaseHp = 140, BaseAttack = 20, Speed = 0.75, Defense = 0.3,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Patch Up", Damage = 0,
                            Target = TargetMode.Self, SelfHeal = 40,
                        },
                    }
                },
                {
                    "necromancer", new EnemyDef
                    {
                        Id = "necromancer", Name = "Necromancer", Archetype = EnemyArchetype.Caster,
                        BaseHp = 85, BaseAttack = 18, Speed = 1.05, Defense = 0.1,
                        Element = ElementType.Aether,
                        Special = new EnemySpecial
                        {
                            Name = "Hex", Damage = 14, Target = TargetMode.AllAllies,
                            ApplyStatus = StatusKind.Poison, StatusChance = 0.7,
                        },
                    }
                },
                {
                    "hollow-captain", new EnemyDef
                    {
                        Id = "hollow-captain", Name = "Hollow Captain",
                        Archetype = EnemyArchetype.Tank,
                        BaseHp = 220, BaseAttack = 26, Speed = 0.9, Defense = 0.25,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Rallying Cry", Damage = 30,
                            Target = TargetMode.AllAllies,
                            ApplyStatus = StatusKind.Slow, StatusChance = 0.5,
                        },
                    }
                },
                {
                    "hollow-king", new EnemyDef
                    {
                        Id = "hollow-king", Name = "Hollow King",
                        Archetype = EnemyArchetype.Boss,
                        BaseHp = 420, BaseAttack = 34, Speed = 1.0, Defense = 0.3,
                        Element = ElementType.Aether,
                        Special = new EnemySpecial
                        {
                            Name = "Sovereign Wrath", Damage = 44,
                            Target = TargetMode.AllAllies,
                            ApplyStatus = StatusKind.Burn, StatusChance = 0.6,
                        },
                    }
                },
                {
                    "hollow-apprentice", new EnemyDef
                    {
                        Id = "hollow-apprentice",
                        Name = "The Apprentice of the Apothecary",
                        Archetype = EnemyArchetype.Boss,
                        BaseHp = 175, BaseAttack = 24, Speed = 1.0, Defense = 0.12,
                        Element = ElementType.Aether,
                        Special = new EnemySpecial
                        {
                            Name = "Tincture", Damage = 0,
                            Target = TargetMode.SingleAlly,
                            ApplyStatus = StatusKind.Slow, StatusChance = 1,
                        },
                    }
                },
                // --- Orc family (WO-481, combat-pivot V1 fight: leader + followers) ---
                {
                    "orc-warrior", new EnemyDef
                    {
                        Id = "orc-warrior", Name = "Orcish Warrior", Archetype = EnemyArchetype.Grunt,
                        BaseHp = 120, BaseAttack = 24, Speed = 1.0, Defense = 0.15,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Warleader's Cleave", Damage = 30,
                            Target = TargetMode.SingleAlly,
                        },
                    }
                },
                {
                    "orc-tank", new EnemyDef
                    {
                        Id = "orc-tank", Name = "Orcish Bulwark", Archetype = EnemyArchetype.Tank,
                        BaseHp = 190, BaseAttack = 18, Speed = 0.70, Defense = 0.35,
                        Element = ElementType.Physical,
                        Special = new EnemySpecial
                        {
                            Name = "Iron Brace", Damage = 0,
                            Target = TargetMode.Self, SelfHeal = 45,
                        },
                    }
                },
                {
                    "orc-mage", new EnemyDef
                    {
                        Id = "orc-mage", Name = "Orcish Mage", Archetype = EnemyArchetype.Caster,
                        BaseHp = 85, BaseAttack = 21, Speed = 1.10, Defense = 0.08,
                        Element = ElementType.Aether,
                        Special = new EnemySpecial
                        {
                            Name = "Spirit Bolt", Damage = 20, Target = TargetMode.SingleAlly,
                            ApplyStatus = StatusKind.Burn, StatusChance = 0.5,
                        },
                    }
                },
            };
    }
}
