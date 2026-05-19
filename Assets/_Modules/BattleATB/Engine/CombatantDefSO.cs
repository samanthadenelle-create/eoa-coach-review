// =============================================================================
// ATB Battle Engine — optional ScriptableObject combatant definitions
// -----------------------------------------------------------------------------
// Designer-tunable mirrors of the static tables in Defs.cs (port-notes §4
// option B). These are OPTIONAL: the pure-logic engine never reads them — it
// reads `Defs` directly. Author SO instances so their serialized values exactly
// equal the Defs tables, then read them through `CombatantDefSO.ToAbilityDef`
// etc. to feed an alternative `Defs` facade if Inspector tuning is desired.
//
// This is the only Engine file that depends on UnityEngine.
// =============================================================================

using UnityEngine;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>
    /// Inspector-authorable ability definition. Mirrors <see cref="AbilityDef"/>.
    /// Optional numerics are exposed as a value + "has" toggle so the Inspector
    /// can faithfully represent the TS nullable fields (a 0 must not be confused
    /// with "absent").
    /// </summary>
    [CreateAssetMenu(
        fileName = "AbilityDefSO",
        menuName = "DeNelle/BattleATB/Ability Def")]
    public sealed class AbilityDefSO : ScriptableObject
    {
        public AbilitySlot slot;
        public string abilityName;
        public int cost;
        public int cooldownTurns;
        public TargetMode target;
        public ElementType element;
        public int damage;

        [Header("Optional — toggle 'has' to enable")]
        public bool hasHits;
        public int hits;
        public bool hasHeal;
        public int heal;
        public bool hasHealPctSelf;
        public double healPctSelf;
        public bool hasApplyStatus;
        public StatusKind applyStatus;
        public bool hasStatusChance;
        public double statusChance;
        public bool hasSelfStatus;
        public StatusKind selfStatus;
        public bool hasArmorPierce;
        public double armorPierce;
        public bool hasSplash;
        public int splash;

        /// <summary>Convert this SO into the engine's immutable AbilityDef.</summary>
        public AbilityDef ToAbilityDef()
        {
            return new AbilityDef
            {
                Slot = slot,
                Name = abilityName,
                Cost = cost,
                CooldownTurns = cooldownTurns,
                Target = target,
                Element = element,
                Damage = damage,
                Hits = hasHits ? (int?)hits : null,
                Heal = hasHeal ? (int?)heal : null,
                HealPctSelf = hasHealPctSelf ? (double?)healPctSelf : null,
                ApplyStatus = hasApplyStatus ? (StatusKind?)applyStatus : null,
                StatusChance = hasStatusChance ? (double?)statusChance : null,
                SelfStatus = hasSelfStatus ? (StatusKind?)selfStatus : null,
                ArmorPierce = hasArmorPierce ? (double?)armorPierce : null,
                Splash = hasSplash ? (int?)splash : null,
            };
        }
    }

    /// <summary>
    /// Inspector-authorable enemy definition. Mirrors <see cref="EnemyDef"/> +
    /// the nested <see cref="EnemySpecial"/>.
    /// </summary>
    [CreateAssetMenu(
        fileName = "EnemyDefSO",
        menuName = "DeNelle/BattleATB/Enemy Def")]
    public sealed class EnemyDefSO : ScriptableObject
    {
        public string id;
        public string enemyName;
        public EnemyArchetype archetype;
        public int baseHp;
        public int baseAttack;
        public double speed;
        public double defense;
        public ElementType element;

        [Header("Special move — toggle to enable")]
        public bool hasSpecial;
        public string specialName;
        public int specialDamage;
        public TargetMode specialTarget;
        public bool specialHasApplyStatus;
        public StatusKind specialApplyStatus;
        public bool specialHasStatusChance;
        public double specialStatusChance;
        public bool specialHasSelfHeal;
        public int specialSelfHeal;

        /// <summary>Convert this SO into the engine's immutable EnemyDef.</summary>
        public EnemyDef ToEnemyDef()
        {
            return new EnemyDef
            {
                Id = id,
                Name = enemyName,
                Archetype = archetype,
                BaseHp = baseHp,
                BaseAttack = baseAttack,
                Speed = speed,
                Defense = defense,
                Element = element,
                Special = hasSpecial
                    ? new EnemySpecial
                    {
                        Name = specialName,
                        Damage = specialDamage,
                        Target = specialTarget,
                        ApplyStatus = specialHasApplyStatus
                            ? (StatusKind?)specialApplyStatus
                            : null,
                        StatusChance = specialHasStatusChance
                            ? (double?)specialStatusChance
                            : null,
                        SelfHeal = specialHasSelfHeal
                            ? (int?)specialSelfHeal
                            : null,
                    }
                    : null,
            };
        }
    }

    /// <summary>
    /// Inspector-authorable hero-class stat block. Mirrors
    /// <see cref="HeroClassStats"/>.
    /// </summary>
    [CreateAssetMenu(
        fileName = "HeroStatsSO",
        menuName = "DeNelle/BattleATB/Hero Stats")]
    public sealed class HeroStatsSO : ScriptableObject
    {
        public HeroClass heroClass;
        public int maxHp;
        public int maxResource;
        public int resourceRegen;
        public double speed;
        public double defense;
        public int attack;
        public ElementType element;

        public HeroClassStats ToStats()
        {
            return new HeroClassStats
            {
                MaxHp = maxHp,
                MaxResource = maxResource,
                ResourceRegen = resourceRegen,
                Speed = speed,
                Defense = defense,
                Attack = attack,
                Element = element,
            };
        }
    }

    /// <summary>
    /// Inspector-authorable pet-species stat block. Mirrors
    /// <see cref="PetSpeciesStats"/>.
    /// </summary>
    [CreateAssetMenu(
        fileName = "PetStatsSO",
        menuName = "DeNelle/BattleATB/Pet Stats")]
    public sealed class PetStatsSO : ScriptableObject
    {
        public PetSpecies species;
        public int maxHp;
        public int attack;
        public double speed;
        public ElementType element;
        public int maxResource;
        public int resourceRegen;

        public PetSpeciesStats ToStats()
        {
            return new PetSpeciesStats
            {
                MaxHp = maxHp,
                Attack = attack,
                Speed = speed,
                Element = element,
                MaxResource = maxResource,
                ResourceRegen = resourceRegen,
            };
        }
    }
}
