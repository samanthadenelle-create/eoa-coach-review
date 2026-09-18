// =============================================================================
// api/_lib/clan-vaults.js — WO-1854 (clan WO-11). THE COLLECTIVE VIGIL.
// -----------------------------------------------------------------------------
// A clan's Vigil, read from a Squads multisig vault instead of from one wallet:
//
//   collective_vigil_weight = percent_of_the_VAULT'S_SKR_staked x vault_tenure_seconds
//   hardware_backed         = every signer holds a verified Seeker Genesis Token
//
// The per-member Vigil (WO-1852, api/_lib/clan-vigil.js) is UNTOUCHED and remains the
// answer for a clan with no vault. This is an additive layer, exactly as the work
// order's non-scope insists ("does NOT replace WO-1852").
//
// ⛔ THE GAME READS. IT NEVER SIGNS, NEVER EXECUTES, NEVER CREATES. There is no vault
// creation flow (owner-ruled "bring your own vault") and no Squads transaction path
// anywhere in this file — Squads and the vault's own signers handle every write, always.
// The only instruction this module could theoretically reach is none: it issues
// getAccountInfo and getTokenAccountsByOwner, and nothing else.
//
// =============================================================================
// ⭐ THE SQUADS READ IS VERIFIED AGAINST MAINNET AND AGAINST THE INSTALLED PACKAGE,
//    NOT AGAINST THE SPEC'S PROSE (the work order's first VERIFY item, done).
// -----------------------------------------------------------------------------
// INSTALLED VERSION IS 2.1.4, NOT v4. `node_modules/@sqds/multisig/package.json` reads
// "version": "2.1.4" — the version package.json already pinned (`^2.1.4`). The source
// spec's discussion of "v4" is about the SQUADS PROGRAM generation (the on-chain program
// this SDK talks to, PROGRAM_ID SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf, printed from
// the package itself), NOT about an npm major. Nothing here is written against a v4 SDK
// shape. The exports actually present, listed off the require:
//   PROGRAM_ADDRESS, PROGRAM_ID, accounts, errors, generated, getBatchTransactionPda,
//   getEphemeralSignerPda, getMultisigPda, getProgramConfigPda, getProposalPda,
//   getSpendingLimitPda, getTransactionPda, getVaultPda, instructions, rpc,
//   transactions, types, utils
// and `accounts.Multisig`'s real statics: fromArgs, fromAccountInfo, fromAccountAddress,
// gpaBuilder, deserialize, byteSize, getMinimumBalanceForRentExemption.
//
// IT IMPORTS CLEANLY IN A PLAIN NODE/CJS CONTEXT — an actual require, not an assumption:
// `require('@sqds/multisig')` succeeded in ~305 ms warm (three runs: 325 / 305 / 301 ms;
// 4093 ms on the very first cold disk read). Pure JS — its dependency tree is
// @metaplex-foundation/beet, beet-solana, cusper, @solana/spl-token, @solana/web3.js,
// bn.js, buffer, invariant — no native addon, so it is Vercel-serverless safe.
//
// ⛔ WHICH IS ALSO WHY IT IS LAZY-REQUIRED, INSIDE THE REGISTER PATH ONLY. 300 ms of
// module init on a cold lambda is a third of a second nobody should pay to READ a clan's
// Vigil, and GET /api/clan/vigil never needs it: the signer list and threshold come from
// Postgres once registered. The SDK is touched only by POST /api/clan/vault/register.
//
// ⭐ AND THE READ IS PURE-DESERIALIZE OVER RAW RPC, NOT `fromAccountAddress`.
// `Multisig.fromAccountAddress(connection, pda)` wants a @solana/web3.js Connection — a
// second HTTP stack, with its own retries and timeouts, inside a function that already
// has one. `Multisig.deserialize(buffer)` is pure and is what the account address variant
// calls anyway. Proven against three REAL mainnet multisigs on 2026-09-17 (found by
// getProgramAccounts on the program, memcmp'd against accounts.multisigDiscriminator
// [224,116,121,186,68,161,79,236]; 156,641 such accounts exist):
//   JEJJhPFUoTzFsAQAoFYUEQDmFUPJjCifHfLgn3V9nYJq  231 B  threshold 2 / 3 members
//     -> vault[0] DUQCftnDJJc4DoqyjPiZETPn9o4EBhwAGrUJoniQgg12 (bump 255)
//   JEJVyALtFCBgNSGAyFtEXF8w2JYUu8awD9EVMYtWLysL  528 B  threshold 2 / 3 members
//     -> vault[0] 5Zbv692eNmxcPFCvGrbYnqiTUyTcqTbTZeuDprLssMNo
//   JEJdqYLAAT8kirhwiWYNKXDPAp2U7xT5mtVqqegpb4Dm  198 B  threshold 2 / 2 members
//     -> vault[0] 8V1BmioKt28HerjpmbBsQPnYQjGATm2iXkJNmDWGVMyM
// Note the byte sizes DIFFER (231 / 528 / 198): a Multisig account is variable-length
// (its members vector), so there is no size check to make here — the discriminator and
// the program owner are the guards, which is the same rule skr-staking's
// requireDiscriminator states for its two FIXED-size accounts.
//
// ⛔ THE ADDRESS THE PLAYER BRINGS IS THE MULTISIG ADDRESS, NOT THE VAULT ADDRESS, AND
//    THE DIFFERENCE IS NOT COSMETIC. A Squads vault is a bare PDA: it holds tokens and
//    carries NO data, so a vault address can tell you nothing about its own signers or
//    threshold, and it cannot be reversed to the multisig that owns it (that is what a
//    one-way PDA derivation means). The multisig account is where the members and the
//    threshold live. So registration takes the MULTISIG address, DERIVES the vault, and
//    stores both — and an address that is not a Squads multisig account is refused with
//    its own code saying which address to pass, never guessed at.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore). CommonJS.
// =============================================================================

