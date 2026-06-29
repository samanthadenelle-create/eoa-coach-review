# Architecture — the one authoritative overview

> **Read this first for architecture.** This is the single hub that orients you to how the
> project is built. It is intentionally concise: it states the load-bearing decisions and
> points to the per-area **deep-dive docs** rather than restating them. When a deep-dive and
> this hub disagree, the deep-dive wins on detail and **the code wins on truth**
> (`docs/MASTER_CATALOG.md` is verified from source, not from comments — comments lie).
>
> Established 2026-06-13 as the consolidation of ~10 scattered architecture notes. The source
> docs remain as deep-dives (indexed in §8); none were deleted.

---

## 1. The lens — HP B2B architecture (the meta-principle)

The owner runs **HP business-to-business operations at global scale** and manages this project
with the **same architecture**: a PM directing dev leads/architects who give the technical read;
she makes the call against this lens. Agents are those architects — give the **real read** (the
why, the tradeoff, the failure mode), name **easy-vs-right** when they diverge, and let the owner
decide. Never quietly pick easy and present it as the answer.

Why the lens works: B2B commerce only survives thousands of SKUs across regions and channels
**because** concerns are siloed and scope is bounded — catalog exposes state; storefront renders
it; pricing/entitlements/i18n/checkout are each their own service composed through contracts.
Tangle presentation into the catalog and it collapses at scale. **The game is built the same way.**

The four operating laws (full text: `docs/ARCHITECTURE_PRINCIPLES.md`):

1. **Bounded context per component — purposely-limited scope.** An object exposes its own state;
   it does not own its display, input, persistence, or its neighbors' concerns. Each cross-cutting
   concern (presentation, input, economy, persistence, i18n) is its own composed layer talking
   through thin contracts. Enforced structurally by the asmdef boundaries (§2) and service seams.
2. **Presentation is a separate layer that NEVER touches the objects.** Nothing about how a thing
   *looks* lives on the thing itself. Objects expose state; the presentation layer observes and
   renders. A gameplay object must not know a prompt's colors/fonts or that an "F" hint exists.
3. **The One Model — a recursive collection of collections.** Realm ⊃ City-State/Castle ⊃ Building
   (entry) ⊃ composable **capabilities** (Interactable · Upgradable · Destructible · Targetable).
   Behavior is the SUM of capabilities held, not inherited per type. Every system is a *reader* of
   the collection ("does this entry retain capability X?"). **Add by entry, not by code.**
   Danger: ungoverned growth sprawls (the two-VFX-stack scar) — so **POOL by default**, keep it
   **in-check/bounded/lazy**, **one owner per concern**. Full spec:
   `docs/WORLD_COLLECTION_MODEL_DIRECTIVE.md`.
4. **Queue by leverage, not effort.** *Player-felt* work earns the active queue. *Holistic/structural*
   work (refactors, layer extractions) is **leverage, not a feature** — logged and done deliberately,
   **never smuggled into a player-facing change**. Decision lens throughout: **what is right, not
   what is easy** — and when they diverge, name it.

**Tests are the permission gate.** A bold refactor of a working subsystem isn't "done" until tests
prove behavior was preserved. The One Model is data-driven, so it is **unit-testable without the
scene** (assert which entries retain which capabilities). Build on the existing harness
(`Assets/Tests/EditMode|PlayMode`, `_Modules/*/Tests`, `Data/Tests`), don't greenfield.

---

## 2. Assembly / module map (current — CLAUDE.md §5/§6)

First-party gameplay code lives in `Assets/_Modules/`. Module map + per-module READMEs:
`Assets/_Modules/README.md`. The asmdef boundaries **are** law #1 made structural.

| Assembly | Namespace | Contents |
|---|---|---|
| `DeNelle.Core` | `DeNelle.Core.*` | Interfaces, enums, pure data; GameState + SaveSchema/Migrator; SceneRouter; CoreServices registry; CanonicalJson; PanelManager; World/Catalog/Quests. Refs nothing first-party. |
| `DeNelle.AI` | `DeNelle.AI` | Behavior-tree primitives (BTNode/Selector/Sequence/Condition/ActionNode) |
| `DeNelle.Village` | `DeNelle.Village` | The big one (~275 files): Enemy/EnemyBrain, WaveManager, HeartController, HeroLocomotion, buildings, gates, world streaming, VFX |
| `DeNelle.HUD` | `DeNelle.HUD` | VillageHudController + panels — **passive display, never references Village** |
| `DeNelle.Audio` | `DeNelle.Audio` | AudioService, SfxClipLibrary, WebGL unlock |
| `DeNelle.BattleATB` | `DeNelle.BattleATB` | Pure-C# ATB engine + Unity controllers |
| `DeNelle.Dungeons` / `Pets` / `Cosmetics` / `Wallet` / `Web3` / `Onboarding` / `Settings` / `DialogueUI` / `DevTools` | resp. | Bounded feature modules; each → Core only |
| `DeNelle.Editor` | `DeNelle.Editor` | Scene builders, animator factories, build tools, QA gates — editor-only, reflection-only into Village |

