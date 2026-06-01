// =============================================================================
// ATB Battle Engine — battle construction + small state helpers
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/state.ts. Bond helpers, unit builders, battle
// construction, and pure read helpers over BattleState. No damage / status /
// action logic here.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.Defs;
using static DeNelle.BattleATB.Engine.PortMath;
using static DeNelle.BattleATB.Engine.RngOps;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Battle construction + pure read helpers.</summary>
    public static class BattleStateOps
    {
        // ---------------------------------------------------------------------
        // Bond helpers
        // ---------------------------------------------------------------------

        /// <summary>Pet damage multiplier from bond rank — +18% per rank.</summary>
        public static double PetBondDamageMul(int bondRank)
        {
            return 1 + 0.18 * Math.Max(0, Math.Min(4, bondRank));
        }

        /// <summary>Pet HP multiplier from bond rank — +12% per rank.</summary>
        public static double PetBondHpMul(int bondRank)
        {
            return 1 + 0.12 * Math.Max(0, Math.Min(4, bondRank));
        }

        /// <summary>How many abilities a pet has unlocked at the given bond rank.</summary>
        public static int PetUnlockedAbilityCount(int bondRank)
        {
            if (bondRank >= 2) return 2;
            if (bondRank >= 1) return 1;
            return 0;
        }

        // ---------------------------------------------------------------------
        // Unit builders
        // ---------------------------------------------------------------------

        /// <summary>Build the hero unit. Legacy entry — stamps Player control.</summary>
        public static BattleUnit BuildHeroUnit(BattleSetup setup, bool reinforced)
        {
            return BuildHeroUnit(setup.HeroClass, setup.HeroName, "hero", ControlMode.Player, reinforced);
        }

        /// <summary>
        /// WO-169 — build a hero-class fighter with an explicit id + control mode
        /// (used by the multi-member party path). Stats/abilities are unchanged; only
        /// the id and <see cref="BattleUnit.ControlMode"/> are parameterised. The
        /// legacy overload above forwards here with id="hero" + Player, so the
        /// single-hero path is byte-identical to before (golden test unaffected).
        /// </summary>
        public static BattleUnit BuildHeroUnit(
            HeroClass heroClass, string name, string id, ControlMode controlMode, bool reinforced)
        {
            HeroClassStats stats = HERO_STATS[heroClass];
            // F-STATE-1: Math.round -> RoundTs (half-up).
            int maxHp = RoundTs(stats.MaxHp * (reinforced ? 1.3 : 1));
            return new BattleUnit
            {
                Id = id,
                Side = Side.Party,
                Name = name,
                Kind = UnitKind.Hero,
                ControlMode = controlMode,
                Hp = maxHp,
                MaxHp = maxHp,
                Resource = stats.MaxResource,
                MaxResource = stats.MaxResource,
                ResourceRegen = stats.ResourceRegen,
                Atb = 0,
                Speed = stats.Speed,
                Defense = stats.Defense,
                Attack = stats.Attack,
                Element = stats.Element,
                Statuses = new List<StatusEffect>(),
                Cooldowns = new Dictionary<AbilitySlot, int>(),
                Defending = false,
                Alive = true,
                HeroClass = heroClass,
            };
        }

        /// <summary>Build a pet unit from its species + bond rank. Legacy entry —
        /// stamps AI control + the conventional <c>pet-{index}</c> id.</summary>
        public static BattleUnit BuildPetUnit(PartyPetSpec spec, int index, bool reinforced)
        {
            return BuildPetUnit(
                spec.Species, spec.Name, spec.BondRank, spec.AiMode,
                $"pet-{index}", ControlMode.AI, reinforced);
        }

        /// <summary>
        /// WO-169 — build a pet unit with an explicit id + control mode (multi-member
        /// path). Stat math is unchanged; only the id and
        /// <see cref="BattleUnit.ControlMode"/> are parameterised. The legacy overload
        /// forwards here with <c>pet-{index}</c> + AI, so the existing pet path is
        /// byte-identical (golden test unaffected).
        /// </summary>
        public static BattleUnit BuildPetUnit(
            PetSpecies species, string name, int bondRank, PetAiMode aiMode,
            string id, ControlMode controlMode, bool reinforced)
        {
            PetSpeciesStats stats = PET_STATS[species];
            // F-STATE-1: Math.round -> RoundTs.
            int maxHp = RoundTs(stats.MaxHp * PetBondHpMul(bondRank) * (reinforced ? 1.3 : 1));
            return new BattleUnit
            {
                Id = id,
                Side = Side.Party,
                Name = name,
                Kind = UnitKind.Pet,
                ControlMode = controlMode,
                Hp = maxHp,
                MaxHp = maxHp,
                Resource = stats.MaxResource,
                MaxResource = stats.MaxResource,
                ResourceRegen = stats.ResourceRegen,
                Atb = 0,
                Speed = stats.Speed,
                // defense is hard-coded 0.1 in TS — NOT taken from stats.
                Defense = 0.1,
                Attack = RoundTs(stats.Attack * PetBondDamageMul(bondRank)),
                Element = stats.Element,
                Statuses = new List<StatusEffect>(),
                Cooldowns = new Dictionary<AbilitySlot, int>(),
                Defending = false,
                Alive = true,
                Species = species,
                BondRank = bondRank,
                AiMode = aiMode,
            };
        }

        /// <summary>Build an enemy unit from a breach spec, applying wave scaling.</summary>
        public static BattleUnit BuildEnemyUnit(BreachEnemySpec spec, int index, int wave)
        {
            if (!ENEMY_DEFS.TryGetValue(spec.DefId, out EnemyDef def) || def == null)
            {
                throw new Exception($"Unknown enemy def id: {spec.DefId}");
            }
            WaveScaling scaling = BattleScaling.WaveScaling(wave);
            bool boss = def.Archetype == EnemyArchetype.Boss && BattleScaling.IsBossWave(wave);
            double hpMul = scaling.HpMul * (boss ? BattleScaling.BossHpMul(wave) : 1);
            // F-STATE-1: Math.round -> RoundTs.
            int maxHp = RoundTs(def.BaseHp * hpMul);
            int attack = RoundTs(def.BaseAttack * scaling.HeartDmgMul);
            return new BattleUnit
            {
                Id = $"enemy-{index}",
                Side = Side.Enemy,
                Name = def.Name,
                Kind = UnitKind.Enemy,
                ControlMode = ControlMode.AI, // enemies are always engine-driven
                Hp = spec.Hp != null ? Math.Max(1, Math.Min(spec.Hp.Value, maxHp)) : maxHp,
                MaxHp = maxHp,
                Resource = 0,
                MaxResource = 0,
                ResourceRegen = 0,
                Atb = 0,
                Speed = def.Speed * scaling.SpeedMul,
                Defense = def.Defense,
                Attack = attack,
                Element = def.Element,
                // Deep copy of carried-over statuses (TS .map(s => ({...s}))).
                Statuses = spec.Statuses != null
                    ? spec.Statuses.Select(s => s.Clone()).ToList()
                    : new List<StatusEffect>(),
                Cooldowns = new Dictionary<AbilitySlot, int>(),
                Defending = false,
                Alive = true,
                Archetype = def.Archetype,
                EnemyDefId = def.Id,
            };
        }

        // ---------------------------------------------------------------------
        // Battle setup
        // ---------------------------------------------------------------------

        /// <summary>Construct a fresh BattleState from a setup.</summary>
        public static BattleState CreateBattle(BattleSetup setup)
        {
            bool reinforced = setup.Reinforcements == true;

            // WO-169 — when the controller supplies an explicit multi-member party,
            // build from it (each member carries its own id + ControlMode). Otherwise
            // fall back to the legacy single-hero + Pets construction, which is
            // byte-identical to the pre-WO-169 engine (golden vectors unaffected).
            bool useMultiMember = setup.PartyMembers != null && setup.PartyMembers.Count > 0;

            BattleUnit hero;
            List<BattleUnit> petUnits;
            List<PartyPetSpec> benched;

            if (useMultiMember)
            {
                // The members list is authoritative + already capped/ordered by the
                // controller. Cap defensively at MAX_PARTY. Hero-class members build
                // as heroes; pet members build as pets — both honour their stored id +
                // control mode. No benched reserve in the multi-member path.
                List<PartyMemberSpec> members = setup.PartyMembers.Take(MAX_PARTY).ToList();
                hero = null;
                petUnits = new List<BattleUnit>();
                foreach (PartyMemberSpec m in members)
                {
                    if (m.Species != null)
                    {
                        petUnits.Add(BuildPetUnit(
                            m.Species.Value, m.Name, m.BondRank, m.AiMode,
                            m.Id, m.ControlMode, reinforced));
                    }
                    else
                    {
                        BattleUnit u = BuildHeroUnit(
                            m.HeroClass ?? setup.HeroClass, m.Name, m.Id, m.ControlMode, reinforced);
                        // The first hero-class member anchors the "hero" slot for
                        // ordering; further hero-class members ride in the pet list
                        // slot (still Party side, still a real combatant).
                        if (hero == null) hero = u; else petUnits.Add(u);
                    }
                }
                // Degenerate guard: a party of pets only — promote the first to anchor.
                if (hero == null && petUnits.Count > 0)
                {
                    hero = petUnits[0];
                    petUnits.RemoveAt(0);
                }
                benched = new List<PartyPetSpec>();
            }
            else
            {
                hero = BuildHeroUnit(setup, reinforced);
                // joining pets get MAX_PARTY - 1 slots (hero takes the 8th).
                List<PartyPetSpec> joining = setup.Pets
                    .Where(p => p.JoinsImmediately)
                    .Take(MAX_PARTY - 1)
                    .ToList();
                benched = setup.Pets
                    .Where(p => !p.JoinsImmediately)
                    .ToList();
                petUnits = joining
                    .Select((p, i) => BuildPetUnit(p, i, reinforced))
                    .ToList();
            }

            List<BattleUnit> enemyUnits = setup.Enemies
                .Take(MAX_ENEMIES)
                .Select((e, i) => BuildEnemyUnit(e, i, setup.Wave))
                .ToList();

            // ?? 0 per key: only null/absent is missing — 0 is a real value.
            var inventory = new Dictionary<ItemKind, int>
            {
                { ItemKind.Potion, InvLookup(setup.Inventory, ItemKind.Potion) },
                { ItemKind.ManaCrystal, InvLookup(setup.Inventory, ItemKind.ManaCrystal) },
                { ItemKind.Cleanse, InvLookup(setup.Inventory, ItemKind.Cleanse) },
            };

            List<RallyReserveUnit> reserve = benched
                .Select(p => new RallyReserveUnit
                {
                    Species = p.Species,
                    Name = p.Name,
                    BondRank = p.BondRank,
                    AiMode = p.AiMode,
                })
                .ToList();

            var units = new List<BattleUnit>();
            units.Add(hero);
            units.AddRange(petUnits);
            units.AddRange(enemyUnits);

            var state = new BattleState
            {
                Wave = setup.Wave,
                Phase = BattlePhase.Intro,
                Outcome = BattleOutcome.None,
                Units = units,
                Reserve = reserve,
                ActiveUnitId = null,
                TurnCounter = 0,
                Rng = CreateRng(setup.Seed),
                Inventory = inventory,
                Log = new List<BattleLogEntry>(),
                ReinforcementsApplied = reinforced,
            };

            PushLog(state, new BattleLogEntry
            {
                Turn = 0,
                SourceId = null,
                TargetId = null,
                Event = BattleLogEvent.BattleStart,
                Text = reinforced
                    ? "The last stand begins — reinforcements bolster the party."
                    : "The last stand begins.",
            });

            return state;
        }

        /// <summary>Inventory lookup with TS `?? 0` semantics (null/absent -&gt; 0).</summary>
        private static int InvLookup(Dictionary<ItemKind, int> inv, ItemKind key)
        {
            if (inv != null && inv.TryGetValue(key, out int v)) return v;
            return 0;
        }

        // ---------------------------------------------------------------------
        // Small state helpers
        // ---------------------------------------------------------------------

        public static void PushLog(BattleState state, BattleLogEntry entry)
        {
            state.Log.Add(entry);
        }

        /// <summary>Find a unit by id, or null.</summary>
        public static BattleUnit GetUnit(BattleState state, string id)
        {
            return state.Units.FirstOrDefault(u => u.Id == id);
        }

        /// <summary>All living units on a side. Order-preserving.</summary>
        public static List<BattleUnit> LivingUnits(BattleState state, Side side)
        {
            return state.Units.Where(u => u.Side == side && u.Alive).ToList();
        }

        /// <summary>
        /// The living enemy with the lowest current HP. Earliest-index wins ties.
        /// Exported but not used inside the engine — UI helper. Ported anyway.
        /// </summary>
        public static BattleUnit LowestHpEnemy(BattleState state)
        {
            List<BattleUnit> foes = LivingUnits(state, Side.Enemy);
            if (foes.Count == 0) return null;
            return foes.Aggregate(foes[0], (lo, f) => f.Hp < lo.Hp ? f : lo);
        }

        /// <summary>True if a unit currently has the given status.</summary>
        public static bool HasStatus(BattleUnit unit, StatusKind kind)
        {
            return unit.Statuses.Any(s => s.Kind == kind && s.Turns > 0);
        }

        /// <summary>The ATB fill multiplier from a unit's haste/slow statuses.</summary>
        public static double StatusFillMul(BattleUnit unit)
        {
            double mul = 1;
            if (HasStatus(unit, StatusKind.Haste)) mul *= HASTE_FILL_MUL;
            if (HasStatus(unit, StatusKind.Slow)) mul *= SLOW_FILL_MUL;
            return mul;
        }

        /// <summary>True once one side has been wiped out.</summary>
        public static bool IsBattleOver(BattleState state)
        {
            return LivingUnits(state, Side.Party).Count == 0
                || LivingUnits(state, Side.Enemy).Count == 0;
        }

        /// <summary>Compute (don't set) the current outcome.</summary>
        public static BattleOutcome ComputeOutcome(BattleState state)
        {
            bool partyAlive = LivingUnits(state, Side.Party).Count > 0;
            bool enemiesAlive = LivingUnits(state, Side.Enemy).Count > 0;
            if (!enemiesAlive && partyAlive) return BattleOutcome.Victory;
            if (!partyAlive) return BattleOutcome.Defeat;
            return BattleOutcome.None;
        }

        // ---------------------------------------------------------------------
        // Abilities available to a unit
        // ---------------------------------------------------------------------

        /// <summary>The ability defs a unit can currently choose (cost+cd gated).</summary>
        public static List<AbilityDef> AvailableAbilities(BattleUnit unit)
        {
            List<AbilityDef> all = UnitAbilityKit(unit);
            return all
                .Where(a => unit.Resource >= a.Cost && CooldownOf(unit, a.Slot) <= 0)
                .ToList();
        }

        /// <summary>The full ability kit a unit owns (ignores cost/cooldown).</summary>
        public static List<AbilityDef> UnitAbilityKit(BattleUnit unit)
        {
            if (unit.Kind == UnitKind.Hero && unit.HeroClass != null)
            {
                return HERO_ABILITIES[unit.HeroClass.Value].ToList();
            }
            if (unit.Kind == UnitKind.Pet && unit.Species != null)
            {
                int unlocked = PetUnlockedAbilityCount(unit.BondRank ?? 0);
                return PET_ABILITIES[unit.Species.Value].Take(unlocked).ToList();
            }
            return new List<AbilityDef>();
        }

        /// <summary>Look up an ability def by slot for a unit, or null.</summary>
        public static AbilityDef FindAbility(BattleUnit unit, AbilitySlot slot)
        {
            return UnitAbilityKit(unit).FirstOrDefault(a => a.Slot == slot);
        }

        /// <summary>Cooldown value for a slot, with TS `?? 0` (absent key -&gt; 0).</summary>
        public static int CooldownOf(BattleUnit unit, AbilitySlot slot)
        {
            return unit.Cooldowns.TryGetValue(slot, out int cd) ? cd : 0;
        }

        // ---------------------------------------------------------------------
        // Snapshot helpers
        // ---------------------------------------------------------------------

        /// <summary>
        /// Deep-clone a battle state. Must be a fully independent deep copy —
        /// mutating the copy must never touch the original.
        /// </summary>
        public static BattleState CloneBattle(BattleState state)
        {
            return new BattleState
            {
                Wave = state.Wave,
                Phase = state.Phase,
                Outcome = state.Outcome,
                Units = state.Units.Select(CloneUnit).ToList(),
                Reserve = state.Reserve.Select(r => r.Clone()).ToList(),
                ActiveUnitId = state.ActiveUnitId,
                TurnCounter = state.TurnCounter,
                Rng = new Rng { Seed = state.Rng.Seed },
                Inventory = new Dictionary<ItemKind, int>(state.Inventory),
                Log = state.Log.Select(l => l.Clone()).ToList(),
                ReinforcementsApplied = state.ReinforcementsApplied,
            };
        }

        /// <summary>Field-copy one BattleUnit with fresh statuses + cooldowns.</summary>
        private static BattleUnit CloneUnit(BattleUnit u)
        {
            return new BattleUnit
            {
                Id = u.Id,
                Side = u.Side,
                Name = u.Name,
                Kind = u.Kind,
                ControlMode = u.ControlMode,
                Hp = u.Hp,
                MaxHp = u.MaxHp,
                Resource = u.Resource,
                MaxResource = u.MaxResource,
                ResourceRegen = u.ResourceRegen,
                Atb = u.Atb,
                Speed = u.Speed,
                Defense = u.Defense,
                Attack = u.Attack,
                Element = u.Element,
                Statuses = u.Statuses.Select(s => s.Clone()).ToList(),
                Cooldowns = new Dictionary<AbilitySlot, int>(u.Cooldowns),
                Defending = u.Defending,
                Alive = u.Alive,
                HeroClass = u.HeroClass,
                Species = u.Species,
                BondRank = u.BondRank,
                AiMode = u.AiMode,
                Archetype = u.Archetype,
                EnemyDefId = u.EnemyDefId,
            };
        }
    }
}
