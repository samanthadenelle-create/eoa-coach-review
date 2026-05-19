// =============================================================================
// ATB Battle Engine — enemy / pet AI
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/ai.ts. Pure action-*choosing* logic for AI-controlled
// units. Deliberately imports neither Actions nor Combat — it only decides what
// to do; the turn pipeline resolves the chosen action.
// =============================================================================

using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Defs;
using static DeNelle.BattleATB.Engine.RngOps;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Pure action-choosing logic for AI-controlled units.</summary>
    public static class Ai
    {
        /// <summary>Pick an action for an AI-controlled enemy.</summary>
        public static BattleAction ChooseEnemyAction(BattleState state, BattleUnit unit)
        {
            EnemyDef def = null;
            if (!string.IsNullOrEmpty(unit.EnemyDefId))
                ENEMY_DEFS.TryGetValue(unit.EnemyDefId, out def);
            List<BattleUnit> foes = LivingUnits(state, Side.Party);
            Rng rng = state.Rng;

            // No special, or no foes — just attack.
            if (def == null || def.Special == null || foes.Count == 0)
            {
                BattleUnit t = PickEnemyAttackTarget(state, unit, foes, rng);
                return BattleAction.MakeAttack(t != null ? t.Id : "");
            }

            EnemySpecial special = def.Special;
            bool useSpecial = false;
            switch (def.Archetype)
            {
                case EnemyArchetype.Grunt:
                    useSpecial = RngChance(rng, 0.2);
                    break;
                case EnemyArchetype.Caster:
                    useSpecial = RngChance(rng, 0.5);
                    break;
                case EnemyArchetype.Tank:
                    // F-AI-1: with selfHeal this is a pure HP comparison — NO
                    // RNG draw. Without selfHeal exactly one RngChance draw.
                    useSpecial = special.SelfHeal != null
                        ? unit.Hp < unit.MaxHp * 0.4
                        : RngChance(rng, 0.35);
                    break;
                case EnemyArchetype.Boss:
                    useSpecial = RngChance(rng, unit.Hp < unit.MaxHp * 0.6 ? 0.55 : 0.3);
                    break;
            }

            if (!useSpecial)
            {
                BattleUnit t = PickEnemyAttackTarget(state, unit, foes, rng);
                return BattleAction.MakeAttack(t != null ? t.Id : "");
            }

            // F-ACT-1: enemy specials dispatch through resolveEnemySpecial; the
            // slot 'q' is a synthetic placeholder.
            return BattleAction.MakeAbility(
                AbilitySlot.Q,
                foes.Count > 0 ? foes[0].Id : null);
        }

        /// <summary>Tanks hit the lowest-defense foe; everyone else hits a random foe.</summary>
        public static BattleUnit PickEnemyAttackTarget(
            BattleState state,
            BattleUnit unit,
            List<BattleUnit> foes,
            Rng rng)
        {
            if (foes.Count == 0) return null;
            if (unit.Archetype == EnemyArchetype.Tank)
            {
                // reduce — on tie the earliest-index foe wins (< is strict).
                return foes.Aggregate(foes[0], (lo, f) => f.Defense < lo.Defense ? f : lo);
            }
            return RngPick(rng, foes);
        }

        /// <summary>
        /// Pick an action for an AI-controlled pet, honouring its aiMode.
        /// Draws NO RNG — all picks are deterministic reductions.
        /// </summary>
        public static BattleAction ChoosePetAction(BattleState state, BattleUnit unit)
        {
            List<AbilityDef> kit = AvailableAbilities(unit);
            List<BattleUnit> allies = LivingUnits(state, Side.Party);
            List<BattleUnit> foes = LivingUnits(state, Side.Enemy);

            // A support ability heals or only buffs (no damage).
            List<AbilityDef> supportAbilities = kit
                .Where(a => (a.Heal ?? 0) > 0
                            || (a.Damage == 0 && a.SelfStatus != null))
                .ToList();
            List<AbilityDef> damageAbilities = kit.Where(a => a.Damage > 0).ToList();

            bool someoneHurt = allies.Any(a => a.Hp < a.MaxHp * 0.7);
            BattleUnit lowestFoe = foes.Count > 0
                ? foes.Aggregate(foes[0], (lo, f) => f.Hp < lo.Hp ? f : lo)
                : null;

            PetAiMode mode = unit.AiMode ?? PetAiMode.Balanced;

            // Defensive: prioritise support; Balanced: support only when needed.
            if ((mode == PetAiMode.Defensive
                 || (mode == PetAiMode.Balanced && someoneHurt))
                && supportAbilities.Count > 0)
            {
                AbilityDef ability = supportAbilities[0];
                return BattleAction.MakeAbility(ability.Slot);
            }

            // Otherwise lead with the strongest damage ability.
            if (damageAbilities.Count > 0 && lowestFoe != null)
            {
                AbilityDef ability = damageAbilities
                    .Aggregate(damageAbilities[0], (best, a) => a.Damage > best.Damage ? a : best);
                return BattleAction.MakeAbility(ability.Slot, lowestFoe.Id);
            }

            // Fall back to a basic attack on the lowest-HP foe.
            if (lowestFoe != null) return BattleAction.MakeAttack(lowestFoe.Id);

            // No foes left — defend.
            return BattleAction.MakeDefend();
        }
    }
}
