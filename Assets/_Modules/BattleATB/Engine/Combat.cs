// =============================================================================
// ATB Battle Engine — damage + status-effect resolution
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/combat.ts. Damage calculation, HP/resource application,
// and status-effect handling (apply / consume / cleanse / tick). Mutates units;
// logs through PushLog.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Defs;
using static DeNelle.BattleATB.Engine.PortMath;
using static DeNelle.BattleATB.Engine.RngOps;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Damage + status-effect resolution.</summary>
    public static class Combat
    {
        // ---------------------------------------------------------------------
        // Damage calculation
        // ---------------------------------------------------------------------

        /// <summary>Element matchups — a small rock-paper-scissors flavour bonus.</summary>
        public static double ElementMultiplier(ElementType attacker, ElementType defender)
        {
            // flame > ice, ice > aether, aether > flame; physical is neutral.
            if (attacker == ElementType.Flame && defender == ElementType.Ice) return 1.25;
            if (attacker == ElementType.Ice && defender == ElementType.Aether) return 1.25;
            if (attacker == ElementType.Aether && defender == ElementType.Flame) return 1.25;
            if (attacker == ElementType.Ice && defender == ElementType.Flame) return 0.85;
            if (attacker == ElementType.Aether && defender == ElementType.Ice) return 0.85;
            if (attacker == ElementType.Flame && defender == ElementType.Aether) return 0.85;
            return 1;
        }

        /// <summary>
        /// Compute the damage one unit deals to another. Pure aside from
        /// advancing the RNG. Does NOT mutate the target.
        ///
        /// F-CMB-1: the shield check happens AFTER both RNG draws — a shielded
        /// hit still consumes 1 (or 2) RNG values. Do not reorder.
        /// </summary>
        public static DamageResult CalculateDamage(DamageInput input)
        {
            BattleUnit target = input.Target;
            int basePower = input.BasePower;
            ElementType element = input.Element;
            Rng rng = input.Rng;

            // Aether damage ignores armour entirely.
            double pierce = element == ElementType.Aether
                ? 1
                : Math.Max(0, Math.Min(1, input.ArmorPierce ?? 0));
            double effectiveDefense = target.Defense * (1 - pierce);

            double elementMul = ElementMultiplier(element, target.Element);

            // "Mark" makes the target take +30% from everything.
            double markMul = HasStatus(target, StatusKind.Mark) ? 1.3 : 1;

            // Defend halves incoming damage until the unit's next turn.
            double defendMul = target.Defending ? 0.5 : 1;

            // CanCrit != false: true/null both allow crit; only explicit false
            // blocks it. && short-circuits — the RngChance draw is skipped when
            // CanCrit == false. Order-significant; ported faithfully.
            bool crit = input.CanCrit != false && RngChance(rng, CRIT_CHANCE);
            double critMul = crit ? CRIT_MULT : 1;

            double raw = basePower * (1 - effectiveDefense) * elementMul
                         * markMul * defendMul * critMul;

            // +/-8% spread (second RNG draw — always happens).
            double spread = 0.92 + RngNext(rng) * 0.16;
            raw *= spread;

            // F-STATE-1: Math.round -> RoundTs.
            int damage = Math.Max(1, RoundTs(raw));

            // A Shield buff negates the next hit outright.
            if (HasStatus(target, StatusKind.Shield))
            {
                return new DamageResult { Damage = 0, Crit = crit, Shielded = true };
            }

            return new DamageResult { Damage = damage, Crit = crit, Shielded = false };
        }

        /// <summary>
        /// Apply a damage result to a unit, mutating its hp / shield / alive
        /// flag. Returns the actual HP lost (0 when shielded).
        /// </summary>
        public static int ApplyDamage(BattleUnit target, DamageResult result)
        {
            if (result.Shielded)
            {
                ConsumeStatus(target, StatusKind.Shield);
                return 0;
            }
            target.Hp = Math.Max(0, target.Hp - result.Damage);
            if (target.Hp == 0) target.Alive = false;
            return result.Damage;
        }

        /// <summary>Heal a unit, clamped at maxHp. Returns HP actually restored.</summary>
        public static int ApplyHeal(BattleUnit target, double amount)
        {
            if (!target.Alive || amount <= 0) return 0;
            int before = target.Hp;
            // F-STATE-1: Math.round -> RoundTs.
            target.Hp = Math.Min(target.MaxHp, target.Hp + RoundTs(amount));
            return target.Hp - before;
        }

        /// <summary>
        /// Restore resource to a unit, clamped at maxResource. No alive check
        /// (unlike applyHeal) — faithful to TS.
        /// </summary>
        public static int ApplyResource(BattleUnit target, double amount)
        {
            int before = target.Resource;
            // F-STATE-1: Math.round -> RoundTs.
            target.Resource = Math.Min(target.MaxResource, target.Resource + RoundTs(amount));
            return target.Resource - before;
        }

        // ---------------------------------------------------------------------
        // Status-effect handling
        // ---------------------------------------------------------------------

        /// <summary>Add (or refresh) a status on a unit using the blueprint.</summary>
        public static void ApplyStatus(BattleUnit unit, StatusKind kind)
        {
            if (!unit.Alive) return;
            StatusBlueprint bp = STATUS_BLUEPRINTS[kind];
            StatusEffect existing = unit.Statuses.FirstOrDefault(s => s.Kind == kind);
            if (existing != null)
            {
                // Refresh duration; keep the higher potency.
                existing.Turns = Math.Max(existing.Turns, bp.Turns);
                existing.Potency = Math.Max(existing.Potency, bp.Potency);
                return;
            }
            unit.Statuses.Add(new StatusEffect
            {
                Kind = kind,
                Turns = bp.Turns,
                Potency = bp.Potency,
            });
        }

        /// <summary>
        /// Remove a status from a unit. F-CMB-2: the TS docstring says "one
        /// charge" but the impl filters out EVERY instance of the kind. Ported
        /// as remove-all (applyStatus never stacks duplicates anyway).
        /// </summary>
        public static void ConsumeStatus(BattleUnit unit, StatusKind kind)
        {
            unit.Statuses = unit.Statuses.Where(s => s.Kind != kind).ToList();
        }

        /// <summary>Strip every non-buff status from a unit (the Cleanse item).</summary>
        public static List<StatusKind> CleanseStatuses(BattleUnit unit)
        {
            var removed = new List<StatusKind>();
            unit.Statuses = unit.Statuses.Where(s =>
            {
                if (STATUS_BLUEPRINTS[s.Kind].Buff) return true;
                removed.Add(s.Kind);
                return false;
            }).ToList();
            return removed;
        }

        /// <summary>
        /// Tick a unit's status effects at the start of its turn. Returns
        /// whether the unit must SKIP its turn (frozen / stunned). Logs each tick.
        /// </summary>
        public static bool TickStatuses(BattleState state, BattleUnit unit)
        {
            bool skip = false;

            // TS for...of runs over the original array reference; reassignment
            // of unit.statuses happens afterward. Snapshot the list and only
            // reassign at the end. The StatusEffect objects are shared so the
            // later Where(Turns>0) filter sees the decremented turns.
            List<StatusEffect> snapshot = unit.Statuses.ToList();
            foreach (StatusEffect status in snapshot)
            {
                if (status.Turns <= 0) continue;
                switch (status.Kind)
                {
                    case StatusKind.Burn:
                    case StatusKind.Poison:
                    {
                        int lost = Math.Min(unit.Hp, RoundTs(status.Potency));
                        unit.Hp -= lost;
                        if (unit.Hp <= 0) unit.Alive = false;
                        PushLog(state, new BattleLogEntry
                        {
                            Turn = state.TurnCounter,
                            SourceId = null,
                            TargetId = unit.Id,
                            Event = BattleLogEvent.StatusTick,
                            Text = $"{unit.Name} suffers {lost} {status.Kind.ToToken()} damage.",
                            Amount = lost,
                            Status = status.Kind,
                        });
                        break;
                    }
                    case StatusKind.Bleed:
                    {
                        int lost = Math.Min(unit.Hp, RoundTs(status.Potency));
                        unit.Hp -= lost;
                        if (unit.Hp <= 0) unit.Alive = false;
                        PushLog(state, new BattleLogEntry
                        {
                            Turn = state.TurnCounter,
                            SourceId = null,
                            TargetId = unit.Id,
                            Event = BattleLogEvent.StatusTick,
                            Text = $"{unit.Name} bleeds for {lost}.",
                            Amount = lost,
                            Status = StatusKind.Bleed,
                        });
                        // Bleed worsens by +1 each turn — mutates the live effect.
                        status.Potency += 1;
                        break;
                    }
                    case StatusKind.Regen:
                    {
                        int healed = ApplyHeal(unit, status.Potency);
                        PushLog(state, new BattleLogEntry
                        {
                            Turn = state.TurnCounter,
                            SourceId = null,
                            TargetId = unit.Id,
                            Event = BattleLogEvent.StatusTick,
                            Text = $"{unit.Name} regenerates {healed} HP.",
                            Amount = -healed,
                            Status = StatusKind.Regen,
                        });
                        break;
                    }
                    case StatusKind.Freeze:
                    case StatusKind.Stun:
                        skip = true;
                        break;
                    // slow / haste / shield / mark have no per-turn tick.
                    default:
                        break;
                }
                status.Turns -= 1;
            }

            // Drop expired statuses and log the ones that fell off.
            List<StatusEffect> expired = unit.Statuses.Where(s => s.Turns <= 0).ToList();
            foreach (StatusEffect s in expired)
            {
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = null,
                    TargetId = unit.Id,
                    Event = BattleLogEvent.StatusExpire,
                    Text = $"{unit.Name}'s {s.Kind.ToToken()} wears off.",
                    Status = s.Kind,
                });
            }
            unit.Statuses = unit.Statuses.Where(s => s.Turns > 0).ToList();

            return skip && unit.Alive;
        }
    }
}
