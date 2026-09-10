// =============================================================================
// test/skr-staking.test.js — WO-1674 / HEART-001.
//
// Run: node --test test/skr-staking.test.js   (package.json "test" runs test/*)
//
// EVERY CASE HERE IS OFFLINE AND DETERMINISTIC. The live-chain proofs (a real
// staker verifying to a real amount, a fresh wallet verifying to NO_STAKE, a
// dead RPC verifying to RPC_UNAVAILABLE with NULL amounts, and five real
// UserStake accounts re-deriving from the `user` pubkey stored inside them) are
// captured in WORK_ORDER_1674_*.RESULT.md, because a test that needs mainnet is
// a test that fails on a plane.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const pda = require('../api/_lib/solana-pda');
const skr = require('../api/_lib/skr-staking');

// ── The ed25519 on-curve test: the thing that silently breaks PDA derivation ──

test('a real ed25519 public key is ON the curve', () => {
    // By construction every generated public key is a curve point. A false here
    // means the decompression is wrong, and a wrong decompression makes
    // findProgramAddress return the wrong address for about half of all inputs.
    for (let i = 0; i < 64; i++) {
        const kp = nacl.sign.keyPair();
        assert.strictEqual(pda.isOnCurve(Buffer.from(kp.publicKey)), true,
            'generated ed25519 public key reported off-curve');
    }
});

test('a derived program address is OFF the curve — the defining property', () => {
    const program = crypto.randomBytes(32);
    for (let i = 0; i < 32; i++) {
        const { address } = pda.findProgramAddress([Buffer.from('seed'), crypto.randomBytes(32)], program);
        assert.strictEqual(pda.isOnCurve(address), false,
            'findProgramAddress returned an ON-CURVE address, which a program can never own');
    }
});

test('findProgramAddress skips on-curve candidates (a bump below 255 must occur)', () => {
    // If the on-curve rejection never fired, every derivation would return bump
    // 255. Roughly half of all inputs must land below it. This is the case that
    // would have caught a missing curve check — and the five real mainnet
    // accounts cross-checked in the RESULT all sit at bump 254.
    const program = crypto.randomBytes(32);
    let sawLowerBump = false;
    for (let i = 0; i < 64 && !sawLowerBump; i++) {
        const { bump } = pda.findProgramAddress([crypto.randomBytes(32)], program);
        if (bump < 255) sawLowerBump = true;
    }
    assert.ok(sawLowerBump, 'no bump below 255 in 64 derivations — the on-curve check is not running');
});

test('PDA derivation is deterministic', () => {
    const program = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32);
    const a = pda.findProgramAddress([Buffer.from('user_stake'), seed], program);
    const b = pda.findProgramAddress([Buffer.from('user_stake'), seed], program);
    assert.ok(a.address.equals(b.address));
    assert.strictEqual(a.bump, b.bump);
});

test('isOnCurve rejects a non-canonical y (y >= p) and wrong-length input', () => {
    const tooBig = Buffer.alloc(32, 0xff);
    tooBig[31] = 0x7f;                      // y = 2^255 - 1 > p
    assert.strictEqual(pda.isOnCurve(tooBig), false);
    assert.strictEqual(pda.isOnCurve(Buffer.alloc(31)), false);
    assert.strictEqual(pda.isOnCurve(null), false);
});

// ── The share math, in raw units ──────────────────────────────────────────────

test('active stake = shares x share_price / 1e9, in BASE UNITS', () => {
    // Real values read off mainnet 2026-09-10: a UserStake holding 40000000000
    // shares against a share price of 1136636001 is 45465.440040 SKR.
    const raw = skr.computeActiveStakeRaw(40000000000n, 1136636001n);
    assert.strictEqual(raw, 45465440040n);
    assert.strictEqual(skr.toDisplaySkr(raw), '45465.440040');
});

test('the display conversion keeps precision a double would lose', () => {
    // Above 2^53 base units an IEEE double stops being able to name the integer.
    const huge = 9007199254740993n;         // 2^53 + 1
    assert.strictEqual(skr.toDisplaySkr(huge), '9007199254.740993');
    assert.notStrictEqual(String(Number(huge)), String(huge)); // the loss, demonstrated
});

test('display conversion pads the fractional part to six places', () => {
    assert.strictEqual(skr.toDisplaySkr(1n), '0.000001');
    assert.strictEqual(skr.toDisplaySkr(1000000n), '1.000000');
    assert.strictEqual(skr.toDisplaySkr(0n), '0.000000');
});

// ── Unstaking readiness (IDL: unstake_timestamp is when unstake was INITIATED) ─

