# Assets/_Modules — Code Module Map

**All first-party gameplay code.** The authoritative architecture reference is
`../../docs/ARCHITECTURE.md` (the HP B2B hub — assembly map, world/scene model, save,
build mode). The older root `CORE_ARCHITECTURE_PLAN.md` is a **historical pre-pivot plan**
(tower-defense + native Solana framing) — read it for intent only, not current state:
V1 ships as a single-Knight overworld + BattleArena + dungeons + raid, with base/tower-defense
V2-gated (`ff.basebuilding`) and zero crypto in the V1 path.

Each module folder has its own README with purpose + key files. **Read the module README before grepping the module.**

| Module | Assembly | One-liner |
|---|---|---|
| `ATB/` | — (empty) | Legacy placeholder, no code. ATB lives in `BattleATB/` |
| `Audio/` | `DeNelle.Audio` | AudioService, SFX library, music selection, WebGL unlock |
| `BattleATB/` | `DeNelle.BattleATB` (+Tests) | ATB combat: pure-C# engine + Unity controllers |
| `Characters/` | — (empty) | Reserved slot, no code/asmdef yet. Character code lives in `Village/` + `Editor/` |
| `Commerce/` | `DeNelle.Commerce` | **Rail-NEUTRAL** store/grant contracts + pure data (WO-1282): `PackCatalog`/`PackDef`/`PackContents`/`PackPricing`/`PackEconomy`/`ConvenienceItemDef`/`BoostSpec`/`StoreBand`, `ShortfallPackOffer`/`ShortfallOffer`, and the three seams that let non-Wallet assemblies reach the storefront without naming it (`StoreFocusRequest`, `StorefrontRegistry`, `ArenaOutcomeRelay`). ⛔ **It may NEVER reference `DeNelle.Wallet` or `DeNelle.Web3`** — that ban is the whole reason it exists: a Google Play artifact excludes the Solana rail whole, and `GooglePlayPackagingGate.AssertSourceIsolation()` checks it. Wallet references Commerce, one way. ⚠ Its types keep the **`DeNelle.Wallet` NAMESPACE** on purpose — `Core/Promo/PromoCodeService.cs` resolves `"DeNelle.Wallet.PackContents"` as a reflection STRING LITERAL, so the namespace is a live runtime contract; the ASSEMBLY is what moved. See `Commerce/README.md` |
| `Core/` | `DeNelle.Core`, `DeNelle.AI` (+Tests) | Interfaces, enums, save/state, services, behavior-tree AI. **Owns `Core/Jobs/`** — the shared "Obsidian" multi-channel work queue (WO-773, `ObsidianQueueEngine`/`ObsidianQueueState`, plus `JobKind`/`JobRushPolicy`/`IJobEffect`; landed at save v35 — **never quote the live schema here, read `Core/State/SaveSchema.cs:CurrentVersion`**; a copied number is how this row went stale at v36). Also owns **`Core/Catalog/`** — catalog registry + placement/timer config, and the dungeon payout data types `DungeonRunGrade` / `DungeonRunPayout` / `DungeonExclusiveItems` / `PolishBonusProvider` |
| `Cosmetics/` | `DeNelle.Cosmetics` | Battle pass, cosmetic catalog, Glimmer currency |
| `Data/` | Assembly-CSharp | `MasterAssetCatalog` only |
| `DevTools/` | `DeNelle.DevTools` | Dev panel, wallet probe |
| `DialogueUI/` | `DeNelle.DialogueUI` | Intro sequence + companion dialogue presentation |
| `Dungeons/` | `DeNelle.Dungeons` | 3D dungeon gameplay, crafting, lore, Bryn the wanderer. Sub-READMEs: `Dungeons/README.md` + `Dungeons/RoomForge/README.md` (the only nested README under `_Modules/`). The **`Composed*` layer** is the runtime host for generated dungeons — `ComposedDungeonHost`/`ComposedDungeonBootstrap`, prop presentation `ComposedPropVisuals`/`ComposedPropSpin`, and the interactables (`ComposedKeyLock`, `ComposedOilStone`, `ComposedTrapHazard`, `ComposedAmbushDirector`, …); `DungeonLanternBalance` holds the torch/oil light tuning |
| `Economy/` | Assembly-CSharp | Resource nodes (gem/ore/lumber/magic) + inventory |
| `Environment/` | Assembly-CSharp | Night torch lighting |
| `HUD/` | `DeNelle.HUD` | VillageHudController + HUD panels. **Core-only deps** |
| `Onboarding/` | `DeNelle.Onboarding` | Title → hero select → pet select → story intro flow |
| `Pets/` | `DeNelle.Pets` | Pet companion runtime: deploy, leash. ⚠ **"progression, skills" is RETIRED, not current** — `PetProgression` was DELETED 2026-08-16 (WO-993, with `AuraController` + `EchoSpiritPresentation`; `HeroProgression` is now the only `IXpEarner`), and `PetSkillTreeCatalog` was deleted 2026-07-08. `PetTaskController` is **RETIRED IN PLACE, NOT deleted** (WO-1031 → WO-1108 Lane B) — a task-state holder with no update loop and no installer, kept as a TYPE because `EchoEngageDialogueRegression` pins its shape; the repair loop moved to `EchoRepairService`. See `Pets/README.md` |
| `Settings/` | `DeNelle.Settings` | Settings/pause UI, audio mixer bridge |
| `UI/` | Assembly-CSharp | (empty — `GameOverUI` deleted 2026-07-03, dead-surface sweep) |
| `Village/` | `DeNelle.Village` | The big one (~275+ files): waves, enemies, hero, buildings, world. **Owns `Village/Troops/`** — the COC-style Teleport/Deploy raid V1 spine + barracks (WO-771/772: `RaidDeployController`, `TroopFactory`, `BarracksService`, `RaidScoring`, shared enemy classes/families). Also owns **`Village/Crafting/`** — the crafting/jeweler surface incl. `JewelPolishService` + `JewelPolishConfirmPanel`, and **`Village/Buildings/Progression/`** — the placed-structure upgrade spine (`UpgradeFamilyResolver`, `PlacedStructureUpgradeService`, `PlacedUpgradeKey`, `StructurePreviewSource`, `DualFamilyLevelResetMigration`) plus the resource-collector stack (`CollectorStackPropCatalog`/`CollectorStackView`, data at `Assets/Resources/Collectors/`) |
| `Wallet/` | `DeNelle.Wallet` (+Tests) | PackStore, crypto payments, wallet providers |
| `Web3/` | `DeNelle.Web3` | Jupiter swap integration |

