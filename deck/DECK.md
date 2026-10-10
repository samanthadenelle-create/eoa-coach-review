# Encyclopedia Elarion

Text of the 18-page CLOCK IN deck. The PDF in this folder is the same file that was on Google Drive (`deck_ency.html`, printed 2026-10-05). This markdown is the extractable text, so a reviewer does not need a Google account.

Repository: https://github.com/samanthadenelle-create/eoa-coach-review

## Page 1

CLOCK IN BY RADIANTS · SOLANA MOBILE HACKATHON · JUDGE ENCYCLOPEDIA
Encyclopedia Elarion
Defenders of the Realm: Echoes of Elarion
A depth brief for coaches: product, architecture, SKR, Orders, commerce, honesty — with sources.
Live on the Solana dApp Store · started May 2026 · no revenue
Companion to Technical Appendix (branch dev · c19c2a7c1 · read Oct 4. Pitch video: youtu.be/RUahALTRU7g
Encyclopedia Elarion · Oct 5, 2026 01 / 18

## Page 2

HOW TO READ THIS ENCYCLOPEDIA
Depth for coaches — not a 60-second pitch
0104 Product · loops · town progression 0506 Architecture · CDN · Command Center
0710 MWA / SKR · Heartbound · Orders / Vigil · Commerce 1112 Heart arc (chat-join) · Arena honesty
1314 Feature status table · Quantified build facts 1517 Traction (safe) · Limitations · The ask
Honesty locks for this deck: no “12M SKR,ˮ no “201 stakers,ˮ no stake-threshold “realm livingˮ tree wake. Heart wake = first chat join. Season
prizes = Planned. Numbers cite Technical Appendix / METRICS Oct 4 or are omitted.
Encyclopedia Elarion · Clock In 02 / 18

## Page 3

1 · PRODUCT OVERVIEW
A real strategy game for Solana Seeker
Orders / Vigil / SKR surfaces on Seeker and web — not on the Google Play build.
Signed-in title (address blurred)
Source: live Seeker build screenshots · pitch assets Oct 4
Problem: few skill-based games on Solana mobile; token rewards often favor luck or
capital
◆
Product: Echoes of Elarion — Home / Adventure / Arena loops on Seeker + web◆
SKR role: identity, Heartbound tiers, Order gates, Vigil cosmetics, Jupiter checkout —
never custody
◆
Shipped: Solana dApp Store (releases Sep 7 & Sep 24; live v2026.10.01◆
Business: pre-revenue; payment rail live and server-verified◆
Encyclopedia Elarion · Clock In 03 / 18

## Page 4

2 · THREE LOOPS
Home →  Adventure →  Arena →  home again
1 · Home
Protect your home
1. Build & upgrade
2. Defend waves
3. Earn resources
4. Improve defenses
2 · Adventure
Discover the next challenge
1. Prepare gear
2. Explore / journey
3. Earn XP
4. Unlock content
3 · Arena
Lead the attack
1. Scout rival base
2. Deploy hero + troops
3. Fight the snapshot
4. Review & retaliate
↺ Arena sends you home to prepare again. Each loop feeds the next.
Product framing locked for Clock In pitch · Oct 4
Encyclopedia Elarion · Clock In 04 / 18

## Page 5

2B · PROGRESSION PLATE · REAL PIXELS
Four towns: early →  mid →  late →  radiant Vigil
Early · wood / dying Heart
Mid · build & place
 Late · fortified walls
Radiant · Vigil canopy
Heart arc Play lock): dying → alive on first chat join Life essence) → radiant after Vigil dressing. Not a stake-threshold “realm livingˮ event.
Frames: Seeker device captures + live build plates (compressed). Labels describe visual stage, not analytics.
Encyclopedia Elarion · Clock In 05 / 18

## Page 6