'use strict';

const skr = require('./skr-staking');
const gt = require('./genesis-token');
// ⚠ NO REQUIRE CYCLE, CHECKED RATHER THAN ASSUMED: wallet-auth.js requires
// ./google-identity and (lazily) ./genesis-token and ./skr-staking, and requires NOTHING
// from this file. genesis-token requires ./skr-staking only. So this top-level import is
// safe in both directions — and isWalletId is imported rather than re-spelled for the
// reason WALLET_RE's own note gives: three copies of one regex is how a player gets a
// nonce they can never spend.
const { isWalletId, verifyGenesisToken } = require('./wallet-auth');

/**
 * Stable machine codes for the vault paths. Same discipline as ClanCode: a code names
 * a CLASS of failure and is what a client branches on.
 */
const VaultCode = {
    BAD_ADDRESS:        'CLAN_VAULT_BAD_ADDRESS',       // 400 — not base58 32..44
    NOT_A_MULTISIG:     'CLAN_VAULT_NOT_A_MULTISIG',    // 400 — right shape, wrong account
    BAD_VAULT_INDEX:    'CLAN_VAULT_BAD_INDEX',         // 400 — outside 0..255
    UNREADABLE:         'CLAN_VAULT_UNREADABLE',        // 503-as-200 — chain not readable
    TOO_MANY_SIGNERS:   'CLAN_VAULT_TOO_MANY_SIGNERS',  // 400 — beyond the RPC fan-out cap
    SIGNER_NO_SGT:      'CLAN_VAULT_SIGNER_NO_SGT',     // 403 — the named signer holds none
    SIGNER_SGT_REUSED:  'CLAN_VAULT_SIGNER_SGT_REUSED', // 403 — that device is already bound
    SIGNER_UNVERIFIABLE:'CLAN_VAULT_SIGNER_UNVERIFIABLE',// 200-shaped refusal — could not look
    ALREADY_REGISTERED: 'CLAN_VAULT_ALREADY_REGISTERED', // 409 — this clan, or this vault
    NOT_LEADER:         'CLAN_VAULT_NOT_LEADER',        // 403 — caller is not the Leader
};

/**
 * ⛔ THE FAN-OUT CEILING, AND IT IS NOT DECORATION. One registration verifies EVERY
 * signer, and one signer's verification is up to (1 + MAX_MINT_PROBES) RPC calls on a
 * shared, rate-limited, BILLED Helius key. Squads itself permits a large member vector,
 * so without a cap a single request could fan out thousands of calls.
 *
 * ⚠ AND THERE IS NO clan_rate_limit BUDGET BEHIND THIS ONE, WHICH IS WHY THE CAP MATTERS
 *   MORE HERE THAN IT WOULD OTHERWISE. CLAN_RATE_LIMITS' shape is pinned by an
 *   `assert.deepEqual` in test/clan-roles.test.js:566 (another lane's file this session),
 *   and an action string that is not one of its six keys silently takes the STRICTEST
 *   budget while logging itself as a programming mistake. Adding a seventh key is the
 *   right long-term answer and is flagged in the implementation record; the cap is what
 *   bounds the damage today.
 */
