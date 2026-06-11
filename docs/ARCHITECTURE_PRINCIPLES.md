# Architecture Principles — Project Law

**Status:** BINDING. Every agent (UI and CLI) and every contributor obeys these.
**Established:** 2026-06-10 (owner directive).
**Decision lens:** **what is right, not what is easy.** When the two diverge, name
the divergence explicitly and choose right with eyes open.

These are not style preferences. They are the operating model the codebase is held
to. A change that violates a principle is wrong even if it compiles and ships.

---

## 0. The HP B2B architecture lens (the meta-principle)

The owner runs **HP business-to-business (B2B) operations professionally, at global
scale**, and manages this project with the **same architecture** she manages there:
a PM directing dev leads + architects, who give technical guidance; she makes the
calls against this lens. Agents are the dev leads/architects in that model — give
the **real architectural read** (the why, the tradeoff, the failure mode), name
**easy-vs-right** when they diverge, and let the owner decide. Never quietly pick
easy and present it as the answer.

Why this lens works: B2B commerce at HP scale only survives thousands of SKUs across
many regions and channels **because** concerns are siloed and scope is bounded — the
catalog/SKU domain exposes state; the storefront/PDP renders it; pricing, entitlements,
i18n, checkout, fulfillment are each their own service composed through contracts.
Tangle presentation into the catalog, or pricing into fulfillment, and it collapses at
scale. The game is built the same way.

---

## 1. Bounded context per component — purposely-limited scope

**Every component is isolated into its own area with a deliberately limited scope.**
It does ONE thing, knows ONLY what it needs, and never reaches outside its lane.

- An object **exposes its own state**; it does not own its display, its input, its
  persistence, or its neighbors' concerns.
- Each cross-cutting concern — **presentation, input, economy, persistence, i18n** —
  is its **own composed layer** that communicates through thin contracts/seams.
- When in doubt: **silo by concern, and bound the scope on purpose.** Scope-limiting
  is a design constraint, not an accident of how the code grew.

This is already enforced structurally by the asmdef boundaries (CLAUDE.md §5:
`Village → Core only`, `HUD → Core only`, never `Village ↔ HUD`) and the
service seams (`CoreServices`, `PanelRouter`). Those are instances of this law.

---

## 2. Presentation is a separate layer that NEVER touches the objects

A direct corollary of §1, called out because it is the most frequently violated.

**Nothing about how a thing *looks* lives on the thing itself.** Objects expose
state; the presentation layer observes and renders. A gameplay object must not know
what a prompt/bar/badge looks like, where it sits, its colors, its fonts, or that an
input hint (e.g. an "F" key) exists.

- Right: `BuildingInteractable` exposes "I am interactable, I am in range, here is my
  action id." A presentation layer decides everything visual.
- Wrong: `BuildingInteractable` spawning its own world-space bubble with hard-coded
  colors and a "Tap / F" string. (This is the smell that flagged **WO-391**.)

The same applies to HUD, health bars, VFX hookups, prompts — display is observed,
never embedded.

---

## 2b. The One Model — a recursive collection of collections rules them all

