// =============================================================================
// api/_lib/clan-ballot.js — WO-1853 (clan WO-10). The perk ballot.
// -----------------------------------------------------------------------------
// ⛔ WO-2031 (owner decisions 2026-09-24) CHANGED THE SHAPE BELOW: no one proposes any
// more (POST /propose is 410 Gone); the ballot OPENS ON ITS OWN each epoch (rollEpoch,
// lazily on read) with the fixed three-banner slate in api/_lib/order-perk-catalog.js;
// a vote is FINAL (upsertVote is insert-only; a second vote is 409
// CLAN_BALLOT_ALREADY_VOTED); and ONE perk is active per Order, each epoch's winner
// replacing the last. The tier/propose prose that follows describes the WO-1853 design and
// is kept for the parts that still hold (the weighted plurality, the turnout bands, the
// Postgres clock); PERK_OPTIONS is retired from every player-facing path.
//
// A clan proposes a perk at a TIER its Vigil has earned, its members vote, and when
// the epoch boundary passes the ballot closes itself on the next request. Two rules
// decide the outcome and they are INDEPENDENT — the owner's ruling of 2026-09-17,
// recorded at WorkOrders/WORK_ORDER_1853_five_tier_perk_ballot.md:10-27:
//
//   1. WHICH option wins  = plurality of TENURE-WEIGHTED vote weight, where a voter's
//      weight is their `vigil_contribution` (percent_staked x tenure_seconds) from
//      WO-1852, snapshotted at the moment they first voted. Never one-wallet-one-vote.
//   2. WHETHER it passes  = a PARTICIPATION threshold that SCALES WITH CLAN SIZE. A
//      ballot with a clear weighted winner STILL FAILS if too few members turned out.
//
// ⛔ THE THRESHOLD NUMBERS IN THIS FILE ARE A FIRST-PASS ENGINEERING DEFAULT, NOT AN
// OWNER RULING. The work order says so in as many words ("This is a first-pass
// engineering default, not a locked owner ruling on the exact numbers... Do not present
// the shipped numbers as final"). Everything tunable is a named constant below, each
// with the owner's own illustrative fraction beside it, so a retune is a one-line edit
// and never a hunt. The same is true of TIER_THRESHOLDS, which depend on real
// vigil_weight magnitudes this repo has never measured.
//
// ⛔ WHY THIS IS ITS OWN FILE. api/_lib/clan.js is the file WO-1845/1846/1847/1850/1851
// all landed in, and clan-vigil.js already recorded (its header, :11-17) that a file
// several concurrent lanes fight over is the definition of NOT file-disjoint
// (CLAUDE.md §9). This module imports two symbols from clan.js (`uniqueViolation`,
// `UUID_RE`) and EDITS it not at all; nothing in clan.js imports this, so there is no
// cycle.
//
// ⛔ EVERY CLOCK IS POSTGRES'S. The epoch index, the epoch boundaries, `closes_at`, and
// "has this ballot expired" are all computed in SQL, against the same clock that wrote
// `opened_at`. This is the rule clan-vigil.js:19-25 states for tenure and touchClanRate
// follows for `retryAfterSeconds`; a serverless function's Date.now() compared against a
// Postgres timestamp is how a duration comes back minutes off in another region. The
// anchor arithmetic is spelled ONCE, in readEpoch(), and `closes_at` is written from the
// value THAT read returned — a second copy of the expression inside the INSERT is
// exactly the duplicated state CLAUDE.md §2/§5/§16 are each about.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore). CommonJS.
// =============================================================================

'use strict';

const { readClanVigil } = require('./clan-vigil');
const { uniqueViolation, UUID_RE } = require('./clan');
const orderPerks = require('./order-perk-catalog');
const { readTunables } = require('./tunables');

// ── Machine codes ────────────────────────────────────────────────────────────
// Prefixed CLAN_BALLOT_ so no code here can ever be confused with one of ClanCode's,
// and declared HERE rather than added to ClanCode for the file-disjointness reason in
// this file's header. The HTTP status each one is answered with lives beside the
// refusal that produces it, never in a second table.
const BallotCode = {
    BAD_TIER:           'CLAN_BALLOT_BAD_TIER',            // 400 — not an integer 1..5
    BAD_OPTIONS:        'CLAN_BALLOT_BAD_OPTIONS',         // 400 — empty, dup, or not in the tier catalog
    BAD_BALLOT_ID:      'CLAN_BALLOT_BAD_BALLOT_ID',       // 400 — missing or not UUID-shaped
    TIER_LOCKED:        'CLAN_BALLOT_TIER_LOCKED',         // 403 — the clan's Vigil is below the tier bar
    NOT_FOUND:          'CLAN_BALLOT_NOT_FOUND',           // 404 — no such ballot in YOUR clan
    ALREADY_OPEN:       'CLAN_BALLOT_ALREADY_OPEN',        // 409 — one open ballot per clan
    CLOSED:             'CLAN_BALLOT_CLOSED',              // 409 — voting on a ballot that has closed
    ALREADY_VOTED:      'CLAN_BALLOT_ALREADY_VOTED',       // 409 — WO-2031: votes are final, one per member
    PROPOSE_GONE:       'CLAN_BALLOT_PROPOSE_GONE',        // 410 — WO-2031: no one proposes; ballots auto-open
    WEIGHT_UNAVAILABLE: 'CLAN_BALLOT_WEIGHT_UNAVAILABLE',  // 503 — the chain read degraded; ask again
};

// ── WO-2031: the automatic epoch ballot ─────────────────────────────────────
//
// Owner decisions 2026-09-24 (WO-2029, "All five answers confirmed"): the ballot OPENS ON
// ITS OWN each epoch with the fixed three-banner slate (api/_lib/order-perk-catalog.js);
// no one proposes; a vote is final; ONE active perk per Order, each epoch's winner
// replacing the last; perks are visual + narrative only (ruling 3). The fixed vote SKIPS
// the Vigil > 0 tier check for opening (`meetsTier` is never consulted by rollEpoch),
// because otherwise a new Order would never get a vote.

/**
 * `clan_ballots.tier` is NOT NULL and CHECKed 1..5 (migration 0035). An automatic ballot
 * has no tier — its slate is the fixed catalog — so it carries tier 1 to satisfy the
 * constraint and nothing reads it as a tier gate. The ballot's identity is its
 * `epoch_index`; `kind: 'epoch'` on the wire says so.
 */
const AUTO_BALLOT_TIER = 1;

/**
 * `clan_perks`' primary key is (clan_id, tier). Every epoch perk is written into ONE slot,
 * tier 0 — outside the retired 1..5 stat ladder, and clan_perks carries no tier CHECK — so
 * a later winner lands on the same row and REPLACES it by construction. The partial unique
 * index clan_perks_one_active_per_clan (migration 0044) states the one-active rule as a
 * database fact on top of that.
 */
const EPOCH_PERK_SLOT = 0;

// ── The epoch ────────────────────────────────────────────────────────────────

/**
 * ⚠ A CLEARLY-LABELLED DEFAULT, NOT A RULING. The work order's cadence section says
 * "anchored to a fixed timestamp (e.g. 2026-01-01T00:00:00Z), not read from a live chain
 * source — this was already ruled by the owner per this repo's WO-numbering banner note
 * for this ticket." That banner note was OPENED AND READ at source on 2026-09-17
 * (CLI_LANES_WO_NUMBERS.md:266) and it says, in full: "**1853** = clan WO-10, five-tier
 * perk ballot, fixed-anchor 48h cadence per owner ruling (needs 1852)". So the SHAPE
 * (fixed anchor, 48h) is ruled and the VALUE is not stated anywhere. This takes the work
 * order's own example rather than inventing a third candidate, and the work order's
 * VERIFY-BEFORE-BUILD explicitly sanctions that ("if genuinely undecided, pick a
 * clearly-labeled default... and flag it as changeable, rather than blocking on it").
 *
 * Changing it re-phases every future ballot and nothing else: no stored row references
 * the anchor, because `closes_at` is a materialised timestamp.
 */
const EPOCH_ANCHOR_ISO = '2026-01-01T00:00:00Z';

/** 48 hours, the owner-ruled cadence. */
const EPOCH_SECONDS = 172800;

// ── The close-early override (Command Center, server-only) ──────────────────
//
// Owner-delegated design, 2026-09-30: a PERMANENT Command Center lever that lets an admin
// close an Order ballot early WITHOUT touching the epoch anchor. It is the serverOnly
// tunable `order.epochCloseEarlySeconds` (api/_lib/tunables.js), written only through
// api/admin/ops.js tunable.set / tunable.clear (both audited: recordOpsWrite writes an
// `admin_ops_write` analytics row, and client_tunables carries updated_by / updated_at).
//
// ⛔ WHAT IT CHANGES, AND ONLY THIS: a ballot's EXPIRY. An open ballot expires at its
// EFFECTIVE close instead of its stored `closes_at`:
//
//     offset  = 0   ->  effective = closes_at                         (byte-identical to before)
//     offset  > 0   ->  effective = GREATEST(closes_at - offset,
//                                            LEAST(closes_at, opened_at + MIN_OPEN))
//
// The epoch index math (readEpoch, epochIndexFromTimestamp) does NOT read it, the stored
// `closes_at` is never rewritten by it, and rollEpoch's "the index never goes backwards"
// target rule is untouched. So CLEARING the row is safe by construction: a ballot the
// offset already closed stays closed (closed_at is set; nothing reopens a closed row), and
// a still-open ballot simply falls back to its stored `closes_at`.
//
// ⛔ WHY NEGATIVE VALUES CLAMP TO 0 (a deliberate deviation from "clamp to +-one epoch").
// normalizeValue accepts any signed 9-digit int, so a negative can land in the table. A
// negative offset would HOLD a ballot open past its stored close — and the admin demo lever
// api/admin/order-epoch-force.js ends an epoch by writing `closes_at = NOW()` and relies on
// the very next read seeing `expired`. Under a negative offset that force would silently do
// nothing for |offset| seconds. "Close early" never means "close later"; the read clamps to
// 0..EPOCH_CLOSE_EARLY_MAX_SECONDS.

/** The serverOnly tunable key. The Command Center card and the allowlist name it. */
const EPOCH_CLOSE_EARLY_KEY = 'order.epochCloseEarlySeconds';

/** Resting state: no override. The ONE home of the default (tunable-manifest.js references it). */
const EPOCH_CLOSE_EARLY_DEFAULT_SECONDS = 0;

/**
 * Strictly LESS than one epoch. An offset of a whole epoch or more would make every ballot's
 * effective close land at or before the previous boundary — i.e. at or before it opened —
 * which the MIN_OPEN floor would then turn into a 60-second ballot every time.
 */
const EPOCH_CLOSE_EARLY_MAX_SECONDS = EPOCH_SECONDS - 1;