const MAX_VAULT_SIGNERS = 20;

/** Squads' own limit: getVaultPda asserts `index >= 0 && index < 256`. */
const MAX_VAULT_INDEX = 255;

/**
 * Lazily load the Squads SDK and @solana/web3.js. See this file's header for the 300 ms
 * that buys, and for why nothing on the Vigil READ path may touch it.
 *
 * ⚠ @solana/web3.js IS REQUIRED EXPLICITLY AND IS LISTED EXPLICITLY IN package.json,
 *   even though @sqds/multisig already depends on it (^1.70.3; 1.98.4 is what resolved).
 *   Reaching through another package's tree for a module is the same class of hazard as
 *   an undeclared tag or a hardcoded repo root — it works until that package changes its
 *   own dependency, and then it fails at require time in production.
 */
let squads = null;
let web3 = null;
let squadsLoadError = null;
function loadSquads() {
    if (squads && web3) return true;
    try {
        // eslint-disable-next-line global-require
        squads = require('@sqds/multisig');
        // eslint-disable-next-line global-require
        web3 = require('@solana/web3.js');
        return !!(squads && squads.accounts && squads.accounts.Multisig && web3 && web3.PublicKey);
    } catch (err) {
        squadsLoadError = err && err.message ? err.message : String(err);
        return false;
    }
}

/**
 * Normalise the address a Leader supplied. Shape-checked HERE so a garbage string is a
 * 400 rather than an RPC round trip that finds nothing — the same split
 * normalizeTargetWallet draws between BAD_TARGET and a 404.
 *
 * A Solana account address and a wallet address are the same base58 shape, so the wallet
 * predicate is REUSED rather than re-spelled. Three copies of one regex is how a player
 * gets a nonce they can never spend (WALLET_RE's own note).
 */
function normalizeVaultAddress(raw) {
    const address = raw != null ? String(raw).trim() : '';
    if (!isWalletId(address)) return { ok: false, code: VaultCode.BAD_ADDRESS };
    return { ok: true, value: address };
}

/** Normalise an optional vault index. Absent means 0, the default Squads vault. */
function normalizeVaultIndex(raw) {
    if (raw == null || raw === '') return { ok: true, value: 0 };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_VAULT_INDEX) {
        return { ok: false, code: VaultCode.BAD_VAULT_INDEX };
    }
    return { ok: true, value: n };
}

/**
 * READ ONE SQUADS MULTISIG ACCOUNT. Never throws.
 *
 * Three guards, in the order that makes each one's failure legible:
 *   1. the account EXISTS (absent is not "a multisig with no members");
 *   2. it is OWNED BY THE SQUADS PROGRAM (an account at the right address owned by the
 *      wrong program is a wrong-program problem, not a decode problem — skr-staking's
 *      `user_stake_wrong_owner` makes the same distinction);
 *   3. it DESERIALIZES, which checks the Anchor discriminator inside the SDK.
 *
 * @returns {Promise<{ok:true, threshold:number, members:string[], memberMasks:number[],
 *                    timeLock:number, configAuthority:string, size:number}
 *                 | {ok:false, code:string, reason?:string}>}
 */
