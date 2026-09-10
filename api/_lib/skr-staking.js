// =============================================================================
// api/_lib/skr-staking.js — the SERVER-SIDE native SKR stake verifier.
// -----------------------------------------------------------------------------
// WO-1674 (HEART-001). Owner ruling 2026-09-10 13:10: BACKEND ONLY; an RPC
// outage falls back to the last-known verified state within a bounded grace
// window; Heartbound is a Seeker-artifact feature.
//
// PRODUCT RULE 7 (spec :22): "The Unity client must never be trusted to report
// the amount of SKR staked." This module is how that becomes true. It takes a
// WALLET ADDRESS and NOTHING ELSE from the caller, and reads the chain itself.
// There is deliberately no parameter through which an amount, a tier, a share
// count or an account address can be supplied.
//
// PRODUCT RULES 1-3: read-only. No signature is requested, no token moves, no
// custody is taken. Two getAccountInfo calls, and that is the whole interaction.
//
// -----------------------------------------------------------------------------
// ⭐ THE ACCOUNT LAYOUT BELOW IS PROVEN, NOT INFERRED (2026-09-10).
//
// WO-1674 D1 called the UserStake unstaking-field layout "the single largest
// unknown in HEART-001" and "an external fact from the Solana Mobile IDL [that]
// must be read there and cited". It was read there. The staking program
// publishes its Anchor IDL ON CHAIN, at the standard Anchor IDL address
//
//     base   = findProgramAddress([], programId)
//     idlPda = sha256(base || "anchor:idl" || programId)
//            = 4aAEUKCcju9iAEAgdeaNz4RC7sCPv63q5g714nw4QY68
//
// which held an 8586-byte account owned by the staking program; bytes 44.. are
// a zlib blob that inflates to 20854 bytes of JSON:
//     {"address":"SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ",
//      "metadata":{"name":"staking","version":"0.1.0","spec":"0.1.0", ...
//
// Its `types` give both layouts EXACTLY, and every offset below is computed
// from that declaration — not from a comment, not from a byte-pattern guess:
//
//   UserStake (169 bytes)                    StakeConfig (193 bytes)
//     8  bump              u8                  8  bump              u8
//     9  stake_config      pubkey              9  authority         pubkey
//    41  user              pubkey             41  mint              pubkey
//    73  guardian_pool     pubkey             73  stake_vault       pubkey
//   105  shares            u128              105  min_stake_amount  u64
//   121  cost_basis        u128              113  cooldown_seconds  u64
//   137  cumulative_commission_before_staking 121  total_shares      u128
//                          u128              137  share_price       u128
//   153  unstaking_amount  u64               153  commission_weight_sum u128
//   161  unstake_timestamp i64               169  cumulative_commission_per_share u128
//                                            185  last_vault_amount u64
//
// The layout was ALSO confirmed empirically before the IDL was found, over all
// 47,862 live UserStake accounts: the only bytes past 128 that are ever nonzero
// are 153-160 and 161-168, on exactly the same 2,871-account population. Two
// independent readings agreeing is why this is stated as fact.
//
// ⛔ THE TWO FIELDS THAT DECIDE ACCEPTANCE CRITERION 3, and the IDL settles it:
//
//   unstake  — "Initiates an unstake by BURNING SHARES and marking tokens for
//              withdrawal after the cooldown period. The unstaking amount is
//              calculated and saved at the time of unstake to prevent
//              benefiting from share price increases during cooldown."
//   cancel_unstake — "restoring the shares and clearing the unstaking state".
//
// So `shares` ALREADY EXCLUDES anything unstaking. `shares × share_price` is
// therefore the ACTIVE stake by construction, and criterion 3 ("unstaking
// amount is not counted as actively resonating SKR") holds structurally rather
// than by a subtraction we would have had to invent. `unstaking_amount` is a
// TOKEN amount in base units (already SKR, NOT shares) — do not multiply it by
// the share price. Reported separately, never added to the active stake.
//
// ⛔ COOLDOWN IS READ FROM THE CHAIN, NEVER HARDCODED. StakeConfig.cooldown_
// seconds was 172800 (2 days) when read on 2026-09-10, and it is an authority-
// updatable field on an account we already fetch. A copied 172800 would be the
// same duplicated state CLAUDE.md sections 2/5/8/16 each pay for.
//
// -----------------------------------------------------------------------------
// ⚠ THE DECIMALS TRAP, ALREADY PAID FOR ONCE. api/_lib/purchase-catalog.js:37-48
// records a 1000x overcharge from splitting SKR decimals per network. Heartbound
// is MAINNET ONLY (spec :181), where SKR is 6 decimals. There is no devnet
// branch here on purpose.
//
// Raw base units are kept in BigInt end to end and converted only at the display
// edge (spec :178, acceptance 7). Nothing in this file produces a float.
// =============================================================================

