// =============================================================================
// ATB Battle Engine — target resolution
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/targeting.ts. Pure targeting helpers. `resolveTargets`
// maps a TargetMode to the list of affected units; `adjacentUnitIds` finds the
// physical neighbours of a unit (used for Mage R "Tempest" splash).
// =============================================================================

using System.Collections.Generic;
using System.Linq;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.RngOps;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>Pure target-resolution helpers.</summary>
    public static class Targeting
    {
        /// <summary>Resolve the list of target units for a given target mode.</summary>
        public static List<BattleUnit> ResolveTargets(
            BattleState state,
            BattleUnit actor,
            TargetMode mode,
            string explicitTargetId,
            Rng rng,
            int hits)
        {
            Side enemySide = actor.Side == Side.Party ? Side.Enemy : Side.Party;
            switch (mode)
            {
                case TargetMode.SingleEnemy:
                {
                    // TS `if (explicitTargetId)` treats "" as falsy — match with
                    // IsNullOrEmpty (chooseEnemyAction can produce targetId: '').
                    if (!string.IsNullOrEmpty(explicitTargetId))
                    {
                        BattleUnit t = GetUnit(state, explicitTargetId);
                        if (t != null && t.Alive && t.Side == enemySide)
                            return new List<BattleUnit> { t };
                    }
                    BattleUnit fallback = RngPick(rng, LivingUnits(state, enemySide));
                    return fallback != null
                        ? new List<BattleUnit> { fallback }
                        : new List<BattleUnit>();
                }
                case TargetMode.AllEnemies:
                    return LivingUnits(state, enemySide);
                case TargetMode.RandomEnemies:
                {
                    List<BattleUnit> pool = LivingUnits(state, enemySide);
                    var picks = new List<BattleUnit>();
                    // F-TARG-2: pool is NOT removed-from — the same unit can be
                    // picked multiple times across hits. Faithful; preserved.
                    for (int i = 0; i < hits && pool.Count > 0; i++)
                    {
                        BattleUnit p = RngPick(rng, pool);
                        if (p != null) picks.Add(p);
                    }
                    return picks;
                }
                case TargetMode.Self:
                    return new List<BattleUnit> { actor };
                case TargetMode.SingleAlly:
                {
                    // F-TARG-1: for an enemy actor with no explicitTargetId this
                    // returns [actor] — the enemy targets itself. Faithful to TS.
                    if (!string.IsNullOrEmpty(explicitTargetId))
                    {
                        BattleUnit t = GetUnit(state, explicitTargetId);
                        if (t != null && t.Alive && t.Side == actor.Side)
                            return new List<BattleUnit> { t };
                    }
                    return new List<BattleUnit> { actor };
                }
                case TargetMode.AllAllies:
                    return LivingUnits(state, actor.Side);
                default:
                    return new List<BattleUnit>();
            }
        }

        /// <summary>The ids of the units physically next to a given unit.</summary>
        public static List<string> AdjacentUnitIds(BattleState state, BattleUnit unit)
        {
            List<BattleUnit> sideUnits = state.Units.Where(u => u.Side == unit.Side).ToList();
            int idx = sideUnits.FindIndex(u => u.Id == unit.Id);
            var ids = new List<string>();
            // left neighbour first, then right — order preserved.
            if (idx > 0) ids.Add(sideUnits[idx - 1].Id);
            if (idx >= 0 && idx < sideUnits.Count - 1) ids.Add(sideUnits[idx + 1].Id);
            return ids;
        }
    }
}
