// =============================================================================
// ATB Battle Engine — shared types
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/types.ts. String-literal unions become enums; the
// interfaces become plain classes (mutable where the engine mutates them).
// Type-only module — no behaviour.
//
// `EnumTokens` keeps the exact TS lowercase/hyphenated spellings, because they
// are interpolated verbatim into BattleLogEntry.Text and into cleanse logs.
// =============================================================================

using System.Collections.Generic;

namespace DeNelle.BattleATB.Engine
{
    // -------------------------------------------------------------------------
    // Core enums / unions
    // -------------------------------------------------------------------------

    /// <summary>Which side of the field a unit fights for. TS: 'party' | 'enemy'.</summary>
    public enum Side { Party, Enemy }

    /// <summary>The five action verbs. TS: 'attack' | 'ability' | 'item' | 'defend' | 'rally'.</summary>
    public enum ActionKind { Attack, Ability, Item, Defend, Rally }

    /// <summary>Ability slots — the Q/W/E/R hero kit. TS: 'q' | 'w' | 'e' | 'r'.</summary>
    public enum AbilitySlot { Q, W, E, R }

    /// <summary>Elemental damage type. TS: 'physical' | 'aether' | 'flame' | 'ice'.</summary>
    public enum ElementType { Physical, Aether, Flame, Ice }

    /// <summary>Status effects. TS: burn|poison|bleed|slow|freeze|stun|regen|haste|shield|mark.</summary>
    public enum StatusKind { Burn, Poison, Bleed, Slow, Freeze, Stun, Regen, Haste, Shield, Mark }

    /// <summary>Inventory item ids. TS strings: 'potion' | 'mana_crystal' | 'cleanse'.</summary>
    public enum ItemKind { Potion, ManaCrystal, Cleanse }

    /// <summary>Pet AI temperament. TS: 'aggressive' | 'defensive' | 'balanced'.</summary>
    public enum PetAiMode { Aggressive, Defensive, Balanced }

    /// <summary>Outcome of a resolved battle. TS `null` -&gt; <see cref="None"/>.</summary>
    public enum BattleOutcome { None, Victory, Defeat }

    /// <summary>
    /// Phase of the battle. TS: 'intro' | 'filling' | 'awaiting-input' |
    /// 'resolving' | 'ended'.
    /// </summary>
    public enum BattlePhase { Intro, Filling, AwaitingInput, Resolving, Ended }

    /// <summary>
    /// How an ability/attack picks its target(s). TS: 'single-enemy' |
    /// 'all-enemies' | 'random-enemies' | 'self' | 'single-ally' | 'all-allies'.
    /// </summary>
    public enum TargetMode { SingleEnemy, AllEnemies, RandomEnemies, Self, SingleAlly, AllAllies }

    /// <summary>Behaviour family that drives an enemy's AI. TS: grunt|caster|tank|boss.</summary>
    public enum EnemyArchetype { Grunt, Caster, Tank, Boss }

    /// <summary>Hero class (from src/content/story.ts). TS: 'mage' | 'knight' | 'ranger'.</summary>
    public enum HeroClass { Mage, Knight, Ranger }

    /// <summary>Pet species (from src/data/gameDesign.ts). TS: 'aether-sprite' | 'flame-pup' | 'ice-wolf'.</summary>
    public enum PetSpecies { AetherSprite, FlamePup, IceWolf }

    /// <summary>Unit kind — derived from TS BattleUnit.kind: 'hero' | 'pet' | 'enemy'.</summary>
    public enum UnitKind { Hero, Pet, Enemy }

    /// <summary>
    /// WO-169 P0 — per-member command source. A <see cref="Player"/> member pauses
    /// the engine for the input UI on its turn; an <see cref="AI"/> member runs the
    /// existing AI policy (<see cref="Ai.ChoosePetAction"/> / archetype logic). This
    /// is decoupled from <see cref="UnitKind"/> so the player can toggle ANY member
    /// (hero or recruit) to Command/Auto in Settings. Enemies are always AI.
    /// </summary>
    public enum ControlMode { Player, AI }

