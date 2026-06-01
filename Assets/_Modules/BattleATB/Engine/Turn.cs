// =============================================================================
// ATB Battle Engine — turn order + the turn pipeline
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/turn.ts. ATB-bar fill, the begin/resolve/finish turn
// pipeline, battle start/end, and the auto-resolve path used by tests + the
// "away" resolution.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.Actions;
using static DeNelle.BattleATB.Engine.Ai;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Combat;
using static DeNelle.BattleATB.Engine.Defs;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Turn order + the turn pipeline.</summary>
    public static class Turn
    {
        // ---------------------------------------------------------------------
        // Turn order — ATB fill
        // ---------------------------------------------------------------------

        /// <summary>
        /// Advance every unit's ATB bar until one is ready, then return that
        /// unit. Deterministic: when several would finish in the same step the
        /// lowest unit index breaks the tie. Returns null only when the battle
        /// is already over.
        /// </summary>
        public static BattleUnit AdvanceToNextTurn(BattleState state)
        {
            if (IsBattleOver(state)) return null;

            // Guard against pathological loops (all units somehow zero-speed).
            for (int guard = 0; guard < 100000; guard++)
            {
                BattleUnit ready = ReadyUnit(state);
                if (ready != null) return ready;

                // Smallest amount of "fill" that pushes someone to ATB_FULL.
                double minSteps = double.PositiveInfinity;
                foreach (BattleUnit u in state.Units)
                {
                    if (!u.Alive) continue;
                    double rate = u.Speed * StatusFillMul(u);
                    if (rate <= 0) continue;
                    double need = (ATB_FULL - u.Atb) / rate;
                    if (need < minSteps) minSteps = need;
                }
                if (!double.IsFinite(minSteps) || minSteps <= 0)
                {
                    // Nobody can fill — break the deadlock by nudging.
                    minSteps = 0.001;
                }

                foreach (BattleUnit u in state.Units)
                {
                    if (!u.Alive) continue;
                    double rate = u.Speed * StatusFillMul(u);
                    u.Atb = Math.Min(ATB_FULL, u.Atb + rate * minSteps);
                }
            }
            // Should be unreachable; treat as a stalemate.
            return ReadyUnit(state);
        }

        /// <summary>The first living unit with a full ATB bar (lowest index wins ties).</summary>
        public static BattleUnit ReadyUnit(BattleState state)
        {
            foreach (BattleUnit u in state.Units)
            {
                if (u.Alive && u.Atb >= ATB_FULL) return u;
            }
            return null;
        }

        // ---------------------------------------------------------------------
        // The turn pipeline
        // ---------------------------------------------------------------------

        /// <summary>
        /// WO-169 P0 — true when this unit's turn pauses for player input. Reads the
        /// per-member <see cref="BattleUnit.ControlMode"/> (Player → input UI; AI →
        /// existing AI policy) instead of the old hard tie to
        /// <see cref="UnitKind.Hero"/>. Draws no RNG — purely a phase decision in
        /// <see cref="BeginNextTurn"/> — so determinism is preserved. The legacy
        /// build path stamps hero = Player and pets/enemies = AI, keeping the golden
        /// vectors identical.
        /// </summary>
        public static bool IsPlayerControlled(BattleUnit unit)
        {
            return unit.ControlMode == ControlMode.Player;
        }

        /// <summary>
        /// Begin the next turn: fill ATB bars, pick the next actor, tick its
        /// statuses, and decide whether the engine should pause for player input.
        /// </summary>
        public static BattleState BeginNextTurn(BattleState state)
        {
            if (state.Phase == BattlePhase.Ended) return state;

            // Settle any outcome that emerged from the previous action.
            BattleOutcome pending = ComputeOutcome(state);
            if (pending != BattleOutcome.None)
            {
                return EndBattle(state, pending);
            }

            BattleUnit actor = AdvanceToNextTurn(state);
            if (actor == null)
            {
                // `?? 'defeat'` — if computeOutcome returns None, use Defeat.
                BattleOutcome o = ComputeOutcome(state);
                return EndBattle(state, o != BattleOutcome.None ? o : BattleOutcome.Defeat);
            }

            state.ActiveUnitId = actor.Id;
            state.TurnCounter += 1;

            // The unit's Defend bonus only lasts until its own next turn.
            actor.Defending = false;

            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = actor.Id,
                TargetId = null,
                Event = BattleLogEvent.TurnStart,
                Text = $"{actor.Name}'s turn.",
            });

            // Status tick (damage/heal/duration). Returns true if must skip.
            bool mustSkip = TickStatuses(state, actor);

            // The tick may have killed the unit (burn) or ended the battle.
            if (!actor.Alive)
            {
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = null,
                    TargetId = actor.Id,
                    Event = BattleLogEvent.Death,
                    Text = $"{actor.Name} succumbs.",
                });
                return FinishTurn(state, actor);
            }
            BattleOutcome afterTick = ComputeOutcome(state);
            if (afterTick != BattleOutcome.None) return EndBattle(state, afterTick);

            if (mustSkip)
            {
                PushLog(state, new BattleLogEntry
                {
                    Turn = state.TurnCounter,
                    SourceId = actor.Id,
                    TargetId = null,
                    Event = BattleLogEvent.Skip,
                    Text = $"{actor.Name} is incapacitated and loses the turn.",
                });
                return FinishTurn(state, actor);
            }

            // Hand control to the player for the hero; else the engine resolves.
            state.Phase = IsPlayerControlled(actor)
                ? BattlePhase.AwaitingInput
                : BattlePhase.Resolving;
            return state;
        }

        /// <summary>
        /// Resolve the turn of the current AI-controlled unit (enemy or pet).
        /// No-op if the active unit is player-controlled.
        /// </summary>
        public static BattleState ResolveAiTurn(BattleState state)
        {
            if (state.Phase != BattlePhase.Resolving
                || string.IsNullOrEmpty(state.ActiveUnitId)) return state;
            BattleUnit actor = GetUnit(state, state.ActiveUnitId);
            if (actor == null || !actor.Alive) return state;
            if (IsPlayerControlled(actor)) return state;

            BattleAction action = actor.Kind == UnitKind.Enemy
                ? ChooseEnemyAction(state, actor)
                : ChoosePetAction(state, actor);

            ApplyAction(state, actor, action);
            return FinishTurn(state, actor);
        }

        /// <summary>Submit a player-chosen action for the active (hero) unit.</summary>
        public static BattleState SubmitAction(BattleState state, BattleAction action)
        {
            if (state.Phase != BattlePhase.AwaitingInput
                || string.IsNullOrEmpty(state.ActiveUnitId)) return state;
            BattleUnit actor = GetUnit(state, state.ActiveUnitId);
            if (actor == null || !actor.Alive || !IsPlayerControlled(actor)) return state;

            ApplyAction(state, actor, action);
            return FinishTurn(state, actor);
        }

        /// <summary>
        /// Close out the current actor's turn: regenerate resource, count down
        /// its cooldowns, reset its ATB, then begin the next turn.
        /// </summary>
        public static BattleState FinishTurn(BattleState state, BattleUnit actor)
        {
            // Resource regen + cooldown decay happen even on a skipped turn.
            if (actor.Alive)
            {
                ApplyResource(actor, actor.ResourceRegen);
                // Snapshot keys before the loop — only values change.
                foreach (AbilitySlot slot in actor.Cooldowns.Keys.ToList())
                {
                    int cd = actor.Cooldowns.TryGetValue(slot, out int v) ? v : 0;
                    if (cd > 0) actor.Cooldowns[slot] = cd - 1;
                }
            }
            actor.Atb = ATB_RESET;
            state.ActiveUnitId = null;

            return BeginNextTurn(state);
        }

        /// <summary>Transition the battle into its `ended` phase.</summary>
        public static BattleState EndBattle(BattleState state, BattleOutcome outcome)
        {
            state.Phase = BattlePhase.Ended;
            state.Outcome = outcome;
            state.ActiveUnitId = null;
            PushLog(state, new BattleLogEntry
            {
                Turn = state.TurnCounter,
                SourceId = null,
                TargetId = null,
                Event = outcome == BattleOutcome.Victory
                    ? BattleLogEvent.Victory
                    : BattleLogEvent.Defeat,
                Text = outcome == BattleOutcome.Victory
                    ? "The breach is repelled — victory!"
                    : "The party falls — the last stand is lost.",
            });
            return state;
        }

        /// <summary>Start a freshly-created battle: leave `intro` and run to the
        /// first decision point.</summary>
        public static BattleState StartBattle(BattleState state)
        {
            if (state.Phase != BattlePhase.Intro) return state;
            state.Phase = BattlePhase.Filling;
            return BeginNextTurn(state);
        }

        // ---------------------------------------------------------------------
        // Auto-resolve — for tests + the "away" auto-resolution path
        // ---------------------------------------------------------------------

        /// <summary>
        /// Run a battle to completion with the hero AI-controlled by a simple
        /// policy. Pure and deterministic. maxTurns guards against a runaway loop.
        /// </summary>
        public static BattleState AutoResolveBattle(BattleState state, int maxTurns = 5000)
        {
            BattleState s = state;
            if (s.Phase == BattlePhase.Intro) s = StartBattle(s);

            int turns = 0;
            while (s.Phase != BattlePhase.Ended && turns < maxTurns)
            {
                turns += 1;
                if (s.Phase == BattlePhase.AwaitingInput
                    && !string.IsNullOrEmpty(s.ActiveUnitId))
                {
                    BattleUnit hero = GetUnit(s, s.ActiveUnitId);
                    if (hero != null)
                    {
                        s = SubmitAction(s, AutoHeroAction(s, hero));
                    }
                    else
                    {
                        break;
                    }
                }
                else if (s.Phase == BattlePhase.Resolving)
                {
                    s = ResolveAiTurn(s);
                }
                else
                {
                    // 'filling' shouldn't persist — nudge the engine forward.
                    s = BeginNextTurn(s);
                }
            }
            return s;
        }

        /// <summary>The default hero policy used by AutoResolveBattle.</summary>
        public static BattleAction AutoHeroAction(BattleState state, BattleUnit hero)
        {
            List<BattleUnit> foes = LivingUnits(state, Side.Enemy);
            if (foes.Count == 0) return BattleAction.MakeDefend();
            BattleUnit lowestFoe = foes.Aggregate(foes[0], (lo, f) => f.Hp < lo.Hp ? f : lo);

            List<BattleUnit> allies = LivingUnits(state, Side.Party);
            bool heroHurt = hero.Hp < hero.MaxHp * 0.4;

            // Emergency potion when the hero is badly hurt and a potion is on hand.
            int potions = state.Inventory.TryGetValue(ItemKind.Potion, out int p) ? p : 0;
            if (heroHurt && potions > 0)
            {
                return BattleAction.MakeItem(ItemKind.Potion, hero.Id);
            }

            List<AbilityDef> usable = AvailableAbilities(hero);
            List<AbilityDef> damageAbilities = usable.Where(a => a.Damage > 0).ToList();
            if (damageAbilities.Count > 0)
            {
                AbilityDef best = damageAbilities
                    .Aggregate(damageAbilities[0], (b, a) => a.Damage > b.Damage ? a : b);
                return BattleAction.MakeAbility(best.Slot, lowestFoe.Id);
            }

            // A self-buff ability (Knight Guard / Last Stand) when nothing fits.
            // TS truthy-check on selfStatus || healPctSelf — both nullable here.
            List<AbilityDef> supportAbilities = usable
                .Where(a => a.SelfStatus != null || a.HealPctSelf != null)
                .ToList();
            if (supportAbilities.Count > 0 && (heroHurt || allies.Count == 1))
            {
                return BattleAction.MakeAbility(supportAbilities[0].Slot);
            }

            return BattleAction.MakeAttack(lowestFoe.Id);
        }
    }
}