const { findProgramAddress } = require('./solana-pda');

let bs58 = null;
function loadBs58() {
    if (bs58) return true;
    try {
        bs58 = require('bs58');
        // bs58 v5/v6 exports under .default when require'd from CJS in some setups
        // (same defensive shape as api/_lib/wallet-auth.js:85-87).
        if (bs58 && typeof bs58.decode !== 'function' && bs58.default) bs58 = bs58.default;
        return !!(bs58 && typeof bs58.decode === 'function');
    } catch (_) {
        return false;
    }
}

// ── Program configuration (spec :78 — "must live in configuration/constants") ──
// These four addresses are the SINGLE backend authority. The Unity client's
// copies (Assets/_Modules/Wallet/NativeSkrStakeQuery.cs:25-27) are now
// display-only; see WO-1674 D4.
const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
const STAKING_PROGRAM = 'SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ';
const STAKE_CONFIG = '4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw';
const GUARDIAN_POOL = 'DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr';

/** SKR is 6 decimals on mainnet. See the decimals-trap note above. */
const SKR_DECIMALS = 6;
const SKR_BASE_UNITS = 1000000n;

/** share_price is scaled by 1e9 (IDL: "Global share price (scaled, e.g., 1e9)"). */
const SHARE_PRICE_SCALE = 1000000000n;

/** Anchor 8-byte account discriminators, taken from the IDL's `accounts` array. */
const USER_STAKE_DISCRIMINATOR = Buffer.from([102, 53, 163, 107, 9, 138, 87, 153]);
const STAKE_CONFIG_DISCRIMINATOR = Buffer.from([238, 151, 43, 3, 11, 151, 63, 176]);

/** Declared account sizes from the IDL. A different size is a program upgrade. */
const USER_STAKE_SIZE = 169;
const STAKE_CONFIG_SIZE = 193;

/** The PDA seed prefix, byte-identical to NativeSkrStakeQuery.cs:53. */
const USER_STAKE_SEED = Buffer.from('user_stake', 'utf8');

/**
 * The seven allowed verification states (spec :145-153). Exported so the route,
 * the migration's CHECK constraint and the regression all name ONE list.
 */
const VerificationStatus = {
    VERIFIED: 'VERIFIED',
    NO_STAKE: 'NO_STAKE',
    RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
    ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
    WALLET_NOT_LINKED: 'WALLET_NOT_LINKED',
    INVALID_RESPONSE: 'INVALID_RESPONSE',
    STALE: 'STALE',
};

const ALL_STATUSES = Object.keys(VerificationStatus);

/** Cache freshness (spec :157) and manual-refresh cooldown (spec :159). */
const CACHE_TTL_SECONDS = 300;
const MANUAL_REFRESH_COOLDOWN_SECONDS = 60;

