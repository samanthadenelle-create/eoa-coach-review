// =============================================================================
// api/_lib/tunables.js - PROD-022, the REMOTE KNOBS the Pi crash loop is bisected
// with. Read side, validation, and the one writer.
// -----------------------------------------------------------------------------
// Owner ruling 2026-09-02, verbatim:
//   "make the testing as robust as possible with as many solutions as
//    possible... all we really have to do is just flip a flag and possibly
//    redeploy"
//
// A WebGL rebuild costs about thirty minutes. PROD-022 is a P0 crash loop that
// reproduces inside Pi Browser on the owner's iPhone and NOWHERE else - desktop
// Chrome ran the identical build for 62 minutes. So every candidate mitigation
// ships in ONE build behind its OWN key, all defaulting to today's behaviour,
// and the bisect is flag flips against this table.
//
// -----------------------------------------------------------------------------
// ⛔ THIS FILE HOLDS NO DEFAULTS, AND THAT IS THE DESIGN.
// -----------------------------------------------------------------------------
// The defaults live in the BUILD, in DeNelle.Core.Ops.RemoteTunables.Registry,
// and they are the values the shipping code hardcoded before PROD-022 touched
// it. This table carries OVERRIDES ONLY. An empty table therefore means "today's
// behaviour", and there is exactly one place a default can be read - which is the
// duplicated-state failure CLAUDE.md sections 2, 5 and 16 keep warning about.
//
// The KEY LIST below is duplicated (client registry / this file / the operator
// CLI), and it is duplicated ON PURPOSE and only as an ALLOWLIST: a typo'd key
// must be REFUSED at write time rather than accepted and silently ignored by
// every client forever. It is a spell-check, never a source of truth.
//
// -----------------------------------------------------------------------------
// FAIL-TO-DEFAULT. Not fail-open, not fail-closed - nothing here is a seal.
// An unreachable table, a query timeout, a malformed row: readTunables answers
// ok=false, the endpoint reports readOk:false, and every client resolves every
// knob to its shipping default. There is no state in which a failure here can
// make the game behave differently from the build that shipped.
//
// CACHE POLICY mirrors api/_lib/maintenance.js: a short in-lambda memo so one
// warm instance does not re-query Neon per request in a burst. The knobs are
// flipped by a human during a bisect, so a few seconds of lag is invisible.
//
// CommonJS, no dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

/**
 * ALLOWLIST, kept in step BY HAND with DeNelle.Core.Ops.RemoteTunables.Registry
 * and with tools/client-tunables.mjs. It exists so a mistyped key is refused at
 * the moment it is written instead of being accepted and quietly ignored by every
 * client for the rest of the incident.
 *
 * `kind` is checked at write time for the same reason: '2' in a bool is a typo,
 * and the client would fall back to the default and log a bad-value line rather
 * than doing what the operator meant.
 */