/**
 * The shortest time an open ballot stays open while an offset is pulling its close earlier.
 *
 * WHY THE FLOOR EXISTS: a ballot INSERTED with less time left than the offset — the first
 * ballot of an Order founded late in an epoch, or the one rollEpoch opens right after an
 * early settle when the offset is large — would otherwise have an effective close at or
 * before its own opened_at. The next read would see it expired with zero votes, settle it
 * `no_votes`, switch the Order's active banner OFF (applyEpochOutcome -> deactivatePerksBefore)
 * and spend an epoch index — a ballot nobody could ever have voted on. The floor keeps it
 * open for at least this long. It is a guard against a zero-length ballot, NOT a player-
 * fairness window; 60 s is enough for the request that opened it and its client's re-read to
 * see it open. LEAST(closes_at, ...) keeps the floor from ever pushing a close LATER than the
 * stored one, so a forced close (closes_at = NOW()) still expires immediately.
 */
const EPOCH_MIN_OPEN_SECONDS = 60;

/**
 * The live close-early offset from a readTunables() result. PURE. Mirrors
 * realm-stake.js resolveThreshold: `source` is 'tunable' | 'default', `why` names the reason.
 *
 * FAIL-SAFE TO 0: an unreadable table, an absent row or a junk value all answer the default,
 * which is "no override" — exactly the pre-override behaviour.
 *
 * @param {{ok:boolean, values:object, reason?:string}} tunables
 * @returns {{seconds:number, source:'tunable'|'default', why:string, clamped:boolean}}
 */
function resolveCloseEarlySeconds(tunables) {
    if (!tunables || tunables.ok !== true) {
        return { seconds: EPOCH_CLOSE_EARLY_DEFAULT_SECONDS, source: 'default', clamped: false,
                 why: 'tunables unreadable (' + ((tunables && tunables.reason) || 'no read') + ')' };
    }
    const raw = tunables.values ? tunables.values[EPOCH_CLOSE_EARLY_KEY] : undefined;
    if (raw == null || raw === '') {
        return { seconds: EPOCH_CLOSE_EARLY_DEFAULT_SECONDS, source: 'default', clamped: false,
                 why: 'no Command Center row' };
    }
    const s = String(raw).trim();
    const n = /^-?\d+$/.test(s) ? parseInt(s, 10) : NaN;
    if (!Number.isFinite(n)) {
        return { seconds: EPOCH_CLOSE_EARLY_DEFAULT_SECONDS, source: 'default', clamped: false,
                 why: 'Command Center row "' + raw + '" is not an integer' };
    }
    const seconds = Math.min(EPOCH_CLOSE_EARLY_MAX_SECONDS, Math.max(0, n));
    return {
        seconds: seconds,
        source: 'tunable',
        clamped: seconds !== n,
        why: seconds !== n
            ? 'Command Center row ' + n + ' clamped to ' + seconds + ' (0..' + EPOCH_CLOSE_EARLY_MAX_SECONDS + ')'
            : 'Command Center row',
    };
}

/**
 * Read the live offset. NEVER throws: readTunables never rejects (it answers ok:false on
 * any failure), and the belt-and-braces catch here answers 0 as well.
 */
async function readCloseEarly(sql) {
    try {
        return resolveCloseEarlySeconds(await readTunables(sql));
    } catch (err) {
        console.warn('[clan-ballot] close-early override read threw (' + (err && err.message) +
            ') - offset 0, stored closes_at governs');
        return { seconds: EPOCH_CLOSE_EARLY_DEFAULT_SECONDS, source: 'default', clamped: false,
                 why: 'read threw' };
    }
}

/** The offset a caller passed in (opts.closeEarlySeconds), clamped; null when none was passed. */
function passedCloseEarly(opts) {
    if (!opts || opts.closeEarlySeconds == null) return null;
    const n = Math.floor(Number(opts.closeEarlySeconds));
    if (!Number.isFinite(n)) return null;
    return Math.min(EPOCH_CLOSE_EARLY_MAX_SECONDS, Math.max(0, n));
}

/** The offset for one read: the caller's, else a fresh (memoised, 5 s) read of the table. */
async function closeEarlyFor(sql, opts) {
    const passed = passedCloseEarly(opts);
    if (passed != null) return passed;
    return (await readCloseEarly(sql)).seconds;
}

function parseTimeMs(value) {
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isFinite(t) ? t : null;
    }
    if (value == null) return null;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
}

/**
 * Epoch a timestamp sits just after, treating it as an epoch boundary.
 * closes_at starts the next epoch, so settled index = floor((t - anchor) / period) - 1.
 * Unparseable input (tests use 'T1') returns null, never NaN.
 */
function epochIndexFromTimestamp(value) {
    const ms = parseTimeMs(value);
    if (ms == null) return null;
    const anchorMs = Date.parse(EPOCH_ANCHOR_ISO);
    if (!Number.isFinite(anchorMs)) return null;
    const idx = Math.floor((ms - anchorMs) / (EPOCH_SECONDS * 1000)) - 1;
    return Number.isFinite(idx) ? idx : null;
}

function settledEpochIndex(ballot) {
    if (!ballot) return null;
    return epochIndexFromTimestamp(ballot.closesAt);
}

/**
 * The epoch, as POSTGRES sees it. The one place the anchor arithmetic is spelled.
 *
 * `idx` is floor((now - anchor) / 48h) — the count of whole epochs since the anchor.
 * `ends_at` is the boundary a ballot opened now will close on, and it is returned so the
 * INSERT can bind it as a value instead of carrying a second copy of this expression.
 *
 * The `::double precision` cast is EXPLICIT, NOT LOAD-BEARING, and that was MEASURED
 * rather than assumed. `FLOOR(EXTRACT(EPOCH FROM …) / n)` is `numeric` here
 * (`pg_typeof` says so on the live server, PostgreSQL 17.11), and `numeric * interval`
 * has no operator of its own — but PostgreSQL resolves it through the implicit
 * numeric→double precision cast, so the un-cast form runs fine and returns the same
 * boundary (probed read-only 2026-09-18, both forms → 2026-09-18T00:00:00.000Z). The
 * cast stays because naming the type is cheaper than relying on an implicit one, NOT
 * because omitting it errors. An earlier draft of this comment claimed the un-cast form
 * was a runtime 42883; that claim was never measured and is false on this server.
 */
async function readEpoch(sql) {
    const rows = await sql`
        WITH e AS (
            SELECT FLOOR(
                EXTRACT(EPOCH FROM (NOW() - ${EPOCH_ANCHOR_ISO}::timestamptz)) / ${EPOCH_SECONDS}
            )::double precision AS idx
        )
        SELECT idx::bigint AS epoch_index,
               (${EPOCH_ANCHOR_ISO}::timestamptz + (idx * ${EPOCH_SECONDS} * INTERVAL '1 second')) AS started_at,
               (${EPOCH_ANCHOR_ISO}::timestamptz + ((idx + 1) * ${EPOCH_SECONDS} * INTERVAL '1 second')) AS ends_at,
               NOW() AS now_at
        FROM e
    `;
    const r = rows && rows[0] ? rows[0] : null;
    if (!r) return null;
    return {
        epochIndex: Number(r.epoch_index),
        startedAt: r.started_at,
        endsAt: r.ends_at,
        nowAt: r.now_at,
    };
}

// ── The tier gate ────────────────────────────────────────────────────────────

/**
 * ⚠ PLACEHOLDERS, AND THE WORK ORDER CALLS THEM THAT ("VERIFY-BEFORE-BUILD
 * placeholders... they depend on real vigil_weight magnitudes this repo does not have
 * yet. Ship placeholders, say so plainly").
 *
 * THE UNIT IS FULLY-STAKED MEMBER-SECONDS, which is the only interpretable unit a
 * vigil_weight has: `vigil_contribution = percent_staked (0..1) x tenure_seconds`, so
 * one member with their whole SKR position staked accrues 1.0 per second, and a clan's
 * weight is the sum. The ladder below is therefore readable as a duration:
 *
 *   T2 =    86 400  — one fully-staked member for one epoch-and-a-bit (a day)
 *   T3 =   604 800  — one fully-staked member for a week, or seven for a day
 *   T4 = 2 592 000  — thirty fully-staked member-days
 *   T5 = 7 776 000  — ninety fully-staked member-days
 *
 * ⛔ TIER 1's BAR IS "> 0", NOT ">= 0", per the work order's table and its acceptance
 * criterion 1 ("a clan with vigil_weight = 0 cannot open a Tier 1 ballot"). It is the
 * ONE strict comparison in this ladder and meetsTier() is where that lives.
 */
const TIER_THRESHOLDS = { 1: 0, 2: 86400, 3: 604800, 4: 2592000, 5: 7776000 };

/** Vigil-weight words, 1:1 with the ballot tiers. Vigil 0 is not Ember. */
const TIER_WORDS = { 1: 'Ember', 2: 'Flame', 3: 'Beacon', 4: 'Pyre', 5: 'Dawn' };

/** Ceremony of Vigil one-liners. Dawn must not reuse the T5 perk title. */
const TIER_LINES = {
    1: 'A spark moves beneath the roots. The Circle has begun.',
    2: 'The Circle keeps its watch. The Heart is warm.',
    3: 'The Heart answers. Light climbs the trunk.',
    4: 'The crown blooms. The ancestors are near.',
    5: 'The canopy shifts. The Circle has been heard.',
};

const MIN_TIER = 1;
const MAX_TIER = 5;

/** Does `weight` clear `tier`'s bar? Tier 1 is strict (> 0); every other tier is >=. */
function meetsTier(weight, tier) {
    const w = Number(weight);
    if (!Number.isFinite(w)) return false;
    const bar = TIER_THRESHOLDS[tier];
    if (typeof bar !== 'number') return false;
    return tier === 1 ? w > 0 : w >= bar;
}

/** Highest unlocked tier for this vigil weight, or 0 if none (vigil 0 is not Ember). */
function highestUnlockedTier(weight) {
    let highest = 0;
    for (let t = MIN_TIER; t <= MAX_TIER; t++) {
        if (meetsTier(weight, t)) highest = t;
    }
    return highest;
}

function normalizeTier(raw) {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (!Number.isInteger(n) || n < MIN_TIER || n > MAX_TIER) {
        return { ok: false, code: BallotCode.BAD_TIER };
    }
    return { ok: true, value: n };
}

// ── The perk catalogue ───────────────────────────────────────────────────────

/**
 * The options a tier may put on a ballot, and the perk each one activates.
 *
 * ⛔ THE CATALOGUE IS CODE, AND THE BALLOT ROW STORES ONLY IDS. `clan_ballots.options`
 * is the JSONB array of option ids the proposer chose; every string a player reads is
 * resolved from this table at render time. Storing the copy inside the row would freeze
 * a typo into the database and give the game two sources for one sentence — the
 * duplicated-state failure CLAUDE.md §2/§5/§8/§16 each describe. The cost is that an id
 * retired from this table later renders as its bare id on an old closed ballot, which
 * describeOption() handles explicitly rather than throwing.
 *
 * ⛔ COPY RULES, FROM THE WORK ORDER, AND THEY ARE TESTED NOT TRUSTED
 * (test/clan-ballot.test.js pins all three):
 *   - no duration is ever stated in hours or days — "epoch" and "vigil" only;
 *   - no investment language anywhere (no returns, profit, APY, dividend, yield-as-
 *     finance — "harvest yield" survives because it is this game's farming noun and the
 *     work order's own tier table uses it);
 *   - the special-troop option carries the owner's line verbatim.
 *
 * The EFFECT magnitudes (+5% build speed and so on) are the work order's own table,
 * carried as a separate `effect` field so a balance retune never has to edit prose.
 */
