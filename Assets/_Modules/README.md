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
| `Core/` | `DeNelle.Core`, `DeNelle.AI` (+Tests) | Interfaces, enums, save/state, services, behavior-tree AI. **Owns `Core/Jobs/`** — the shared "Obsidian" multi-channel work queue (WO-773, `ObsidianQueueEngine`/`ObsidianQueueState`; save v35) |
| `Cosmetics/` | `DeNelle.Cosmetics` | Battle pass, cosmetic catalog, Glimmer currency |
| `Data/` | Assembly-CSharp | `MasterAssetCatalog` only |
| `DevTools/` | `DeNelle.DevTools` | Dev panel, wallet probe |
| `DialogueUI/` | `DeNelle.DialogueUI` | Intro sequence + companion dialogue presentation |
| `Dungeons/` | `DeNelle.Dungeons` | 3D dungeon gameplay, crafting, lore, Bryn the wanderer |
| `Economy/` | Assembly-CSharp | Resource nodes (gem/ore/lumber/magic) + inventory |
| `Environment/` | Assembly-CSharp | Night torch lighting |
| `HUD/` | `DeNelle.HUD` | VillageHudController + HUD panels. **Core-only deps** |
| `Onboarding/` | `DeNelle.Onboarding` | Title → hero select → pet select → story intro flow |
| `Pets/` | `DeNelle.Pets` | Pet companion runtime: deploy, leash, progression, skills |
| `Settings/` | `DeNelle.Settings` | Settings/pause UI, audio mixer bridge |
| `UI/` | Assembly-CSharp | (empty — `GameOverUI` deleted 2026-07-03, dead-surface sweep) |
| `Village/` | `DeNelle.Village` | The big one (~275+ files): waves, enemies, hero, buildings, world. **Owns `Village/Troops/`** — the COC-style Teleport/Deploy raid V1 spine + barracks (WO-771/772: `RaidDeployController`, `TroopFactory`, `BarracksService`, `RaidScoring`, shared enemy classes/families) |
| `Wallet/` | `DeNelle.Wallet` (+Tests) | PackStore, crypto payments, wallet providers |
| `Web3/` | `DeNelle.Web3` | Jupiter swap integration |

## Cross-assembly rules (from CLAUDE.md — non-negotiable)

- Village → Core only. HUD → Core only. **Never Village ↔ HUD directly.**
- Cross-module calls go through `CoreServices.Hud` / `CoreServices.Audio` with `?.`
- Key interfaces live in Core: `IDamageableStructure`, `IVillageHud`, `IAudioService`

> Maintenance: when you add/remove/move files in a module, update that module's README.