/**
 * ⛔ TODO — OWNER DECISION REQUIRED (WO-1674, ruling 2026-09-10 13:10).
 *
 * The ruling says an RPC outage falls back to "last-known verified state with a
 * BOUNDED GRACE WINDOW". It does not say how long the window is, and the spec
 * sets no figure anywhere. That number is a FAIRNESS decision, not an
 * engineering one: it is exactly how long a player keeps Heartbound benefits
 * after we have stopped being able to see their stake — which is also how long
 * someone who unstakes keeps them.
 *
 * THE MECHANISM IS BUILT AND WIRED; only the number is open. It is read from
 * HEARTBOUND_STALE_GRACE_SECONDS so it can be set without a deploy.
 *
 * The provisional default below is 86400 (24 h) and is NOT an owner ruling. It
 * was chosen only because it is the coarsest cadence anything else in this
 * feature runs at (vercel.json declares two crons, both daily), so a shorter
 * default would expire a player's grace before the next scheduled refresh could
 * possibly renew it. ⚠ Do not cite this number as canon and do not copy it into
 * a doc — read it here, and replace it when the owner rules.
 */
const DEFAULT_STALE_GRACE_SECONDS = 86400;

function staleGraceSeconds() {
    const raw = process.env.HEARTBOUND_STALE_GRACE_SECONDS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STALE_GRACE_SECONDS;
}

/**
 * The MAINNET RPC endpoint.
 *
 * ⛔ TODO — OWNER / INFRA DECISION REQUIRED (WO-1674). Which provider serves
 * this is not settled: the public api.mainnet-beta.solana.com endpoint rate-
 * limits aggressively and is not a production dependency, and no paid provider
 * has been chosen or provisioned for this project. The variable is read here so
 * the choice is a dashboard setting, never a code change.
 *
 * ⚠ AND IT IS DELIBERATELY *NOT* `SOLANA_RPC_URL`. That var is already read by
 * api/tower-swap/log.js and api/purchases/verify.js, and api/_lib/purchase-
 * catalog.js:57 proves this project runs a devnet configuration too
 * ({ devnet: 9, 'mainnet-beta': 6 }). Heartbound is mainnet-only (spec :181,
 * acceptance 8); silently inheriting a var that may point at devnet is how a
 * verifier reports a real stake of zero, or a devnet stake as real. A dedicated
 * mainnet-named var cannot be pointed elsewhere by accident.
 *
 * Unset is NOT a fallback to another network — it is RPC_UNAVAILABLE, which the
 * last-known-state path is built to survive.
 */