/**
 * ⛔⛔ RETIRED FROM EVERY PLAYER-FACING PATH — WO-2031 (owner, 2026-09-24). This is the
 * WO-1853 stat catalogue (+5% build speed and ten more), and ruling 3 (WO-1870:36,
 * 2026-09-18) forbids every row of it: "VISUAL + NARRATIVE outcomes only ... No stat
 * edge, no troop types." It is kept ONLY because the WO-1921 motif-map tests
 * (test/clan-ballot.test.js, regression row RP2-D-091) and the legacy tier helpers
 * (normalizeOptionIds, describeOption) still read it. NOTHING in toWire, tierWire,
 * ceremonyWire or any settle path resolves copy or a perk through it any more — the
 * wire speaks ONLY api/_lib/order-perk-catalog.js, and a test walks every response for
 * these titles, effects and descriptions. Do not wire it back up.
 *
 * ⭐ `treeMotifId` — WO-1921 lane 3, owner ruling 2 (2026-09-21), VERBATIM:
 * "Server returns a stable `treeMotifId` (a.k.a. `visualMotifId`) with the unlocked-perk
 * payload, NOT the gameplay perkId: gameplay identity and visual identity decoupled;
 * several perks may share a motif; art can change without migrating perk ids."
 *
 * It is authored HERE, as a field on the perk record, and nowhere else — a second
 * hand-maintained perkId->motifId table beside this one would be duplicated state and
 * would rot exactly the way CLAUDE.md §2/§5/§16 each describe. `PERK_MOTIFS` below is
 * DERIVED from these records, never typed twice. The three build-speed tiers share ONE
 * motif on purpose; ruling 2 explicitly permits several perks per motif.
 *
 * The motifs are described by FORM, never by hue — the owner is colourblind and no
 * colour name is asked of her (memory `owner-colorblind-delegate-visual-creative`). The
 * client binds each motif to one rune-mask channel; an unmapped or unknown perk resolves
 * to DEFAULT_TREE_MOTIF_ID ('motif_dormant'), never to null, so an unknown perk can never
 * blank the tree.
 */
const PERK_OPTIONS = {
    1: [
        { optionId: 'build_speed_1', perkId: 'clan_build_speed_1',
          title: 'Steady Hands', effect: '+5% build speed',
          treeMotifId: 'motif_hands',
          description: 'The ancestors steady every hammer in the town.' },
        { optionId: 'harvest_yield_1', perkId: 'clan_harvest_yield_1',
          title: 'Full Baskets', effect: '+3% harvest yield',
          treeMotifId: 'motif_harvest',
          description: 'The ancestors bless the fields your people work.' },
    ],
    2: [
        { optionId: 'build_speed_2', perkId: 'clan_build_speed_2',
          title: 'Sure Hands', effect: '+10% build speed',
          treeMotifId: 'motif_hands',
          description: 'Scaffolds rise without a wasted motion.' },
        { optionId: 'harvest_yield_2', perkId: 'clan_harvest_yield_2',
          title: 'Heavy Baskets', effect: '+6% harvest yield',
          treeMotifId: 'motif_harvest',
          description: 'What the fields give, they give generously.' },
        { optionId: 'wall_hp_1', perkId: 'clan_wall_hp_1',
          title: 'Old Stone', effect: '+5% wall HP',
          treeMotifId: 'motif_stone',
          description: 'The stones remember standing, and stand a little longer.' },
    ],
    3: [
        { optionId: 'build_speed_3', perkId: 'clan_build_speed_3',
          title: 'Tireless Hands', effect: '+15% build speed',
          treeMotifId: 'motif_hands',
          description: 'The work goes on while the town sleeps.' },
        { optionId: 'harvest_yield_3', perkId: 'clan_harvest_yield_3',
          title: 'Overflowing Baskets', effect: '+10% harvest yield',
          treeMotifId: 'motif_harvest',
          description: 'The fields answer the vigil that was kept over them.' },
        { optionId: 'wall_hp_2', perkId: 'clan_wall_hp_2',
          title: 'Deep Stone', effect: '+10% wall HP',
          treeMotifId: 'motif_stone',
          description: 'What the ancestors laid down does not give way easily.' },
    ],
    4: [
        { optionId: 'new_building', perkId: 'clan_new_building',
          title: 'A Shape Remembered', effect: 'Unlocks a new building type',
          treeMotifId: 'motif_shape',
          description: 'A structure your people had forgotten how to raise.' },
        { optionId: 'turret_variant', perkId: 'clan_turret_variant',
          title: 'The Watchful Tower', effect: 'Unlocks a defensive turret variant',
          treeMotifId: 'motif_watch',
          description: 'A tower built the way the old defenders built them.' },
    ],
    5: [
        // ⚠ ONE OPTION, DELIBERATELY. The work order's tier table names exactly one
        // Tier 5 option ("A special troop type (ancestor-summoned)"), and inventing a
        // second is writing game content this lane was not asked to write. So a
        // single-option ballot is LEGAL — it is a confirmation ballot, and it still has
        // to clear the participation threshold to pass. Flagged for the owner.
        { optionId: 'ancestor_troop', perkId: 'clan_ancestor_troop',
          title: 'The Ancestors Stir', effect: 'Unlocks an ancestor-summoned troop',
          treeMotifId: 'motif_ancestor',
          description: 'The ancestors stir. A new shape is possible.' },
    ],
};

/**
 * The motif an unknown, retired or unmapped perk resolves to. NEVER null and never
 * absent: the client reads this field to pick a rune channel, and a null would blank
 * the Heart tree instead of leaving it dormant (WO-1921 §6b item 4).
 */
const DEFAULT_TREE_MOTIF_ID = 'motif_dormant';

/**
 * perkId -> treeMotifId, DERIVED from PERK_OPTIONS above. Exported so a test (and any
 * future consumer) can assert coverage without re-reading the nested catalogue — but it
 * is never authored by hand, so it cannot disagree with the perk records.
 */
const PERK_MOTIFS = Object.freeze(
    Object.keys(PERK_OPTIONS).reduce((acc, tier) => {
        for (const o of PERK_OPTIONS[tier]) {
            if (o.perkId) acc[o.perkId] = o.treeMotifId || DEFAULT_TREE_MOTIF_ID;
        }
        return acc;
    }, {}),
);

/**
 * The motif for a perk id. Total: every input — null, '', a retired id, an id whose
 * record forgot the field — answers with a real motif id.
 *
 * ⛔ The fallback lives HERE and not in describePerk(), which must keep returning null
 * for an unknown perk: toWire and ceremonyWire both key their copy off that null
 * ("Never invents copy"), and making it return a stub row would put invented titles on
 * the wire.
 */
function motifFor(perkId) {
    const banner = orderPerks.findOrderPerk(perkId);
    if (banner) return banner.treeMotifId || DEFAULT_TREE_MOTIF_ID;
    const rec = describePerk(perkId);
    return (rec && rec.treeMotifId) || DEFAULT_TREE_MOTIF_ID;
}

/** The headline copy, verbatim from the work order's copy rules. */
const BALLOT_HEADLINE =
    'The ancestors listen to those who gather. Stake together, and they will consider your requests.';

function tierOptions(tier) {
    return PERK_OPTIONS[tier] || [];
}

/** One option's full record, or a minimal one for an id no longer in the catalogue. */
function describeOption(tier, optionId) {
    const found = tierOptions(tier).find((o) => o.optionId === optionId);
    if (found) return found;
    return { optionId: String(optionId), perkId: null, title: String(optionId), effect: null, description: null };
}

function perkIdFor(tier, optionId) {
    const o = describeOption(tier, optionId);
    return o.perkId || null;
}

/** Catalogue row for a perk id, or null. Never invents copy. */
function describePerk(perkId) {
    if (perkId == null) return null;
    const id = String(perkId);
    if (id === '') return null;
    for (let t = MIN_TIER; t <= MAX_TIER; t++) {
        const found = tierOptions(t).find((o) => o.perkId === id);
        if (found) return found;
    }
    return null;
}

/** The proposer's chosen option ids: an array of DISTINCT ids from this tier's catalogue. */
function normalizeOptionIds(raw, tier) {
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: BallotCode.BAD_OPTIONS };
    const allowed = new Set(tierOptions(tier).map((o) => o.optionId));
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const id = entry == null ? '' : String(entry).trim();
        if (id === '' || !allowed.has(id) || seen.has(id)) return { ok: false, code: BallotCode.BAD_OPTIONS };
        seen.add(id);
        out.push(id);
    }
    if (out.length > allowed.size) return { ok: false, code: BallotCode.BAD_OPTIONS };
    return { ok: true, value: out };
}

// ── The participation threshold (THE FIRST-PASS DEFAULT) ─────────────────────

/**
 * ⚠⚠ THIS TABLE IS THIS LANE'S FIRST-PASS ENGINEERING DEFAULT AND IS FLAGGED FOR THE
 * OWNER. It is not a ruling and must not be quoted as one.
 *
 * The owner's ruling is the SHAPE: "the amount that they need is based on how many they
 * have in their group weighted by duration or length" — a bar that scales with clan size,
 * small clans needing a smaller ratio of members to vote and large clans a bigger one.
 * The fractions she gave in conversation were explicitly illustrative: "roughly 2/3 for a
 * small group, 2/4, up to 5/6 for a larger one".
 *
 * Those three fractions are the anchors of the bands below, read in the monotone order
 * the work order's own gloss states (":21-22 — Small clans need a smaller ratio of members
 * voting; larger clans need a bigger ratio"):
 *
 *   <=  4 members : 1/2 — her "2/4". A 4-member clan needs 2 voters; a 3-member clan
 *                          needs 2 as well, because ceil(1.5) = 2, which is also her "2/3".
 *   5..12 members : 2/3 — her "2/3" carried up the range.
 *   >= 13 members : 5/6 — her "5/6 for a larger one".
 *
 * requiredVoters = ceil(ratio x memberCount), clamped into [1, memberCount]: CEILING, not
 * rounding, because a bar that rounds DOWN can be cleared by fewer members than the
 * fraction names, which is the one direction a quorum must never err in.
 *
 * ⛔ THE BAR IS MEASURED IN HEADS, NOT IN WEIGHT, AND THAT IS A DECISION WITH A REASON.
 * A weight-based turnout ratio (voted weight / total clan weight) is UNDEFINED for a clan
 * whose total Vigil is zero — every member unstaked, or every chain read degraded — and
 * that is the ordinary state of a brand-new clan, so the gate would either divide by zero
 * or pass vacuously exactly when it matters least. A head count is always defined. The
 * weighted turnout IS computed and reported alongside (`weighted_turnout`) so the owner
 * can see both numbers on a real ballot and rule, and so switching the gate later is a
 * one-line change with the data already on screen. Flagged in the hand-back.
 */