3 · ARCHITECTURE
Five tiers — client never trusted on stake/price/rewards
Unity client
Unity 6000.4.8f1 · 49 asmdefs
Strict MVVM (e.g. StructureCardVM
Android APK · WebGL · Windows
⇄
Vercel API
api/ · 93 routes · 71 libs
Wallet-signed requests
8 scheduled crons
⇄
Postgres (Neon)
api/schema.sql
46 migrations
stakes, Orders, saves, arena
Cloudflare R2 CDN
Addressables bundles
Android 234 · WebGL 249 · Win 305
⇐
Command Center
tools/command-centre.ps1
live tunables · kill switches
gate / preview / promote / prove
⇄
Solana mainnet
MWA · native SKR stake
Genesis Token · Jupiter · Squads
Source: Technical Appendix p.03 · branch dev c19c2a7c1 · counted from repo Oct 4
Encyclopedia Elarion · Clock In 06 / 18

## Page 7

3B · LIVE OPS WITHOUT SHIPPING A BUILD
CDN swap · tunables · server is truth
①  CDN content swap
Addressables → r2-ship.ps1 push → verify
ALL targets. Android: 373 catalog
generations on disk.
②  Live tunables
Command Center → client_tunables →
clients poll 30s. 109 allow-listed knobs ·
150s turnaround.
③  Server is truth
SKU catalog, stake tiers, Order banners
computed server-side. Fail-soft tunables
(build defaults on error).
Target Bundles Catalogs Newest catalog
Android 234 373 2026.10.04.397868
WebGL 249 46 2026.10.04.397868
Windows 305 57 2026.10.02.395461
Technical Appendix · Content pipeline + zero-downtime pages · R2_PARITY_OK Oct 4 0243 CT
Encyclopedia Elarion · Clock In 07 / 18

## Page 8

4 · MWA / SKR DEEP DIVE
Connect →  read-only stake →  snapshot →  unlock →  pay
Step Mechanism
1 Connect Mobile Wallet Adapter; ed25519 over 5-min wallet-bound nonce (burned)
2 Read Server getAccountInfo on native stake — client never trusted to report stake
PRODUCT RULE 7
3
Snapshot
skr_stake_snapshots · 7 statuses · verified_at grace
4 Tier Resonance score → 11-tier Heartbound ladder (server-told)
5 Unlock Cosmetics + Order create/join/vote gated on verified stake
6 Pay Jupiter ExactOut; verify at commitment finalized
Never custody
Player SKR stays staked in the playerʼs wallet. Server reads
chain; client renders.
Cache / refresh
300 s stake cache · 60 s manual cooldown. Cooldown from
StakeConfig, not hardcoded.
Anti-whale
Log curve: 500k SKR  500× of 1k. 21 curve tests + 28
telemetry tests.
Technical Appendix · SKR and wallet + anti-whale pages · api/_lib/skr-staking.js · heartbound-resonance.test.js
Encyclopedia Elarion · Clock In 08 / 18

## Page 9

4B · HEARTBOUND RESONANCE · 11 TIERS
StakePower + TenurePower →  server tier
StakePower = 1000 × log101  Stake/250
TenurePower = MIN700, 150 × ln(1  Pulses/5
minHeartboundStake = 100 · increases ramp over pulses; decreases immediate
Client is told its tier. Flash-staking does not stick.
heartbound-resonance-config.json · test/heartbound-resonance.test.js 21 tests)
Tier Name Minscore Tier Name Minscore
0 Silent 0 6 Hearttouched 1800
1 Emberbound 300 7 Deep
Resonance
2150
2 Rootbound 600 8 Heartforged 2500
3 Stonebound 900 9 Eternal Echo 2850
4 Echoing 1200 10 Heartbound 3200
5 Awakened 1500
Encyclopedia Elarion · Clock In 09 / 18

## Page 10

5 · ORDERS · HEARTBOUND · VIGIL
Stake-gated clans; tenure-weighted Vigil
Order = clan. One per wallet. Create / join / vote require verified
SKR stake (clan-stake-gate.js). Failed/degraded stake read → 403
STAKE_READ_FAILED first.
Vigil = Σ (percent_staked × tenure_seconds). Tenure from
Postgres. 5 Vigil tiers: Ember → Dawn 0 / 1d / 7d / 30d / 90d).
48h banners Lantern / Tide / Gale) — cosmetic only, Vigil-
weighted plurality. Turnout bands scale with Order size.
Genesis Token = badge for Order join, not the stake gate. Squads
vault signers must each hold a Seeker Genesis Token. Today:
PARTIAL 0 vaults registered.
PARTIAL Orders / Vigil usage at owner-test scale — do not pitch
as live clan meta.
Heart with Vigil dressing (radiant stage)
Technical Appendix · Orders and the Vigil · api/_lib/clan-stake-gate.js · clan-vigil.js · schema clan_*
Encyclopedia Elarion · Clock In 10 / 18

