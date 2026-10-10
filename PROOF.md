# Proof that is actually in this tree

## Re-run here

On the committed files in this snapshot, `npm test` reported:

```
tests 117
pass 117
fail 0
```

Node v26.10.0. No network. The stake tests assert that an RPC outage does not report stake as zero, that `verifyStake` accepts a wallet and no amount, and that the SQL check constraint lists the same seven states as the code (`api/migrations/20260910_0024_skr_stake_snapshots.sql`).

## Recorded logs from commit 8b008f6

Commit `8b008f6142df03bbda705dd6acbdc7ec7d4626f4` (2026-10-05, `chore(gitignore): ignore secrets/`) is in the game repository. Two logs from a scratch archive of that commit are copied here:

- `proof/stake-purchase-145.log` — 145 tests, 145 pass, 0 fail. The command in the log is `test/skr-staking.test.js`, `test/clan-stake-gate.test.js`, `test/clan-vigil.test.js`, `test/purchases.verify.test.js`, `test/purchases.verify.swap-delta.test.js`.
- `proof/api-suite-8b008f6.log` — 2065 tests, 2062 pass, 1 fail. The failing test is `Google Play storefront submits the request with its verified cached session`.

Those two logs were not produced by the 117-test run above. The wider API suite is not fully green in that log.

## Boundaries the code enforces

- `api/_lib/skr-staking.js` takes a wallet address and reads mainnet itself. `Assets/_Modules/Wallet/NativeSkrStakeQuery.cs` says the device-computed amount must not grant anything.
- `api/purchases/verify.js` checks the chain against the server quote. It does not recompute the price from client input.
- `DeNelle.Wallet.asmdef` has `defineConstraints: ["!GOOGLE_PLAY"]`. `Assets/Editor/MobileWalletAdapterPlayExclusion.cs` keeps the Mobile Wallet Adapter Android library out of a Play build.
- `Assets/_Modules/Commerce/DeNelle.Commerce.asmdef` references only `DeNelle.Core`.
- `Assets/_Modules/BattleATB/Engine/` is the combat rules. `Assets/_Modules/BattleATB/Tests/` holds 69 `[Test]` methods against that engine. They were not run in this snapshot.