const TUNABLE_KEYS = [
    { key: 'pi.eagerStructureWarm', kind: 'bool' },
    { key: 'pi.awaitInitBeforeFirstLoad', kind: 'bool' },
    { key: 'pi.disableRemoteStructureArt', kind: 'bool' },
    { key: 'assets.maxConcurrentRequests', kind: 'int' },
    { key: 'pi.requestTimeoutSeconds', kind: 'int' },
    { key: 'assets.maxRequestAttempts', kind: 'int' },
    { key: 'visuals.missLogCap', kind: 'int' },
    { key: 'trace.assetVerbosity', kind: 'int' },
    // WO-1306 - NOT a PROD-022 knob. The mage's drain return rate, as an integer
    // percent of the damage actually dealt. Build default 100 = today (heal ==
    // damage dealt). Owner ruling 2026-09-02: "be smart, dont make it need a code
    // change, make it tweakable from a db call" - so balance rides the SAME rail
    // rather than growing a second configuration mechanism.
    { key: 'combat.drainReturnPct', kind: 'int' },
    // WO-1327 - NOT PROD-022 knobs either. Two VFX FEEL/PERF dials that had to be
    // code-side because the numbers they replace are baked into a prefab inside a
    // GITIGNORED art pack (Assets/Spells Pack/), where a hand-edit cannot be
    // reviewed, cannot be committed, and is erased by the next re-import.
    //   vfx.particleBouncePct  - build default 0: a world-colliding VFX particle
    //     stops at the surface it hits and dies, instead of ricocheting off every
    //     layer with zero energy loss and coming back to the caster. 100 = leave
    //     the pack's authored collision alone.
    //   vfx.maxParticleLights  - build default 4: concurrent real-time point
    //     lights ONE spawned VFX host may drive. Spell_Fire_9 authored 25.
    { key: 'vfx.particleBouncePct', kind: 'int' },
    { key: 'vfx.maxParticleLights', kind: 'int' },
    // WO-1330 - NOT PROD-022 knobs. The THREE levers of the one over-time engine
    // (DeNelle.Core.Combat.OverTimeEngine), shared by every damage-over-time and
    // every heal-over-time effect rather than duplicated per ability.
    //   combat.overTimeTickMs        - build default 1000: milliseconds between
    //     pulses. Exactly the "const float tick = 1f" the two shipped DoT
    //     coroutines hardcoded. Cadence only - total delivery is invariant.
    //   combat.overTimeMagnitudePct  - build default 100: percent scale on each
    //     pulse's size, both signs.
    //   combat.overTimeDurationPct   - build default 100: percent scale on each
    //     effect's duration, both signs.
    { key: 'combat.overTimeTickMs', kind: 'int' },
    { key: 'combat.overTimeMagnitudePct', kind: 'int' },
    { key: 'combat.overTimeDurationPct', kind: 'int' },
    // WO-1343 - NOT PROD-022 knobs, and not balance either: this is a CREATIVE
    // choice the owner has explicitly not made. She tagged one Night Store aura,
    // then a second ("i added another option for REalm store, not sure which will
    // be best"), then asked whether the seven Aura_* spell prefabs could cycle
    // "slowly one after another instead ... IF THE OTHER ONE DOESNT LOOK GOOD".
    // Three candidates and a conditional, all of which need to be seen on a
    // device. Building one and discarding the rest would either pick for her or
    // cost a 30-minute rebuild per opinion, so all of it ships and the choice is
    // a row here. Her FIRST pick is the build default; nothing promotes the others.
    //   vfx.nightStoreAuraMode        - build default 0: her first tagged key
    //     (NightStoreoption_Aura). 1 = her second (Store_Aura). 2 = walk the seven
    //     Aura_* prefabs one at a time. 3 = the Marker8 ring this build replaced.
    //   vfx.nightStoreAuraCadenceMin  - build default 30: her "every 30~min". In a
    //     burst mode a tick re-fires the burst; in rotate mode it advances the walk.
    //   vfx.nightStoreAuraFamilyMask  - build default 127: which of the seven may
    //     be selected (1 Arcane, 2 Dark, 4 Fire, 8 Ice, 16 Light, 32 Nature,
    //     64 Storm). Inert unless mode is 2.
    //   vfx.nightStoreAuraBurstRepeatSec - build default 0 (OFF): extra re-fires of
    //     the burst inside one cadence period. Both store candidates are MEASURED
    //     one-shots, so 0 is her spec read literally.
    { key: 'vfx.nightStoreAuraMode', kind: 'int' },
    { key: 'vfx.nightStoreAuraCadenceMin', kind: 'int' },
    { key: 'vfx.nightStoreAuraFamilyMask', kind: 'int' },
    { key: 'vfx.nightStoreAuraBurstRepeatSec', kind: 'int' },
    // WO-1374 - NOT PROD-022 knobs. THE RAID REWARD TABLE, from the north-star map
    // docs/PROGRAM_RAID_ECONOMY_2026-09-04.md, whose section 12.7 says in capitals
    // that every number in it is a tunable. This is the curve the owner sets BY
    // FEEL: how much a raid pays, and how much better raiding has to get before it
    // pays more.
    //   raid.lootWoodBase   - build default 1800: wood at a PERFECT run (3 stars
    //     AND 100% razed) on a Camp I-tier base, before the camp multiplier.
    //   raid.lootIronBase   - build default 1100: the same for iron.
    //   the five ladder rungs - percent of that base by result, per the map:
    //     failed 18 (the middle of its stated 15-20 band, and deliberately not 0),
    //     1 star 50, 2 stars 75, 3 stars 100, 3 stars + 100% destruction 110.
    // (!) These two bases are the ONE place in this file where a default is NOT
    // today's shipped behaviour - today a raid pays zero wood and zero iron, which
    // is the defect the work order exists to close, and the map states the target
    // outright. Same shape as combat.drainReturnPct shipping at her 60. Setting
    // both bases to 0 restores the old food-and-crystals-only payout exactly.
    // (!) GOLD IS HERE NOW. The fork WO-1374 was blocked on was CLOSED at commit
    // 281902df0: troops cost GOLD, they ALSO take time, and a second gold spend
    // hires mercenaries to skip the clock. Gold is FOUR knobs, not one, because
    // the map publishes a DESIGNED target per camp (2200 / 3100 / 4500 / 6500)
    // sized at 125-140% of that camp's expected army replacement cost - and it is
    // deliberately NOT multiplied by the camp's rewardMultiplier, since x1.5 of
    // 2200 is 3300 and her Camp II number is 3100.
    //   raid.lootCrystalsBase / ...PerStar - build defaults 20 and 2: a perfect
    //     clear pays 26 crystals, DOWN from the 55 this build used to pay, and not
    //     multiplied by the camp multiplier either. "Crystals are timer
    //     compression" - it is the one reward in the map's table that decreases.
    { key: 'raid.lootWoodBase', kind: 'int' },
    { key: 'raid.lootIronBase', kind: 'int' },
    { key: 'raid.lootFailPct', kind: 'int' },
    { key: 'raid.lootOneStarPct', kind: 'int' },
    { key: 'raid.lootTwoStarPct', kind: 'int' },
    { key: 'raid.lootThreeStarPct', kind: 'int' },
    { key: 'raid.lootPerfectPct', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp1', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp2', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp3', kind: 'int' },
    { key: 'raid.lootCoinsBaseBastion', kind: 'int' },
    { key: 'raid.lootCrystalsBase', kind: 'int' },
    { key: 'raid.lootCrystalsPerStar', kind: 'int' },
    //   raid.lootRepeatClearPct - build default 60 (WO-1461, owner ruling 2026-09-06
    //     20:33): the share of ordinary loot a re-clear pays while the camp's cooldown
    //     is still running. It shipped as a compiled const 0.25f, which is exactly why
    //     it disagreed with her ruling and could not be flipped. Clamped 0..100 at the
    //     consumer - a repeat may never pay MORE than a first clear.
    //   raid.cacheCapPerResource - build default 1800: per-resource ceiling on the RAID
    //     CACHE, the temporary hold that catches loot the town bank refused so a win is
    //     never burned. Capped resources only (wood/iron/stone). 1800 is one perfect
    //     Camp I wood haul - a STATED DERIVATION, not her number; she ruled the
    //     mechanic and said only "a modest cap". 0 restores the pre-WO-1461 burn.
    { key: 'raid.lootRepeatClearPct', kind: 'int' },
    { key: 'raid.cacheCapPerResource', kind: 'int' },
    // WO-1763 PER-CAMP RAID DIFFICULTY - NOT PROD-022 knobs. Two axes per camp, and
    // the first difficulty levers on this rail at all: until this ticket the ONLY way
    // to make a camp harder was to edit Assets/Resources/Data/Canonical/scene-configs.json
    // and ship a build. The owner nearly 3-starred the top camp with a level-4 hero, and
    // that camp's garrison block is a field-for-field clone of the one below it on every
    // difficulty axis - read the authored values off that JSON, never off a number here.
    //   raid.difficultyMultPct<Camp> - build default 100: a PERCENT on the camp's
    //     AUTHORED difficultyMultiplier, which is the one number that scales a raid
    //     defender's HP and contact damage. 100 is identity and bit-identical to today
    //     (the consumer short-circuits and never round-trips the float). Clamped 25..400
    //     at the consumer. 160 = 1.6x the authored toughness on both axes.
    //   raid.levelOffset<Camp> - build default -999, a SENTINEL meaning "use the value
    //     scene-configs.json authors". It REPLACES that offset, it does not add to it -
    //     the number written is the offset. Deleting the row is the same as the sentinel
    //     and is this table's documented resting state. Any other value is clamped -5..20
    //     at the consumer. The spawner's max(baseEnemyLevel, playerLevel + offset) floor
    //     is untouched, so this only ever raises the ceiling.
    // (!) The NEGATIVE SENTINEL is why this family's manifest `min` is -999 rather than
    // -5: test/tunables-manifest.test.js asserts the shipped default is inside the range
    // the page offers, so a min of -5 would be red on correct code.
    { key: 'raid.difficultyMultPctCamp1', kind: 'int' },
    { key: 'raid.difficultyMultPctCamp2', kind: 'int' },
    { key: 'raid.difficultyMultPctCamp3', kind: 'int' },
    { key: 'raid.difficultyMultPctBastion', kind: 'int' },
    { key: 'raid.levelOffsetCamp1', kind: 'int' },
    { key: 'raid.levelOffsetCamp2', kind: 'int' },
    { key: 'raid.levelOffsetCamp3', kind: 'int' },
    { key: 'raid.levelOffsetBastion', kind: 'int' },
    // WO-1773 TOWN WAVE DIFFICULTY + THE TOWN-REGEN COMBAT GATE. Two dead steps
    // measured off an external tester's wave-176 recording, and fixing either one
    // alone closes nothing:
    //   A. town.regenSuppressSecondsAfterHit / town.regenPctDuringWave - the town
    //      safe-zone regen had NO combat check at all. It is a fraction of MaxHp per
    //      second, so it scales with gear while incoming damage is capped by the wave
    //      curve's clamp: the gap widens with every upgrade and can never be
    //      outgrown. This is the PREREQUISITE - a heavier roster cannot move a bar
    //      that refills faster than it drains. Defaults 0 (no gate) and 100 (full
    //      rate in a wave) are today exactly. The suppression window WINS over the
    //      in-wave percent, and the first-time tutorial is never gated.
    //   B. wave.hpGrowthPctPerWave / wave.dmgGrowthPctPerWave / wave.maxCountPct /
    //      wave.countCapPct / wave.maxSimultaneousPct - nothing got harder after wave
    //      60, so wave 176 IS wave 60. The two growth knobs are HUNDREDTHS of
    //      multiplier ADDED per wave past the curve's clamp band (additive, not
    //      multiplicative - the shapes diverge hard at high waves); the three
    //      percents scale the roster ceiling, the endless count cap and the on-screen
    //      concurrency cap. Defaults 0 / 0 / 100 / 100 / 100 are today exactly.
    // (!) wave.maxSimultaneousPct is a PHONE FRAME BUDGET, not a difficulty dial - it
    // is the only knob in this family that can regress device frame rate, and its
    // consumer clamps it tighter (25..400) than the roster knobs for that reason.
    { key: 'town.regenSuppressSecondsAfterHit', kind: 'int' },
    { key: 'town.regenPctDuringWave', kind: 'int' },
    //   town.captureSalvagePct - build default 50 (WO-1872, owner ruling 2026-09-18). The
    //     captured Iron Bastion now converts as the DESTROYED camp: its walls and watchtowers
    //     arrive as rubble and the player clears each ruin for salvage worth this percent of
    //     that structure's catalog build cost. 0 = clearing pays nothing; 100 = a full refund.
    //     Clamped 0..100 at the consumer, deliberately not 0..1000: a ruin that paid more than
    //     it cost to build would turn the perimeter into a resource printer.
    { key: 'town.captureSalvagePct', kind: 'int' },
    { key: 'wave.hpGrowthPctPerWave', kind: 'int' },
    { key: 'wave.dmgGrowthPctPerWave', kind: 'int' },
    { key: 'wave.maxCountPct', kind: 'int' },
    { key: 'wave.countCapPct', kind: 'int' },
    { key: 'wave.maxSimultaneousPct', kind: 'int' },
    //   raid.starterArmySize - build default 10 (WO-1803, 2026-09-16; was 3): the
    //     TOTAL free troops granted the first time a save has a Barracks (map
    //     section 2, "the first army is free"). The CLIENT splits it even between
    //     Footmen and Archers, remainder to Footmen - so 10 is 5 + 5 and this row
    //     never carries the composition. Once per save, so a rebuilt Barracks is not
    //     a troop faucet and an existing save keeps the squad it already took.
    //     0 disables it. Clamped client-side to the fresh-save housing cap (10).
    { key: 'raid.starterArmySize', kind: 'int' },
    // WO-1379 HEARTFIRE - the raid PACING charge, and it is a CHARGE, NOT A
    // CURRENCY: never earned, traded, stored, gifted or bought, so neither key
    // below is a price and neither may ever be joined to a wallet or a purchase.
    //   raid.heartfireMaxCharges   - build default 3: how many expeditions the
    //     Heart can sustain at once. Charges STACK to this ceiling so a player who
    //     sleeps or works is not punished.
    //   raid.heartfireRegenSeconds - build default 14400 (4 h) per charge. It
    //     ships EQUAL to the shortest authored per-camp cooldown on purpose, which
    //     is what keeps "a player holding Heartfire always has somewhere to spend
    //     it" true. Raising it past that shortest cooldown breaks the criterion.
    { key: 'raid.heartfireMaxCharges', kind: 'int' },
    { key: 'raid.heartfireRegenSeconds', kind: 'int' },
    // WO-1388 BUILDER'S HOUR - NOT a PROD-022 knob. How long the +1 Builder crew
    // sold by the $1.99 'builders-hour' pack lasts, in seconds.
    //   economy.packTemporaryBuilderSeconds - build default 21600 (6 h, the owner's
    //     number). A charge bought while a window is running is DEFERRED behind it,
    //     never stacked and never burned. 0 refuses the grant and keeps the charge
    //     deferred. Convenience compresses TIME, never sells power - this is a
    //     duration and nothing else.
    { key: 'economy.packTemporaryBuilderSeconds', kind: 'int' },
    // WO-1384b NIGHT MARKET GLOW - NOT PROD-022 knobs. Three FEEL levers on the
    // HUD's permanent store card: a soft rounded ring plus three comets chasing
    // the card's perimeter. Read when the HUD builds the card; clamped there.
    //   hud.nightMarketGlowLapSec      - build default 5 (seconds per lap, 1..60).
    //   hud.nightMarketGlowAlphaPct    - build default 35 (peak alpha %, 0..100).
    //   hud.nightMarketGlowPaletteMask - build default 7 (Gold=1|Amber=2|Rose=4,
    //     0..7; an empty mask resolves to Gold alone, never to nothing).
    { key: 'hud.nightMarketGlowLapSec', kind: 'int' },
    { key: 'hud.nightMarketGlowAlphaPct', kind: 'int' },
    { key: 'hud.nightMarketGlowPaletteMask', kind: 'int' },
    // WO-1366 ARENA WAGER - NOT PROD-022 knobs. PRICES: the Crystals staked per
    // opponent tier and the purse a win pays. Read live by ArenaWagerTunables,
    // which owns the clamps; the defaults are exactly what ArenaCatalog.cs
    // hardcoded, deliberately not re-picked.
    //   arena.wagerTier1  - build default 50  (Crystals, 1..100000).
    //   arena.wagerTier2  - build default 100 (Crystals, 1..100000).
    //   arena.wagerTier3  - build default 200 (Crystals, 1..100000).
    //   arena.winPursePct - build default 200 (percent of the wager, 100..1000;
    //     100 returns only the stake, below that a win would lose money).
    { key: 'arena.wagerTier1', kind: 'int' },
    { key: 'arena.wagerTier2', kind: 'int' },
    { key: 'arena.wagerTier3', kind: 'int' },
    { key: 'arena.winPursePct', kind: 'int' },
    // WO-1094 - NOT a PROD-022 knob, and not balance: the honest FLOOR under a
    // DERIVED bound. The hero's off-mesh playable-bounds clamp used to be a
    // hardcoded +/-50 box, written for a castle and left standing in a merged
    // 1000x1000 world, where it teleported a legitimately-placed hero back to the
    // old bounds. It is now MEASURED from the live Terrain extent - but three
    // shipped scenes carry no Terrain at all (Village2, RaidBase_*, the legacy
    // MainCastle_Hall), and in those a purely-derived bound is NO bound: the hero
    // drifts unbounded on the off-mesh transform fallback, inside the raid loop.
    //   hero.playableFallbackHalf - build default 50 metres: EXACTLY the bound this
    //     build replaced, so an empty table reproduces today's behaviour in every
    //     unmeasured scene. Never read where a Terrain exists. Clamped 1..100000 at
    //     the consumer, so a typo of 0 cannot pin the hero to the origin.
    { key: 'hero.playableFallbackHalf', kind: 'int' },
    // WO-1095 - the stranding watchdog's wall-clock ceiling on raid STAGING, in
    // seconds. Staging costs nothing on the raid clock, so the only thing a
    // wall-clock bound should catch is a DEAD session. RaidDeployController already
    // reads this key and answers 900 for itself while the key has no spec, so
    // registering it changes nothing on its own - it just makes the number
    // reachable without a 30-minute rebuild.
    //   raid.stagingCeilingSeconds - build default 900 (fifteen minutes).
    { key: 'raid.stagingCeilingSeconds', kind: 'int' },
    // WO-1810 - WHAT LOSING A RAID COSTS, owner ruling 2026-09-16, verbatim: "there
    // is no cost to losing a raid" / "loss should lose troops and then rebuild" /
    // "maybe lose 100 on fail, lose 60% on retreat" / "but any troop killed is dead
    // so 60% of whats left". Percents of the SURVIVORS; troops KILLED on the field
    // are dead on every outcome and are deliberately NOT on the rail.
    //   raid.lossPctFail    - build default 100: a failed raid (clock expiry, wipe,
    //     watchdog, hero-death settlement) loses the whole warband.
    //   raid.lossPctRetreat - build default 60: the price of the player's own
    //     Retreat, charged on what is left after the killed.
    // ⚠ BOTH ARE A DEPARTURE from "the default is today's behaviour": the build lost
    // 0% permanently - the fallen came home "wounded" and healed free on a timer.
    // A row of 0 on both restores that.
    { key: 'raid.lossPctFail', kind: 'int' },
    { key: 'raid.lossPctRetreat', kind: 'int' },
    // WO-1811 - DISMISSING A TRAINED TROOP, owner ruling 2026-09-16, verbatim:
    // "you need to remove ones from active army, and either return them to gold or
    // to a staged ready troop". The Reserve is the free exit; this prices the
    // permanent one as a PERCENT OF THE TROOP'S CATALOG GOLD VALUE.
    //   army.dismissReturnPercent - build default 50.
    // ⚠ IT REFUNDS NOTHING THAT WAS PAID: training has charged nothing since
    // WO-1387, so there is no spend to give back. The owner ruled the VERB and not
    // the number, which is exactly why the number is a row and not a literal.
    { key: 'army.dismissReturnPercent', kind: 'int' },
    // WO-1594 - THE RAID HONOR MILESTONES, owner ruling 2026-09-09, verbatim
    // choice: "Tunables with those defaults". The raid HUD opens with three stars
    // lit and snuffs them as these milestones pass, and the settle clamps the
    // payout to min(settle, honor) - so these three decide what a raid PAYS as
    // well as what the bar narrates. RaidScoring reads all three through
    // RemoteTunables.SpecFor before Int, so an unregistered key still answers the
    // shipping default instead of 0.
    //   raid.honorThirdStarSeconds - build default 90 (half the 180 s clock).
    //   raid.honorSecondStarSeconds - build default 150 (the last 30 s).
    //   raid.honorSecondStarMinDestructionPct - build default 50. An integer
    //     PERCENT, not a fraction: the rail carries no floats, and the consumer
    //     clamps 0..100 and divides by 100.
    { key: 'raid.honorThirdStarSeconds', kind: 'int' },
    { key: 'raid.honorSecondStarSeconds', kind: 'int' },
    { key: 'raid.honorSecondStarMinDestructionPct', kind: 'int' },
    // WO-1373 ROUGH-STONE CHAIN - owner ruling 2026-09-09, verbatim: "there is only
    // one stone type till it gets to jeweler, and then its RND. So only top two tiers
    // of raids can drop stone and no more than 1 per day. 5% drop rate in dungeons not
    // included the starter dungeons".
    //   raid.roughStoneMinTier    - build default 3: the LOWER of the top two rungs on
    //     the Camp I..Iron Bastion ladder, so mage_enclave and iron_bastion drop and
    //     nothing below does. 2 admits fortified_garrison; 5 turns the raid drop off.
    //   raid.roughStonePerDayCap  - build default 1: how many stones EVERY raid
    //     together may pay in one UTC day. GLOBAL, not per camp. 0 turns it off.
    //   dungeon.roughStoneDropPct - build default 5, and the one DEPARTURE here: the
    //     build shipped 15 as a compiled const. 15 restores it. Starter dungeons
    //     (layout tier 1) are excluded by a tier gate, not by this number, and the
    //     guaranteed FIRST stone is not on this axis at all.
    { key: 'raid.roughStoneMinTier', kind: 'int' },
    { key: 'raid.roughStonePerDayCap', kind: 'int' },
    { key: 'dungeon.roughStoneDropPct', kind: 'int' },
    // WO-1805 LANE C - THE DUNGEON DARKNESS. Owner's report 2026-09-16, verbatim: "we never
    // really ever go over the mechanics of the torch in so nobody understands why the torch
    // runs out and why just become suddenly dark". Lane A teaches it; these four make the PACE
    // answerable from the database instead of a ten-minute APK rebuild per opinion.
    //   dungeon.lanternDrainPerSecX100  - build default 50 = 0.50 oil/s = 200 s a flask, which
    //     is exactly what dungeon-balance.json authors. x100 because this rail carries no
    //     floats. 33 ~= 300 s, 25 = 400 s. maxOil is deliberately NOT a knob: it is the meter's
    //     100 % and the denominator of three fraction thresholds.
    //   dungeon.lanternOilStoneRefillPct - build default 100: a cache TOPS the flask. Each
    //     stone stays ONE USE per visit whatever this says.
    //   dungeon.lanternStillRefillPct    - build default 40 = ComposedOilStill's 0.40f, the
    //     one-use flask+cloth field distillation (80 s at today's drain).
    //   dungeon.lanternFinalWarningSec   - build default 30: the final collapse window, range to
    //     1.35 u behind a 0.45..3.2 m fog wall. THE "suddenly dark" knob.
    // Both the drain and the warning window are ALSO authored in dungeon-balance.json, so the
    // client treats a row AT its default as "not set" and leaves that json as the authority.
    { key: 'dungeon.lanternDrainPerSecX100', kind: 'int' },
    { key: 'dungeon.lanternOilStoneRefillPct', kind: 'int' },
    { key: 'dungeon.lanternStillRefillPct', kind: 'int' },
    { key: 'dungeon.lanternFinalWarningSec', kind: 'int' },
    // WO-1348 - NOT PROD-022 knobs and NOT balance: these are the owner's CREATIVE VFX
    // picks, moved off a thirty-minute rebuild and onto this rail. Her ask, verbatim:
    // "is it possible to tag those from the command center? and then change pointer on
    // next town load?" / "realm.vfx(set)" - and her namespace proposal is the key shape,
    // adopted verbatim, VFX-key casing and underscores included.
    //
    // (!) THE VALUE IS A STABLE OPTION ID, NOT A PREFAB PATH. This rail is int-only, so
    // the row names an entry in the pool generated from her own tag file by
    // tools/gen-vfx-pick-options.mjs. Ids are append-only and NEVER reassigned: a sorted
    // position would shift the day somebody tags a new effect and would silently re-point
    // a row she set last week.
    //
    // (!) 0 = THE BUILD-TIME PICK. An empty table therefore renders exactly what
    // Assets/Editor/VfxManualPicks.json renders today - that file stays the default and
    // the record. An id this build cannot resolve falls back to it and traces the reason;
    // it never renders nothing, because art that is picked but never shipped fails with NO
    // ERROR ON SCREEN and that silence has already cost this project three incidents
    // (CLAUDE.md section 16).
    //
    //   realm.vfx.atfootprintoftree_Aura   - the world tree's foot glow (a LOOP slot).
    //   realm.vfx.atfootprintoftree_Impact - the world tree's foot burst. NO build-time
    //     entry: at 0 nothing renders, and setting an id CREATES the tag rather than
    //     replacing one. Key creation is a stated acceptance criterion of the ticket.
    //   realm.vfx.EliteDeath_Impact        - the elite death burst.
    //   realm.vfx.BossDeath_Impact         - the boss death burst.
    { key: 'realm.vfx.atfootprintoftree_Aura', kind: 'int' },
    { key: 'realm.vfx.atfootprintoftree_Impact', kind: 'int' },
    { key: 'realm.vfx.EliteDeath_Impact', kind: 'int' },
    { key: 'realm.vfx.BossDeath_Impact', kind: 'int' },
];

// ─────────────────────────────────────────────────────────────────────────────
// WO-1799 THE STOREWIDE SALE - owner 2026-09-16, verbatim: "can we run a 30%
// deal?" - and the FIRST TWO `serverOnly` ROWS ON THIS RAIL.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⛔ WHY THESE TWO ARE APPENDED AND NOT WRITTEN INSIDE THE LITERAL ABOVE.
//
// The array literal above is not just a list - it is a DOMAIN THE UNITY BUILD'S
// ORACLE COMPARES ITSELF AGAINST. Assets/Editor/Regression/
// RemoteTunablesDefaultsRegression.cs case 4 (`Case4_KeyDomain` -> `CompareDomain`)
// reads this file from disk, matches `TUNABLE_KEYS = [ ... ];` with a regex, pulls
// every `key: '...'` out of it and asserts the result is EXACTLY the pinned
// ExpectedDefaults set, reporting anything extra as an "UNPINNED key". Its own
// failure text explains why: *"a key the server knows and the build does not is
// stored and silently ignored"*.
//
// ⭐ THAT IS PRECISELY WHAT A serverOnly KEY IS SUPPOSED TO BE - the server reads
// it, on the money path, and no build ever should. So the literal above holds the
// CLIENT-READ domain the build oracle is entitled to pin, and these rows are
// appended here, deliberately outside it. The runtime allowlist is the same
// allowlist either way: `setTunable`/`isKnownKey` walk the joined array.
//
// ⛔ AND THE APPEND BLOCK IS GUARDED, so it cannot become a back door. The
// assertion below THROWS at module load if any appended row lacks
// `serverOnly: true` - a client knob smuggled in here would otherwise escape the
// build oracle silently, which is the one thing this structure must not allow.
//
// ⚠ THE ALTERNATIVE, FOR THE RECORD: a one-line skip in that C# oracle for specs
// carrying `serverOnly: true`. That is the tidier fix and it is the LEAD'S CALL -
// this lane is forbidden to touch Assets/ (the owner wants the sale without a new
// APK). If that skip is ever added, these two rows can move back inside the
// literal and this whole comment deletes.
//
// ⛔ `serverOnly: true` MEANS NO BUILD READS THIS KEY AND NONE EVER SHOULD.
// The mechanism it rides was landed by WO-1682 D3 for exactly this shape of
// number (api/_lib/tunable-manifest.js, the serverOnly header). It buys ONE
// exemption - from the build-registry join - and nothing else: the key must still
// be allowlisted, which is what these rows are.
//
    // ⛔ `serverOnly: true` MEANS NO BUILD READS THIS KEY AND NONE EVER SHOULD.
    // The mechanism it rides was landed by WO-1682 D3 for exactly this shape of
    // number (api/_lib/tunable-manifest.js, the serverOnly header). It buys ONE
    // exemption - from the build-registry join, because RemoteTunables.Registry
    // deliberately does not carry these - and nothing else: the key must still be
    // allowlisted here to be writable, which is this row.
    //
    // ⛔ AND IT IS WHAT KEEPS A PRICE OFF THE PHONE. A sale percentage the Unity
// client could read would be a SECOND authority on money, on a device we do not
// control. api/client-tunables.js therefore OMITS every serverOnly key from its
// public payload, and neither key gets a Command Center card - that page's own
// boundary notice says prices are never editable there.
//
// ⚠ THE END TIME IS EPOCH **MINUTES**. normalizeValue() below accepts at most nine
// digits; epoch SECONDS is ten and would be REFUSED at write time. Do not widen
// that rule to make seconds fit - it widens every key on the rail, and the client
// parses these as C# int. See api/_lib/store-sale.js.
//
//   store.saleBps            - 0 (resting state) = NO SALE. 3000 = 30% off every
//     quotable SKU on every server-priced rail. Clamped 0..7000 on the READ
//     (store-sale.js), so a fat thumb cannot give the store away.
//   store.saleEndsAtEpochMin - 0/absent = the sale runs until it is cleared.
//     Otherwise the sale STOPS at that minute without anybody being awake.
const SERVER_ONLY_TUNABLE_KEYS = [
    { key: 'store.saleBps', kind: 'int', serverOnly: true },
    { key: 'store.saleEndsAtEpochMin', kind: 'int', serverOnly: true },
];

for (const spec of SERVER_ONLY_TUNABLE_KEYS) {
    // Loud at module load, not silent at write time. A row that reaches this list
    // without the marker would be invisible to the build oracle AND served to every
    // phone by api/client-tunables.js - two failures at once, neither with a symptom.
    if (!spec || spec.serverOnly !== true) {
        throw new Error('SERVER_ONLY_TUNABLE_KEYS carries a row without serverOnly:true (' +
            (spec && spec.key) + '). A client knob belongs in the TUNABLE_KEYS literal, ' +
            'where the build oracle can see it.');
    }
    TUNABLE_KEYS.push(spec);
}

/** How long one warm lambda may reuse a read of the table. */
const MEMO_TTL_MS = 5000;

/** A query that has not answered in this long is treated as unreachable. */
const QUERY_TIMEOUT_MS = 2500;

/** Values are short. Anything longer is not a knob. */
const VALUE_MAX_LEN = 32;

let s_memo = null;
let s_memoAt = 0;

/** The spec for one key, or null when the key is not one of ours. */
function specFor(key) {
    if (typeof key !== 'string') return null;
    for (const spec of TUNABLE_KEYS) {
        if (spec.key === key) return spec;
    }
    return null;
}

/** True when `key` is an allowlisted knob. */
function isKnownKey(key) {
    return specFor(key) !== null;
}

/**
 * Validate a value against its key's kind. Returns the NORMALIZED string to
 * store ('0'/'1' for bools, a canonical decimal for ints), or null when the
 * value is unusable.
 */
function normalizeValue(key, raw) {
    const spec = specFor(key);
    if (!spec) return null;
    if (raw == null) return null;

    const s = String(raw).trim();
    if (!s || s.length > VALUE_MAX_LEN) return null;

    if (spec.kind === 'bool') {
        const low = s.toLowerCase();
        if (low === '1' || low === 'true' || low === 'on') return '1';
        if (low === '0' || low === 'false' || low === 'off') return '0';
        return null;
    }

    if (!/^-?\d{1,9}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return String(n);
}

/**
 * Read every knob row. NEVER throws, NEVER rejects.
 *
 * @param {Function} sql neon(...) client, or null
 * @returns {Promise<{ok: boolean, values: object, rows: object, reason: string}>}
 *   ok=false means the table could not be read. The client then resolves every
 *   knob to its SHIPPING DEFAULT, which is today's behaviour - so a failure here
 *   can never change how the game behaves.
 */
async function readTunables(sql) {
    const now = Date.now();
    if (s_memo && (now - s_memoAt) < MEMO_TTL_MS) {
        return s_memo;
    }

    if (!sql) {
        try {
            console.warn('[tunables] no sql handle - every knob resolves to its shipping default');
        } catch (_) { /* logging must never break a request */ }
        return { ok: false, values: {}, rows: {}, reason: 'NO_SQL_HANDLE' };
    }

    let rows = null;
    try {
        // The timeout is the whole point of the race: a hung Neon socket must
        // resolve in bounded time rather than hold the request until the platform
        // kills it. A hang and an outage are the same answer here.
        rows = await Promise.race([
            sql`SELECT key, value, updated_by, updated_at FROM client_tunables`,
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error('tunables query timeout')), QUERY_TIMEOUT_MS)),
        ]);
    } catch (err) {
        try {
            console.warn('[tunables] table unreadable (' + (err && err.message) +
                         ') - every knob resolves to its shipping default');
        } catch (_) { /* noop */ }
        // NOT memoised. One blip must not hold a stale answer for the warm life
        // of the instance - the same reasoning api/_lib/maintenance.js records.
        return { ok: false, values: {}, rows: {}, reason: 'QUERY_FAILED' };
    }

    // ⚠ SHAPE-CHECK BEFORE WALKING. A driver that answers with a STRING is
    // perfectly iterable in JavaScript and would walk characters, yielding
    // { ok: true, values: {} } - the right OUTCOME by the wrong ROUTE. ok:true
    // means "we read the table", which is a claim we could not make. This is the
    // identical trap api/_lib/maintenance.js documents; it is repeated because it
    // was found in production, not because it is theoretical.
    const rowList = Array.isArray(rows) ? rows
        : (rows && Array.isArray(rows.rows) ? rows.rows : null);
    if (rowList === null) {
        try { console.warn('[tunables] query returned a non-array result - reported as unreadable'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    const values = {};
    const meta = {};
    let ignored = 0;
    try {
        for (const r of rowList) {
            const key = r && r.key != null ? String(r.key) : '';
            if (!isKnownKey(key)) { ignored++; continue; }
            const value = r.value != null ? String(r.value) : '';
            values[key] = value;
            meta[key] = {
                value: value,
                updatedAt: r.updated_at != null ? String(r.updated_at) : null,
                updatedBy: r.updated_by != null ? String(r.updated_by) : null,
            };
        }
    } catch (err) {
        try { console.warn('[tunables] malformed rows (' + (err && err.message) + ')'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    if (ignored > 0) {
        // NOT an outage, and deliberately different from maintenance.js's
        // all-rows-malformed rule: an unrecognised key here is FORWARD
        // COMPATIBILITY (a newer build's knob), not corruption. An empty result
        // is the correct, expected resting state of this table, so it must never
        // be reported as unreadable.
        try { console.warn('[tunables] ignored ' + ignored + ' row(s) naming an unregistered key'); }
        catch (_) { /* noop */ }
    }

    const good = { ok: true, values: values, rows: meta, reason: 'OK' };
    s_memo = good;
    s_memoAt = now;
    return good;
}

/**
 * Set one knob. UPSERT, never "ON CONFLICT DO NOTHING" - a write that silently
 * did not land would send the owner chasing a build during an incident. Reads the
 * row BACK rather than trusting the statement.
 *
 * @throws when the key or value is not allowlisted, or the write returned no row.
 */
async function setTunable(sql, key, value, operator) {
    const spec = specFor(key);
    if (!spec) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const normalized = normalizeValue(key, value);
    if (normalized === null) {
        const err = new Error('BAD_TUNABLE_VALUE');
        err.code = 'BAD_TUNABLE_VALUE';
        throw err;
    }

    const rows = await sql`
        INSERT INTO client_tunables (key, value, updated_by, updated_at)
        VALUES (${key}, ${normalized}, ${operator}, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        RETURNING key, value, updated_by, updated_at`;
    if (!rows || !rows.length) {
        const err = new Error('WRITE_RETURNED_NO_ROW');
        err.code = 'WRITE_RETURNED_NO_ROW';
        throw err;
    }
    s_memo = null;
    s_memoAt = 0;
    return rows[0];
}

/**
 * Delete one knob's row, returning that knob to its SHIPPING DEFAULT.
 *
 * ⭐ CLEARING IS NOT "SETTING IT TO 0". Clearing removes the override entirely, so
 * the client answers whatever the build hardcodes - which for an int knob such as
 * pi.requestTimeoutSeconds is 20, not 0. This is the one-word way back to today's
 * behaviour and it is why the operator surface exposes it separately.
 *
 * @returns {Promise<{key: string, existed: boolean}>}
 */
async function clearTunable(sql, key) {
    if (!isKnownKey(key)) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const rows = await sql`DELETE FROM client_tunables WHERE key = ${key} RETURNING key`;
    s_memo = null;
    s_memoAt = 0;
    return { key: key, existed: !!(rows && rows.length) };
}

/** Test hook: drop the warm-instance memo so a test can drive consecutive states. */
function _resetMemo() {
    s_memo = null;
    s_memoAt = 0;
}

module.exports = {
    TUNABLE_KEYS,
    MEMO_TTL_MS,
    QUERY_TIMEOUT_MS,
    VALUE_MAX_LEN,
    specFor,
    isKnownKey,
    normalizeValue,
    readTunables,
    setTunable,
    clearTunable,
    _resetMemo,
};