test('unstaking readiness is timestamp + cooldown, not the timestamp alone', () => {
    const started = 1000000n;
    const cooldown = 172800n;               // the live StakeConfig value, 2 days
    assert.strictEqual(skr.isUnstakingReady(started, cooldown, 1000000 + 172799), false);
    assert.strictEqual(skr.isUnstakingReady(started, cooldown, 1000000 + 172800), true);
});

test('nothing unstaking (timestamp 0) is never "ready"', () => {
    assert.strictEqual(skr.isUnstakingReady(0n, 172800n, 999999999), false);
    assert.strictEqual(skr.isUnstakingReady(null, 172800n, 999999999), false);
});

// ── Decoding refuses what it cannot vouch for ────────────────────────────────

test('a wrong Anchor discriminator is refused, never decoded', () => {
    const data = Buffer.alloc(skr.USER_STAKE_SIZE);
    data.write('deadbeef', 0, 'hex');
    assert.throws(() => skr.decodeUserStake(data), /discriminator/);
});

test('an account of the wrong size is refused (a program upgrade must not decode)', () => {
    const data = Buffer.alloc(skr.USER_STAKE_SIZE + 8);
    Buffer.from([102, 53, 163, 107, 9, 138, 87, 153]).copy(data, 0);
    assert.throws(() => skr.decodeUserStake(data), /not the IDL/);
});

test('UserStake decodes at the IDL offsets', () => {
    const data = Buffer.alloc(skr.USER_STAKE_SIZE);
    Buffer.from([102, 53, 163, 107, 9, 138, 87, 153]).copy(data, 0);
    data.writeBigUInt64LE(12345n, 105);          // shares low half
    data.writeBigUInt64LE(777n, 153);            // unstaking_amount
    data.writeBigInt64LE(1789064275n, 161);      // unstake_timestamp
    const d = skr.decodeUserStake(data);
    assert.strictEqual(d.sharesRaw, 12345n);
    assert.strictEqual(d.unstakingAmountRaw, 777n);
    assert.strictEqual(d.unstakeTimestamp, 1789064275n);
});

// ── The ruling: last-known verified state within a bounded grace window ───────

function storedRow(overrides) {
    return Object.assign({
        walletAddress: 'W', guardianPool: 'G', userStakeAddress: 'U',
        sharesRaw: 40000000000n, sharePriceRaw: 1136636001n,
        activeStakedRaw: 45465440040n, unstakingRaw: 0n,
        unstakeTimestamp: 0n, cooldownSeconds: 172800n, unstakingReady: false,
        sourceSlot: 1, verificationStatus: 'VERIFIED', errorCode: null,
        verifiedAtSeconds: 1000000, lastAttemptSeconds: 1000000,
    }, overrides || {});
}

function outage() {
    return {
        walletAddress: 'W', guardianPool: 'G', userStakeAddress: 'U',
        sharesRaw: null, sharePriceRaw: null, activeStakedRaw: null,
        unstakingRaw: null, unstakeTimestamp: null, cooldownSeconds: null,
        unstakingReady: false, sourceSlot: null,
        verificationStatus: 'RPC_UNAVAILABLE', errorCode: 'stake_config_rpc_unavailable',
    };
}

test('ACCEPTANCE 4: an RPC outage NEVER reports the stake as zero', () => {
    // The Unity client does exactly this today (NativeSkrStakeQuery.cs:87-94
    // sets _activeStake = 0 in its catch). This is the case that must not.
    const r = skr.resolveServedState(outage(), storedRow(), 1000060);
    assert.strictEqual(r.served.verificationStatus, 'STALE');
    assert.strictEqual(r.served.activeStakedRaw, 45465440040n);
    assert.notStrictEqual(r.served.activeStakedRaw, 0n);
    assert.strictEqual(r.fromCache, true);
    assert.strictEqual(r.ageSeconds, 60);
});

test('an outage with NO stored snapshot serves nulls, not zeros', () => {
    const r = skr.resolveServedState(outage(), null, 1000060);
    assert.strictEqual(r.served.verificationStatus, 'RPC_UNAVAILABLE');
    assert.strictEqual(r.served.activeStakedRaw, null);
    assert.strictEqual(r.fromCache, false);
});

test('past the grace window the last-known state STOPS being served', () => {
    const grace = skr.staleGraceSeconds();
    const r = skr.resolveServedState(outage(), storedRow(), 1000000 + grace + 1);
    assert.strictEqual(r.graceExpired, true);
    assert.strictEqual(r.fromCache, false);
    assert.strictEqual(r.served.verificationStatus, 'RPC_UNAVAILABLE');
    assert.strictEqual(r.served.activeStakedRaw, null);
});