## Cross-assembly rules (from CLAUDE.md — non-negotiable)

- ⛔ **`DeNelle.HUD` NEVER references `DeNelle.Village`, in either direction.** `HUD/DeNelle.HUD.asmdef`
  references `DeNelle.Core` + `DeNelle.Data` ONLY; `HUD/AdminOverlay.cs` reaches a Village type by
  reflection *because* the asmdef forbids the reference — that is evidence of the rule, not a breach.
- ⚠ The old line here — *"Village → Core only. HUD → Core only"* — **was FALSE and is RETIRED**
  (CLAUDE.md §5). `DeNelle.Village.asmdef` legitimately references `DeNelle.BattleATB`, `DeNelle.AI`,
  `DeNelle.Cosmetics`, `DeNelle.Data`, `DeNelle.Pets`, `DeNelle.Commerce` and `DeNelle.Audio` besides
  `DeNelle.Core`. **Read the `.asmdef` — it is the authority on what may reference what.** The table
  above is a convenience map, never the dependency graph.
- ⛔ **`DeNelle.Village` NEVER references `DeNelle.Wallet`** (WO-1282, 2026-08-30). It went through
  `DeNelle.Commerce` instead, and that removal is what lets a Google Play artifact exclude the Solana
  rail. `GooglePlayPackagingGate.InspectSourceIsolation()` FAILS the AAB build the moment the
  reference comes back. If Village needs something from Wallet, the answer is a Commerce seam, never
  the reference. (⚠ The line above still names Wallet for a different reason: `DeNelle.Village.asmdef`
  did reference it, legitimately, until this change.)
- ⛔ **`DeNelle.Commerce` NEVER references `DeNelle.Wallet` or `DeNelle.Web3`, in either direction of
  reasoning.** Wallet -> Commerce only. A `CurrencyKind` (`Sol`/`Usdc`/`Skr`) in a Commerce file is
  the tell that the boundary has been crossed.
- Cross-module calls go through `CoreServices.Hud` / `CoreServices.Audio` with `?.`
- Key interfaces live in Core: `IDamageableStructure`, `IVillageHud`, `IAudioService`

> Maintenance: when you add/remove/move files in a module, update that module's README.