## Page 11

6 · COMMERCE · PAY IN SKR
Jupiter ExactOut — priced and verified on server
Stage Where
Server prices the SKU POST /api/purchases/quote — server decides the number
Short on SKR? JupiterSwapService.cs ExactOut quote; wallet opens only if quote returns
Settlement /api/purchases/verify reads transfer at commitment finalized
Health Cron */15 synthetic ExactOut; HTTP 200 with error payload = DOWN
852/852
swap-health checks passed, last 30 days
live DB read Backend), Oct 4
Honesty
Payment rail is live. Studio is pre-revenue for this pitch — do not lead with
purchase counts or ad dollars. Failures alert via jupiter-fail-alert.js.
Technical Appendix · Pay in SKR page
Encyclopedia Elarion · Clock In 11 / 18

## Page 12

7 · HEART OF ELARION · PLAY ARC LOCK
Dying →  alive on first chat join →  radiant after Vigil
1
Dying
Pre-chat Heart still dying
2
Alive
First chat join · Life essence line
3
Radiant
Vigil tier + banner dressing
REMOVED claim
Do not say canopy wakes because total verified stake crosses a threshold (“the realm is livingˮ).
That stake-threshold path is not the Play Heart arc for this submission.
UI Cherry welcome or one-time modal (not a toast) paired with canopy wake. Persists across sessions
after first join.
Dying / early Heart
Radiant after Vigil
Owner/Link lock Oct 5 · supersedes older pitch VO at 318 and appendix realm-config stake-threshold copy for Play messaging
Encyclopedia Elarion · Clock In 12 / 18

## Page 13

7B · ARENA · HERO-LED VS SNAPSHOT
Real base layout — matchmaking still Partial
PARTIAL Matchmaking / real rival lookup — today a seeded demo rival. Live player matchmaking
is Planned rollout.
PLANNED Season prize pool from staked $10K SKR Integration prize yield only 40 / 25 / 15 / 20%
shared 410. No payouts made.
Arena prep
Hero-led fight
Lead Dev lock Oct 4 · commit c19c2a7c1 · Technical Appendix Arena page · ArenaTwoBaseSession.cs
ArenaTwoBase hero-led assault into a defender snapshot (layout, troops, hero, gear)◆
Defender hero fights as boss; WritesLiveSave = false — your town save is never touched◆
Clash-of-Clans hook: hit a real base, rebuild, retaliate◆
Encyclopedia Elarion · Clock In 13 / 18

## Page 14

