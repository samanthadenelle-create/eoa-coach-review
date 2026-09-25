// =============================================================================
// api/_lib/realm-stake.js - WO-2061h. How much SKR the Orders hold, and what that
// makes the Heart tree look like.
// -----------------------------------------------------------------------------
// Owner rulings 2026-09-25, verbatim:
//   "If total orders have over 200k staked should persist to all players showing it's living"
//   "The total should be tunable from the command center"
//   "The higher the stake the more alive it displays" / "For all the circle"
//
// TWO LAYERS, ONE MODULE:
//   REALM  - the SUM of verified stake across EVERY Order's members. Above the owner's
//            threshold every player's tree (Order or not) shows the living canopy.
//            Served to EVERY client on GET /api/client-tunables (the one route read before
//            sign-in and polled every 30 s) as a `realm` block.
//   CIRCLE - one Order's members' verified stake. With a resolved vote (an active banner)
//            it sets how FULL that Order's canopy is. Served to members on
//            GET /api/clan/ballot/current (the hub-load read) as circle_staked_skr +
//            canopy_density01.
//
// ⛔ PERSISTED STATE, NEVER RPC. Both sums read skr_stake_snapshots.active_staked_raw - the
// per-wallet stake api/heartbound/status.js persist() (:215-268) writes after a mainnet read -
// joined to clan_members on the wallet (skr_stake_snapshots.player_id IS the wallet, migration
// 20260910_0024_skr_stake_snapshots.sql:59-62). One aggregate per request, behind
// client-tunables' 10 s edge cache; no chain read, no per-request fan-out, no new table.
// The join is 1:1: the snapshot PK is player_id and clan_members carries the unique index
// clan_members_one_clan_per_wallet (schema.sql:2351) - do NOT add a DISTINCT.
//
// ⚠ WO-2061o (2026-09-25, SKR flow audit blocker 1): until this date both sums read
//   heartbound_state.last_actual_stake. That table had 0 rows on prod and its only writers
//   (heartbound-state.js activateHeartbound :277, recordVerifiedStake :361) have no caller
//   under api/, so realm living was always false and the Circle canopy pinned at its floor.
//   Do not point this back at heartbound_state until something live writes it.
//
// ⚠ WHAT COUNTS, STATED - the WRITER'S semantics, not new ones:
//   - verification_status = 'VERIFIED'. persist() stores only VERIFIED / NO_STAKE on a
//     successful chain read (status.js:437-438); a FAILED read touches only error_code +
//     last_attempt_at (:255-267) and leaves the status and the amounts where they were.
//     'STALE' is a SERVED status (skr-staking.js resolveServedState), never persisted.
//   - active_staked_raw IS NOT NULL (NULL = never verified, migration :30-43).
//   - verified_at inside the writer's own grace window: skr.staleGraceSeconds()
//     (skr-staking.js:160-186, env HEARTBOUND_STALE_GRACE_SECONDS) - the same bound
//     resolveServedState applies (`age > grace` = expired), measured from the last SUCCESS
//     (verified_at, never last_attempt_at). No second staleness number is minted here.
//   CONSEQUENCE, stated for whoever sets the threshold: a member counts only while a Seeker
//   build has verified their wallet inside that window (HeartboundStatusClient refreshes every
//   300 s while signed in), so the totals move with who has opened the app recently.
//   Staked wallets that are in NO Order are not counted ("total orders").
//
// ⛔ NEVER A GUESSED TRUE. Any read failure answers living:false with a NAMED reason.
// ⛔ THE THRESHOLD IS THE SERVER'S. The client is told `living`; it never compares numbers.
//
// CommonJS. Files under api/_lib/ are not routed by Vercel.
// =============================================================================

'use strict';

const config = require('./realm-config.json');
const resonanceConfig = require('./heartbound-resonance-config.json');
const { readTunables } = require('./tunables');
const skr = require('./skr-staking');

/** The Command Center knob (serverOnly tunable) holding the realm threshold, in whole SKR. */
const THRESHOLD_KEY = 'realm.livingStakeThresholdSkr';