**Cross-assembly rule (non-negotiable):** Village → Core only. HUD → Core only. **Never Village ↔ HUD
directly.** Cross-module calls go through `CoreServices.Hud` / `CoreServices.Audio` with null-conditional
(`?.`). Key Core interfaces: `IDamageableStructure`, `IVillageHud`, `IAudioService`.

**Reflection-bridge pattern:** where a module must push into another across an asmdef edge without a
reference (e.g. a struct payload that isn't a valid persistent-UnityEvent arg), a thin reflection
bridge is used (precedent: `WallRepairHudBridge`). This is the sanctioned escape hatch — *not* general
reflection in gameplay code (no new `System.Reflection` in bridge scripts beyond this established pattern).

---

## 3. World / scene model (current)

Verified scene graph (deep facts: `docs/MASTER_CATALOG.md` §2b, `docs/ZONE_STREAMING_ARCHITECTURE.md`):

```
Title ─► HeroSelect ─► PetSelect ── confirm ─► SceneRouter.GoCastle() ─► MainCastle_Hall (HOME HUB)
                                                                              │
MainCastle_Hall  └─ WorldSceneLoader auto-loads ► OuterWorld (ADDITIVE on any hub)
                 └─ SceneTransitionTrigger (south-gate seam) ► OuterWorld + WarpTo hero across seam
OuterWorld       ├─ DungeonEntrance / portal spawner ► Dungeon_HealersCottage / _FolksGranary
                 ├─ RaidOutpostSystem ► 4 cardinal in-world EnemyOutposts (~10s delay)
                 └─ raid access ► Garrison_{troll_outpost,ruined_keep,hill_fort,frost_keep} (ADDITIVE)
Village2 (TD town / raid target) — GoVillage() = async overlay; also a hub (auto-loads OuterWorld)
Breach (Village2/dungeon) ► GoBattle(BattleParams) ► ATBBattle ► returns to ReturnScene
```
> **STALE: 2026-06-28 (combat flow above)** — the `Breach ► ATBBattle` route is superseded. V1 combat =
> a **single-Knight real-time `BattleArena`** in the overworld; **WO-584** routes the dungeon/outpost via a
> **RegionGate warp → resolver → Arena-skinned space → ownership flip** (the flat **ATB is behind
> `ff.atbdungeon`, OFF**). Current truth = `docs/COMBAT_PIVOT_NORTHSTAR.md` + `WorkOrders/WORK_ORDER_584_dungeon_outpost_arena_consolidation.md`.

- **Home/start hub = `MainCastle_Hall`** (the 2026-06-08 castle-start pivot; built by
  `Assets/Editor/CastleHubBuilder.cs`, owner hand-dialed + committed — **do not regen, it reverts
  owner offsets**). Stale "…→ Village" prose lingers in `PetSelectController`/`SceneRouter` headers;
  trust the code — onboarding lands in `MainCastle_Hall`.
- **`Village2`** = generated TD town / raid-target stronghold (canonical). **`Village.unity` =
  ABANDONED / corruption-cursed — never use or re-save it.** `SceneRouter.Village = "Village2"`,
  `Castle = "MainCastle_Hall"`.
- **`OuterWorld` streams additively over any hub** via `WorldSceneLoader` (`HubScenes.IsHub` is the
  single source of hub truth, read by the loader + HUD). Every load guards
  `Application.CanStreamedLevelBeLoaded`.
- **Two-scene NavMesh seam reality:** a navmesh baked in one scene does **not** auto-connect to the
  neighbor's. Crossing is a **confirm-to-cross seam + WarpTo**: `SceneTransitionTrigger.WarpTo`
  disables → warps → re-enables the hero's `NavMeshAgent` across the seam (hero locomotion is
  agent-driven, not a transform — debug "can't cross/exit" as a **bake** issue, not colliders).
  The hero returns to a **return-point** (`ReturnScene` in `BattleParams` for combat; the seam warp
  for world crossings). Cross-zone *AI* pathing across the seam is **deferred** until raids walk
  between zones (off-mesh links the recommended path — `docs/ZONE_STREAMING_ARCHITECTURE.md` §NavMesh).