    /// <summary>
    /// Machine-readable battle-log event. Derived from the 14-member TS union on
    /// BattleLogEntry.event.
    /// </summary>
    public enum BattleLogEvent
    {
        BattleStart,
        TurnStart,
        Attack,
        Ability,
        Item,
        Defend,
        Rally,
        StatusTick,
        StatusApply,
        StatusExpire,
        Death,
        Skip,
        Victory,
        Defeat,
    }

    // -------------------------------------------------------------------------
    // Token helpers — exact TS string spellings for log interpolation
    // -------------------------------------------------------------------------

    /// <summary>
    /// Maps enum members back to their original TS string spelling. These tokens
    /// are interpolated verbatim into log text (e.g. "afflicted with burn") and
    /// into the cleanse "removed.join(', ')" list, so they MUST match TS exactly.
    /// </summary>
    public static class EnumTokens
    {
        public static string ToToken(this StatusKind kind)
        {
            switch (kind)
            {
                case StatusKind.Burn: return "burn";
                case StatusKind.Poison: return "poison";
                case StatusKind.Bleed: return "bleed";
                case StatusKind.Slow: return "slow";
                case StatusKind.Freeze: return "freeze";
                case StatusKind.Stun: return "stun";
                case StatusKind.Regen: return "regen";
                case StatusKind.Haste: return "haste";
                case StatusKind.Shield: return "shield";
                case StatusKind.Mark: return "mark";
                default: return "";
            }
        }

        public static string ToToken(this ElementType element)
        {
            switch (element)
            {
                case ElementType.Physical: return "physical";
                case ElementType.Aether: return "aether";
                case ElementType.Flame: return "flame";
                case ElementType.Ice: return "ice";
                default: return "";
            }
        }

        public static string ToToken(this ItemKind item)
        {
            switch (item)
            {
                case ItemKind.Potion: return "potion";
                case ItemKind.ManaCrystal: return "mana_crystal";
                case ItemKind.Cleanse: return "cleanse";
                default: return "";
            }
        }

        public static string ToToken(this Side side)
        {
            return side == Side.Party ? "party" : "enemy";
        }
    }

    // -------------------------------------------------------------------------
    // Status-effect tuning
    // -------------------------------------------------------------------------

    /// <summary>A live status effect riding on a unit. Mutable — the engine
    /// mutates Turns/Potency in tickStatuses and applyStatus.</summary>
    public sealed class StatusEffect
    {
        public StatusKind Kind;
        /// <summary>Turns remaining. Decrements at the start of the bearer's turn.</summary>
        public int Turns;
        /// <summary>Magnitude. Per-turn HP delta for damage/heal effects; for
        /// bleed this grows +1 each turn. (mark blueprint potency is 0.3.)</summary>
        public double Potency;

        public StatusEffect Clone()
        {
            return new StatusEffect { Kind = Kind, Turns = Turns, Potency = Potency };
        }
    }

    // -------------------------------------------------------------------------
    // Ability + item definitions
    // -------------------------------------------------------------------------

    /// <summary>
    /// A hero/pet ability — the Q/W/E/R kit. Immutable data class.
    /// All TS optional (?) fields become C# nullable. Do NOT default null
    /// numerics to 0 — the engine checks "damage == 0" and "heal &gt; 0" separately.
    /// </summary>
    public sealed class AbilityDef
    {
        public AbilitySlot Slot;
        public string Name;
        /// <summary>Resource cost.</summary>
        public int Cost;
        /// <summary>Turns of cooldown after use.</summary>
        public int CooldownTurns;
        public TargetMode Target;
        public ElementType Element;
        /// <summary>Base damage per hit (0 for pure-support abilities).</summary>
        public int Damage;
        /// <summary>Number of hits for random-enemies abilities.</summary>
        public int? Hits;
        /// <summary>Heal applied to each target (HP).</summary>
        public int? Heal;
        /// <summary>Fraction of self max HP healed (Knight R "Last Stand").</summary>
        public double? HealPctSelf;
        /// <summary>Status applied to each damaged/targeted unit.</summary>
        public StatusKind? ApplyStatus;
        /// <summary>Probability the status lands (default 1).</summary>
        public double? StatusChance;
        /// <summary>Status applied to the caster (e.g. Haste self).</summary>
        public StatusKind? SelfStatus;
        /// <summary>Fraction of target Defense ignored (Ranger Q "Pierce Shot").</summary>
        public double? ArmorPierce;
        /// <summary>Splash damage to units adjacent to the primary target (Mage R).</summary>
        public int? Splash;
    }