function mainnetRpcUrl() {
    const v = process.env.SOLANA_MAINNET_RPC_URL;
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// =============================================================================
//  Pure decoding — no network, no clock, fully unit-testable
// =============================================================================

/** Little-endian u64 at `offset` as BigInt. Throws when the buffer is short. */
function readU64LE(data, offset) {
    if (!data || data.length < offset + 8) {
        throw new Error('account shorter than its IDL layout at offset ' + offset);
    }
    return data.readBigUInt64LE(offset);
}

/** Little-endian i64 at `offset` as BigInt (unstake_timestamp is signed). */
function readI64LE(data, offset) {
    if (!data || data.length < offset + 8) {
        throw new Error('account shorter than its IDL layout at offset ' + offset);
    }
    return data.readBigInt64LE(offset);
}

/** Little-endian u128 at `offset` as BigInt, assembled from two u64 halves. */
function readU128LE(data, offset) {
    if (!data || data.length < offset + 16) {
        throw new Error('account shorter than its IDL layout at offset ' + offset);
    }
    return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

/**
 * Refuse an account whose first 8 bytes are not the expected Anchor
 * discriminator. This is the guard that stops a program upgrade, a wrong
 * address or an unrelated account from being decoded as a stake and reported as
 * an amount. Same rule as NativeSkrStakeQuery.RequireDiscriminator (:106-113).
 */
function requireDiscriminator(data, expected, accountName) {
    if (!data || data.length < expected.length) {
        throw new Error(accountName + ' account data was missing');
    }
    for (let i = 0; i < expected.length; i++) {
        if (data[i] !== expected[i]) {
            throw new Error(accountName + ' discriminator did not match the official IDL');
        }
    }
}

/** Decode StakeConfig. Returns raw BigInts only. */
function decodeStakeConfig(data) {
    requireDiscriminator(data, STAKE_CONFIG_DISCRIMINATOR, 'StakeConfig');
    if (data.length !== STAKE_CONFIG_SIZE) {
        throw new Error('StakeConfig is ' + data.length + ' bytes, not the IDL\'s ' + STAKE_CONFIG_SIZE);
    }
    return {
        minStakeAmountRaw: readU64LE(data, 105),
        cooldownSeconds: readU64LE(data, 113),
        totalSharesRaw: readU128LE(data, 121),
        sharePriceRaw: readU128LE(data, 137),
    };
}

/** Decode UserStake. Returns raw BigInts only. */
function decodeUserStake(data) {
    requireDiscriminator(data, USER_STAKE_DISCRIMINATOR, 'UserStake');
    if (data.length !== USER_STAKE_SIZE) {
        throw new Error('UserStake is ' + data.length + ' bytes, not the IDL\'s ' + USER_STAKE_SIZE);
    }
    return {
        sharesRaw: readU128LE(data, 105),
        costBasisRaw: readU128LE(data, 121),
        unstakingAmountRaw: readU64LE(data, 153),
        unstakeTimestamp: readI64LE(data, 161),
    };
}

/**
 * shares x share_price / 1e9 -> ACTIVE stake in SKR BASE UNITS (6 decimals).
 *
 * ⛔ RETURNS BASE UNITS, NOT WHOLE SKR. The Unity client divided by 1e6 here
 * (NativeSkrStakeQuery.cs:76) and handed out a whole-SKR long, which is the
 * precision loss WO-1674 §0 item 3 names. The division to display units happens
 * once, at the very edge, in toDisplaySkr.
 */
function computeActiveStakeRaw(sharesRaw, sharePriceRaw) {
    return (sharesRaw * sharePriceRaw) / SHARE_PRICE_SCALE;
}

/**
 * Base units -> a DISPLAY string with 6 decimals. A string, never a Number:
 * a stake above ~9e9 SKR would lose integer precision as an IEEE double, and
 * this value is shown to a player beside their real financial position.
 */
function toDisplaySkr(raw) {
    const v = typeof raw === 'bigint' ? raw : BigInt(raw || 0);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const whole = abs / SKR_BASE_UNITS;
    const frac = (abs % SKR_BASE_UNITS).toString().padStart(SKR_DECIMALS, '0');
    return (neg ? '-' : '') + whole.toString() + '.' + frac;
}

/**
 * Is a pending unstake past its cooldown?
 *
 * READY means the tokens can be withdrawn now: unstake_timestamp is when the
 * unstake was INITIATED (IDL), so the ready moment is that plus the config's
 * cooldown_seconds. A zero timestamp with a zero amount means nothing is
 * unstaking at all.
 *
 * `nowSeconds` is the CHAIN's clock where we have one, never the client's —
 * the same honest-clock rule api/purchases/verify.js:92-94 already follows.
 */
function isUnstakingReady(unstakeTimestamp, cooldownSeconds, nowSeconds) {
    if (unstakeTimestamp === undefined || unstakeTimestamp === null) return false;
    const ts = BigInt(unstakeTimestamp);
    if (ts <= 0n) return false;
    return ts + BigInt(cooldownSeconds) <= BigInt(nowSeconds);
}

/**
 * Derive the UserStake PDA for a wallet — seeds byte-identical to the client's
 * (NativeSkrStakeQuery.cs:52-54) and to the on-chain program's.
 *
 * ⭐ VERIFIED AGAINST THE CHAIN, not against our own reasoning: five real
 * UserStake accounts fetched from mainnet were re-derived from the `user`
 * pubkey stored INSIDE each of them, and all five matched the account's own
 * address AND its stored bump — every one at bump 254, which is only reachable
 * if the on-curve rejection in solana-pda.js actually runs. See that file's
 * header for why an implementation without it fails silently.
 */
function deriveUserStakePda(walletAddress) {
    if (!loadBs58()) throw new Error('bs58 unavailable');
    const user = Buffer.from(bs58.decode(walletAddress));
    if (user.length !== 32) throw new Error('wallet address did not decode to 32 bytes');
    const config = Buffer.from(bs58.decode(STAKE_CONFIG));
    const guardian = Buffer.from(bs58.decode(GUARDIAN_POOL));
    const program = Buffer.from(bs58.decode(STAKING_PROGRAM));
    const { address, bump } = findProgramAddress(
        [USER_STAKE_SEED, config, user, guardian], program);
    return { address: bs58.encode(address), bump: bump };
}

// =============================================================================
//  RPC
// =============================================================================

/** One JSON-RPC call. Never throws: a fault is a typed refusal, as in log.js. */
async function rpcCall(url, method, params) {
    let payload;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
        });
        if (!resp.ok) return { ok: false, reason: 'rpc_unavailable', http: resp.status };
        payload = await resp.json();
    } catch (_) {
        return { ok: false, reason: 'rpc_unavailable' };
    }
    if (!payload) return { ok: false, reason: 'rpc_unavailable' };
    if (payload.error) return { ok: false, reason: 'rpc_unavailable' };
    return { ok: true, result: payload.result };
}