The world is **collections of collections**, one recursive shape from the realm down to
the smallest prop. Every level is a catalog of **entries**; every entry composes
**capabilities** it retains or does not retain. (Owner, 2026-06-10: *"it's amazing how
that collection of collections rules them all."*)

```
Realm  ⊃  City-State / Castle  ⊃  Building (entry)
                                    capabilities (composable, opt-in/out):
                                      Interactable · Upgradable · Destructible · Targetable · …
```

- **Capability is a property on the entry, never bespoke per-type code.** A wall =
  Destructible+Targetable; a vendor = Interactable; the Heart = Destructible+Targetable.
  Behavior is the SUM of the capabilities held, composed — not inherited from a class.
- **Every system is a READER of the collection.** HUD, interaction, combat targeting,
  damage, upgrade, persistence, and the bigger-world raid pillar all ask *"does this
  entry retain capability X?"* They never hard-code per type/tag/interface.
- **Add by entry, not by code.** A new realm / castle / building / capability = a new
  entry or a new property + the ONE system that reads it (§1). This is the HP B2B
  catalog at world scale (Region → Catalog → Category → SKU, capabilities on the leaf).
- This is the project's **organizing law**: when modeling any world content, express it
  as an entry-in-a-collection with composable capabilities, and reconcile onto the
  existing seams (`IDamageableStructure`, target tags, `BuildingInteractable`, upgrade
  panels, `VillageSceneBuilder.Buildings[]`, the recipe/StructureFactory catalog) —
  additively, never greenfield. Full spec: `docs/WORLD_COLLECTION_MODEL_DIRECTIVE.md`.

### 2b.1 The danger — the One Model causes PAIN if not in-check and POOLED

A recursive collection is powerful **and** dangerous. Owner, 2026-06-10: *"it can also
cause pain, like with the VFX, if originally not in check and pooled."* This is the
scar from the **two combat-feel/VFX stacks** (VfxPool / VFXManager) — VFX left
ungoverned **doubled up and sprawled**. The same failure scales with collections-of-
collections: a realm ⊃ city-states ⊃ buildings, each composing capabilities that may
spawn objects/VFX/colliders, becomes a memory + perf disaster if entries are
instantiated freely.

**Non-negotiable guardrails for the One Model:**
- **POOL by default.** Entries and their spawned visuals/effects come from object pools,
  never `new`/`Instantiate` per use. Build pooling into the model from day one — NOT
  bolted on after sprawl (that's how the VFX pain happened).
- **Keep it IN CHECK — bounded + lazy.** Stream/activate only the in-scope slice (the
  active city-state's buildings), not the whole realm. Caps on live entries; deactivate
  + return out-of-range entries to the pool (the HUD context + town-ring gating is the
  precedent).
- **ONE owner per concern (no double-stacks).** Exactly one pool/manager per capability's
  effects. The VFX lesson: never let two systems both spawn the same thing. Composability
  must not become duplication.
- **Capability ≠ free instantiation.** A capability flag is data; whether it *spawns*
  anything routes through the pooled, single-owner system that reads it.

Apply these guardrails BEFORE scaling the model past the buildings leaf. The model is
correct; ungoverned growth of it is the risk.

### 2b.2 Standard: POOL by default — use it MORE (owner directive 2026-06-10)

*"We should utilize pooling more."* This is a standing engineering standard, not just a
note on the world model. Anything spawned repeatedly — VFX, projectiles, enemies,
floating text, prompts, markers, collection entries — **comes from a pool**, not
`Instantiate()`/`new` per use.

**Current state (reconcile onto this — don't reinvent):**
- Exists: `Village/Vfx/VfxPool.cs`, `Village/Buildings/ProjectilePool.cs` +
  `PooledProjectile.cs`. These are the proven patterns.
- Gap: pooling is **Village-local + per-type**; there is NO shared/generic pool, and
  `Instantiate(` is scattered across ~30 call sites (waves, enemies, NPCs, pets,
  dialogue, cinematics, …) — each a sprawl risk and the exact shape of the VFX double-up.

**The standard:**
- **Default to pooling** for anything spawned more than once. New spawn code uses a pool.
- **ONE pool per concern, one owner** (the VFX-stack lesson — never two systems pooling
  the same thing).
- **Prefer consolidating** the per-type pools toward a small shared generic pool
  (candidate: `UnityEngine.Pool.ObjectPool<T>`, WebGL-safe) so the pattern is uniform —
  but reconcile additively with `VfxPool`/`ProjectilePool`, don't greenfield.
- **Audit `Instantiate(` call sites** as a holistic/leverage task (§3): pool the hot
  ones (waves/enemies/VFX/projectiles/floating-UI first). Spec as its own WO; do not
  rip out working spawns blind.

---

## 2c. Unit tests are the PERMISSION GATE for holistic change

Owner, 2026-06-10: *"that's why we have unit testing — unit testing ensures we met
those permission gates."* The architecture laws above (the One Model, pooling,
presentation separation) are only **safe to pursue** because tests enforce them. A
bold refactor of a working subsystem doesn't get **permission to be called done** until
the tests prove behavior was preserved. The gate catches regression — not faith.

- **Tests gate the holistic work (§3).** Before re-architecting (interaction service,
  buildings collection, pool consolidation, HUD kit refactor), there must be tests that
  lock the current behavior; the refactor passes ONLY if they stay green. No "it's fixed"
  without the gate (memory: don't-patch-and-claim-fixed).
- **Capability + collection model → testable by data.** Because the One Model is
  data-driven (entries + capability flags), it is **unit-testable without the scene**:
  assert which entries retain `Targetable`/`Destructible`/`Upgradable`/`Interactable`,
  assert collection integrity, assert capability composition. This is WHY the model is
  safe to scale — it's verifiable in EditMode.
- **Build on the existing harness (reconcile, not new):** EditMode + PlayMode asmdefs
  exist (`Assets/Tests/EditMode`, `/PlayMode`, `_Modules/*/Tests`, `Data/Tests`).
  ~29 test files. **`Data/Tests/BuildingCatalogTest.cs` already exists** — the buildings
  collection is *already* catalog-driven + tested; extend that seam for the
  capabilities, don't greenfield. `EconomyServiceTests`, save round-trip, ATB combat,
  catalog integrity are the proven patterns to mirror.
- **New holistic WO ⇒ ships with tests.** A structural WO is not "ready" without the
  permission-gate tests that prove the migration is behavior-preserving.

---

## 3. Player-felt vs. holistic work — queue by leverage, not effort

- **Player-felt** work changes what the player experiences → earns a place in the
  active queue.
- **Holistic / structural** work (refactors, consolidations, layer extractions)
  often has **no direct player benefit** but large **holistic benefit** (future
  features become easy + safe; a class of bugs disappears). It is **leverage, not a
  feature.**

Holistic work is **logged and done deliberately** when it is the highest-leverage
move — **never smuggled into a player-facing change**. Re-architecting a working
subsystem under cover of a UX pass is itself a violation (it risks a working system
for no felt gain and skips the structural change's own playtest).

**Pattern:** when a clean fix has two tiers, do the **right-sized right thing now**
(e.g. swap a presentation layer) and **log the structural tier** as its own WO
(e.g. extract the shared service). Prove the deferred tier honors the lens — that
deferring it is *right*, not a dressed-up shortcut.

---

## Instances / first payments toward these principles

- **WO-391** — Consolidate proximity-interaction behind ONE isolated interaction
  service the HUD reads from (objects register their interactable + expose
  in-range/action; presentation reads, never drives). First concrete payment toward
  §1 + §2. Tech-debt; no direct player benefit, high holistic benefit (§3).
- **WO-403** — Unified Context HUD: code-built presentation layer reading `IVillageHud`
  state via `CoreServices.Hud`; the HUD renders, the Village objects feed state
  through bridges. Presentation isolated from gameplay (§2).

---

*Cross-refs:* `CLAUDE.md` (§5 assembly boundaries, §11 orchestration),
`ARCHITECTURE_REFERENCE.md` (script inventory + seams), Notion "Work Orders" DB.