    /// <summary>Item effects. Immutable. Target is always SingleAlly.</summary>
    public sealed class ItemDef
    {
        public ItemKind Kind;
        public string Name;
        /// <summary>HP restored to the target ally.</summary>
        public int? Heal;
        /// <summary>Resource restored to the target ally.</summary>
        public int? RestoreResource;
        /// <summary>True if the item strips all non-buff statuses.</summary>
        public bool? Cleanse;
        public TargetMode Target;
    }

    /// <summary>A special move an enemy may use instead of a basic attack.</summary>
    public sealed class EnemySpecial
    {
        public string Name;
        public int Damage;
        public TargetMode Target;
        public StatusKind? ApplyStatus;
        public double? StatusChance;
        /// <summary>Self-heal HP (tank "patch up").</summary>
        public int? SelfHeal;
    }

    /// <summary>A blueprint for one enemy type. Immutable.</summary>
    public sealed class EnemyDef
    {
        public string Id;
        public string Name;
        public EnemyArchetype Archetype;
        /// <summary>Pre-scaling base HP.</summary>
        public int BaseHp;
        /// <summary>Pre-scaling base attack.</summary>
        public int BaseAttack;
        public double Speed;
        public double Defense;
        public ElementType Element;
        /// <summary>A special move the enemy may use — nullable.</summary>
        public EnemySpecial Special;
    }

    // -------------------------------------------------------------------------
    // Unit / battle state
    // -------------------------------------------------------------------------

    /// <summary>A single combatant on the field. Mutable — the engine mutates
    /// it in place.</summary>
    public sealed class BattleUnit
    {
        public string Id;
        public Side Side;
        public string Name;
        public UnitKind Kind;

        /// <summary>
        /// WO-169 P0 — who drives this unit's turn. Set at build time from the
        /// party-member spec (hero/recruits default Player; pets default AI; enemies
        /// always AI). Read by <see cref="Turn.IsPlayerControlled"/> — replaces the
        /// old hard-tie to <see cref="UnitKind.Hero"/>. Does NOT participate in any
        /// RNG draw or damage calc, so it cannot perturb determinism.
        /// </summary>
        public ControlMode ControlMode;

        public int Hp;
        public int MaxHp;
        public int Resource;
        public int MaxResource;
        public int ResourceRegen;

        /// <summary>ATB-bar value, 0..ATB_FULL.</summary>
        public double Atb;
        /// <summary>ATB fill speed multiplier (before haste/slow status).</summary>
        public double Speed;
        /// <summary>Incoming-damage reduction fraction.</summary>
        public double Defense;
        /// <summary>Basic-attack base damage.</summary>
        public int Attack;
        public ElementType Element;

        public List<StatusEffect> Statuses;
        public Dictionary<AbilitySlot, int> Cooldowns;
        public bool Defending;
        public bool Alive;

        // hero / pet only
        public HeroClass? HeroClass;
        public PetSpecies? Species;
        /// <summary>Pet bond rank 0..4.</summary>
        public int? BondRank;
        public PetAiMode? AiMode;

        // enemy only
        public EnemyArchetype? Archetype;
        public string EnemyDefId;
    }

    /// <summary>A pet sitting on the bench that the player may Rally in.</summary>
    public sealed class RallyReserveUnit
    {
        public PetSpecies Species;
        public string Name;
        public int BondRank;
        public PetAiMode AiMode;

        public RallyReserveUnit Clone()
        {
            return new RallyReserveUnit
            {
                Species = Species,
                Name = Name,
                BondRank = BondRank,
                AiMode = AiMode,
            };
        }
    }

    /// <summary>A line in the battle log.</summary>
    public sealed class BattleLogEntry
    {
        /// <summary>Monotonic turn counter at the time the entry was produced.</summary>
        public int Turn;
        /// <summary>May be null.</summary>
        public string SourceId;
        /// <summary>May be null.</summary>
        public string TargetId;
        public BattleLogEvent Event;
        public string Text;
        /// <summary>Damage dealt (positive) or healing (negative), when relevant.</summary>
        public int? Amount;
        /// <summary>True if the hit was a critical.</summary>
        public bool? Crit;
        /// <summary>Status involved, when relevant.</summary>
        public StatusKind? Status;
        /// <summary>Damage element of the strike, when relevant. LOG METADATA ONLY
        /// (owner VFX picks 2026-08-16 - the presentation layer keys element-typed
        /// impact VFX off this; the engine never reads it back).</summary>
        public ElementType? Element;

