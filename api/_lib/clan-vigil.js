// =============================================================================
// api/_lib/clan-vigil.js — WO-1852 (clan WO-9). The clan Vigil read.
// -----------------------------------------------------------------------------
// THE VIGIL is percentage-of-SKR-staked x game-tracked tenure, per member, summed
// across a clan. Source: docs/SKR Integtration.md ("WO-9") and
// docs/SKR_ALANIA_ROOT_NETWORK_EXPLORATION_2026-09-17.md.
//
//   vigil_contribution = percent_staked x tenure_seconds       (per member)
//   vigil_weight       = sum(vigil_contribution)               (per clan)
//
// ⛔ WHY THIS IS ITS OWN FILE AND NOT AN ADDITION TO api/_lib/clan.js. clan.js is
// the file WO-1850 / WO-1851 / WO-1858 all landed in on 2026-09-17 (commit
// 2c22f341d, whose own body records reconciling three lanes that shared it). The
// brief for this ticket is explicitly not to touch WO-1851's files again, and a
// file three concurrent lanes just fought over is the definition of NOT
// file-disjoint (CLAUDE.md §9). Nothing here is imported BY clan.js, so there is
// no cycle and no coupling in the other direction either.
//
// ⛔ TENURE IS MEASURED BY POSTGRES, NEVER BY NODE. `EXTRACT(EPOCH FROM (NOW() -
// first_seen_staked_at))` is computed in the same transaction as the read, against
// the same clock that WROTE the column (wallet-auth.stampFirstSeenStaked uses
// NOW()). A serverless function's Date.now() compared against a Postgres timestamp
// is how a duration comes back negative in one region and minutes off in another —
// the work order names this ("Use Postgres time, not Node time") and touchClanRate's
// retryAfterSeconds already follows the same rule.
//
// ⛔ AND THERE IS NO CHAIN HISTORY HERE, BY RULING. Tenure counts from the FIRST
// OBSERVATION we made, not from when the player actually began staking — the work
// order's non-scope says so outright ("No chain history indexing"). A wallet that
// staked a year before this feature existed starts its Vigil the day we first see
// it. That is an owner ruling, not a gap to be closed by a well-meaning later seat.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore). CommonJS.
// =============================================================================

'use strict';

const skr = require('./skr-staking');
// ⛔ WO-1854, AND IT IS PURELY ADDITIVE — the work order's non-scope says so outright
// ("does NOT replace WO-1852 — that stays the single-wallet path"). Nothing above this
// line changed behaviour: a clan with no registered vault produces exactly the response
// it produced before, with `vault: null` alongside it. clan-vaults.js requires
// ./wallet-auth and ./genesis-token and NOTHING from this file, so there is no cycle, and
// it does NOT load the Squads SDK on this path (see its loadSquads note — 300 ms of
// module init is not a cost a clan's Vigil read may pay).
const vaults = require('./clan-vaults');

/**
 * How many member stake reads run at once.
 *
 * ⚠ THERE IS NO MEMBER CAP IN THE SCHEMA. Grepped at source 2026-09-17: no
 * `max_member` / `member_cap` anywhere under api/, and migration 0030's
 * clan_members carries only the one-clan-per-wallet UNIQUE index. So clan size is
 * unbounded today, and an unbounded fan-out would hand a 200-member clan's worth of
 * simultaneous RPC calls to a provider that rate-limits (the public mainnet endpoint
 * answered 429 to a single getTokenLargestAccounts while this ticket was being
 * built — measured, not feared). Bounded concurrency turns a burst into a queue.
 */
const VIGIL_READ_CONCURRENCY = 5;

/**
 * Every member of one clan, with the tenure Postgres computes.
 *
 * ⛔ LEFT JOIN, NOT JOIN. A member whose wallet_identity row is missing (the table is
 * written fail-open, so it CAN be absent — see touchWalletIdentity) must still appear
 * in the roster with a zero tenure. An inner join would silently drop them from their
 * own clan's Vigil and the sum would simply be quietly wrong.
 *
 * ⛔ SCOPED BY clan_id, WHICH IS THE PRIVACY PROPERTY. The caller's own clan id comes
 * from their proven membership, never from the request, so this can never be asked
 * about a clan the caller does not belong to — the same rule readMemberInClan's
 * header states for the same reason.
 *
 * @param {Function} sql      neon(...) tagged-template client
 * @param {string}   clanId   the CALLER'S OWN clan id, from their membership row
 */