8 · FEATURE STATUS
Implemented · Partial · Planned
Feature Status One-line proof
MWA sign-in IMPLEMENTED Wallet-signed sessions; ed25519 nonce
On-chain SKR stake read IMPLEMENTED Server read-only; PRODUCT RULE 7
Stake snapshot → tier IMPLEMENTED skr_stake_snapshots · 11 Heartbound tiers
Anti-whale scoring curve IMPLEMENTED 21 curve + 28 telemetry tests
Jupiter ExactOut checkout IMPLEMENTED Quote → swap → finalize verify; 852/852 health
Orders stake-gated IMPLEMENTED create/join/vote; STAKE_REQUIRED / STAKE_READ_FAILED
Vigil weight + 48h banners IMPLEMENTED stake%×tenure; Lantern/Tide/Gale cosmetic
Heart · chat-join wake IMPLEMENTED Dying → alive on first chat join Life essence)
Heart Vigil dressing IMPLEMENTED Radiant tier + banner on Heart tree
ArenaTwoBase hero-led IMPLEMENTED vs snapshot; WritesLiveSave false
dApp Store live IMPLEMENTED Releases Sep 7 & Sep 24
10 languages IMPLEMENTED 58,120 keys; 15 locale regressions
Regression suite IMPLEMENTED 1,155 Unity decls · 2,014 API cases (counted)
Arena matchmaking PARTIAL Seeded demo rival today
Orders / Vigil usage PARTIAL Owner-test scale
Shared Order vaults PARTIAL Genesis Token gate on vault signers; 0 vaults
Season prize from yield PLANNED $10K SKR prize staked → yield 40/25/15/20
Google Play / iOS / Pi PLANNED “Coming toˮ — not live
Matchmaking rollout PLANNED Real rival lookup next
Lead Dev lock Oct 4 (c19c2a7c1 + Technical Appendix counts + Owner Heart arc lock Oct 5
Encyclopedia Elarion · Clock In 14 / 18

## Page 15

8B · QUANTIFIED BUILD FACTS · VERIFIED ONLY
Counted from repo / appendix / Backend logs
5,967
commits all branches · first May 18, 2026
1,155
Unity Test/UnityTest] declarations
2,014
API test cases · 120 suites
93 / 71 / 46
API routes · libs · migrations
110
canonical JSON catalogs
10
locales · 58,120 string entries
11
Heartbound tiers 010
300s / 60s
stake cache / manual cooldown
852/852
Jupiter health · 30 days Backend Oct 4
Technical Appendix regression + repo stats + SKR wallet pages. Omitted this pass if unverified: product SKU count “27,ˮ 12M SKR, 201 stakers.
Encyclopedia Elarion · Clock In 15 / 18

## Page 16

9 · TRACTION · SAFE FIGURES ONLY · AS OF OCT 4, 2026
Wallets, play, installs — no SKR totals
538
Solana wallets connected
178
peak daily players, dApp launch week
2,292
waves defended · high wave 49
1,700+
installs in two weeks on dApp Store
95
dApp Store reviews · avg 3.9/5
1,674
commits in hackathon window Sep 8Oct 4
Deliberately omitted: 12M SKR held / 201 verified stakers Link form lock — not cited on coach materials without fresh Backend verify). No
“visitors.ˮ No revenue.
METRICS.md / Backend Oct 4 · publisher portal for installs/reviews · commit window from METRICS hackathon facts
Encyclopedia Elarion · Clock In 16 / 18

## Page 17

9B · HONESTY / LIMITATIONS
What is shipped vs what is still soft
Topic Status Coach-facing wording
Arena rivals PARTIAL Seeded demo rival today; matchmaking Planned
Orders / Vigil social PARTIAL Owner-test scale — not a live clan economy yet
Shared Order vaults PARTIAL Genesis Token required for vault signers; 0 vaults
Season prizes PLANNED Yield-only from Integration prize stake; 40/25/15/20%
Google Play / iOS / Pi PLANNED “Coming toˮ — Seeker dApp Store is live
Heart wake LOCK Chat-join Life essence — not stake-threshold realm living
SKR totals on forms OMIT Do not claim 12M / 201 without fresh Backend verify
Revenue NONE Pre-revenue; rail live
Aligned with Owner/Link Oct 5 honesty locks + Lead Dev Partial notes
Encyclopedia Elarion · Clock In 17 / 18

## Page 18

10 · THE ASK
Play it. Stress it. Help it last.
GitHub: [repo link to be added] Pitch video (unlisted): youtu.be/RUahALTRU7g
Started May 2026 · no revenue · Clock In by Radiants
Play Echoes of Elarion on the Solana dApp Store◆
$10K SKR Integration prize → staked principal; yield only funds seasons Planned)◆
Four Seekers. Four dedicated testers. Zero excuses.◆
Encyclopedia + Technical Appendix are the depth pack for coaches◆
Clock In by Radiants · Encyclopedia Elarion 18 / 18