        public BattleLogEntry Clone()
        {
            return new BattleLogEntry
            {
                Turn = Turn,
                SourceId = SourceId,
                TargetId = TargetId,
                Event = Event,
                Text = Text,
                Amount = Amount,
                Crit = Crit,
                Status = Status,
                Element = Element,
            };
        }
    }

    /// <summary>The complete, serialisable state of one ATB battle. Mutable.</summary>
    public sealed class BattleState
    {
        /// <summary>Wave that triggered this battle (drives enemy scaling).</summary>
        public int Wave;
        public BattlePhase Phase;
        public BattleOutcome Outcome;

        /// <summary>All combatants — party first, then enemies.</summary>
        public List<BattleUnit> Units;
        /// <summary>Pets on the bench, available to Rally.</summary>
        public List<RallyReserveUnit> Reserve;

        /// <summary>Id of the unit whose turn it is, or null while filling.</summary>
        public string ActiveUnitId;
        /// <summary>Monotonic counter — increments once per unit turn.</summary>
        public int TurnCounter;

        /// <summary>RNG cursor — snapshot/restore this to replay a battle.</summary>
        public Rng Rng;

        /// <summary>Shared inventory carried into the battle.</summary>
        public Dictionary<ItemKind, int> Inventory;

        /// <summary>Append-only event log.</summary>
        public List<BattleLogEntry> Log;

        /// <summary>Anti-frustration: +party HP buff applied at setup.</summary>
        public bool ReinforcementsApplied;
    }

    // -------------------------------------------------------------------------
    // Battle setup
    // -------------------------------------------------------------------------

    /// <summary>One breached enemy snapshotted from the 3D sim.</summary>
    public sealed class BreachEnemySpec
    {
        /// <summary>Enemy def id — must be a key of ENEMY_DEFS.</summary>
        public string DefId;
        /// <summary>Optional HP override. Null = roll full scaled HP.</summary>
        public int? Hp;
        /// <summary>Carried-over statuses from the 3D phase. Nullable.</summary>
        public List<StatusEffect> Statuses;
    }

    /// <summary>A pet the player owns, as handed to the engine at battle setup.</summary>
    public sealed class PartyPetSpec
    {
        public PetSpecies Species;
        public string Name;
        public int BondRank;
        public PetAiMode AiMode;
        /// <summary>When false the pet starts on the bench and must be Rallied in.</summary>
        public bool JoinsImmediately;
    }

    /// <summary>
    /// WO-169 P0 — one PLAYABLE party member as handed to the engine at setup. This
    /// is the multi-member party record the controller surfaces (hero + recruits +
    /// pets), each carrying its own <see cref="ControlMode"/>. A member is either a
    /// hero-class fighter (<see cref="HeroClass"/> set) or a pet
    /// (<see cref="Species"/> set) — exactly one is non-null. The engine keeps the
    /// existing per-kind stat/ability tables; this only chooses WHICH unit builder
    /// runs and stamps the member's id + control mode. Does not alter any math.
    /// </summary>
    public sealed class PartyMemberSpec
    {
        /// <summary>Stable unique id (e.g. "hero", "pet-0", "member-2"). Drives the
        /// HUD card key + the persisted control-mode preference.</summary>
        public string Id;
        public string Name;
        /// <summary>Set for a hero-class fighter; null for a pet member.</summary>
        public HeroClass? HeroClass;
        /// <summary>Set for a pet member; null for a hero-class fighter.</summary>
        public PetSpecies? Species;
        /// <summary>Pet bond rank 0..4 (ignored for hero-class members).</summary>
        public int BondRank;
        /// <summary>Pet AI temperament (ignored for hero-class members).</summary>
        public PetAiMode AiMode;
        /// <summary>Player-commanded or AI-driven this battle. Toggled in Settings.</summary>
        public ControlMode ControlMode;
    }