async function readClanVigilRoster(sql, clanId) {
    const rows = await sql`
        SELECT m.wallet,
               m.role,
               wi.first_seen_staked_at,
               COALESCE(
                   GREATEST(EXTRACT(EPOCH FROM (NOW() - wi.first_seen_staked_at)), 0),
                   0
               )::float8 AS tenure_seconds
        FROM clan_members m
        LEFT JOIN wallet_identity wi ON wi.wallet = m.wallet
        WHERE m.clan_id = ${clanId}
        ORDER BY m.joined_at ASC, m.wallet ASC
    `;
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
        wallet: String(r.wallet),
        role: r.role,
        firstSeenStakedAt: r.first_seen_staked_at != null ? r.first_seen_staked_at : null,
        tenureSeconds: Number(r.tenure_seconds) || 0,
    }));
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Order of results
 * matches order of input. Never throws — a worker that rejects yields its error as
 * a value, because one unreadable member must not lose the whole roster.
 */
async function mapWithConcurrency(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            try {
                out[i] = await worker(items[i], i);
            } catch (err) {
                out[i] = { __threw: err };
            }
        }
    });
    await Promise.all(runners);
    return out;
}

/**
 * THE VIGIL, for one clan.
 *
 * ⛔ AN RPC FAILURE IS A 200 WITH A FLAG, NEVER A 500 — the work order's acceptance
 * criterion 4. The flag is carried PER MEMBER (`degraded: true` on that member, whose
 * `percent_staked` reads 0) and ALSO summarised once at the top level, and the choice
 * is deliberate: a sum is a clan-level fact and cannot say WHICH member it could not
 * read, so per-member is where the truth has to live; the top-level boolean exists
 * only so a client can ask "is any of this untrustworthy" without walking the array.
 * The work order asks for one shape to be picked and flagged — this is both, with the
 * per-member flag as the authority and the top-level one derived from it.
 *
 * ⛔ A DEGRADED MEMBER CONTRIBUTES ZERO, AND THAT UNDER-STATES THE WEIGHT ON PURPOSE.
 * The alternative — carrying a last-known percentage forward — is Heartbound's
 * grace-window ruling, which exists because losing a STREAK to an outage is unfair.
 * A Vigil weight is a live comparison between clans, so inventing a number we cannot
 * currently see would advantage whoever happened to be unreadable. Zero and a flag is
 * the honest answer; the number recovers by itself on the next successful read.
 *
 * ⛔ AND IT STAMPS. A member observed staked whose `first_seen_staked_at` is still NULL
 * has their Vigil begun here, so the feature works even with VIGIL_STAMP_ON_AUTH off.
 * Such a member reports `tenure_seconds: 0` for THIS response and is not re-read — the
 * tenure genuinely is zero at the instant it begins, and a second round trip to learn
 * that would be a round trip to learn nothing.
 *
 * @param {Function} sql                 neon(...) client
 * @param {string}   clanId              the caller's own clan id
 * @param {{rpcUrl?:string, nowSeconds?:number, noCache?:boolean,
 *          concurrency?:number, stamp?:boolean}} [opts]  test seams / switches
 */
async function readClanVigil(sql, clanId, opts) {
    const options = opts || {};
    const roster = await readClanVigilRoster(sql, clanId);
    if (roster.length === 0) {
        // ⛔ AN EMPTY ROSTER STILL READS THE VAULT. A clan whose last member left could
        // still have a registered vault row (clan_vaults cascades on the CLAN, not on
        // membership), and returning early without looking would report `hardware_backed:
        // false` for a vault that is perfectly intact — a wrong answer dressed as a cheap
        // one. Costs one query in the case nobody hits.
        const empty = await readCollective(sql, clanId, options);
        return Object.assign(
            { members: [], vigilWeight: 0, degraded: false, memberCount: 0 }, empty);
    }

    const limit = Number.isFinite(options.concurrency) && options.concurrency > 0
        ? Math.floor(options.concurrency)
        : VIGIL_READ_CONCURRENCY;

    const reads = await mapWithConcurrency(roster, limit, async (member) => {
        // getStakedPercentage never throws and never returns null; the guard is for a
        // future edit to it, not for today's behaviour.
        const r = await skr.getStakedPercentage(member.wallet, {
            rpcUrl: options.rpcUrl,
            nowSeconds: options.nowSeconds,
            noCache: options.noCache === true,
        });
        return r || { degraded: true, percent: 0 };
    });

    const members = [];
    let weight = 0;
    let anyDegraded = false;

    for (let i = 0; i < roster.length; i++) {
        const member = roster[i];
        const read = reads[i];
        // mapWithConcurrency turns a throw into a value rather than losing the roster.
        const threw = !!(read && read.__threw);
        const degraded = threw || !read || read.degraded === true;
        const percent = degraded ? 0 : Number(read.percent) || 0;

        let tenureSeconds = member.tenureSeconds;
        let firstSeenStakedAt = member.firstSeenStakedAt;
        let stampedNow = false;

        if (!degraded && percent > 0 && firstSeenStakedAt == null && options.stamp !== false) {
            const stamp = await stampMemberVigil(sql, member.wallet);
            stampedNow = stamp.stamped;
            if (stampedNow) {
                firstSeenStakedAt = stamp.firstSeenStakedAt;
                tenureSeconds = 0;   // it begins NOW; see this function's header
            }
        }

        const contribution = percent * tenureSeconds;
        weight += contribution;
        if (degraded) anyDegraded = true;

        members.push({
            wallet: member.wallet,
            role: member.role,
            percentStaked: percent,
            tenureSeconds: tenureSeconds,
            vigilContribution: contribution,
            firstSeenStakedAt: firstSeenStakedAt,
            vigilBegan: stampedNow,
            degraded: degraded,
        });
    }

    const collective = await readCollective(sql, clanId, options);

    return Object.assign({
        members: members,
        vigilWeight: weight,
        degraded: anyDegraded,
        memberCount: roster.length,
    }, collective);
}