/**
 * Fetch one account's data as a Buffer.
 * Distinguishes "the RPC did not answer" (rpc_unavailable) from "the RPC
 * answered and there is no such account" (account_not_found) — collapsing those
 * two is how an outage becomes a fabricated NO_STAKE, which is the exact bug
 * acceptance criterion 4 forbids.
 */
async function fetchAccount(url, address) {
    const r = await rpcCall(url, 'getAccountInfo',
        [address, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r.ok) return r;

    const value = r.result && r.result.value;
    const context = r.result && r.result.context;
    const slot = context && Number.isFinite(context.slot) ? context.slot : null;

    if (!value) return { ok: false, reason: 'account_not_found', slot: slot };
    const encoded = value.data && Array.isArray(value.data) ? value.data[0] : null;
    if (typeof encoded !== 'string') return { ok: false, reason: 'invalid_response', slot: slot };

    let data;
    try {
        data = Buffer.from(encoded, 'base64');
    } catch (_) {
        return { ok: false, reason: 'invalid_response', slot: slot };
    }
    return { ok: true, data: data, slot: slot, owner: value.owner || null };
}

/**
 * VERIFY ONE WALLET'S NATIVE SKR STAKE, MAINNET, READ-ONLY.
 *
 * The ONLY input is a wallet address. There is no parameter for an amount, a
 * tier, a share count or an account address — product rule 7 is enforced by the
 * SHAPE of this function, not by a check inside it.
 *
 * Never throws. Every outcome is one of the seven VerificationStatus values,
 * with raw BigInts on success and nulls (never zeros) on failure — because a
 * fabricated zero is indistinguishable from a real "no stake", and that
 * confusion is the whole reason this layer exists.
 *
 * @param {string} walletAddress base58 wallet (the authenticated player id)
 * @param {{rpcUrl?: string, nowSeconds?: number}} [opts] test seams only
 */
async function verifyStake(walletAddress, opts) {
    const options = opts || {};
    const url = options.rpcUrl || mainnetRpcUrl();

    const empty = {
        walletAddress: walletAddress || null,
        guardianPool: GUARDIAN_POOL,
        userStakeAddress: null,
        sharesRaw: null,
        sharePriceRaw: null,
        activeStakedRaw: null,
        unstakingRaw: null,
        unstakeTimestamp: null,
        cooldownSeconds: null,
        unstakingReady: false,
        sourceSlot: null,
        verificationStatus: VerificationStatus.INVALID_RESPONSE,
        errorCode: null,
        rpcLatencyMs: null,
    };

    if (!walletAddress || typeof walletAddress !== 'string') {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.WALLET_NOT_LINKED,
            errorCode: 'wallet_missing',
        });
    }

    if (!url) {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.RPC_UNAVAILABLE,
            errorCode: 'rpc_url_unset',
        });
    }

    let userStakeAddress;
    try {
        userStakeAddress = deriveUserStakePda(walletAddress).address;
    } catch (err) {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.WALLET_NOT_LINKED,
            errorCode: 'pda_derivation_failed',
        });
    }
    empty.userStakeAddress = userStakeAddress;

    const startedAt = Date.now();

    // 1. StakeConfig — the share price and the cooldown. Required for BOTH the
    //    amount and the readiness, so a failure here is not survivable as a
    //    partial answer.
    const cfgRes = await fetchAccount(url, STAKE_CONFIG);
    if (!cfgRes.ok) {
        const status = cfgRes.reason === 'rpc_unavailable'
            ? VerificationStatus.RPC_UNAVAILABLE
            : VerificationStatus.INVALID_RESPONSE;
        return Object.assign(empty, {
            verificationStatus: status,
            errorCode: 'stake_config_' + cfgRes.reason,
            rpcLatencyMs: Date.now() - startedAt,
        });
    }

    let config;
    try {
        config = decodeStakeConfig(cfgRes.data);
    } catch (err) {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.INVALID_RESPONSE,
            errorCode: 'stake_config_decode_failed',
            rpcLatencyMs: Date.now() - startedAt,
        });
    }

    // 2. UserStake — absent is a REAL answer ("this wallet has never staked"),
    //    which is NO_STAKE and not an error.
    const userRes = await fetchAccount(url, userStakeAddress);
    const latencyMs = Date.now() - startedAt;

    if (!userRes.ok && userRes.reason === 'account_not_found') {
        return Object.assign(empty, {
            sharesRaw: 0n,
            sharePriceRaw: config.sharePriceRaw,
            activeStakedRaw: 0n,
            unstakingRaw: 0n,
            unstakeTimestamp: 0n,
            cooldownSeconds: config.cooldownSeconds,
            sourceSlot: userRes.slot != null ? userRes.slot : cfgRes.slot,
            verificationStatus: VerificationStatus.NO_STAKE,
            rpcLatencyMs: latencyMs,
        });
    }

    if (!userRes.ok) {
        const status = userRes.reason === 'rpc_unavailable'
            ? VerificationStatus.RPC_UNAVAILABLE
            : VerificationStatus.INVALID_RESPONSE;
        return Object.assign(empty, {
            verificationStatus: status,
            errorCode: 'user_stake_' + userRes.reason,
            rpcLatencyMs: latencyMs,
        });
    }

    // An account at the right address owned by the wrong program is not a
    // decoding problem, it is a wrong-chain / wrong-program problem.
    if (userRes.owner && userRes.owner !== STAKING_PROGRAM) {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.INVALID_RESPONSE,
            errorCode: 'user_stake_wrong_owner',
            rpcLatencyMs: latencyMs,
        });
    }

    let user;
    try {
        user = decodeUserStake(userRes.data);
    } catch (err) {
        return Object.assign(empty, {
            verificationStatus: VerificationStatus.INVALID_RESPONSE,
            errorCode: 'user_stake_decode_failed',
            rpcLatencyMs: latencyMs,
        });
    }

    const activeRaw = computeActiveStakeRaw(user.sharesRaw, config.sharePriceRaw);
    const nowSeconds = Number.isFinite(options.nowSeconds)
        ? options.nowSeconds
        : Math.floor(Date.now() / 1000);

    return {
        walletAddress: walletAddress,
        guardianPool: GUARDIAN_POOL,
        userStakeAddress: userStakeAddress,
        sharesRaw: user.sharesRaw,
        sharePriceRaw: config.sharePriceRaw,
        activeStakedRaw: activeRaw,
        unstakingRaw: user.unstakingAmountRaw,
        unstakeTimestamp: user.unstakeTimestamp,
        cooldownSeconds: config.cooldownSeconds,
        unstakingReady: isUnstakingReady(user.unstakeTimestamp, config.cooldownSeconds, nowSeconds),
        sourceSlot: userRes.slot != null ? userRes.slot : cfgRes.slot,
        // Zero shares with a live account is still NO_STAKE, not VERIFIED-with-
        // zero: the player has fully unstaked, and every consumer downstream
        // asks "is there a stake", never "is the number zero".
        verificationStatus: activeRaw > 0n
            ? VerificationStatus.VERIFIED
            : VerificationStatus.NO_STAKE,
        errorCode: null,
        rpcLatencyMs: latencyMs,
    };
}

