# Echoes of Elarion — CLOCK IN review snapshot

This is a small, disposable repository for the Radiants CLOCK IN AI coach. It is the payment, stake, wallet, and combat slice of the private game tree, with the real commit history of those files kept. It is not a buildable Unity player and it does not contain art, scenes, or the Android plugin binaries.

## History

`git rev-list --count HEAD` on the game repository is **5829** changesets, from `2026-05-18` (`d0863ac`, the initial spec) through `2026-10-06` (`5afe186a310cfc3f79f8919dc8b06c57a7478ef7`, WO-2232).

This snapshot keeps the **252** of those changesets that touched the files included here, dated 2026-05-18 through 2026-10-06. Authors, dates, and messages are the originals. The hashes differ because each tree contains only these paths. Packaging commits sit on top. See `HISTORY.md`.

```
git rev-list --count HEAD
git shortlog -sn HEAD
git log --oneline
```

The CLOCK IN deck is in this repository so it can be fetched without a Google account:

- Text: https://raw.githubusercontent.com/samanthadenelle-create/eoa-coach-review/main/deck/DECK.md
- PDF: https://github.com/samanthadenelle-create/eoa-coach-review/raw/main/deck/Encyclopedia-Elarion.pdf

## What to read

| Path | What it is |
|---|---|
| `HISTORY.md` | Changeset counts, monthly pace, what was kept |
| `docs/ARCHITECTURE.md` | Current architecture hub |
| `Assets/_Modules/README.md` | Assembly map. The asmdef files are the boundary law |
| `api/_lib/skr-staking.js` | Server-side SKR stake read. The client does not get to report the amount |
| `api/purchases/verify.js` | Server checks a purchase against the quote it already issued |
| `api/_lib/swap-quote-probe.js` | Jupiter ExactOut quote probe |
| `api/wallet/rpc.js` | Allow-listed Solana RPC proxy |
| `Assets/_Modules/Wallet/SolanaWalletProvider.cs` | Mobile Wallet Adapter session |
| `Assets/Editor/MobileWalletAdapterPlayExclusion.cs` | MWA stays out of the Google Play artifact |
| `Assets/_Modules/BattleATB/Engine/` | Pure combat rules, no Unity engine |
| `test/` | Node tests for stake, realm stake, Jupiter probe, RPC, WebGL Jupiter connect |
| `proof/` | Recorded test logs |

## What was run in this snapshot

`npm test` on these committed files: **117 pass, 0 fail**. Offline. No database and no mainnet.

Unity EditMode tests under `Assets/_Modules/BattleATB/Tests/` (69 `[Test]` methods) are here as source. They were not executed here. They need the Unity project.

## What this snapshot does not claim

- It does not claim a store listing is live. `DeNelle.Wallet.asmdef` compiles only when `GOOGLE_PLAY` is absent. The Play artifact and the Seeker/MWA artifact are different builds.
- It does not include an APK.
- The figure "145/852" is not a result in this tree. A separate log, `proof/stake-purchase-145.log`, records **145 pass, 0 fail** for the stake and purchase files it names, at commit `8b008f6142df03bbda705dd6acbdc7ec7d4626f4`. A wider API run the same hour, `proof/api-suite-8b008f6.log`, records **2062 pass, 1 fail** out of 2065. The failure is `Google Play storefront submits the request with its verified cached session`.
