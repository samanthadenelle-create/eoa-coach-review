// =============================================================================
// ATB Battle Engine — Turn pipeline + full round-trip tests (EditMode)
// Mirrors atbEngine.test.ts "turn order", "rally", "items", and the headline
// "full 3v5 battle round-trip" describes.
// =============================================================================

using System.Collections.Generic;
using NUnit.Framework;
using DeNelle.BattleATB.Engine;
using static DeNelle.BattleATB.Engine.BattleStateOps;
using static DeNelle.BattleATB.Engine.Turn;

namespace DeNelle.BattleATB.Tests
{
    [TestFixture]
    public class TurnTest
    {
        // ---------------------------------------------------------------------
        // Turn order
        // ---------------------------------------------------------------------

        [Test]
        public void a_faster_unit_takes_its_first_turn_before_a_slower_one()
        {
            // Ranger (1.15 speed) should act before a slow Bruiser-heavy field.
            var setup = new BattleSetup
            {
                Wave = 3,
                Seed = 1,
                HeroClass = HeroClass.Ranger,
                HeroName = "Swift",
                Pets = new List<PartyPetSpec>(),
                Enemies = new List<BreachEnemySpec>
                {
                    new BreachEnemySpec { DefId = "bruiser" },
                },
            };
            BattleState state = StartBattle(CreateBattle(setup));
            BattleLogEntry firstTurn =
                state.Log.Find(l => l.Event == BattleLogEvent.TurnStart);
            Assert.That(firstTurn, Is.Not.Null);
            Assert.That(firstTurn.SourceId, Is.EqualTo("hero"));
        }

        [Test]
        public void start_battle_moves_out_of_intro()
        {
            BattleState state = CreateBattle(TestSupport.SampleSetup());
            Assert.That(state.Phase, Is.EqualTo(BattlePhase.Intro));
            state = StartBattle(state);
            Assert.That(state.Phase, Is.Not.EqualTo(BattlePhase.Intro));
        }

        // ---------------------------------------------------------------------
        // Rally / items via the live pipeline
        // ---------------------------------------------------------------------

        [Test]
        public void rally_pulls_a_benched_pet_into_the_active_party()
        {
            BattleState state = StartBattle(CreateBattle(TestSupport.SampleSetup()));
            Assert.That(state.Reserve.Count, Is.EqualTo(1));
            int partyBefore = LivingUnits(state, Side.Party).Count;

            BattleState s = state;
            int guard = 0;
            while (s.Phase != BattlePhase.Ended && guard < 200)
            {
                guard += 1;
                if (s.Phase == BattlePhase.AwaitingInput && s.ActiveUnitId == "hero")
                {
                    s = SubmitAction(s, BattleAction.MakeRally(0));
                    break;
                }
                if (s.Phase == BattlePhase.AwaitingInput)
                {
                    s = SubmitAction(s, BattleAction.MakeDefend());
                }
                else
                {
                    s = ResolveAiTurn(s);
                }
            }
            Assert.That(s.Reserve.Count, Is.EqualTo(0));
            Assert.That(LivingUnits(s, Side.Party).Count, Is.EqualTo(partyBefore + 1));
            Assert.That(s.Log.Exists(l => l.Event == BattleLogEvent.Rally), Is.True);
        }

        [Test]
        public void using_a_potion_consumes_inventory_and_heals()
        {
            BattleState state = StartBattle(CreateBattle(TestSupport.SampleSetup()));
            BattleUnit hero = GetUnit(state, "hero");
            hero.Hp = 30;

            BattleState s = state;
            int guard = 0;
            while (s.Phase != BattlePhase.Ended && guard < 200)
            {
                guard += 1;
                if (s.Phase == BattlePhase.AwaitingInput && s.ActiveUnitId == "hero")
                {
                    int before = s.Inventory[ItemKind.Potion];
                    s = SubmitAction(s, BattleAction.MakeItem(ItemKind.Potion, "hero"));
                    Assert.That(s.Inventory[ItemKind.Potion], Is.EqualTo(before - 1));
                    break;
                }
                if (s.Phase == BattlePhase.AwaitingInput)
                {
                    s = SubmitAction(s, BattleAction.MakeDefend());
                }
                else
                {
                    s = ResolveAiTurn(s);
                }
            }
            BattleUnit healedHero = GetUnit(s, "hero");
            Assert.That(healedHero.Hp, Is.GreaterThan(30));
        }

        // ---------------------------------------------------------------------
        // Status effects driven through the engine
        // ---------------------------------------------------------------------

        [Test]
        public void burn_chips_a_targets_hp_over_the_turns()
        {
            BattleState state = StartBattle(CreateBattle(TestSupport.SampleSetup()));
            BattleUnit target = LivingUnits(state, Side.Enemy)[0];
            int hpBefore = target.Hp;
            Combat.ApplyStatus(target, StatusKind.Burn);
            Assert.That(BattleStateOps.HasStatus(target, StatusKind.Burn), Is.True);

            BattleState s = state;
            for (int i = 0; i < 30 && s.Phase != BattlePhase.Ended; i++)
            {
                if (s.Phase == BattlePhase.AwaitingInput
                    && !string.IsNullOrEmpty(s.ActiveUnitId))
                {
                    s = SubmitAction(s, BattleAction.MakeDefend());
                }
                else
                {
                    s = ResolveAiTurn(s);
                }
                BattleUnit t = GetUnit(s, target.Id);
                if (t != null && !t.Alive) break;
            }
            BattleUnit after = GetUnit(s, target.Id);
            Assert.That(after.Hp, Is.LessThan(hpBefore));
        }