/** Shipping default when the knob row is absent or unreadable. The ONE home: realm-config.json. */
const DEFAULT_THRESHOLD_SKR = config.livingStakeThresholdSkr;

/** SKR base units per whole SKR, by reference to the resonance table (6 decimals, mainnet). */
const SKR_BASE_UNITS = BigInt(resonanceConfig.chain.skrBaseUnits);

/** skr_stake_snapshots.verification_status values whose active_staked_raw counts (see the
 * header). The SQL spells the same literal; test/realm-stake.test.js pins them together. */
const COUNTED_STATUSES = ['VERIFIED'];

/**
 * The oldest verified_at that still counts, as an ISO string for a bound parameter. The window
 * is the writer's grace (skr.staleGraceSeconds()); `opts` exists for tests only.
 */
function freshnessCutoff(opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const grace = Number.isFinite(o.graceSeconds) ? o.graceSeconds : skr.staleGraceSeconds();
    return { cutoffIso: new Date(nowMs - grace * 1000).toISOString(), graceSeconds: grace };
}

/** Raw base units (a NUMERIC(39,0) as text) -> whole SKR as a Number. Never throws. */
function rawToSkr(rawText) {
    try {
        if (rawText == null || rawText === '') return 0;
        const raw = BigInt(String(rawText).split('.')[0]);
        const whole = raw / SKR_BASE_UNITS;
        const frac = Number(raw % SKR_BASE_UNITS) / Number(SKR_BASE_UNITS);
        return Number(whole) + frac;
    } catch (_) {
        return NaN;
    }
}

/**
 * The live threshold: the Command Center row when it holds a positive integer, else the
 * default. `source` is 'tunable' | 'default' and `why` names the default's reason.
 * @param {{ok:boolean, values:object, reason?:string}} tunables readTunables() result
 */
function resolveThreshold(tunables) {
    if (!tunables || tunables.ok !== true) {
        return { thresholdSkr: DEFAULT_THRESHOLD_SKR, source: 'default',
                 why: 'tunables unreadable (' + ((tunables && tunables.reason) || 'no read') + ')' };
    }
    const raw = tunables.values ? tunables.values[THRESHOLD_KEY] : undefined;
    if (raw == null || raw === '') {
        return { thresholdSkr: DEFAULT_THRESHOLD_SKR, source: 'default', why: 'no Command Center row' };
    }
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) {
        return { thresholdSkr: DEFAULT_THRESHOLD_SKR, source: 'default',
                 why: 'Command Center row "' + raw + '" is not a positive integer' };
    }
    return { thresholdSkr: n, source: 'tunable', why: 'Command Center row' };
}

/** living is TRUE only for a total STRICTLY above the threshold ("over 200k"). */
function isLiving(totalSkr, thresholdSkr) {
    return Number.isFinite(totalSkr) && Number.isFinite(thresholdSkr) && totalSkr > thresholdSkr;
}

/**
 * SUM of counted stake across every Order's members (clanId omitted) or one Order's members.
 * Resolves { ok, totalSkr, members, reason, cutoffIso }. NEVER throws.
 * @param {object} [opts] tests only: { nowMs, graceSeconds }
 */