- **Two raid mechanisms (easy to conflate):** (a) `RaidOutpostSystem` spawns 4 in-world
  `EnemyOutpost`s inside OuterWorld (no scene load); (b) standalone `Garrison_*` **scenes** loaded
  additively, driven by `GarrisonController` from `garrison-recipes.json`.
- **Streaming is North-Star, built lazily.** Today zones are *logical* (one OuterWorld scene,
  classified by position via `ZoneManager`); the load/unload streamer + per-zone state rehydration
  are designed but built only when zones carry real weight. **Defend-the-Tower / PatriciaLight =
  REMOVED 2026-06-09.**

---

## 4. Data / catalog system

The data spine is **catalog (the look) ⊥ repo (the behavior)** — decouple appearance from
properties so you can re-skin without touching logic and re-tune without touching art. Deep-dives:
`docs/CATALOG_SYSTEM.md`, `docs/MASTER_CATALOG/data-catalogs.md`.

- **`CanonicalJson` — the WebGL-safe loader (`DeNelle.Core`).** `File.ReadAllText` throws in WebGL →
  combat/catalogs come up empty. `CanonicalJson.Read` loads `Resources.Load<TextAsset>` **first**,
  filesystem second. **Dual-copy rule:** the editable source lives in `StreamingAssets/Data/Canonical/`,
  and a **`Resources/Data/Canonical/` copy WINS at load** — keep the two in sync (a needed-in-web
  catalog absent from Resources returns `null` in WebGL: exactly the failure CanonicalJson exists to
  prevent).
- **~30 typed catalog classes** over JSON: abilities · weapons/armor (gear) · enemies · buildings ·
  structures (the build-mode `CatalogRegistry`/`CatalogEntry`) · quests · pets · packs · themes.
  `GearCatalog` etc. read the Resources copy through `CanonicalJson`.
- **Orientation/grip/seat is DERIVED from bounds + name, never guessed** (Principle §4). Structures
  bake it via `CatalogOrientationBaker` (longest axis → +Y, base→origin, `manual=true` preserved);
  the bow via `HeroBowAttachment.NormalizeInto`. **This MUST generalize to every weapon + armor
  (`WeaponOrientHelper`), applied at equip + dev-adjustable via DevOrient.** Binding canon +
  algorithm: **`docs/WEAPON_ARMOR_ORIENT_LOGIC.md`** — read before any attach/placement work.
- **DataRegression harness** (`Assets/Editor/Regression/DataRegression.cs`) is the
  "**real object in → assert real response → one marker**" gate: reload through the *real* game path,
  assert the catalog mapped to non-empty rows with ids, emit `REGRESSION_OK` / `REGRESSION_FAIL`
  (LogError on purpose, so it also lands in the flight recorder). Runs headless; it is the cheapest
  behavior-preserving / CI gate. Its own nested editor asmdef references runtime assemblies but is
  referenced by none.

---

## 5. Save system

Persistence spine (deep facts in `docs/MASTER_CATALOG/core.md`):

- **`GameState`** (ScriptableObject, ~41 partialized fields) is the single live state object —
  resources, region progress, hero/pet choices, `BaseLayout`, quests.
- **`SaveSchema`** (`CurrentVersion = 20`) + **`SaveMigrator`** (v1 → v20) handle serialization and
  forward migration. **Rule for new fields:** additive-nullable + schema bump + default-on-read
  (the v14/v18/v20 precedent) — never a breaking change. `BaseLayout` is the public contract once
  raids/Arena land, so treat its shape as a versioned API.
- Resource model: Wood/Iron/Food (gathered → build/upgrade structures) + Crystals/Aether (special
  arc). **Core can't reference Village** — award crystals by writing `GameState` directly, never via
  `Village.CrystalEconomy` (circular asmdef).
- Offline-first + server-sync is the north-star persistence model (a DB-per-player sync layer over
  local save; the backend code stays in the React repo, not Unity).

---

## 6. Build mode (the CREATE verb)

Player base-building, CoC/Fallout-4-grain. **~70% built for towers — do NOT greenfield.** Full
reconciliation + gap list + delivery plan: `docs/BUILD_MODE_ARCHITECTURE.md`.

- **Wired end-to-end for towers today:** enter (top-down cam + frozen waves) → tap a palette card →
  green/red ghost → place → charge → persists in `GameState.BaseLayout` (save v14) → reload rebuilds.
  Move + sell (50% refund) work.
- **Persistence = recipes, not objects:** `BaseLayout = List<PlacedStructureData>` (itemId + cell +
  yaw + level), grid-relative, replayed via `StructureFactory.Create` — the **same path** the
  designer builder and a future Arena server use (the headless-replay seam is designed in).
