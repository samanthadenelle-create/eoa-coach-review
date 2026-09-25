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
// ⛔ PERSISTED STATE, NEVER RPC. Both sums read heartbound_state.last_actual_stake - the
// per-wallet stake the heart-pulse cron VERIFIES and writes (api/_lib/heartbound-state.js
// :398-413) - joined to clan_members on the wallet (heartbound_state.player_id IS the wallet,
// wallet-auth.js / heartbound-state.js:19-20). One indexed aggregate per request, behind
// client-tunables' 10 s edge cache; no chain read, no per-request fan-out, no new table.
// (A pulse-job cache is the alternative if the table ever grows large - not needed today.)
//
// ⚠ WHAT COUNTS, STATED: status ACTIVE or STALE (a stake the pulse verified; STALE is inside
// its grace window). UNSTAKING, DISCONNECTED, SUSPENDED and DORMANT do not count. A staked
// member who has never activated Heartbound has NO heartbound_state row and counts 0 - a real
// gap, recorded rather than papered over with an RPC read.
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

/** The Command Center knob (serverOnly tunable) holding the realm threshold, in whole SKR. */
const THRESHOLD_KEY = 'realm.livingStakeThresholdSkr';

/** Shipping default when the knob row is absent or unreadable. The ONE home: realm-config.json. */
const DEFAULT_THRESHOLD_SKR = config.livingStakeThresholdSkr;

/** SKR base units per whole SKR, by reference to the resonance table (6 decimals, mainnet). */
const SKR_BASE_UNITS = BigInt(resonanceConfig.chain.skrBaseUnits);

/** Statuses whose last_actual_stake counts as staked (see the header). The SQL spells the same
 * two literals; test/realm-stake.test.js pins them together. */
const COUNTED_STATUSES = ['ACTIVE', 'STALE'];

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
 * SUM of counted stake across every Order member (clanId omitted) or one Order's members.
 * Resolves { ok, totalSkr, members, reason }. NEVER throws.
 */
async function readStakeSum(sql, clanId) {
    if (!sql) return { ok: false, totalSkr: 0, members: 0, reason: 'NO_SQL_HANDLE' };
    let rows;
    try {
        rows = clanId
            ? await sql`
                SELECT COALESCE(SUM(hs.last_actual_stake), 0)::text AS total_raw,
                       COUNT(hs.player_id)::int                     AS stakers
                  FROM clan_members cm
                  JOIN heartbound_state hs ON hs.player_id = cm.wallet
                 WHERE cm.clan_id = ${clanId}
                   AND hs.status IN ('ACTIVE', 'STALE')`
            : await sql`
                SELECT COALESCE(SUM(hs.last_actual_stake), 0)::text AS total_raw,
                       COUNT(hs.player_id)::int                     AS stakers
                  FROM clan_members cm
                  JOIN heartbound_state hs ON hs.player_id = cm.wallet
                 WHERE hs.status IN ('ACTIVE', 'STALE')`;
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
    return { ok: true, totalSkr: total, members: Number(row.stakers) || 0, reason: 'ok' };
}

/**
 * The REALM block for /api/client-tunables. `tunables` is the readTunables() result that
 * route already holds (so the knob table is not read twice). NEVER throws.
 * @returns {Promise<{living:boolean, staked_total_skr:number|null, threshold_skr:number,
 *                     threshold_source:string, canopy_density01:number, reason:string}>}
 */
async function readRealm(sql, tunables) {
    const t = resolveThreshold(tunables);
    const sum = await readStakeSum(sql, null);
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
    rawToSkr,
    resolveThreshold,
    isLiving,
    readStakeSum,
    readRealm,
    circleCanopyDensity,
    readThreshold,
};