async function readStakeSum(sql, clanId, opts) {
    if (!sql) return { ok: false, totalSkr: 0, members: 0, reason: 'NO_SQL_HANDLE' };
    const { cutoffIso } = freshnessCutoff(opts);
    let rows;
    try {
        rows = clanId
            ? await sql`
                SELECT COALESCE(SUM(ss.active_staked_raw), 0)::text AS total_raw,
                       COUNT(ss.player_id)::int                     AS stakers
                  FROM clan_members cm
                  JOIN skr_stake_snapshots ss ON ss.player_id = cm.wallet
                 WHERE cm.clan_id = ${clanId}
                   AND ss.verification_status = 'VERIFIED'
                   AND ss.active_staked_raw IS NOT NULL
                   AND ss.verified_at >= ${cutoffIso}::timestamptz`
            : await sql`
                SELECT COALESCE(SUM(ss.active_staked_raw), 0)::text AS total_raw,
                       COUNT(ss.player_id)::int                     AS stakers
                  FROM clan_members cm
                  JOIN skr_stake_snapshots ss ON ss.player_id = cm.wallet
                 WHERE ss.verification_status = 'VERIFIED'
                   AND ss.active_staked_raw IS NOT NULL
                   AND ss.verified_at >= ${cutoffIso}::timestamptz`;
    } catch (err) {
        return { ok: false, totalSkr: 0, members: 0,
                 reason: 'STAKE_READ_FAILED: ' + ((err && err.message) || String(err)) };
    }
    const row = rows && rows[0];
    if (!row || row.total_raw == null) {
        return { ok: false, totalSkr: 0, members: 0, reason: 'STAKE_READ_EMPTY' };
    }
    const total = rawToSkr(row.total_raw);
    if (!Number.isFinite(total)) {
        return { ok: false, totalSkr: 0, members: 0, reason: 'STAKE_UNPARSEABLE: ' + row.total_raw };
    }
    return { ok: true, totalSkr: total, members: Number(row.stakers) || 0, reason: 'ok',
             cutoffIso: cutoffIso };
}

/**
 * The REALM block for /api/client-tunables. `tunables` is the readTunables() result that
 * route already holds (so the knob table is not read twice). NEVER throws.
 * @returns {Promise<{living:boolean, staked_total_skr:number|null, threshold_skr:number,
 *                     threshold_source:string, canopy_density01:number, reason:string}>}
 */
async function readRealm(sql, tunables, opts) {
    const t = resolveThreshold(tunables);
    const sum = await readStakeSum(sql, null, opts);
    const living = sum.ok && isLiving(sum.totalSkr, t.thresholdSkr);
    const reason = !sum.ok ? sum.reason
        : (living ? 'total above threshold' : 'total at or below threshold');
    const block = {
        living: living,
        staked_total_skr: sum.ok ? Math.floor(sum.totalSkr) : null,
        threshold_skr: t.thresholdSkr,
        threshold_source: t.source,
        canopy_density01: living ? config.realmLivingCanopy01 : 0,
        reason: reason,
    };
    try {
        console.log('[realm] living=' + block.living + ' total=' + block.staked_total_skr +
                    ' stakers=' + (sum.ok ? sum.members : 'n/a') + ' verifiedSince=' + (sum.cutoffIso || 'n/a') +
                    ' threshold=' + block.threshold_skr + ' (' + t.source + ': ' + t.why + ') reason=' + reason);
    } catch (_) { /* logging never breaks a request */ }
    return block;
}

/**
 * The CIRCLE canopy fullness: 0 with no resolved vote; otherwise minAtResolvedVote01 rising
 * linearly to 1 at fullAtStakeSkr of the Circle's verified stake. An unreadable stake with a
 * resolved vote answers the MINIMUM (the vote is a fact; the stake is unknown - never guessed up).
 */
function circleCanopyDensity(hasResolvedVote, circleStakeSkr) {
    if (!hasResolvedVote) return 0;
    const min = config.circleCanopy.minAtResolvedVote01;
    const full = config.circleCanopy.fullAtStakeSkr;
    if (!Number.isFinite(circleStakeSkr) || circleStakeSkr <= 0 || !(full > 0)) return min;
    const t = Math.min(1, circleStakeSkr / full);
    return Math.round((min + (1 - min) * t) * 1000) / 1000;
}

/** Convenience for the ballot route: the threshold resolution without a stake read. */
async function readThreshold(sql) {
    return resolveThreshold(await readTunables(sql));
}

module.exports = {
    THRESHOLD_KEY,
    DEFAULT_THRESHOLD_SKR,
    COUNTED_STATUSES,
    freshnessCutoff,
    rawToSkr,
    resolveThreshold,
    isLiving,
    readStakeSum,
    readRealm,
    circleCanopyDensity,
    readThreshold,
};