/**
 * WO-1854. The clan's COLLECTIVE Vigil, bolted on beside the per-member one.
 *
 * ⛔ IT CAN NEVER FAIL THE READ IT IS ATTACHED TO. This function has no throwing path:
 * readCollectiveVigil is written not to throw, and the try/catch is here anyway because
 * "an RPC failure is a 200 with a flag" (this file's own ruling, and /api/clan/vigil's
 * acceptance criterion 4) has to keep holding after a feature was added underneath it. A
 * clan with no vault, a clan_vaults table that has not been migrated yet, and a chain we
 * cannot read are three DIFFERENT states and all three are a 200.
 *
 * ⛔ THE TWO WEIGHTS ARE NEVER ADDED TOGETHER, AND MUST NOT BE. `vigilWeight` is the sum
 * of what the MEMBERS hold individually; `collectiveVigilWeight` is what the VAULT holds
 * jointly. Summing them would double-count nothing today (they are disjoint positions) but
 * would silently start double-counting the moment a member stakes through the vault they
 * also signed for — and it would collapse the one distinction the whole feature is about:
 * "several individual stakes added up" versus "a genuinely collectively-owned thing"
 * (docs/SKR_ALANIA_ROOT_NETWORK_EXPLORATION_2026-09-17.md's own framing of the mechanic).
 * Two numbers, reported separately, forever.
 */
async function readCollective(sql, clanId, options) {
    let r;
    try {
        r = await vaults.readCollectiveVigil(sql, clanId, options);
    } catch (err) {
        console.warn('[clan-vigil] collective Vigil unavailable — continuing (fail-open):', err.message);
        return { vault: null, collectiveVigilWeight: 0, hardwareBacked: false, collectiveDegraded: true };
    }
    if (!r || !r.vault) {
        return {
            vault: null,
            collectiveVigilWeight: 0,
            // ⛔ NO VAULT IS NOT HARDWARE-BACKED. There is nothing to be backed BY, and a
            // truthy default here would hand the status to every clan in the game.
            hardwareBacked: false,
            collectiveDegraded: !!(r && r.degraded),
        };
    }
    return {
        vault: r.vault,
        collectiveVigilWeight: r.vault.collectiveVigilWeight,
        hardwareBacked: r.vault.hardwareBacked === true,
        collectiveDegraded: r.degraded === true,
    };
}

/**
 * Begin ONE member's Vigil. Idempotent by its WHERE clause and clocked by Postgres,
 * for the same reasons wallet-auth.stampFirstSeenStaked is — see that function.
 *
 * NEVER THROWS. A failed stamp means the member's tenure starts on a later read; it
 * must never turn a clan's Vigil read into a 500.
 */
async function stampMemberVigil(sql, wallet) {
    try {
        const rows = await sql`
            UPDATE wallet_identity
            SET first_seen_staked_at = NOW()
            WHERE wallet = ${wallet} AND first_seen_staked_at IS NULL
            RETURNING first_seen_staked_at
        `;
        if (rows && rows.length > 0) {
            return { stamped: true, firstSeenStakedAt: rows[0].first_seen_staked_at };
        }
        return { stamped: false, firstSeenStakedAt: null };
    } catch (err) {
        console.warn('[clan-vigil] first_seen_staked_at stamp failed — continuing (fail-open):', err.message);
        return { stamped: false, firstSeenStakedAt: null };
    }
}

/**
 * The wire shape. snake_case field names because the work order names them that way
 * (`{wallet, percent_staked, tenure_seconds, vigil_contribution}` / `vigil_weight`)
 * and a client branching on those strings should get exactly them.
 *
 * ⛔ THE WALLET IS RENDERED HERE AND THAT IS THE ONE PLACE IT MAY BE. This endpoint is
 * CLAN-INTERNAL: the caller has proven they are a member of this clan, and a roster is
 * the thing they are entitled to see. It is NOT the leaderboard, which renders no
 * wallet at any depth (api/_lib/clan.js's getLeaderboard header) because that surface
 * is public-shaped. Never widen this response to a non-member or an unauthenticated
 * caller, and never let a wallet reach an ERROR body — the route answers refusals with
 * quietFail's code+ref and nothing else.
 */