/**
 * Decide what to SERVE, given a fresh verification attempt and the last stored
 * snapshot. This is the owner's 13:10 ruling expressed as one pure function.
 *
 * ⛔ NEVER RETURNS ZERO FOR AN OUTAGE. Acceptance criterion 4 — "RPC failure
 * does not incorrectly turn stake into zero" — and it is the exact behaviour
 * the Unity client has today (NativeSkrStakeQuery.cs:87-94 sets
 * `_activeStake = 0` in its catch). Fail-closed is right for a one-off perk and
 * wrong for a streak; this function is where the two part company.
 *
 * The rule:
 *   • a successful read (VERIFIED / NO_STAKE) is served as-is and stored;
 *   • a failed read with a stored snapshot inside the grace window is served as
 *     STALE, carrying the LAST VERIFIED AMOUNTS and the age that makes the
 *     staleness legible;
 *   • a failed read with no snapshot, or one past the window, is served as the
 *     failure itself with NULL amounts — never zeros.
 *
 * @param {object} fresh    a verifyStake() result
 * @param {object|null} stored  the last row, or null
 * @param {number} nowSeconds
 */
function resolveServedState(fresh, stored, nowSeconds) {
    const succeeded = fresh && (fresh.verificationStatus === VerificationStatus.VERIFIED ||
                                fresh.verificationStatus === VerificationStatus.NO_STAKE);
    if (succeeded) {
        return { served: fresh, fromCache: false, ageSeconds: 0, graceExpired: false };
    }

    const hasStored = !!(stored && stored.verifiedAtSeconds);
    if (!hasStored) {
        return { served: fresh, fromCache: false, ageSeconds: null, graceExpired: false };
    }

    const age = Math.max(0, Math.floor(nowSeconds - stored.verifiedAtSeconds));
    const grace = staleGraceSeconds();

    if (age > grace) {
        // The last-known state has outlived its window. Serve the failure, and
        // say WHY it is a failure rather than a stale answer.
        return {
            served: Object.assign({}, fresh, { errorCode: fresh.errorCode || 'grace_expired' }),
            fromCache: false,
            ageSeconds: age,
            graceExpired: true,
        };
    }

    return {
        served: Object.assign({}, stored, {
            verificationStatus: VerificationStatus.STALE,
            errorCode: fresh ? fresh.errorCode : null,
        }),
        fromCache: true,
        ageSeconds: age,
        graceExpired: false,
    };
}