test('exactly AT the grace boundary the state is still served', () => {
    const grace = skr.staleGraceSeconds();
    const r = skr.resolveServedState(outage(), storedRow(), 1000000 + grace);
    assert.strictEqual(r.graceExpired, false);
    assert.strictEqual(r.served.verificationStatus, 'STALE');
});

test('a successful read always wins over the cache', () => {
    const fresh = Object.assign(outage(), {
        verificationStatus: 'VERIFIED', activeStakedRaw: 1n, errorCode: null,
    });
    const r = skr.resolveServedState(fresh, storedRow(), 1000060);
    assert.strictEqual(r.fromCache, false);
    assert.strictEqual(r.served.activeStakedRaw, 1n);
});

test('NO_STAKE is a SUCCESS, not a failure to be papered over with the cache', () => {
    // A player who genuinely unstaked must see that, immediately. Treating
    // NO_STAKE as a failure would let the grace window keep paying a player who
    // has withdrawn — the exploit the window must not create.
    const fresh = Object.assign(outage(), {
        verificationStatus: 'NO_STAKE', activeStakedRaw: 0n, errorCode: null,
    });
    const r = skr.resolveServedState(fresh, storedRow(), 1000060);
    assert.strictEqual(r.fromCache, false);
    assert.strictEqual(r.served.verificationStatus, 'NO_STAKE');
    assert.strictEqual(r.served.activeStakedRaw, 0n);
});

// ── Refresh policy ───────────────────────────────────────────────────────────

test('the 5-minute cache window is honoured at both edges', () => {
    assert.strictEqual(skr.isCacheFresh(1000000, 1000000 + 299), true);
    assert.strictEqual(skr.isCacheFresh(1000000, 1000000 + 300), false);
    assert.strictEqual(skr.isCacheFresh(null, 1000000), false);
});

test('the 60-second manual refresh cooldown is honoured at both edges', () => {
    assert.strictEqual(skr.manualRefreshAllowed(1000000, 1000000 + 59), false);
    assert.strictEqual(skr.manualRefreshAllowed(1000000, 1000000 + 60), true);
    assert.strictEqual(skr.manualRefreshAllowed(null, 1000000), true);
});

// ── PRODUCT RULE 7, asserted against the code's SHAPE ─────────────────────────

test('ACCEPTANCE 5: verifyStake takes a wallet and nothing that could be an amount', () => {
    // The security property is structural: there is no parameter through which a
    // stake, tier or share count can enter. verifyStake(wallet, opts) — and opts
    // carries only an RPC url and a clock, both test seams.
    assert.strictEqual(skr.verifyStake.length, 2);
});

test('an absent wallet is WALLET_NOT_LINKED, and carries no amounts', async () => {
    const out = await skr.verifyStake(null, { rpcUrl: 'http://127.0.0.1:1/dead' });
    assert.strictEqual(out.verificationStatus, 'WALLET_NOT_LINKED');
    assert.strictEqual(out.activeStakedRaw, null);
});

test('an unset RPC url is RPC_UNAVAILABLE, never a fallback to another network', async () => {
    // ACCEPTANCE 8 (mainnet is explicit). Silently falling back to whatever
    // SOLANA_RPC_URL points at could read devnet and call it real.
    const saved = process.env.SOLANA_MAINNET_RPC_URL;
    delete process.env.SOLANA_MAINNET_RPC_URL;
    try {
        const out = await skr.verifyStake('11111111111111111111111111111111');
        assert.strictEqual(out.verificationStatus, 'RPC_UNAVAILABLE');
        assert.strictEqual(out.errorCode, 'rpc_url_unset');
        assert.strictEqual(out.activeStakedRaw, null);
    } finally {
        if (saved !== undefined) process.env.SOLANA_MAINNET_RPC_URL = saved;
    }
});

test('the seven verification states are exactly the spec\'s seven', () => {
    assert.deepStrictEqual(skr.ALL_STATUSES.slice().sort(), [
        'ACCOUNT_NOT_FOUND', 'INVALID_RESPONSE', 'NO_STAKE', 'RPC_UNAVAILABLE',
        'STALE', 'VERIFIED', 'WALLET_NOT_LINKED',
    ]);
});

test('the migration CHECK constraint lists exactly those seven states', () => {
    // Two copies of one list is duplicated state (CLAUDE.md sections 2/5/8/16).
    // It cannot be reduced to one — a CHECK constraint cannot import from JS —
    // so it is PINNED instead: this fails the moment they diverge.
    const fs = require('fs');
    const sql = fs.readFileSync(
        require('path').join(__dirname, '..', 'api', 'migrations',
            '20260910_0024_skr_stake_snapshots.sql'), 'utf8');
    for (const s of skr.ALL_STATUSES) {
        assert.ok(sql.includes("'" + s + "'"),
            'migration CHECK is missing the ' + s + ' state');
    }
});