    /// <summary>Everything needed to construct a battle.</summary>
    public sealed class BattleSetup
    {
        public int Wave;
        /// <summary>Documented assumption: a non-negative 32-bit integer seed.</summary>
        public int Seed;

        /// <summary>
        /// WO-169 — the multi-member party (hero + recruits/pets), each with its own
        /// control mode. When NON-EMPTY this is authoritative and supersedes the
        /// legacy <see cref="HeroClass"/>/<see cref="HeroName"/>/<see cref="Pets"/>
        /// triple. When null/empty the engine falls back to the legacy single-hero +
        /// Pets path below — that fallback is byte-identical to the pre-WO-169
        /// construction, which is why the RNG golden vectors are unaffected.
        /// </summary>
        public List<PartyMemberSpec> PartyMembers;

        public HeroClass HeroClass;
        public string HeroName;
        public List<PartyPetSpec> Pets;
        public List<BreachEnemySpec> Enemies;
        /// <summary>Shared item inventory carried in. Nullable.</summary>
        public Dictionary<ItemKind, int> Inventory;
        /// <summary>Anti-frustration buff: true after 3 consecutive ATB losses. Nullable.</summary>
        public bool? Reinforcements;
    }

    // -------------------------------------------------------------------------
    // Damage calculation
    // -------------------------------------------------------------------------

    /// <summary>Inputs for a single damage calculation.</summary>
    public sealed class DamageInput
    {
        public BattleUnit Attacker;
        public BattleUnit Target;
        /// <summary>Base power before any modifiers.</summary>
        public int BasePower;
        public ElementType Element;
        /// <summary>Fraction of target defense ignored (0..1). Nullable.</summary>
        public double? ArmorPierce;
        /// <summary>When false, never rolls a crit. Nullable.</summary>
        public bool? CanCrit;
        public Rng Rng;
    }

    /// <summary>Result of resolving damage against a unit. Not mutated — a struct.</summary>
    public struct DamageResult
    {
        /// <summary>Final HP removed after all mitigation.</summary>
        public int Damage;
        public bool Crit;
        /// <summary>True if a Shield buff soaked the hit entirely.</summary>
        public bool Shielded;
    }

    // -------------------------------------------------------------------------
    // Action resolution
    // -------------------------------------------------------------------------

    /// <summary>
    /// A fully-specified action chosen for the active unit. TS is a discriminated
    /// union of 5 shapes; ported here as one class with an <see cref="ActionKind"/>
    /// discriminant + nullable payload fields, matching the switch in applyAction.
    /// </summary>
    public sealed class BattleAction
    {
        public ActionKind Kind;
        /// <summary>attack / item / ability(optional) target id.</summary>
        public string TargetId;
        /// <summary>ability slot.</summary>
        public AbilitySlot? Slot;
        /// <summary>item kind.</summary>
        public ItemKind? Item;
        /// <summary>rally reserve index.</summary>
        public int ReserveIndex;

        public static BattleAction MakeAttack(string targetId)
        {
            return new BattleAction { Kind = ActionKind.Attack, TargetId = targetId };
        }

        public static BattleAction MakeAbility(AbilitySlot slot, string targetId = null)
        {
            return new BattleAction { Kind = ActionKind.Ability, Slot = slot, TargetId = targetId };
        }

        public static BattleAction MakeItem(ItemKind item, string targetId)
        {
            return new BattleAction { Kind = ActionKind.Item, Item = item, TargetId = targetId };
        }

        public static BattleAction MakeDefend()
        {
            return new BattleAction { Kind = ActionKind.Defend };
        }

        public static BattleAction MakeRally(int reserveIndex)
        {
            return new BattleAction { Kind = ActionKind.Rally, ReserveIndex = reserveIndex };
        }
    }

    // -------------------------------------------------------------------------
    // Shared port helpers
    // -------------------------------------------------------------------------

    /// <summary>Cross-cutting helpers used throughout the port.</summary>
    public static class PortMath
    {
        /// <summary>
        /// Half-up rounding matching JS <c>Math.round</c> (round-half-up toward
        /// +infinity). C# <c>Math.Round</c> uses banker's rounding which would
        /// diverge — see flag F-STATE-1. Use this everywhere TS used Math.round.
        /// </summary>
        public static int RoundTs(double x)
        {
            return (int)System.Math.Floor(x + 0.5);
        }
    }
}