const PARTICIPATION_BANDS = [
    { maxMembers: 4,        requiredRatio: 1 / 2, ownerExample: '2/4' },
    { maxMembers: 12,       requiredRatio: 2 / 3, ownerExample: '2/3' },
    { maxMembers: Infinity, requiredRatio: 5 / 6, ownerExample: '5/6' },
];

function participationBand(memberCount) {
    const n = Number(memberCount) || 0;
    for (const band of PARTICIPATION_BANDS) {
        if (n <= band.maxMembers) return band;
    }
    return PARTICIPATION_BANDS[PARTICIPATION_BANDS.length - 1];
}

/** How many members must have voted for a clan of this size. Always >= 1. */
function requiredVoters(memberCount) {
    const n = Math.max(0, Math.floor(Number(memberCount) || 0));
    if (n <= 0) return 1;
    const band = participationBand(n);
    return Math.min(n, Math.max(1, Math.ceil(band.requiredRatio * n)));
}

/**
 * The turnout verdict for one ballot.
 *
 * `votedWeight` (the weight that actually voted) and `clanWeight` (the clan's whole
 * current Vigil) are carried through for the ADVISORY `weighted_turnout` only — they never
 * decide `clears`. `clanWeight` is frequently unknown at settle time on purpose: closing a
 * ballot must not require a chain read (see settleBallot), so when no caller supplies it
 * the reported fraction is null rather than a number computed against the wrong
 * denominator. A wrong number is worse than an absent one — it would be the exact
 * "measured something, but not the right thing" failure CLAUDE.md §11B records.
 */
function evaluateTurnout(voterCount, memberCount, votedWeight, clanWeight) {
    const voters = Math.max(0, Math.floor(Number(voterCount) || 0));
    const members = Math.max(0, Math.floor(Number(memberCount) || 0));
    const band = participationBand(members);
    const required = requiredVoters(members);
    const vw = Number(votedWeight);
    const tw = Number(clanWeight);
    return {
        voters: voters,
        memberCount: members,
        requiredVoters: required,
        requiredRatio: band.requiredRatio,
        ownerExample: band.ownerExample,
        ratio: members > 0 ? voters / members : 0,
        // Undefined rather than 0 when there is no weight to take a fraction of — a
        // reported null is honest, a reported 0 reads as "nobody with weight voted".
        weightedTurnout: Number.isFinite(vw) && Number.isFinite(tw) && tw > 0 ? vw / tw : null,
        clears: voters >= required,
    };
}

// ── The tally ────────────────────────────────────────────────────────────────

/**
 * Plurality BY WEIGHT, with a fully deterministic order.
 *
 * Ties break on weight DESC, then voter count DESC, then option id ASC. The last key is
 * what makes the answer reproducible rather than dependent on row order — the same
 * "never an unordered pick" rule clan.js's leaveAsLeader ORDER BY exists for, and the one
 * WaveSpawnResolver exists for on the game side (CLAUDE.md §7).
 *
 * ⛔ A ZERO-WEIGHT ELECTORATE STILL HAS A WINNER. If every voter's Vigil contribution is
 * 0 (a clan where nobody has staked yet), every tally is 0 and the weight key decides
 * nothing — so the voter-count key does, and the id key after it. The alternative,
 * "no winner", would make the head-count turnout gate unreachable for exactly the clans
 * most likely to clear it.
 */
function tallyVotes(votes) {
    const byOption = new Map();
    let totalWeight = 0;
    for (const v of votes || []) {
        const id = String(v.optionId);
        const w = Number(v.weight) || 0;
        const cur = byOption.get(id) || { optionId: id, weight: 0, voters: 0 };
        cur.weight += w;
        cur.voters += 1;
        byOption.set(id, cur);
        totalWeight += w;
    }
    const tallies = [...byOption.values()].sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        if (b.voters !== a.voters) return b.voters - a.voters;
        return a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0;
    });
    return {
        tallies: tallies,
        totalWeight: totalWeight,
        winner: tallies.length > 0 ? tallies[0].optionId : null,
    };
}

// ── Reads ────────────────────────────────────────────────────────────────────

function rowToBallot(r) {
    if (!r) return null;
    const options = Array.isArray(r.options)
        ? r.options.map(String)
        : (typeof r.options === 'string' ? safeParseArray(r.options) : []);
    return {
        ballotId: String(r.id),
        clanId: String(r.clan_id),
        proposedByWallet: r.proposed_by_wallet != null ? String(r.proposed_by_wallet) : null,
        tier: Number(r.tier),
        options: options,
        openedAt: r.opened_at,
        closesAt: r.closes_at,
        closedAt: r.closed_at != null ? r.closed_at : null,
        winningOption: r.winning_option != null ? String(r.winning_option) : null,
        // WO-2031. The epoch an AUTOMATIC ballot runs in; NULL on a legacy proposed one.
        epochIndex: r.epoch_index != null && Number.isFinite(Number(r.epoch_index))
            ? Number(r.epoch_index) : null,
        // Computed by POSTGRES in the same statement, never by comparing Date.now().
        expired: r.expired === true,
        // The close-early override. `effective_closes_at` is computed by POSTGRES in the
        // readLatestBallot / readBallotInClan statement; every other read (the INSERT's
        // RETURNING, readLastClosedBallot) does not spell it and falls back to the stored
        // closes_at, which is exactly the effective close at offset 0. `closesAt` above stays
        // the STORED value — settledEpochIndex derives an epoch from it, and that index math
        // must never move with the override.
        effectiveClosesAt: r.effective_closes_at != null ? r.effective_closes_at : r.closes_at,
        closeOffsetSeconds: 0,
    };
}

/** Stamp the offset a read ran under onto the ballot it returned (null stays null). */
function withOffset(b, offsetSeconds) {
    if (b) b.closeOffsetSeconds = offsetSeconds;
    return b;
}

// ── WO-2031: the live column guard (deploy-order safety) ─────────────────────

let _epochColumnsEnsured = false;

/**
 * Adds migration 0044's COLUMNS live, once per cold start, so code deployed before the
 * migration runs does not 500 on `epoch_index` / `active`. The same deploy-order pattern
 * as api/_lib/clan.js ensureCherryRoomColumns (WO-2027) — except that this one never throws. The two UNIQUE INDEXES are
 * migration-only — building an index is not something a cold start should do — and until
 * 0044 runs the 0035 partial index clan_ballots_one_open_per_clan still bounds a racing
 * auto-open to ONE open ballot per Order.
 *
 * ONE statement (the Neon HTTP driver sends one per call), every step guarded by
 * information_schema so an already-migrated database takes no ALTER at all.
 *
 * NEVER THROWS: if the guard itself is refused (a role without ALTER), the columns either
 * exist already (the migration ran) or the next query fails loudly on its own — a warn
 * here must not turn a working read into a 500.
 */
async function ensureEpochColumns(sql) {
    if (_epochColumnsEnsured) return;
    try {
        await sql`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = 'public' AND table_name = 'clan_ballots'
                                 AND column_name = 'epoch_index') THEN
                    ALTER TABLE clan_ballots ADD COLUMN epoch_index INTEGER NULL;
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'clan_ballots'
                             AND column_name = 'proposed_by_wallet' AND is_nullable = 'NO') THEN
                    ALTER TABLE clan_ballots ALTER COLUMN proposed_by_wallet DROP NOT NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = 'public' AND table_name = 'clan_perks'
                                 AND column_name = 'epoch_index') THEN
                    ALTER TABLE clan_perks ADD COLUMN epoch_index INTEGER NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = 'public' AND table_name = 'clan_perks'
                                 AND column_name = 'active') THEN
                    ALTER TABLE clan_perks ADD COLUMN active BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
            END $$
        `;
        _epochColumnsEnsured = true;
    } catch (err) {
        console.warn('[clan-ballot] epoch column guard refused (continuing):', err && err.message);
    }
}

/** JSONB arrives as a JS array from neon; a string is the belt-and-braces path. */
function safeParseArray(text) {
    try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v.map(String) : [];
    } catch (_) {
        return [];
    }
}

/**
 * The clan's CURRENT ballot: the open one if there is one, otherwise the most recently
 * opened closed one — which is exactly the window the work order's non-scope allows
 * ("No ballot history beyond the current/most-recently-closed ballot").
 *
 * ⛔ SCOPED BY clan_id, WHICH IS THE PRIVACY PROPERTY, not an optimisation — the same
 * rule clan.js readMemberInClan and clan-vigil.js readClanVigilRoster each state. The
 * clan id comes from the caller's proven membership and never from the request.
 */
//
// ⛔ THE EXPIRY VERDICT IS THE EFFECTIVE CLOSE, and both reads below spell it the same way
// (see "The close-early override" near the top of this file). At offset 0 the CASE answers
// the stored closes_at, so the verdict is byte-for-byte the old `closes_at <= NOW()`. The
// offset and the floor are BOUND parameters; the clock is still Postgres's NOW().
// `opts.closeEarlySeconds` lets a caller that already read the offset (rollEpoch) pass it
// down; without it each read resolves the offset itself (readTunables memoises for 5 s).
async function readLatestBallot(sql, clanId, opts) {
    await ensureEpochColumns(sql);
    const off = await closeEarlyFor(sql, opts);
    const rows = await sql`
        SELECT b.*, (b.closed_at IS NULL AND b.effective_closes_at <= NOW()) AS expired
        FROM (
            SELECT id, clan_id, proposed_by_wallet, tier, options, opened_at,
                   closes_at, closed_at, winning_option, epoch_index,
                   CASE WHEN ${off}::int > 0
                        THEN GREATEST(closes_at - (${off}::int * INTERVAL '1 second'),
                                      LEAST(closes_at, opened_at + (${EPOCH_MIN_OPEN_SECONDS}::int * INTERVAL '1 second')))
                        ELSE closes_at
                   END AS effective_closes_at
            FROM clan_ballots
            WHERE clan_id = ${clanId}
            ORDER BY opened_at DESC, id ASC
            LIMIT 1
        ) b
    `;
    return withOffset(rowToBallot(rows && rows[0] ? rows[0] : null), off);
}

/** ONE ballot by id, and only if it belongs to the caller's own clan (see above). */
async function readBallotInClan(sql, clanId, ballotId, opts) {
    await ensureEpochColumns(sql);
    const off = await closeEarlyFor(sql, opts);
    const rows = await sql`
        SELECT b.*, (b.closed_at IS NULL AND b.effective_closes_at <= NOW()) AS expired
        FROM (
            SELECT id, clan_id, proposed_by_wallet, tier, options, opened_at,
                   closes_at, closed_at, winning_option, epoch_index,
                   CASE WHEN ${off}::int > 0
                        THEN GREATEST(closes_at - (${off}::int * INTERVAL '1 second'),
                                      LEAST(closes_at, opened_at + (${EPOCH_MIN_OPEN_SECONDS}::int * INTERVAL '1 second')))
                        ELSE closes_at
                   END AS effective_closes_at
            FROM clan_ballots
            WHERE clan_id = ${clanId} AND id = ${ballotId}
            LIMIT 1
        ) b
    `;
    return withOffset(rowToBallot(rows && rows[0] ? rows[0] : null), off);
}