/** Is a stored snapshot still inside the 5-minute cache (spec :157)? */
function isCacheFresh(verifiedAtSeconds, nowSeconds) {
    if (!verifiedAtSeconds) return false;
    return (nowSeconds - verifiedAtSeconds) < CACHE_TTL_SECONDS;
}

/** Has the 60-second manual-refresh cooldown (spec :159) elapsed? */
function manualRefreshAllowed(lastAttemptSeconds, nowSeconds) {
    if (!lastAttemptSeconds) return true;
    return (nowSeconds - lastAttemptSeconds) >= MANUAL_REFRESH_COOLDOWN_SECONDS;
}

module.exports = {
    // configuration
    SKR_MINT,
    STAKING_PROGRAM,
    STAKE_CONFIG,
    GUARDIAN_POOL,
    SKR_DECIMALS,
    SKR_BASE_UNITS,
    SHARE_PRICE_SCALE,
    USER_STAKE_SIZE,
    STAKE_CONFIG_SIZE,
    CACHE_TTL_SECONDS,
    MANUAL_REFRESH_COOLDOWN_SECONDS,
    DEFAULT_STALE_GRACE_SECONDS,
    VerificationStatus,
    ALL_STATUSES,
    // pure
    decodeStakeConfig,
    decodeUserStake,
    computeActiveStakeRaw,
    toDisplaySkr,
    isUnstakingReady,
    deriveUserStakePda,
    resolveServedState,
    isCacheFresh,
    manualRefreshAllowed,
    staleGraceSeconds,
    mainnetRpcUrl,
    // network
    verifyStake,
};
