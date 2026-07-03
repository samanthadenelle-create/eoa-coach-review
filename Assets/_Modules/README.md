# Assets/_Modules — Code Module Map

**All first-party gameplay code.** This is the heart of the professional modular architecture (see `../../CORE_ARCHITECTURE_PLAN.md` for full plan, assembly rules, and how features — tower defense, dungeons, native Solana wallets, mobile, cosmetics/seasonal pass — are mapped).

Each module folder has its own README with purpose + key files. **Read the module README before grepping the module.**

| Module | Assembly | One-liner |
|---|---|---|
| `ATB/` | — (empty) | Legacy placeholder, no code. ATB lives in `BattleATB/` |
| `Audio/` | `DeNelle.Audio` | AudioService, SFX library, music selection, WebGL unlock |
| `BattleATB/` | `DeNelle.BattleATB` (+Tests) | ATB combat: pure-C# engine + Unity controllers |
| `Core/` | `DeNelle.Core`, `DeNelle.AI` (+Tests) | Interfaces, enums, save/state, services, behavior-tree AI |
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
| `Village/` | `DeNelle.Village` | The big one (~275 files): waves, enemies, hero, buildings, world |
| `Wallet/` | `DeNelle.Wallet` (+Tests) | PackStore, crypto payments, wallet providers |
| `Web3/` | `DeNelle.Web3` | Jupiter swap integration |

## Cross-assembly rules (from CLAUDE.md — non-negotiable)

- Village → Core only. HUD → Core only. **Never Village ↔ HUD directly.**
- Cross-module calls go through `CoreServices.Hud` / `CoreServices.Audio` with `?.`
- Key interfaces live in Core: `IDamageableStructure`, `IVillageHud`, `IAudioService`

> Maintenance: when you add/remove/move files in a module, update that module's README.
