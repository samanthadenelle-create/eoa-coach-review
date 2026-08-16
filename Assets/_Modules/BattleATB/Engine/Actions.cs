// =============================================================================
// ATB Battle Engine — action resolution
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/actions.ts. The resolve* family (attack / ability /
// item / defend / rally / enemy-special) plus the applyAction dispatcher.
// Mutates state.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Combat;
using static DeNelle.BattleATB.Engine.Defs;
using static DeNelle.BattleATB.Engine.RngOps;
using static DeNelle.BattleATB.Engine.Targeting;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>
    /// Options bundle for <see cref="Actions.Strike"/> — ports the inline TS
    /// `opts` object. Event is only ever Attack or Ability.
    /// </summary>
    public struct StrikeOpts
    {
        public double? ArmorPierce;
        public StatusKind? ApplyStatus;
        public double? StatusChance;
        public BattleLogEvent Event;
        public string Label;
        public bool? CanCrit;
    }

    /// <summary>The resolve* family + the applyAction dispatcher.</summary>
    public static class Actions
    {
        /// <summary>
        /// Deal basePower damage from actor to target, log + apply statuses.
        ///
        /// F-ACT-2: the status-roll RngChance is gated behind &amp;&amp;, so a
        /// shielded hit / a kill / a no-status strike skips that draw.
        /// CalculateDamage already drew 1-2 values. The &amp;&amp; chain is exact.
        /// </summary>
        public static void Strike(
            BattleState state,
            BattleUnit actor,
            BattleUnit target,
            int basePower,
            ElementType element,
            StrikeOpts opts)
        {
            if (!target.Alive) return;
            DamageResult result = CalculateDamage(new DamageInput
            {
                Attacker = actor,
                Target = target,
                BasePower = basePower,
                Element = element,
                ArmorPierce = opts.ArmorPierce,
                CanCrit = opts.CanCrit,
                Rng = state.Rng,
            });
            int dealt = ApplyDamage(target, result);
            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = actor.Id,
                TargetId = target.Id,
                Event = opts.Event,
                Text = result.Shielded
                    ? $"{actor.Name}'s {opts.Label} is absorbed by {target.Name}'s shield."
                    : $"{actor.Name} hits {target.Name} with {opts.Label} for {dealt}"
                      + (result.Crit ? " (CRIT!)" : "") + ".",
                Amount = dealt,
                Crit = result.Crit,
                // Element is presentation metadata (ice-impact VFX keys off it) -
                // stamping it changes no logic, no RNG draw, no log text.
                Element = element,
            });
            if (target.Hp <= 0 && !target.Alive)
            {
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = target.Id,
                    Event = BattleLogEvent.Death,
                    Text = $"{target.Name} falls.",
                });
            }
            else if (opts.ApplyStatus != null
                     && !result.Shielded
                     && target.Alive
                     && RngChance(state.Rng, opts.StatusChance ?? 1))
            {
                ApplyStatus(target, opts.ApplyStatus.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = target.Id,
                    Event = BattleLogEvent.StatusApply,
                    Text = $"{target.Name} is afflicted with {opts.ApplyStatus.Value.ToToken()}.",
                    Status = opts.ApplyStatus,
                });
            }
        }

        // ---------------------------------------------------------------------
        // Action resolution
        // ---------------------------------------------------------------------

        /// <summary>Resolve a basic Attack.</summary>
        public static void ResolveAttack(BattleState state, BattleUnit actor, string targetId)
        {
            BattleUnit target = GetUnit(state, targetId);
            Side enemySide = actor.Side == Side.Party ? Side.Enemy : Side.Party;
            BattleUnit real = target != null && target.Alive && target.Side == enemySide
                ? target
                : RngPick(state.Rng, LivingUnits(state, enemySide));
            if (real == null) return;
            Strike(state, actor, real, actor.Attack, actor.Element, new StrikeOpts
            {
                Event = BattleLogEvent.Attack,
                Label = "a basic attack",
            });
        }

        /// <summary>Resolve an Ability action.</summary>
        public static void ResolveAbility(
            BattleState state,
            BattleUnit actor,
            AbilitySlot slot,
            string targetId)
        {
            AbilityDef ability = FindAbility(actor, slot);
            if (ability == null) return;
            // Charge cost + start cooldown.
            actor.Resource = Math.Max(0, actor.Resource - ability.Cost);
            actor.Cooldowns[slot] = ability.CooldownTurns;

            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = actor.Id,
                TargetId = targetId,
                Event = BattleLogEvent.Ability,
                Text = $"{actor.Name} casts {ability.Name}.",
            });

            List<BattleUnit> targets = ResolveTargets(
                state, actor, ability.Target, targetId, state.Rng, ability.Hits ?? 1);

            // Damage component.
            if (ability.Damage > 0)
            {
                foreach (BattleUnit t in targets)
                {
                    Strike(state, actor, t, ability.Damage, ability.Element, new StrikeOpts
                    {
                        ArmorPierce = ability.ArmorPierce,
                        ApplyStatus = ability.ApplyStatus,
                        StatusChance = ability.StatusChance,
                        Event = BattleLogEvent.Ability,
                        Label = ability.Name,
                    });
                }
                // Splash to neighbours of the primary target (Mage R "Tempest").
                // F-ACT-3: TS truthy-checks `splash`, so splash 0 = "no splash".
                if (ability.Splash.HasValue && ability.Splash.Value != 0 && targets.Count > 0)
                {
                    BattleUnit primary = targets[0];
                    foreach (string adjId in AdjacentUnitIds(state, primary))
                    {
                        BattleUnit adj = GetUnit(state, adjId);
                        if (adj != null && adj.Alive)
                        {
                            Strike(state, actor, adj, ability.Splash.Value, ability.Element,
                                new StrikeOpts
                                {
                                    Event = BattleLogEvent.Ability,
                                    Label = $"{ability.Name} (splash)",
                                    CanCrit = false,
                                });
                        }
                    }
                }
            }

            // Heal component.
            if (ability.Heal != null && ability.Heal.Value > 0)
            {
                foreach (BattleUnit t in targets)
                {
                    int healed = ApplyHeal(t, ability.Heal.Value);
                    PushLog(state, new BattleLogEntry
                    {
                        Turn = state.TurnCounter,
                        SourceId = actor.Id,
                        TargetId = t.Id,
                        Event = BattleLogEvent.Ability,
                        Text = $"{t.Name} is healed for {healed}.",
                        Amount = -healed,
                    });
                }
            }
            if (ability.HealPctSelf != null && ability.HealPctSelf.Value > 0)
            {
                int healed = ApplyHeal(actor, actor.MaxHp * ability.HealPctSelf.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = actor.Id,
                    Event = BattleLogEvent.Ability,
                    Text = $"{actor.Name} mends {healed} HP.",
                    Amount = -healed,
                });
            }

            // Non-damage status component (e.g. Hunter's Mark) — damage abilities
            // already applied their status inside Strike.
            if (ability.ApplyStatus != null && ability.Damage == 0)
            {
                foreach (BattleUnit t in targets)
                {
                    if (t.Alive && RngChance(state.Rng, ability.StatusChance ?? 1))
                    {
                        ApplyStatus(t, ability.ApplyStatus.Value);
                        PushLog(state, new BattleLogEntry
                        {
                            Turn = state.TurnCounter,
                            SourceId = actor.Id,
                            TargetId = t.Id,
                            Event = BattleLogEvent.StatusApply,
                            Text = $"{t.Name} is marked by {ability.Name}.",
                            Status = ability.ApplyStatus,
                        });
                    }
                }
            }

            // Self status (Shield / Haste).
            if (ability.SelfStatus != null)
            {
                ApplyStatus(actor, ability.SelfStatus.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = actor.Id,
                    Event = BattleLogEvent.StatusApply,
                    Text = $"{actor.Name} gains {ability.SelfStatus.Value.ToToken()}.",
                    Status = ability.SelfStatus,
                });
            }
        }

        /// <summary>Resolve an Item action. Returns false if it could not be used.</summary>
        public static bool ResolveItem(
            BattleState state,
            BattleUnit actor,
            ItemKind item,
            string targetId)
        {
            int have = state.Inventory.TryGetValue(item, out int n) ? n : 0;
            if (have <= 0) return false;
            ItemDef def = ITEM_DEFS[item];
            BattleUnit target = GetUnit(state, targetId);
            BattleUnit real = target != null && target.Alive && target.Side == actor.Side
                ? target
                : actor;

            state.Inventory[item] -= 1;

            if (def.Heal != null)
            {
                int healed = ApplyHeal(real, def.Heal.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = real.Id,
                    Event = BattleLogEvent.Item,
                    Text = $"{actor.Name} uses {def.Name} on {real.Name} (+{healed} HP).",
                    Amount = -healed,
                });
            }
            if (def.RestoreResource != null)
            {
                int restored = ApplyResource(real, def.RestoreResource.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = real.Id,
                    Event = BattleLogEvent.Item,
                    Text = $"{actor.Name} uses {def.Name} on {real.Name} (+{restored} resource).",
                });
            }
            if (def.Cleanse != null && def.Cleanse.Value)
            {
                List<StatusKind> removed = CleanseStatuses(real);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = real.Id,
                    Event = BattleLogEvent.Item,
                    Text = removed.Count > 0
                        ? $"{actor.Name} cleanses "
                          + string.Join(", ", removed.Select(k => k.ToToken()))
                          + $" from {real.Name}."
                        : $"{actor.Name} uses {def.Name} on {real.Name}.",
                });
            }
            return true;
        }

        /// <summary>Resolve a Defend action — halves incoming damage + restores resource.</summary>
        public static void ResolveDefend(BattleState state, BattleUnit actor)
        {
            actor.Defending = true;
            int restored = ApplyResource(actor, 8);
            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = actor.Id,
                TargetId = actor.Id,
                Event = BattleLogEvent.Defend,
                Text = $"{actor.Name} braces (+{restored} resource, damage halved).",
            });
        }

        /// <summary>Resolve a Rally action — pull a benched pet into the fight.</summary>
        public static bool ResolveRally(BattleState state, BattleUnit actor, int reserveIndex)
        {
            if (reserveIndex < 0 || reserveIndex >= state.Reserve.Count) return false;
            if (LivingUnits(state, Side.Party).Count >= MAX_PARTY) return false;

            RallyReserveUnit reserve = state.Reserve[reserveIndex];
            state.Reserve.RemoveAt(reserveIndex);

            // Use the count of party slots ever created to keep ids unique.
            int petCount = state.Units.Count(u => u.Kind == UnitKind.Pet);
            BattleUnit unit = BuildPetUnit(
                new PartyPetSpec
                {
                    Species = reserve.Species,
                    Name = reserve.Name,
                    BondRank = reserve.BondRank,
                    AiMode = reserve.AiMode,
                    JoinsImmediately = true,
                },
                petCount,
                state.ReinforcementsApplied);
            // Rallied pets arrive with a fresh id even if a slot index repeats.
            unit.Id = $"pet-rally-{state.TurnCounter}-{petCount}";

            // Insert just before the first enemy so portraits stay grouped.
            int firstEnemyIdx = state.Units.FindIndex(u => u.Side == Side.Enemy);
            if (firstEnemyIdx == -1)
            {
                state.Units.Add(unit);
            }
            else
            {
                state.Units.Insert(firstEnemyIdx, unit);
            }

            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = actor.Id,
                TargetId = unit.Id,
                Event = BattleLogEvent.Rally,
                Text = $"{actor.Name} rallies {unit.Name} into the last stand!",
            });
            return true;
        }

        /// <summary>
        /// Resolve an enemy's special move. Enemies have no Q/W/E/R kit, so their
        /// "ability" action is dispatched here against the EnemyDef.Special table.
        /// </summary>
        public static void ResolveEnemySpecial(BattleState state, BattleUnit unit)
        {
            EnemyDef def = null;
            if (!string.IsNullOrEmpty(unit.EnemyDefId))
                ENEMY_DEFS.TryGetValue(unit.EnemyDefId, out def);
            if (def == null || def.Special == null)
            {
                // Degenerate — fall back to a basic attack.
                BattleUnit t = RngPick(state.Rng, LivingUnits(state, Side.Party));
                if (t != null) ResolveAttack(state, unit, t.Id);
                return;
            }
            EnemySpecial special = def.Special;
            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = unit.Id,
                TargetId = null,
                Event = BattleLogEvent.Ability,
                Text = $"{unit.Name} uses {special.Name}.",
            });

            if (special.SelfHeal != null && special.SelfHeal.Value > 0)
            {
                int healed = ApplyHeal(unit, special.SelfHeal.Value);
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = unit.Id,
                    TargetId = unit.Id,
                    Event = BattleLogEvent.Ability,
                    Text = $"{unit.Name} recovers {healed} HP.",
                    Amount = -healed,
                });
                return;
            }

            List<BattleUnit> targets = ResolveTargets(
                state, unit, special.Target, null, state.Rng, 1);
            foreach (BattleUnit t in targets)
            {
                if (special.Damage > 0)
                {
                    Strike(state, unit, t, special.Damage, unit.Element, new StrikeOpts
                    {
                        ApplyStatus = special.ApplyStatus,
                        StatusChance = special.StatusChance,
                        Event = BattleLogEvent.Ability,
                        Label = special.Name,
                    });
                }
                else if (special.ApplyStatus != null
                         && t.Alive
                         && RngChance(state.Rng, special.StatusChance ?? 1))
                {
                    ApplyStatus(t, special.ApplyStatus.Value);
                    PushLog(state, new BattleLogEntry
                    {
                        Turn = state.TurnCounter,
                        SourceId = unit.Id,
                        TargetId = t.Id,
                        Event = BattleLogEvent.StatusApply,
                        Text = $"{t.Name} is afflicted with {special.ApplyStatus.Value.ToToken()}.",
                        Status = special.ApplyStatus,
                    });
                }
            }
        }

        // ---------------------------------------------------------------------
        // Action dispatch
        // ---------------------------------------------------------------------

        /// <summary>Validate + dispatch a single action for actor.</summary>
        public static void ApplyAction(BattleState state, BattleUnit actor, BattleAction action)
        {
            switch (action.Kind)
            {
                case ActionKind.Attack:
                    ResolveAttack(state, actor, action.TargetId);
                    break;
                case ActionKind.Ability:
                    if (actor.Kind == UnitKind.Enemy)
                    {
                        ResolveEnemySpecial(state, actor);
                    }
                    else
                    {
                        // action.Slot is always set for a non-enemy ability action.
                        AbilitySlot slot = action.Slot.Value;
                        AbilityDef ability = FindAbility(actor, slot);
                        bool usable = ability != null
                            && actor.Resource >= ability.Cost
                            && CooldownOf(actor, slot) <= 0;
                        if (usable)
                        {
                            ResolveAbility(state, actor, slot, action.TargetId);
                        }
                        else
                        {
                            // Unusable ability — fall back to a basic attack.
                            BattleUnit foe = RngPick(state.Rng, LivingUnits(state, Side.Enemy));
                            if (foe != null) ResolveAttack(state, actor, foe.Id);
                        }
                    }
                    break;
                case ActionKind.Item:
                    if (!ResolveItem(state, actor, action.Item.Value, action.TargetId))
                    {
                        // Item unavailable — treat as Defend.
                        ResolveDefend(state, actor);
                    }
                    break;
                case ActionKind.Defend:
                    ResolveDefend(state, actor);
                    break;
                case ActionKind.Rally:
                    if (!ResolveRally(state, actor, action.ReserveIndex))
                    {
                        ResolveDefend(state, actor);
                    }
                    break;
            }
        }
    }
}