async function readMultisig(url, multisigAddress) {
    if (!loadSquads()) {
        return { ok: false, code: VaultCode.UNREADABLE, reason: 'sdk_unavailable:' + squadsLoadError };
    }

    const r = await gt.rpcCall(url, 'getAccountInfo', [
        multisigAddress, { encoding: 'base64', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, code: VaultCode.UNREADABLE, reason: r.reason };

    const value = r.result && r.result.value;
    // ⛔ ABSENT IS "NOT A MULTISIG", NOT "UNREADABLE". The RPC answered; the address is
    // simply not a Squads account, and a Leader needs to be told to check the address
    // rather than to try again later.
    if (!value) return { ok: false, code: VaultCode.NOT_A_MULTISIG, reason: 'account_not_found' };
    if (value.owner !== squads.PROGRAM_ID.toBase58()) {
        return { ok: false, code: VaultCode.NOT_A_MULTISIG, reason: 'wrong_program_owner' };
    }

    const encoded = value.data && Array.isArray(value.data) ? value.data[0] : null;
    if (typeof encoded !== 'string') {
        return { ok: false, code: VaultCode.UNREADABLE, reason: 'invalid_response' };
    }

    let data;
    try {
        data = Buffer.from(encoded, 'base64');
    } catch (_) {
        return { ok: false, code: VaultCode.UNREADABLE, reason: 'invalid_response' };
    }

    // ⛔ THE DISCRIMINATOR IS CHECKED HERE, EXPLICITLY, BECAUSE `Multisig.deserialize` DOES
    //    NOT CHECK IT — measured 2026-09-17, not assumed. A 200-byte buffer carrying the
    //    PROPOSAL discriminator and zeroes elsewhere deserialized SUCCESSFULLY and returned a
    //    Multisig with threshold 0 and an empty member vector. beet's generated reader treats
    //    the 8 bytes as just another struct field; nothing in it compares them.
    //
    //    That matters because the owner check above does NOT separate Squads' account TYPES:
    //    a Proposal, a VaultTransaction, a SpendingLimit and a ProgramConfig are all owned by
    //    SQDS4ep…, so without this guard any one of them at the supplied address would decode
    //    as a "multisig" whose threshold and member list are whatever those bytes happen to
    //    mean. The Array.isArray guard below would catch SOME of those by accident — an empty
    //    or absent vector — but "caught by accident" is not a property, and a Proposal with
    //    real data in the right place is exactly the case accident does not cover.
    //
    //    This is the rule skr-staking.requireDiscriminator states for its two accounts, and it
    //    is here for the identical reason: it is the guard that stops an unrelated account
    //    being decoded as a governance configuration and reported as a clan's signer set.
    const expected = Buffer.from(squads.accounts.multisigDiscriminator);
    if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
        return { ok: false, code: VaultCode.NOT_A_MULTISIG, reason: 'discriminator_or_decode' };
    }

    let ms;
    try {
        [ms] = squads.accounts.Multisig.deserialize(data);
    } catch (err) {
        // A truncated or corrupt account past the discriminator.
        return { ok: false, code: VaultCode.NOT_A_MULTISIG, reason: 'discriminator_or_decode' };
    }
    if (!ms || !Array.isArray(ms.members)) {
        return { ok: false, code: VaultCode.NOT_A_MULTISIG, reason: 'no_member_vector' };
    }

    return {
        ok: true,
        threshold: Number(ms.threshold),
        members: ms.members.map((m) => m.key.toBase58()),
        // The permission masks are REPORTED but never STORED — see registerClanVault.
        memberMasks: ms.members.map((m) => Number(m.permissions && m.permissions.mask)),
        timeLock: Number(ms.timeLock || 0),
        configAuthority: ms.configAuthority ? ms.configAuthority.toBase58() : null,
        size: data.length,
    };
}

/**
 * Derive vault `index` of `multisigAddress`, using the SDK's OWN derivation.
 *
 * ⛔ NOT re-implemented over api/_lib/solana-pda.js, even though that helper exists and is
 * itself chain-verified. The seeds of a Squads vault are Squads' fact, and the package we
 * depend on is its authority; a hand-rolled copy would be a second spelling of somebody
 * else's constant, which is the duplicated-state failure this repo pays for in §2/§5/§16.
 * The derivation is cross-checked against three real mainnet vaults in this file's header.
 */
function deriveVaultAddress(multisigAddress, index) {
    if (!loadSquads()) return null;
    try {
        const [pda] = squads.getVaultPda({
            multisigPda: new web3.PublicKey(multisigAddress),
            index: index,
        });
        return pda.toBase58();
    } catch (_) {
        return null;
    }
}

/**
 * VERIFY EVERY SIGNER'S SEEKER GENESIS TOKEN, sequentially, stopping at the first
 * refusal.
 *
 * ⛔ SEQUENTIAL AND SHORT-CIRCUITING, WHERE clan-vigil's roster read is CONCURRENT, and
 * the asymmetry is deliberate. The Vigil read needs EVERY member's number to form a sum,
 * so it must complete all of them and bounds the burst with VIGIL_READ_CONCURRENCY. This
 * needs only the FIRST failure — the refusal names one wallet and the Leader fixes one
 * thing — so finishing the rest would spend RPC budget to learn nothing the caller can
 * act on. It also means an honest 20-signer vault is the expensive case and a hostile
 * address list is the cheap one, which is the right way round.
 *
 * @returns {Promise<{ok:true, bound:Array<{wallet:string, mint:string}>}
 *                 | {ok:false, code:string, wallet:string, reason:string}>}
 */
async function verifyAllSigners(sql, signers, opts) {
    const bound = [];
    for (const wallet of signers) {
        const r = await verifyGenesisToken(sql, wallet, opts);
        if (r.ok) {
            bound.push({ wallet: wallet, mint: r.mint, memberNumber: r.memberNumber });
            continue;
        }
        // ⛔ THREE OUTCOMES, THREE CODES, AND THEY MUST NOT COLLAPSE INTO ONE 403.
        //    no_sgt        — we looked; this signer holds no Genesis Token. The Leader's
        //                    problem, fixable by changing the signer. 403.
        //    sgt_reused    — the device is already bound to another wallet. Also 403, also
        //                    the Leader's problem, but a DIFFERENT problem with a
        //                    different fix, and telling them "no token" would send them
        //                    hunting a phone that is sitting in their hand.
        //    anything else — we could NOT look (RPC down, no URL, too much junk in the
        //                    wallet, a write failure). NOT a 403: refusing a real Seeker
        //                    owner because our provider blinked is the fabricated-zero
        //                    mistake skr-staking exists to prevent, wearing a 403.
        if (r.reason === 'no_sgt') {
            return { ok: false, code: VaultCode.SIGNER_NO_SGT, wallet: wallet, reason: r.reason };
        }
        if (r.reason === 'sgt_reused') {
            return { ok: false, code: VaultCode.SIGNER_SGT_REUSED, wallet: wallet, reason: r.reason };
        }
        return {
            ok: false, code: VaultCode.SIGNER_UNVERIFIABLE, wallet: wallet,
            reason: r.reason || 'unknown',
        };
    }
    return { ok: true, bound: bound };
}

/**
 * REGISTER A CLAN'S VAULT. The caller must ALREADY be the proven Leader of `clanId` —
 * this function does not read roles, exactly as readClanVigil does not read membership;
 * the route owns that check because the route is where the caller's identity lives.
 *
 * ⛔ signer_wallets IS STORED AS AN ARRAY OF PLAIN ADDRESS STRINGS, and the permission
 *    masks are deliberately NOT stored. Two reasons, both house rules:
 *      * the column is named signer_wallets and the migration's CHECK only requires an
 *        array — an array of strings is what makes `jsonb_array_elements_text` join
 *        straight onto wallet_identity, which is how hardware_backed is derived live;
 *      * a stored mask is a COPY of on-chain state that changes without telling us
 *        (Squads' own multisigAddMember / multisigRemoveMember do exactly that). The
 *        multisig_address is stored instead, which makes the masks re-readable at any
 *        time and never stale. Same reasoning as the absent hardware_backed column.
 *
 * ⚠ ALL MEMBERS COUNT AS SIGNERS — A FIRST-PASS DEFAULT, NOT A RULING. Squads
 *   permissions are a bitmask (1 Initiate / 2 Vote / 4 Execute); the three real mainnet
 *   multisigs read for this ticket carried masks 7,2,7 / 7,2,7 / 7,6. So a member with
 *   mask 2 can vote but not execute, and one with mask 4 can execute but never approve.
 *   "Every signer holds a Seeker" is STRICTER when it means every member, so the strict
 *   reading is the one shipped. Narrowing it to vote-capable members is an owner call and
 *   is flagged in the implementation record.
 */
async function registerClanVault(sql, clanId, rawAddress, rawIndex, opts) {
    const options = opts || {};

    const addr = normalizeVaultAddress(rawAddress);
    if (!addr.ok) return { ok: false, status: 400, code: addr.code };
    const idx = normalizeVaultIndex(rawIndex);
    if (!idx.ok) return { ok: false, status: 400, code: idx.code };

    const url = options.rpcUrl || gt.sgtRpcUrl();
    if (!url) {
        return { ok: false, status: 503, code: VaultCode.UNREADABLE, detail: { reason: 'rpc_url_unset' } };
    }

    const ms = await readMultisig(url, addr.value);
    if (!ms.ok) {
        const status = ms.code === VaultCode.NOT_A_MULTISIG ? 400 : 503;
        return { ok: false, status: status, code: ms.code, detail: { reason: ms.reason } };
    }
    if (ms.members.length === 0) {
        return { ok: false, status: 400, code: VaultCode.NOT_A_MULTISIG, detail: { reason: 'no_members' } };
    }
    if (ms.members.length > MAX_VAULT_SIGNERS) {
        return {
            ok: false, status: 400, code: VaultCode.TOO_MANY_SIGNERS,
            detail: { signers: ms.members.length, cap: MAX_VAULT_SIGNERS },
        };
    }

    const vaultAddress = deriveVaultAddress(addr.value, idx.value);
    if (!vaultAddress) {
        return { ok: false, status: 503, code: VaultCode.UNREADABLE, detail: { reason: 'vault_pda_derivation_failed' } };
    }

    // ⛔ THE SGT SWEEP RUNS BEFORE THE INSERT, SO A REFUSED REGISTRATION LEAVES NO ROW.
    //    It DOES leave sgt_mint bindings for the signers it got through — which is correct
    //    and not a partial write to be undone: those bindings are facts about devices, not
    //    about this clan, and they are exactly as true whether or not the vault registers.
    const signers = await verifyAllSigners(sql, ms.members, options);
    if (!signers.ok) {
        const status = signers.code === VaultCode.SIGNER_UNVERIFIABLE ? 503 : 403;
        return {
            ok: false, status: status, code: signers.code,
            // ⭐ THE OFFENDING SIGNER IS NAMED IN FULL, and the work order says so
            // explicitly ("this specific error needs to name it so the Leader knows which
            // signer to fix"). It is an address the Leader themselves supplied via the
            // multisig they nominated — not a third party's identity being disclosed to
            // them — which is the same reasoning clan-vigil's toWire gives for rendering
            // a roster to a proven member of that roster.
            wallet: signers.wallet, detail: { reason: signers.reason },
        };
    }

    let rows;
    try {
        rows = await sql`
            INSERT INTO clan_vaults
                (clan_id, vault_address, multisig_address, vault_index, signer_wallets, threshold)
            VALUES (${clanId}, ${vaultAddress}, ${addr.value}, ${idx.value},
                    ${JSON.stringify(ms.members)}::jsonb, ${ms.threshold})
            RETURNING clan_id, vault_address, multisig_address, vault_index,
                      signer_wallets, threshold, verified_at
        `;
    } catch (err) {
        // 23505 covers all three uniqueness rules at once — clan_id (one vault per clan),
        // vault_address, and multisig_address — and the honest answer to every one of them
        // is the same: something is already registered. Which one is in the db, under the
        // ref, not in the player's face.
        if (err && (err.code === '23505' || /duplicate key|unique constraint/i.test(String(err.message || '')))) {
            return { ok: false, status: 409, code: VaultCode.ALREADY_REGISTERED, detail: { unique: true } };
        }
        throw err;   // a real database fault: the route answers SERVER_ERROR
    }

    const row = rows && rows[0] ? rows[0] : null;
    return {
        ok: true,
        vault: {
            clanId: clanId,
            vaultAddress: vaultAddress,
            multisigAddress: addr.value,
            vaultIndex: idx.value,
            threshold: ms.threshold,
            signerWallets: ms.members,
            signerPermissionMasks: ms.memberMasks,
            timeLock: ms.timeLock,
            // ⚠ SURFACED ON PURPOSE, AND IT IS A REAL CAVEAT ON "COLLECTIVE". A Squads
            // multisig whose configAuthority is NOT the system program is CONTROLLED: that
            // one authority can add or remove members without the members' consent, so the
            // signer set this row pins could be changed by a single key afterwards. All
            // three mainnet multisigs read for this ticket were UNcontrolled
            // (11111111111111111111111111111111). Registration does NOT refuse a controlled
            // vault — that is a design ruling, not an engineering one — but it reports the
            // fact so the decision can be made with it in view. Flagged for the owner.
            configAuthority: ms.configAuthority,
            verifiedAt: row ? row.verified_at : null,
        },
        signers: signers.bound,
    };
}

/**
 * THE VAULT ROW, ITS TENURE AND ITS HARDWARE STATUS — in ONE query.
 *
 * ⛔ TENURE IS MEASURED BY POSTGRES, NEVER BY NODE, for precisely the reason
 * clan-vigil.js's header gives: the column is written with NOW() and must be compared
 * against the same clock that wrote it. A serverless function's Date.now() against a
 * Postgres timestamp is how a duration comes back negative in one region.
 *
 * ⛔ AND hardware_backed IS COUNTED IN SQL, NOT CACHED IN A COLUMN. The two counts below
 * come from the SAME jsonb array in the SAME statement, so they cannot disagree, and a
 * binding cleared a second ago is reflected on the next read. A boolean column would be
 * the stale copy §15 exists to stop.
 *
 * Returns null when the clan has no vault — which is the ORDINARY case and never an error.
 */
async function readClanVaultRow(sql, clanId) {
    const rows = await sql`
        SELECT v.clan_id, v.vault_address, v.multisig_address, v.vault_index,
               v.signer_wallets, v.threshold, v.verified_at, v.first_seen_staked_at,
               COALESCE(
                   GREATEST(EXTRACT(EPOCH FROM (NOW() - v.first_seen_staked_at)), 0),
                   0
               )::float8 AS tenure_seconds,
               (SELECT COUNT(*) FROM jsonb_array_elements_text(v.signer_wallets) AS s(w))::int
                   AS signer_count,
               (SELECT COUNT(*) FROM jsonb_array_elements_text(v.signer_wallets) AS s(w)
                  JOIN wallet_identity wi ON wi.wallet = s.w
                 WHERE wi.sgt_verified_at IS NOT NULL)::int AS verified_signer_count
        FROM clan_vaults v
        WHERE v.clan_id = ${clanId}
        LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    return shapeVaultRow(rows[0]);
}

/** Row -> the shape the rest of this module and the wire both read. Pure. */
function shapeVaultRow(r) {
    const signers = Array.isArray(r.signer_wallets)
        ? r.signer_wallets.map((s) => String(s))
        : parseSignerJson(r.signer_wallets);
    const signerCount = r.signer_count != null ? Number(r.signer_count) : signers.length;
    const verifiedCount = r.verified_signer_count != null ? Number(r.verified_signer_count) : 0;
    return {
        clanId: r.clan_id != null ? String(r.clan_id) : null,
        vaultAddress: String(r.vault_address),
        multisigAddress: r.multisig_address != null ? String(r.multisig_address) : null,
        vaultIndex: r.vault_index != null ? Number(r.vault_index) : 0,
        signerWallets: signers,
        threshold: Number(r.threshold),
        verifiedAt: r.verified_at != null ? r.verified_at : null,
        firstSeenStakedAt: r.first_seen_staked_at != null ? r.first_seen_staked_at : null,
        tenureSeconds: Number(r.tenure_seconds) || 0,
        signerCount: signerCount,
        verifiedSignerCount: verifiedCount,
        // ⛔ AN EMPTY SIGNER LIST IS NOT "ALL VERIFIED". `0 === 0` is true and would hand
        // hardware-backed status to a vault with no signers at all — the vacuous-truth bug.
        // Registration cannot create such a row (no_members is refused), so this guard is
        // for a hand-edited row, not for today's write path.
        hardwareBacked: signerCount > 0 && verifiedCount === signerCount,
    };
}

/** JSONB may arrive already-parsed or as text, depending on the driver. Accept both. */
function parseSignerJson(raw) {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw.map((s) => String(s));
    try {
        const v = JSON.parse(String(raw));
        return Array.isArray(v) ? v.map((s) => String(s)) : [];
    } catch (_) {
        return [];
    }
}

/**
 * Begin the VAULT's Vigil. Idempotent by its WHERE clause, clocked by Postgres, and it
 * NEVER THROWS — the same three properties stampMemberVigil has, for the same reasons.
 */
async function stampVaultVigil(sql, clanId) {
    try {
        const rows = await sql`
            UPDATE clan_vaults
            SET first_seen_staked_at = NOW()
            WHERE clan_id = ${clanId} AND first_seen_staked_at IS NULL
            RETURNING first_seen_staked_at
        `;
        if (rows && rows.length > 0) {
            return { stamped: true, firstSeenStakedAt: rows[0].first_seen_staked_at };
        }
        return { stamped: false, firstSeenStakedAt: null };
    } catch (err) {
        console.warn('[clan-vaults] vault Vigil stamp failed — continuing (fail-open):', err.message);
        return { stamped: false, firstSeenStakedAt: null };
    }
}

/**
 * THE COLLECTIVE VIGIL for one clan, or null when it has no vault. NEVER THROWS.
 *
 * ⛔ IT IS THE VAULT'S OWN STAKE, READ BY THE SAME CODE THAT READS A MEMBER'S. The vault
 * is an ordinary Solana address as far as skr-staking is concerned — a UserStake PDA is
 * derived from it exactly as from a wallet, and its SKR balance is summed over its token
 * accounts exactly as a wallet's is. No second stake reader, no second denominator, no
 * second cache. Whatever WO-1852 proved about the per-member number is therefore true of
 * this one too.
 *
 * ⚠ AND WHAT THAT MEANS TODAY, SAID PLAINLY RATHER THAN IMPLIED: a Squads vault PDA with
 *   no UserStake account reads NO_STAKE — a REAL zero, `degraded: false`, percent 0. That
 *   is the honest answer for a vault that has not staked, and it is the answer every
 *   existing mainnet vault gives, because whether the SKR staking program will accept a
 *   PDA as its `user` (an invoke_signed CPI from Squads) is NOT something this ticket
 *   proved. The read path is correct either way; the day a vault does stake, the number
 *   appears with no code change. Recorded in the implementation record as unproven.
 *
 * ⛔ A FAILED CHAIN READ IS A FLAG, NEVER AN EXCEPTION AND NEVER A ZERO PASSED OFF AS
 *    REAL. `degraded: true` with weight 0, matching readClanVigil's ruling line for line:
 *    inventing a number we cannot see would advantage whoever happened to be unreadable.
 */
async function readCollectiveVigil(sql, clanId, opts) {
    const options = opts || {};

    let row;
    try {
        row = await readClanVaultRow(sql, clanId);
    } catch (err) {
        // A missing clan_vaults table (migration 0036 not applied) lands here, and it must
        // degrade rather than take the Vigil endpoint down with it — the deploy-order
        // failure touchClanRate's fail-open note describes. No vault, flagged.
        console.warn('[clan-vaults] vault row unavailable — continuing without a collective Vigil:', err.message);
        return { vault: null, degraded: true, reason: 'vault_row_unavailable' };
    }
    if (!row) return { vault: null, degraded: false, reason: null };

    let read;
    try {
        read = await skr.getStakedPercentage(row.vaultAddress, {
            rpcUrl: options.rpcUrl,
            nowSeconds: options.nowSeconds,
            noCache: options.noCache === true,
        });
    } catch (err) {
        read = null;
    }

    const degraded = !read || read.degraded === true;
    const percent = degraded ? 0 : Number(read.percent) || 0;

    let tenureSeconds = row.tenureSeconds;
    let firstSeenStakedAt = row.firstSeenStakedAt;
    let stampedNow = false;

    // The vault's tenure BEGINS on the first observation that it is staking anything — the
    // same "first observation, not chain history" ruling WO-1852 records, and the reason
    // verified_at is not used: a clan should not bank tenure for the gap between
    // registering an empty vault and funding it.
    if (!degraded && percent > 0 && firstSeenStakedAt == null && options.stamp !== false) {
        const stamp = await stampVaultVigil(sql, clanId);
        stampedNow = stamp.stamped;
        if (stampedNow) {
            firstSeenStakedAt = stamp.firstSeenStakedAt;
            tenureSeconds = 0;   // it begins NOW — see stampMemberVigil's identical note
        }
    }

    return {
        vault: Object.assign({}, row, {
            firstSeenStakedAt: firstSeenStakedAt,
            tenureSeconds: tenureSeconds,
            percentStaked: percent,
            collectiveVigilWeight: percent * tenureSeconds,
            vigilBegan: stampedNow,
            degraded: degraded,
        }),
        degraded: degraded,
        reason: degraded ? (read && read.errorCode ? read.errorCode : 'stake_unreadable') : null,
    };
}

module.exports = {
    VaultCode,
    MAX_VAULT_SIGNERS,
    MAX_VAULT_INDEX,
    // pure
    normalizeVaultAddress,
    normalizeVaultIndex,
    shapeVaultRow,
    parseSignerJson,
    // chain / db
    loadSquads,
    readMultisig,
    deriveVaultAddress,
    verifyAllSigners,
    registerClanVault,
    readClanVaultRow,
    stampVaultVigil,
    readCollectiveVigil,
};