/**
 * WO-2031. The Order's most recently CLOSED ballot, or null. Once the next epoch's ballot
 * has auto-opened, the latest ballot is the open one — so "what did the last vote decide"
 * needs its own read. Scoped by clan_id for the same privacy reason as readLatestBallot.
 */
async function readLastClosedBallot(sql, clanId) {
    await ensureEpochColumns(sql);
    const rows = await sql`
        SELECT id, clan_id, proposed_by_wallet, tier, options, opened_at,
               closes_at, closed_at, winning_option, epoch_index, FALSE AS expired
        FROM clan_ballots
        WHERE clan_id = ${clanId} AND closed_at IS NOT NULL
        ORDER BY closed_at DESC, id ASC
        LIMIT 1
    `;
    return rowToBallot(rows && rows[0] ? rows[0] : null);
}

/**
 * Every vote on one ballot.
 *
 * `weight` is NUMERIC in the schema and neon returns NUMERIC as a STRING, so it is cast
 * to float8 in SQL rather than parsed in JS — the same reason clan-vigil.js casts its
 * tenure. Deterministic order for the same reason tallyVotes has a final sort key.
 */
async function readVotes(sql, ballotId) {
    const rows = await sql`
        SELECT wallet, option_id, weight::float8 AS weight, voted_at
        FROM clan_ballot_votes
        WHERE ballot_id = ${ballotId}
        ORDER BY voted_at ASC, wallet ASC
    `;
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
        wallet: String(r.wallet),
        optionId: String(r.option_id),
        weight: Number(r.weight) || 0,
        votedAt: r.voted_at,
    }));
}

async function readMemberCount(sql, clanId) {
    const rows = await sql`
        SELECT COUNT(*)::int AS member_count FROM clan_members WHERE clan_id = ${clanId}
    `;
    return rows && rows[0] ? Number(rows[0].member_count) || 0 : 0;
}

/**
 * The Order's ACTIVE perk, as a list of at most one (the shape every caller already
 * passes to toWire).
 *
 * ⛔ WO-2031: `WHERE active` IS THE STAT-PERK BLOCK AT THE SOURCE. Every legacy WO-1853
 * row (a stat perk, ruling 3) took `active = FALSE` from the column's default when 0044
 * added it, so no legacy row is ever read here; and anything that is somehow active but
 * not a catalog banner is dropped below rather than trusted.
 */
