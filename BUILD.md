# How to check this snapshot

Node 18 or newer.

```
npm install
npm test
```

`npm test` runs five files:

- `test/skr-staking.test.js` — PDA derivation, UserStake decode, the seven stake states, outage behavior
- `test/realm-stake.test.js` — realm stake sums from stored snapshots, not from the client
- `test/swap-probe.test.js` — Jupiter ExactOut probe, including a dead host and a zero quote
- `test/wallet.rpc.test.js` — the RPC allow-list and refusal of methods off that list
- `test/webgl-wallet-connect.test.js` — Jupiter connect state machine, without the WalletConnect bundle

No `DATABASE_URL`, RPC URL, or API key is required. Those are read from the environment by the server when it is deployed. They are not in this tree.

`package.json` installs `@neondatabase/serverless`, `bs58`, and `tweetnacl` only. `@solana/web3.js` and `@sqds/multisig` are imported lazily by `api/_lib/clan-vaults.js` and by the browser wallet bundle. They are not installed here. Installing them pulled `bigint-buffer` 1.1.5, `stream-json` 1.9.1, and `uuid` 8.3.2 into the lockfile, and none of the tests in this snapshot call that loader. `npm audit` on this lockfile reports no vulnerabilities.

The Unity gate that covers the whole game is `DeNelle.Editor.DataRegression.RunAll` inside the full Unity project. It is not in this snapshot, and this snapshot cannot run it. A handover dated 2026-10-02 records `REGRESSION_OK 776/776` against commit `b07a87d9bd2de397996c8162a0b001c8d77ed0ed`. That log file is not in this snapshot, so that marker is a citation, not a result reproduced here.