        // ---------------------------------------------------------------------
        // Full 3v5 battle round-trip — the headline test
        // ---------------------------------------------------------------------

        [Test]
        public void runs_a_deterministic_3v5_battle_to_completion()
        {
            BattleState state = CreateBattle(TestSupport.SampleSetup());

            BattleState s = StartBattle(state);
            int turns = 0;
            const int maxTurns = 4000;

            while (s.Phase != BattlePhase.Ended && turns < maxTurns)
            {
                turns += 1;
                TestSupport.AssertConsistent(s);

                if (s.Phase == BattlePhase.AwaitingInput
                    && !string.IsNullOrEmpty(s.ActiveUnitId))
                {
                    BattleUnit hero = GetUnit(s, s.ActiveUnitId);
                    List<BattleUnit> foes = LivingUnits(s, Side.Enemy);
                    Assert.That(foes.Count, Is.GreaterThan(0));

                    // Hero script: cast Arcane Bolt at the first foe, else attack.
                    int bolt = CooldownOf(hero, AbilitySlot.Q);
                    if (hero.Resource >= 12 && bolt <= 0)
                    {
                        s = SubmitAction(s,
                            BattleAction.MakeAbility(AbilitySlot.Q, foes[0].Id));
                    }
                    else
                    {
                        s = SubmitAction(s, BattleAction.MakeAttack(foes[0].Id));
                    }
                }
                else if (s.Phase == BattlePhase.Resolving)
                {
                    s = ResolveAiTurn(s);
                }
                else
                {
                    Assert.Fail($"unexpected phase {s.Phase}");
                }
            }

            // The battle must have terminated cleanly within the turn budget.
            Assert.That(s.Phase, Is.EqualTo(BattlePhase.Ended));
            Assert.That(turns, Is.LessThan(maxTurns));
            Assert.That(
                s.Outcome == BattleOutcome.Victory || s.Outcome == BattleOutcome.Defeat,
                Is.True);

            // The reported outcome must agree with the field state.
            Assert.That(s.Outcome, Is.EqualTo(ComputeOutcome(s)));

            int partyAlive = LivingUnits(s, Side.Party).Count;
            int enemyAlive = LivingUnits(s, Side.Enemy).Count;
            if (s.Outcome == BattleOutcome.Victory)
            {
                Assert.That(enemyAlive, Is.EqualTo(0));
                Assert.That(partyAlive, Is.GreaterThan(0));
            }
            else
            {
                Assert.That(partyAlive, Is.EqualTo(0));
            }

            // The log must bookend the battle.
            Assert.That(s.Log[0].Event, Is.EqualTo(BattleLogEvent.BattleStart));
            BattleLogEvent last = s.Log[s.Log.Count - 1].Event;
            Assert.That(
                last == BattleLogEvent.Victory || last == BattleLogEvent.Defeat,
                Is.True);

            TestSupport.AssertConsistent(s);
        }

        [Test]
        public void auto_resolve_battle_is_reproducible_for_a_fixed_seed()
        {
            // Same seed -> the engine is fully deterministic.
            BattleState a = AutoResolveBattle(
                CreateBattle(TestSupport.SampleSetup(0xBEEF)));
            BattleState b = AutoResolveBattle(
                CreateBattle(TestSupport.SampleSetup(0xBEEF)));
            Assert.That(a.Phase, Is.EqualTo(BattlePhase.Ended));
            Assert.That(a.Outcome, Is.EqualTo(b.Outcome));
            Assert.That(a.TurnCounter, Is.EqualTo(b.TurnCounter));
            Assert.That(a.Log.Count, Is.EqualTo(b.Log.Count));
        }

        [Test]
        public void different_seeds_can_produce_different_battle_lengths()
        {
            // Across a spread the engine must show RNG-driven variation.
            var lengths = new HashSet<int>();
            for (int seed = 1; seed <= 12; seed++)
            {
                BattleState done = AutoResolveBattle(
                    CreateBattle(TestSupport.SampleSetup(seed)));
                Assert.That(done.Phase, Is.EqualTo(BattlePhase.Ended));
                lengths.Add(done.TurnCounter);
            }
            Assert.That(lengths.Count, Is.GreaterThan(1));
        }

        [Test]
        public void ready_unit_breaks_ties_by_lowest_unit_index()
        {
            BattleState state = CreateBattle(TestSupport.SampleSetup());
            // Force two units to a full bar; the earlier index must win.
            state.Units[2].Atb = Defs.ATB_FULL;
            state.Units[4].Atb = Defs.ATB_FULL;
            BattleUnit ready = ReadyUnit(state);
            Assert.That(ready.Id, Is.EqualTo(state.Units[2].Id));
        }
    }
}