async function readPerks(sql, clanId) {
    await ensureEpochColumns(sql);
    const rows = await sql`
        SELECT tier, perk_id, epoch_index, activated_at, expires_at
        FROM clan_perks
        WHERE clan_id = ${clanId} AND active
        ORDER BY activated_at DESC
        LIMIT 1
    `;
    if (!rows || rows.length === 0) return [];
    return rows
        .filter((r) => orderPerks.isOrderPerkId(r.perk_id))
        .map((r) => ({
            tier: Number(r.tier),
            perkId: String(r.perk_id),
            epochIndex: r.epoch_index != null && Number.isFinite(Number(r.epoch_index))
                ? Number(r.epoch_index) : null,
            activatedAt: r.activated_at,
            expiresAt: r.expires_at != null ? r.expires_at : null,
        }));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * WO-2031. Open the AUTOMATIC ballot for one epoch.
 *
 * `closesAt` is the CURRENT epoch's boundary exactly as readEpoch() returned it, and
 * `epochsAhead` is how many whole epochs past the current one this ballot runs in (0 on
 * every ordinary roll; > 0 only after api/admin/order-epoch-force.js closed an epoch
 * early). The anchor arithmetic is therefore still spelled ONCE, in readEpoch — this adds
 * whole epochs to a value Postgres computed.
 *
 * `proposed_by_wallet` is NULL: no one proposes (owner, 2026-09-24). The alternative, a
 * sentinel "system" wallet, would put a fake identity into wallet_identity (WO-2028 §3.2).
 *
 * ⛔ ON CONFLICT DO NOTHING, with no target, IS THE IDEMPOTENCE. Two unique indexes can
 * refuse this row — clan_ballots_one_per_epoch (clan_id, epoch_index), migration 0044, and
 * clan_ballots_one_open_per_clan, migration 0035 — and a racing second roll must lose to
 * either one quietly. Zero rows back means "somebody else opened it"; the caller re-reads.
 */
async function insertEpochBallot(sql, clanId, epochIndex, optionIds, closesAt, epochsAhead) {
    const ahead = Math.max(0, Math.floor(Number(epochsAhead) || 0));
    const rows = await sql`
        INSERT INTO clan_ballots (clan_id, proposed_by_wallet, tier, options, opened_at,
                                  closes_at, epoch_index)
        VALUES (${clanId}, NULL, ${AUTO_BALLOT_TIER}, ${JSON.stringify(optionIds)}::jsonb, NOW(),
                ${closesAt}::timestamptz
                    + ((${ahead}::int * ${EPOCH_SECONDS}::int) * INTERVAL '1 second'),
                ${epochIndex})
        ON CONFLICT DO NOTHING
        RETURNING id, clan_id, proposed_by_wallet, tier, options, opened_at,
                  closes_at, closed_at, winning_option, epoch_index, FALSE AS expired
    `;
    return rowToBallot(rows && rows[0] ? rows[0] : null);
}

/**
 * Cast one vote — ONCE. WO-2031 (owner, 2026-09-24: "No vote changes. A cast vote is
 * final.").
 *
 * ⛔ ON CONFLICT (ballot_id, wallet) DO NOTHING. The primary key is one vote per member
 * per ballot; a second vote now changes NOTHING — not the option, not the weight snapshot,
 * not voted_at — and RETURNING gives zero rows. That zero is the distinct result:
 *
 *   returns the recorded vote        the vote was cast by THIS call
 *   returns null                     this member had ALREADY voted; the route answers
 *                                    409 CLAN_BALLOT_ALREADY_VOTED (BallotCode.ALREADY_VOTED)
 *
 * (The name is kept because api/clan/ballot/vote.js — WO-2030's file this wave — calls it
 * by this name; `castVote` is the same function under the honest name.)
 */
async function upsertVote(sql, ballotId, wallet, optionId, weight) {
    const rows = await sql`
        INSERT INTO clan_ballot_votes (ballot_id, wallet, option_id, voted_at, weight)
        VALUES (${ballotId}, ${wallet}, ${optionId}, NOW(), ${weight})
        ON CONFLICT (ballot_id, wallet) DO NOTHING
        RETURNING wallet, option_id, weight::float8 AS weight, voted_at
    `;
    const r = rows && rows[0] ? rows[0] : null;
    if (!r) {
        console.warn('[clan-ballot] vote refused: already voted (votes are final) ballot=' + ballotId);
        return null;
    }
    return {
        wallet: String(r.wallet),
        optionId: String(r.option_id),
        weight: Number(r.weight) || 0,
        votedAt: r.voted_at,
    };
}

/**
 * Close a ballot, and RETURN WHETHER THIS CALLER IS THE ONE THAT CLOSED IT.
 *
 * ⛔ `AND closed_at IS NULL` IS THE WHOLE CONCURRENCY DESIGN. Closing happens on
 * whichever request first observes the expiry, so two simultaneous requests both compute
 * the same verdict and both try to close. The conditional UPDATE means exactly one moves
 * a row; the loser gets zero rows back, re-reads, and reports the stored outcome instead
 * of writing a second perk. No transaction is needed — and none is available in the
 * shape this API uses anyway: `sql.transaction([...])` exists in the neon driver and is
 * used once in this repo (api/purchases/quote.js:470), but it takes a pre-built array of
 * statements and cannot span a decision made between two reads, which is precisely what
 * closing is.
 */
async function closeBallot(sql, ballotId, winningOption) {
    const rows = await sql`
        UPDATE clan_ballots
        SET closed_at = NOW(), winning_option = ${winningOption}
        WHERE id = ${ballotId} AND closed_at IS NULL
        RETURNING id, closed_at, winning_option
    `;
    return rows && rows.length > 0 ? { closed: true, closedAt: rows[0].closed_at } : { closed: false };
}

/**
 * WO-2031. Activate an epoch's winning banner, REPLACING the Order's previous perk.
 *
 * ⛔ ONE STATEMENT, ONE SLOT. Every epoch perk lives at (clan_id, EPOCH_PERK_SLOT), so the
 * primary key makes "the winner replaces the last" true by construction (owner,
 * 2026-09-24: "perks replace each other every epoch"), with no read-then-write and no
 * second statement to fail between. Legacy stat rows (tiers 1..5) are all active = FALSE,
 * so this row is the only one clan_perks_one_active_per_clan ever sees.
 *
 * ⛔ MONOTONIC: the DO UPDATE only fires for an epoch at least as new as the stored one.
 * A late self-heal of an OLD ballot therefore returns zero rows and can never overwrite a
 * newer epoch's banner.
 *
 * `epoch_index` is the epoch the ballot RAN in; the banner applies to the next one
 * (`applies_to_epoch = epoch_index + 1` on the wire). expires_at stays NULL: the next
 * settle replaces the row, which is the whole lifetime rule.
 */
async function writeEpochPerk(sql, clanId, perkId, epochIndex) {
    const rows = await sql`
        INSERT INTO clan_perks (clan_id, tier, perk_id, epoch_index, active, activated_at, expires_at)
        VALUES (${clanId}, ${EPOCH_PERK_SLOT}, ${perkId}, ${epochIndex}, TRUE, NOW(), NULL)
        ON CONFLICT (clan_id, tier) DO UPDATE SET
            perk_id = EXCLUDED.perk_id,
            epoch_index = EXCLUDED.epoch_index,
            active = TRUE,
            activated_at = NOW(),
            expires_at = NULL
        WHERE clan_perks.epoch_index IS NULL OR clan_perks.epoch_index <= EXCLUDED.epoch_index
        RETURNING clan_id, tier, perk_id, epoch_index, activated_at, expires_at
    `;
    const r = rows && rows[0] ? rows[0] : null;
    if (!r) return null;
    return {
        tier: Number(r.tier),
        perkId: String(r.perk_id),
        epochIndex: r.epoch_index != null ? Number(r.epoch_index) : null,
        activatedAt: r.activated_at,
        expiresAt: r.expires_at != null ? r.expires_at : null,
    };
}

/**
 * WO-2031. A ballot that FAILED (no quorum, or no votes) writes no perk, and the Order
 * lives the next epoch with no banner (09-17 ruling; WO-2028 §3.5 "the Order lives
 * through the next epoch with no outcome"). So the previous epoch's banner is switched off
 * — but only one from an EARLIER epoch, for the same monotonic reason writeEpochPerk has.
 */
async function deactivatePerksBefore(sql, clanId, epochIndex) {
    const rows = await sql`
        UPDATE clan_perks SET active = FALSE
        WHERE clan_id = ${clanId} AND active
          AND (epoch_index IS NULL OR epoch_index < ${epochIndex})
        RETURNING perk_id
    `;
    return rows ? rows.length : 0;
}

// ── The outcome ──────────────────────────────────────────────────────────────

const REASON_PASSED = 'passed';
const REASON_NO_VOTES = 'no_votes';
const REASON_INSUFFICIENT_TURNOUT = 'insufficient_turnout';

/**
 * Decide one ballot from its votes and its clan's size. PURE — no IO, no clock, so the
 * rule can be read and tested without a database.
 */
function decideBallot(votes, memberCount, clanWeight) {
    const tally = tallyVotes(votes);
    const turnout = evaluateTurnout(
        (votes || []).length, memberCount, tally.totalWeight, clanWeight);
    const hasVotes = (votes || []).length > 0;
    const passed = hasVotes && turnout.clears && tally.winner != null;
    return {
        tally: tally,
        turnout: turnout,
        winner: tally.winner,
        passed: passed,
        reason: passed ? REASON_PASSED : (hasVotes ? REASON_INSUFFICIENT_TURNOUT : REASON_NO_VOTES),
    };
}

/**
 * CLOSE AN EXPIRED BALLOT — the work order's step 4, and the ONLY place a ballot is
 * closed. Called by all three endpoints before they do anything else, which is what makes
 * "the next request to any ballot endpoint closes it" true rather than aspirational.
 *
 * ⛔ CLOSING SPENDS NO RPC AND NEEDS NO CHAIN. Every vote's weight was snapshotted into
 * clan_ballot_votes when it was cast, so the verdict is pure SQL — which means an SKR RPC
 * outage can never leave a clan's ballot stuck open. That property is worth more than the
 * freshness a re-read would buy, and it is why the weight is a snapshot in the schema.
 *
 * ⛔ AND IT SELF-HEALS A MISSING PERK ROW. If the close won the race but the perk INSERT
 * failed (a transient database fault between two statements that cannot share a
 * transaction — see closeBallot), the next read notices `winning_option` is set with no
 * matching clan_perks row and writes it then. The honest alternative — reporting
 * `passed: true, perk_written: false` forever — was rejected because the player would see
 * a won ballot with no perk and nothing would ever fix it.
 *
 * @returns {Promise<{ballot:object, decision:object|null, perk:object|null,
 *                     closedNow:boolean, perkWritten:boolean}>}
 */
async function settleBallot(sql, clanId, ballot, opts) {
    if (!ballot) return { ballot: null, decision: null, perk: null, closedNow: false, perkWritten: false };
    // The clan's whole Vigil, when the CALLER happens to have read it already (every
    // endpoint does, for its own reasons). Advisory only — see evaluateTurnout.
    const clanWeight = opts && opts.clanWeight != null ? Number(opts.clanWeight) : null;

    const votes = await readVotes(sql, ballot.ballotId);
    const memberCount = await readMemberCount(sql, clanId);

    // Still running: nothing to settle, but the caller still wants the live tally.
    if (ballot.closedAt == null && !ballot.expired) {
        return {
            ballot: ballot, votes: votes, memberCount: memberCount,
            decision: decideBallot(votes, memberCount, clanWeight),
            perk: null, closedNow: false, perkWritten: false,
        };
    }

    // Already closed: re-derive the verdict from the stored row, never re-decide it. The
    // stored `winning_option` IS the outcome — NULL means it did not pass, and which of
    // the two failure reasons applies is recoverable from the vote count.
    if (ballot.closedAt != null) {
        const decided = decideBallot(votes, memberCount, clanWeight);
        const passed = ballot.winningOption != null;
        const decision = {
            tally: decided.tally,
            turnout: decided.turnout,
            winner: ballot.winningOption,
            passed: passed,
            reason: passed ? REASON_PASSED : (votes.length > 0 ? REASON_INSUFFICIENT_TURNOUT : REASON_NO_VOTES),
        };
        // ⛔ WO-2031: keyed on the EPOCH, not the tier — every automatic ballot is tier 1.
        // A legacy (proposed, epoch_index NULL) ballot never grows a perk: its slate is
        // the retired stat catalogue.
        let perk = null;
        let perkWritten = false;
        if (ballot.epochIndex != null) {
            const active = (await readPerks(sql, clanId))[0] || null;
            if (outcomeIsStale(active, ballot, passed)) {
                const applied = await applyEpochOutcome(sql, clanId, ballot);
                perk = applied.perk;
                perkWritten = applied.written;
            } else if (passed && active && active.epochIndex === ballot.epochIndex) {
                perk = active;
            }
        }
        return { ballot: ballot, votes: votes, memberCount: memberCount,
                 decision: decision, perk: perk, closedNow: false, perkWritten: perkWritten };
    }

    // Expired and open: decide it, then try to be the one that closes it.
    const decision = decideBallot(votes, memberCount, clanWeight);
    const won = await closeBallot(sql, ballot.ballotId, decision.passed ? decision.winner : null);
    if (!won.closed) {
        // Somebody else closed it between our read and our write. Their row is the truth.
        const fresh = await readBallotInClan(sql, clanId, ballot.ballotId,
            { closeEarlySeconds: ballot.closeOffsetSeconds });
        return settleBallot(sql, clanId, fresh, opts);
    }

    // The close-early override's trace: EVERY settle this request made while the offset was
    // non-zero says so, with the stored and the effective close side by side, so a ballot
    // that closed "early" is never a mystery in the logs (CLAUDE.md s12: no silent branch).
    if (Number(ballot.closeOffsetSeconds) > 0) {
        console.warn('[clan-ballot] settle under close-early override ballot=' + ballot.ballotId +
            ' clan=' + clanId + ' epoch=' + (ballot.epochIndex != null ? ballot.epochIndex : 'legacy') +
            ' offset_s=' + ballot.closeOffsetSeconds + ' stored_closes_at=' + String(ballot.closesAt) +
            ' effective_closes_at=' + String(ballot.effectiveClosesAt) +
            ' passed=' + decision.passed + ' reason=' + decision.reason);
    }

    const closedBallot = Object.assign({}, ballot, {
        closedAt: won.closedAt,
        winningOption: decision.passed ? decision.winner : null,
        expired: false,
    });
    // (effectiveClosesAt / closeOffsetSeconds carry over from the read that saw it expire.)

    console.log('[clan-ballot] settle closed ballot=' + ballot.ballotId + ' clan=' + clanId +
        ' epoch=' + (ballot.epochIndex != null ? ballot.epochIndex : 'legacy') +
        ' passed=' + decision.passed + ' reason=' + decision.reason +
        ' winner=' + (decision.passed ? decision.winner : 'none'));

    let perk = null;
    let perkWritten = false;
    if (ballot.epochIndex != null) {
        const applied = await applyEpochOutcome(sql, clanId, closedBallot);
        perk = applied.perk;
        perkWritten = applied.written;
    } else if (decision.passed) {
        // ⛔ A legacy proposed ballot's winner is a retired stat perk (ruling 3). It is
        // recorded on the ballot row and activates NOTHING.
        console.warn('[clan-ballot] legacy ballot ' + ballot.ballotId + ' closed — no perk (stat slate retired)');
    }
    return { ballot: closedBallot, votes: votes, memberCount: memberCount,
             decision: decision, perk: perk, closedNow: true, perkWritten: perkWritten };
}

/**
 * Does the Order's active perk still need to catch up with this closed epoch ballot?
 * Passed: yes unless a banner from this epoch or a newer one is already active.
 * Failed: yes while a banner from an OLDER epoch is still active (it must go dark).
 */
function outcomeIsStale(active, ballot, passed) {
    if (ballot == null || ballot.epochIndex == null) return false;
    const activeIdx = active && active.epochIndex != null ? active.epochIndex : null;
    if (passed) return activeIdx == null || activeIdx < ballot.epochIndex;
    return active != null && (activeIdx == null || activeIdx < ballot.epochIndex);
}

/**
 * WO-2031. Make the Order's perk match one CLOSED epoch ballot: the winner's banner
 * becomes the one active perk, or — if it failed — the older banner goes dark.
 *
 * NEVER THROWS. A perk that could not be written is re-attempted by the next read
 * (settleBallot's closed branch, and rollEpoch's heal of the last closed ballot); a throw
 * here would turn a WON ballot into a 500 and lose the close that already committed.
 */
async function applyEpochOutcome(sql, clanId, ballot) {
    if (!ballot || ballot.epochIndex == null) return { perk: null, written: false };
    if (ballot.winningOption == null) {
        try {
            const off = await deactivatePerksBefore(sql, clanId, ballot.epochIndex);
            if (off > 0) {
                console.log('[clan-ballot] no quorum: previous perk switched off clan=' + clanId +
                    ' epoch=' + ballot.epochIndex);
            }
        } catch (err) {
            console.error('[clan-ballot] perk switch-off failed — the next read will retry it:',
                err && err.message);
        }
        return { perk: null, written: false };
    }
    const rec = orderPerks.findOrderPerk(ballot.winningOption);
    if (!rec) {
        console.warn('[clan-ballot] winning option ' + ballot.winningOption +
            ' is not an Order perk — no perk written');
        return { perk: null, written: false };
    }
    try {
        const perk = await writeEpochPerk(sql, clanId, rec.perkId, ballot.epochIndex);
        if (perk) {
            console.log('[clan-ballot] perk activated clan=' + clanId + ' perk=' + perk.perkId +
                ' epoch=' + perk.epochIndex);
            return { perk: perk, written: true };
        }
        // Zero rows: a NEWER epoch's banner already holds the slot (the monotonic guard).
        const active = (await readPerks(sql, clanId))[0] || null;
        return { perk: active, written: false };
    } catch (err) {
        console.error('[clan-ballot] perk write failed — the next read will retry it:', err && err.message);
        return { perk: null, written: false };
    }
}

// ── WO-2031: the roll ────────────────────────────────────────────────────────

/**
 * ROLL THE ORDER'S BALLOT FORWARD — lazily, on read, with no cron (the demo needs none).
 *
 *   1. An open LEGACY ballot (proposed under WO-1853, epoch_index NULL) is retired: closed
 *      with no winner and no perk. Its slate is the stat catalogue ruling 3 forbids, and it
 *      holds the one-open-ballot slot the automatic ballot needs.
 *   2. An open, EXPIRED epoch ballot is settled (settleBallot: conditional close + the one
 *      active perk).
 *   3. If the Order then has no ballot for the target epoch, one is opened with the fixed
 *      three-banner slate and proposed_by_wallet NULL.
 *
 * The target epoch is the current one — unless the latest closed ballot already ran in
 * the current epoch or later (only api/admin/order-epoch-force.js can do that, by ending
 * an epoch early), in which case it is the epoch after that ballot. That is what keeps the
 * unique (clan_id, epoch_index) index from refusing every roll after a forced close.
 *
 * ⛔ NO VIGIL READ, NO RPC. Opening skips the Vigil > 0 tier check by owner decision, so
 * a roll is pure SQL and an SKR outage can never stop a ballot opening.
 *
 * Idempotent: a second call finds the ballot the first one opened and does nothing, and a
 * racing call loses the INSERT quietly (ON CONFLICT DO NOTHING) and re-reads the winner.
 *
 * @returns {Promise<{epoch:object, ballot:object|null, opened:boolean,
 *                    closedNow:object|null, retired:object|null, targetIndex:number|null}>}
 */
async function rollEpoch(sql, clanId, opts) {
    const o = opts || {};
    const epoch = o.epoch || await readEpoch(sql);
    if (!epoch) throw new Error('epoch read returned no row');

    // The close-early override, read ONCE for the whole roll and passed down, so the expiry
    // verdict and the ballot the roll opens are judged under the same offset.
    const off = await closeEarlyFor(sql, o);
    const readOpts = { closeEarlySeconds: off };

    let latest = await readLatestBallot(sql, clanId, readOpts);
    let closedNow = null;
    let retired = null;

    if (latest && latest.closedAt == null) {
        if (latest.epochIndex == null) {
            const won = await closeBallot(sql, latest.ballotId, null);
            console.log('[clan-ballot] roll retired legacy ballot=' + latest.ballotId + ' clan=' + clanId +
                ' (proposed stat slate, no perk) closed=' + won.closed);
            retired = Object.assign({}, latest, {
                closedAt: won.closed ? won.closedAt : (latest.closedAt || 'closed'),
                winningOption: null,
                expired: false,
            });
            latest = retired;
        } else if (latest.expired) {
            closedNow = await settleBallot(sql, clanId, latest, { clanWeight: o.clanWeight });
            latest = closedNow.ballot;
        } else {
            // The running ballot is the answer. Nothing to roll.
            return { epoch: epoch, ballot: latest, opened: false, closedNow: null, retired: null,
                     targetIndex: latest.epochIndex };
        }
    }

    const cur = epoch.epochIndex;
    const lastIdx = latest && latest.epochIndex != null ? latest.epochIndex : null;
    const target = lastIdx != null && lastIdx >= cur ? lastIdx + 1 : cur;

    const inserted = await insertEpochBallot(
        sql, clanId, target, orderPerks.selectBallotOptions(), epoch.endsAt, target - cur);
    if (inserted) {
        console.log('[clan-ballot] roll opened ballot=' + inserted.ballotId + ' clan=' + clanId +
            ' epoch=' + target + ' (current ' + cur + ') options=' + inserted.options.join(','));
        let opened = withOffset(inserted, off);
        if (off > 0) {
            // The INSERT's RETURNING carries the STORED closes_at only (the effective-close
            // expression is spelled in the two reads, not a third time here). Under a live
            // offset the client must be told the EFFECTIVE close, so ONE re-read through the
            // spelled expression. At offset 0 stored == effective and no query is spent.
            const reread = await readLatestBallot(sql, clanId, readOpts);
            if (reread && reread.ballotId === inserted.ballotId) opened = reread;
            console.warn('[clan-ballot] roll opened ballot=' + inserted.ballotId + ' under close-early override' +
                ' offset_s=' + off + ' stored_closes_at=' + String(inserted.closesAt) +
                ' effective_closes_at=' + String(opened.effectiveClosesAt));
        }
        return { epoch: epoch, ballot: opened, opened: true, closedNow: closedNow, retired: retired,
                 targetIndex: target };
    }

    // Lost the race (or the slot is held): the row that won is the truth. ONE re-read,
    // never a retry loop.
    const fresh = await readLatestBallot(sql, clanId, readOpts);
    console.log('[clan-ballot] roll found epoch ' + target + ' already opened clan=' + clanId);
    return { epoch: epoch, ballot: fresh || latest, opened: false, closedNow: closedNow, retired: retired,
             targetIndex: target };
}

/**
 * WO-2031. What the Order's last CLOSED ballot decided, for `last_result` and the
 * ceremony — plus the self-heal: if that ballot's outcome never reached clan_perks (a
 * perk write that failed after the close committed), it is applied now.
 *
 * `known` is a settle result this request already holds (rollEpoch's `closedNow`); when
 * present it is used instead of re-reading.
 */
async function readLastResult(sql, clanId, known) {
    if (known && known.ballot && known.ballot.closedAt != null && known.decision) {
        return { ballot: known.ballot, passed: known.decision.passed, reason: known.decision.reason };
    }
    const last = await readLastClosedBallot(sql, clanId);
    if (!last) return null;
    const passed = last.winningOption != null;
    let reason = REASON_PASSED;
    if (!passed) {
        const votes = await readVotes(sql, last.ballotId);
        reason = votes.length > 0 ? REASON_INSUFFICIENT_TURNOUT : REASON_NO_VOTES;
    }
    if (last.epochIndex != null) {
        const active = (await readPerks(sql, clanId))[0] || null;
        if (outcomeIsStale(active, last, passed)) await applyEpochOutcome(sql, clanId, last);
    }
    return { ballot: last, passed: passed, reason: reason };
}

/**
 * WO-2031. End ONE Order's epoch now — the admin demo lever
 * (api/admin/order-epoch-force.js). Sets the open ballot's closes_at to NOW(), then rolls:
 * the roll settles it (the one active perk) and opens the next epoch's ballot.
 *
 * ⛔ SCOPED BY clan_id IN THE STATEMENT ITSELF, so a wrong ballot id can never close
 * another Order's vote.
 */
async function forceEpochEnd(sql, clanId) {
    const latest = await readLatestBallot(sql, clanId);
    let forcedBallotId = null;
    if (latest && latest.closedAt == null) {
        const rows = await sql`
            UPDATE clan_ballots SET closes_at = NOW()
            WHERE id = ${latest.ballotId} AND clan_id = ${clanId} AND closed_at IS NULL
            RETURNING id
        `;
        if (rows && rows.length > 0) forcedBallotId = latest.ballotId;
    }
    console.log('[clan-ballot] force epoch end clan=' + clanId + ' ballot=' + (forcedBallotId || 'none-open'));
    const rolled = await rollEpoch(sql, clanId);
    return { forcedBallotId: forcedBallotId, rolled: rolled };
}

// ── The Vigil seam ───────────────────────────────────────────────────────────

/**
 * The clan's Vigil, and ONE member's contribution out of it.
 *
 * ⛔ IT REUSES readClanVigil RATHER THAN SPELLING A SECOND TENURE QUERY. The propose
 * path needs the clan's `vigil_weight` for the tier gate and the vote path needs the
 * caller's `vigil_contribution` for the weight snapshot; both are rows of the same
 * read, which is already bounded (VIGIL_READ_CONCURRENCY = 5) and already cached
 * (skr-staking's 60-second per-wallet cache). A second, narrower query would be a second
 * spelling of "how long has this wallet been staked", i.e. duplicated state.
 *
 * `opts.readVigil` is the injection seam the tests use so ballot logic can be proven
 * without a Solana RPC — the arithmetic itself is already proven in
 * test/clan-vigil.test.js and is not re-proven here.
 */
async function readVigilFor(sql, clanId, wallet, opts) {
    const options = opts || {};
    const read = typeof options.readVigil === 'function' ? options.readVigil : readClanVigil;
    const vigil = await read(sql, clanId, options.vigilOpts);
    const members = (vigil && vigil.members) || [];
    const mine = wallet ? members.find((m) => m.wallet === String(wallet)) || null : null;
    return {
        vigilWeight: Number(vigil && vigil.vigilWeight) || 0,
        memberCount: Number(vigil && vigil.memberCount) || members.length,
        degraded: !!(vigil && vigil.degraded),
        member: mine,
        // The caller's OWN read is what gates their vote: a clan-wide degradation caused
        // by somebody else's unreadable wallet must not block a member whose own position
        // read cleanly.
        memberDegraded: mine ? mine.degraded === true : false,
        myContribution: mine ? Number(mine.vigilContribution) || 0 : 0,
    };
}

// ── The wire ─────────────────────────────────────────────────────────────────

/**
 * snake_case on the wire, matching the vigil endpoint's toWire and the work order's own
 * literal `{ closed: true, passed: false, reason: 'insufficient_turnout' }`.
 *
 * ⛔ TALLIES ARE PUBLIC; WHO VOTED FOR WHAT IS NOT. The response carries a per-option
 * weight-and-count tally plus the CALLER'S OWN vote, and never a wallet-to-option map.
 * The work order says "the open ballot + votes + caller's own vote", which this satisfies
 * without publishing a member's choice to their clan; the standing convention elsewhere
 * in this API is that a wallet is never rendered where a tally or a count would do
 * (clan.js getLeaderboard's header states it). A secret ballot with public totals is
 * also the shape every real vote takes. Flagged for the owner as a reviewable ruling.
 *
 * ⛔ WO-2031: THE WIRE SPEAKS ONLY api/_lib/order-perk-catalog.js. Every option and every
 * perk is rendered as { id, name KEY, emblem id, motif id } — no title, no effect, no
 * description, no English at all (the client localizes the key, WO-2032). The retired
 * PERK_OPTIONS stat catalogue is never read on this path; test/clan-ballot.test.js walks
 * every response for its strings.
 *
 * The shape (WO-2031; the client lane WO-2032 reads it):
 *
 *   ballot  { ballot_id, kind:'epoch'|'legacy', epoch_index, tier, closed, opened_at,
 *             closes_at, closed_at, options:[ OPTION ], my_vote, can_vote, turnout }
 *   OPTION  { option_id, perk_id, name_key, emblem, tree_motif_id, weight, voters }
 *   result  { closed:true, passed, reason, winning_option, perk_id, epoch_index } — the
 *             Order's LAST CLOSED ballot (with auto-open, the current one is always open)
 *   perk    { perk_id, name_key, emblem, tree_motif_id, epoch_index, applies_to_epoch,
 *             activated_at } | null — the ONE active perk
 *   perks   [ perk ] — the same record as a 0..1 list, for the existing binding
 */
function toWire(state) {
    const s = state || {};
    const ballot = s.ballot || null;
    const decision = s.decision || null;
    const epoch = s.epoch || null;
    const closed = closedOutcome(s, ballot, decision);
    const active = activePerk(s);
    const wireEndsAt = epochWireEndsAt(epoch, ballot);

    const body = {
        ok: true,
        headline: BALLOT_HEADLINE,
        epoch: epoch ? {
            index: epoch.epochIndex,
            started_at: epoch.startedAt,
            ends_at: wireEndsAt,
            anchor: EPOCH_ANCHOR_ISO,
            seconds: EPOCH_SECONDS,
            // The close-early override in force when this answer was built (0 = none). The
            // client needs no change: ends_at / closes_at already carry the EFFECTIVE close.
            close_offset_seconds: ballotOffset(ballot),
        } : null,
        tiers: tierWire(s.vigilWeight),
        vigil_weight: s.vigilWeight != null ? Number(s.vigilWeight) : null,
        vigil_degraded: s.vigilDegraded === true,
        ballot: null,
        result: null,
        perk: active ? perkWire(active) : null,
        perks: active ? [perkWire(active)] : [],
        // WO-2061h - owner 2026-09-25: "We need the leaves to be added to tree on any votes" +
        // "The higher the stake the more alive it displays" / "For all the circle". The whole
        // Circle's verified stake (null when the route did not / could not read it) and the
        // canopy fullness the SERVER derives from it: 0 with no resolved vote (no active banner),
        // else api/_lib/realm-config.json circleCanopy. The client is told a float, never a ladder.
        circle_staked_skr: Number.isFinite(s.circleStakedSkr) ? Math.floor(s.circleStakedSkr) : null,
        canopy_density01: require('./realm-stake').circleCanopyDensity(
            !!active, Number.isFinite(s.circleStakedSkr) ? s.circleStakedSkr : NaN),
    };

    if (ballot) {
        const tallies = decision ? decision.tally.tallies : [];
        const turnout = decision ? decision.turnout : null;
        const isClosed = ballot.closedAt != null;
        const myVote = s.myVote != null ? String(s.myVote) : null;
        const kind = ballot.epochIndex != null ? 'epoch' : 'legacy';
        body.ballot = {
            ballot_id: ballot.ballotId,
            kind: kind,
            epoch_index: ballot.epochIndex != null ? ballot.epochIndex : null,
            tier: ballot.tier,
            closed: isClosed,
            opened_at: ballot.openedAt,
            // The EFFECTIVE close (== the stored closes_at at offset 0), so a client counts
            // down to the moment the server will actually settle this ballot.
            closes_at: ballot.effectiveClosesAt != null ? ballot.effectiveClosesAt : ballot.closesAt,
            closed_at: ballot.closedAt,
            options: ballot.options.map((id) => {
                const t = tallies.find((x) => x.optionId === id);
                return Object.assign(optionWire(id), {
                    weight: t ? t.weight : 0,
                    voters: t ? t.voters : 0,
                });
            }),
            my_vote: myVote,
            // Votes are FINAL (owner, 2026-09-24): once my_vote is set, never again.
            can_vote: !isClosed && !ballot.expired && myVote == null && kind === 'epoch',
            turnout: turnout ? {
                voters: turnout.voters,
                member_count: turnout.memberCount,
                required_voters: turnout.requiredVoters,
                required_ratio: turnout.requiredRatio,
                ratio: turnout.ratio,
                weighted_turnout: turnout.weightedTurnout,
                clears: turnout.clears,
            } : null,
        };
    }

    if (closed) {
        body.result = {
            closed: true,
            passed: closed.passed,
            reason: closed.reason,
            winning_option: closed.ballot.winningOption,
            perk_id: closed.perkId,
            epoch_index: closed.epochIndex,
        };
    }

    body.ceremony = ceremonyWire(s, closed, active, epoch, wireEndsAt);
    return body;
}

/** The close-early offset the ballot was read under; 0 when there is no ballot or no offset. */
function ballotOffset(ballot) {
    const n = ballot ? Number(ballot.closeOffsetSeconds) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `epoch.ends_at` (and `ceremony.next_ends_at`, which the client treats as the same instant).
 *
 * Offset 0: epoch.endsAt, exactly as before — nothing about the wire changes while the
 * override is off. Offset > 0 with an OPEN epoch ballot: that ballot's EFFECTIVE close, the
 * moment the server will actually settle and roll. (Not `endsAt - offset`: after an early
 * settle the next ballot runs for the NEXT epoch index, and `endsAt - offset` would already
 * be in the past, so every countdown would read zero.) Anything else: epoch.endsAt.
 */
function epochWireEndsAt(epoch, ballot) {
    if (!epoch) return null;
    if (ballotOffset(ballot) > 0 && ballot.closedAt == null && ballot.epochIndex != null &&
        ballot.effectiveClosesAt != null) {
        return ballot.effectiveClosesAt;
    }
    return epoch.endsAt;
}

/** One ballot option: catalog fields for a banner, bare id for a retired (legacy) option. */
function optionWire(id) {
    const rec = orderPerks.findOrderPerk(id);
    return {
        option_id: String(id),
        perk_id: rec ? rec.perkId : null,
        name_key: rec ? rec.nameKey : null,
        emblem: rec ? rec.emblem : null,
        tree_motif_id: motifFor(id),
    };
}

/** The one active perk. Only a catalog banner is ever rendered — never a legacy stat row. */
function perkWire(p) {
    const rec = orderPerks.findOrderPerk(p.perkId);
    const epochIndex = p.epochIndex != null ? p.epochIndex : null;
    return {
        perk_id: rec ? rec.perkId : null,
        name_key: rec ? rec.nameKey : null,
        emblem: rec ? rec.emblem : null,
        tree_motif_id: motifFor(p.perkId),
        // The epoch the vote RAN in; the banner is worn through the one after it.
        epoch_index: epochIndex,
        applies_to_epoch: epochIndex != null ? epochIndex + 1 : null,
        activated_at: p.activatedAt != null ? p.activatedAt : null,
    };
}

/** The Order's active perk record: the listed one, else the one this request just wrote. */
function activePerk(s) {
    const listed = (s.perks || []).find((p) => p && orderPerks.isOrderPerkId(p.perkId));
    if (listed) return listed;
    return s.perk && orderPerks.isOrderPerkId(s.perk.perkId) ? s.perk : null;
}

/**
 * The closed ballot the `result` and the ceremony describe: the caller's `lastResult`
 * (rollEpoch / readLastResult — the current ballot is open once the next epoch rolled), or
 * the ballot itself when IT is the closed one (the vote route's 409 path, legacy callers).
 */
function closedOutcome(s, ballot, decision) {
    let b = null;
    let passed = false;
    let reason = null;
    if (s.lastResult && s.lastResult.ballot && s.lastResult.ballot.closedAt != null) {
        b = s.lastResult.ballot;
        passed = s.lastResult.passed === true;
        reason = s.lastResult.reason || (passed ? REASON_PASSED : REASON_NO_VOTES);
    } else if (ballot && ballot.closedAt != null && decision) {
        b = ballot;
        passed = decision.passed === true;
        reason = decision.reason;
    }
    if (!b) return null;
    const rec = passed && b.epochIndex != null ? orderPerks.findOrderPerk(b.winningOption) : null;
    return {
        ballot: b,
        passed: passed,
        reason: reason,
        perkId: rec ? rec.perkId : null,
        epochIndex: b.epochIndex != null ? b.epochIndex : settledEpochIndex(b),
    };
}

/**
 * Additive ceremony object. Always present. Word follows CURRENT vigil_weight,
 * never the ballot's tier number.
 *
 * ⛔ WO-2031: the ceremony names its perk by catalog id + name KEY + emblem. The old
 * `perk_title` / `perk_description` fields carried the retired stat catalogue's English and
 * are GONE, not emptied — an empty string would still be a server-authored text field.
 */
function ceremonyWire(s, closed, active, epoch, wireEndsAt) {
    const unlocked = highestUnlockedTier(s.vigilWeight);
    const passed = !!(closed && closed.passed);
    // A closed ballot names its OWN outcome (a failed one names none, and its banner has
    // gone dark); with no closed ballot yet, the active perk, if any.
    const perkId = closed ? (passed ? closed.perkId : null) : (active ? active.perkId : null);
    const rec = orderPerks.findOrderPerk(perkId);
    let epochIndex = closed ? closed.epochIndex : null;
    if (epochIndex == null && active && active.epochIndex != null) epochIndex = active.epochIndex;
    return {
        epoch_index: epochIndex,
        word: TIER_WORDS[unlocked] || '',
        line: TIER_LINES[unlocked] || '',
        circle_name: s.circleName ? String(s.circleName) : '',
        perk_id: rec ? rec.perkId : null,
        perk_name_key: rec ? rec.nameKey : null,
        perk_emblem: rec ? rec.emblem : null,
        // WO-1921 state 4 fires off the CEREMONY, so the motif has to arrive on the same
        // object as the perk. No perk (or an unknown one) reads as dormant, never null.
        tree_motif_id: rec ? motifFor(rec.perkId) : DEFAULT_TREE_MOTIF_ID,
        passed: passed,
        // The same instant as epoch.ends_at (epochWireEndsAt), override included.
        next_ends_at: wireEndsAt !== undefined
            ? (wireEndsAt != null ? wireEndsAt : null)
            : (epoch && epoch.endsAt != null ? epoch.endsAt : null),
    };
}

/**
 * The Vigil ladder: each tier's bar and whether this Order's Vigil has reached it (the
 * ceremony word follows it). ⛔ WO-2031: NO `options` — the per-tier stat slate was the
 * propose menu, propose is gone (410), and those rows are ruling-3 stat perks.
 */
function tierWire(vigilWeight) {
    const out = [];
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier++) {
        out.push({
            tier: tier,
            threshold: TIER_THRESHOLDS[tier],
            // Tier 1's bar is "any Vigil at all"; meetsTier owns that asymmetry.
            unlocked: vigilWeight != null ? meetsTier(vigilWeight, tier) : null,
        });
    }
    return out;
}

function isUuid(raw) {
    const s = raw == null ? '' : String(raw).trim();
    return s !== '' && UUID_RE.test(s);
}

module.exports = {
    BallotCode,
    EPOCH_ANCHOR_ISO,
    EPOCH_SECONDS,
    TIER_THRESHOLDS,
    TIER_WORDS,
    TIER_LINES,
    MIN_TIER,
    MAX_TIER,
    PERK_OPTIONS,
    PERK_MOTIFS,
    DEFAULT_TREE_MOTIF_ID,
    PARTICIPATION_BANDS,
    BALLOT_HEADLINE,
    REASON_PASSED,
    REASON_NO_VOTES,
    REASON_INSUFFICIENT_TURNOUT,
    // pure
    meetsTier,
    highestUnlockedTier,
    normalizeTier,
    normalizeOptionIds,
    tierOptions,
    describeOption,
    describePerk,
    motifFor,
    perkIdFor,
    settledEpochIndex,
    participationBand,
    requiredVoters,
    evaluateTurnout,
    tallyVotes,
    decideBallot,
    isUuid,
    tierWire,
    toWire,
    // IO
    readEpoch,
    readLatestBallot,
    readBallotInClan,
    readVotes,
    readMemberCount,
    readPerks,
    readLastClosedBallot,
    readLastResult,
    insertEpochBallot,
    upsertVote,
    closeBallot,
    writeEpochPerk,
    deactivatePerksBefore,
    applyEpochOutcome,
    outcomeIsStale,
    settleBallot,
    rollEpoch,
    forceEpochEnd,
    ensureEpochColumns,
    readVigilFor,
    uniqueViolation,
    // WO-2031
    AUTO_BALLOT_TIER,
    EPOCH_PERK_SLOT,
    // The close-early override (Command Center, serverOnly)
    EPOCH_CLOSE_EARLY_KEY,
    EPOCH_CLOSE_EARLY_DEFAULT_SECONDS,
    EPOCH_CLOSE_EARLY_MAX_SECONDS,
    EPOCH_MIN_OPEN_SECONDS,
    resolveCloseEarlySeconds,
    readCloseEarly,
    epochWireEndsAt,
};