- **NavMesh = carving, NOT runtime bake** (the hardest-won lesson) — placed structures attach a
  `NavMeshObstacle`; a gate-clearance rule guarantees a spawn→Heart lane always exists.
- Gaps (the real work): fill the palette beyond towers, multi-resource cost via `ResourceLedger`,
  the upgrade verb + wall tiers, mobile touch behind `IBuildInput`, a bounded plot, Arena snapshot.

The wider ambition is a **generic typed-dispatch world engine** (`EngineDispatcher.Build(def)` over
`WorldDef`/`IBuildHandler`, with the rampart's visual⊥navigable `NavSurface` decouple as the
walkability spine) where designer authoring, player build-mode, and server raid-replay are **one code
path**. This is *extraction toward a dispatcher, not greenfield* — see
`docs/WORLD_ENGINE_ARCHITECTURE.md`, `docs/ENGINE_MASTER_PLAN.md`, `docs/CHARACTER_ARCHITECTURE.md`.

---

## 7. Instrumentation standard (observable-first)

Write code observable-first: **a failure must be a logged line, never a silent blank.** Full method:
`docs/INSTRUMENTATION_STANDARD.md`. Four helpers (all `DeNelle.Core`, no cross-module coupling):

- **`FlowTrace`** (`Core/Diagnostics/FlowTrace.cs`) — `Step/Warn/Fail/Throttle/Once/Measure`,
  `[Flow:<system>]` tags, runtime `Enabled` + per-category gating. Trace flow entry, every branch
  *taken*, every fallback, service resolution, and the render/commit seam.
- **`Guard`** (`Core/Diagnostics/Guard.cs`) — `Try` / `TryEach`, the always-on safety net.
  **Load-bearing rule:** one bad object must never blank a whole list/screen — list/screen
  population uses `Guard.TryEach`. `Guard` is never compile-stripped (it changes control flow).
- **`BreakCaptureHarness`** (`Core/Diagnostics/BreakCaptureHarness.cs`) — F8 flight recorder →
  `break-log.jsonl` + screenshots (disables itself on WebGL).
- **`DataRegression`** (`Editor/Regression/DataRegression.cs`) — the headless data/logic gate (§4).

Log-level mapping is fixed: `Step`→Log, `Warn`→LogWarning, `Fail`→LogError (only LogError is caught
by the recorder — never downgrade a true failure to `Warn`). New code is written to standard; existing
code is instrumented **on-touch, not big-bang** (law #4). `[Conditional("ENABLE_FLOWTRACE")]`
compile-strip is *pending* — not yet applied (§1.6 of the standard).

---

## 8. Deep-dive docs (this hub indexes; it does not replace them)

| Area | Deep-dive doc |
|---|---|
| The operating laws (binding) | `docs/ARCHITECTURE_PRINCIPLES.md` |
| The One Model full spec | `docs/WORLD_COLLECTION_MODEL_DIRECTIVE.md` |
| Foundation-first scope + build order | `docs/ENGINE_MASTER_PLAN.md` |
| Generic typed-dispatch world engine | `docs/WORLD_ENGINE_ARCHITECTURE.md` |
| Unified actor substrate (Character/Brain/Equipment) | `docs/CHARACTER_ARCHITECTURE.md` |
| Monster families (leader/follower packs) | `docs/MONSTER_FAMILY_ARCHITECTURE.md` |
| Zone streaming + persistence (north-star) | `docs/ZONE_STREAMING_ARCHITECTURE.md` |
| Build mode (CREATE verb) | `docs/BUILD_MODE_ARCHITECTURE.md` |
| Catalog (look ⊥ repo) + placement rules | `docs/CATALOG_SYSTEM.md` |
| "Does the foundation grow into the dream?" | `docs/ARCHITECTURE_NORTH_STAR.md` |
| Root canonical structure / folder plan | `CORE_ARCHITECTURE_PLAN.md` |
| Decisions log (every non-trivial call, dated) | `docs/unity-decisions.md` |
| Instrumentation method | `docs/INSTRUMENTATION_STANDARD.md` |
| **Exhaustive file-by-file catalog (verified from code)** | `docs/MASTER_CATALOG.md` + `docs/MASTER_CATALOG/<area>.md` |
| Assembly/module map + per-module READMEs | `Assets/_Modules/README.md` |
| Root file map / docs index | `PROJECT_INDEX.md` · `docs/README.md` |

---

*Maintenance: keep this hub current when a load-bearing decision changes; keep the detail in the
deep-dives. The MASTER_CATALOG is the source of truth verified from code — when in doubt, read it.*