/**
 * WO-1854 ADDS ONLY TOP-LEVEL FIELDS, AND THE PER-MEMBER OBJECT IS UNTOUCHED ON PURPOSE.
 *
 * ⛔ test/clan-vigil.test.js asserts the member object's key set with a `deepEqual` over
 * `Object.keys(...).sort()`. Adding a field there would break WO-1852's own test — which is
 * the correct signal, because a SIGNER is not a MEMBER: the two sets overlap by accident at
 * best (a vault signer need not be in the clan, and a member need not be a signer), so
 * hanging vault status off a roster row would state a relationship that does not exist.
 *
 * ⚠ BOTH SPELLINGS OF THE TWO NEW FIELDS ARE EMITTED, and that is not indecision. This
 *   endpoint's established convention is snake_case (WO-1852 chose it because that work
 *   order named its fields that way, and a client branches on those exact strings). WO-1854
 *   names ITS fields in camelCase, and its acceptance criterion is written as a literal —
 *   "returns `hardwareBacked: true`". Emitting one and not the other makes a stated
 *   acceptance criterion false or breaks the file's convention. So both exist, with the
 *   snake_case pair as the convention-carrying names and the camelCase pair as the work
 *   order's — exactly the precedent skr-staking set with `totalRaw` / `balanceRaw`
 *   ("the spec's field name exists and means what its test plan implies"). ⛔ They are
 *   assigned from ONE source expression each, so they cannot drift apart.
 */
function toWire(vigil) {
    const hardwareBacked = vigil.hardwareBacked === true;
    const collectiveWeight = Number(vigil.collectiveVigilWeight) || 0;
    return {
        ok: true,
        vigil_weight: vigil.vigilWeight,
        member_count: vigil.memberCount,
        degraded: vigil.degraded,
        // ── WO-1854, additive ────────────────────────────────────────────────
        collective_vigil_weight: collectiveWeight,
        collectiveVigilWeight: collectiveWeight,
        hardware_backed: hardwareBacked,
        hardwareBacked: hardwareBacked,
        collective_degraded: vigil.collectiveDegraded === true,
        vault: vaultToWire(vigil.vault),
        members: vigil.members.map((m) => ({
            wallet: m.wallet,
            role: m.role,
            percent_staked: m.percentStaked,
            tenure_seconds: m.tenureSeconds,
            vigil_contribution: m.vigilContribution,
            degraded: m.degraded,
        })),
    };
}

/**
 * WO-1854. The vault's wire shape, or null.
 *
 * ⛔ THE SIGNER LIST IS RENDERED, AND THIS IS THE ONE SURFACE WHERE THAT IS ALLOWED, for
 * exactly the reason toWire's own note gives for the roster: the caller has PROVEN
 * membership of this clan, and its vault's signer set is clan-internal information they are
 * entitled to. It is NOT the leaderboard, which renders no wallet at any depth.
 *
 * ⛔ AND THE VERIFIED COUNT IS RENDERED WITHOUT THE MINTS. `verified_signer_count` says how
 * many signers hold a Genesis Token; `sgt_mint` is never emitted anywhere. A mint is a
 * DEVICE identifier — one per physical phone — and publishing it, even to a clanmate, hands
 * out a stable cross-wallet fingerprint for a person. Nothing in this feature needs it
 * outside the database.
 */
function vaultToWire(vault) {
    if (!vault) return null;
    return {
        vault_address: vault.vaultAddress,
        multisig_address: vault.multisigAddress,
        vault_index: vault.vaultIndex,
        threshold: vault.threshold,
        signer_count: vault.signerCount,
        verified_signer_count: vault.verifiedSignerCount,
        signer_wallets: vault.signerWallets,
        percent_staked: vault.percentStaked != null ? vault.percentStaked : 0,
        tenure_seconds: vault.tenureSeconds != null ? vault.tenureSeconds : 0,
        collective_vigil_weight: vault.collectiveVigilWeight != null ? vault.collectiveVigilWeight : 0,
        hardware_backed: vault.hardwareBacked === true,
        degraded: vault.degraded === true,
        verified_at: vault.verifiedAt,
    };
}

module.exports = {
    VIGIL_READ_CONCURRENCY,
    readCollective,        // ← WO-1854
    vaultToWire,           // ← WO-1854
    readClanVigilRoster,
    readClanVigil,
    stampMemberVigil,
    mapWithConcurrency,
    toWire,
};
