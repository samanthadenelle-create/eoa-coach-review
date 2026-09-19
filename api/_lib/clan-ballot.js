// =============================================================================
// api/_lib/clan-ballot.js — WO-1853 (clan WO-10). The perk ballot.
// -----------------------------------------------------------------------------
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
    WEIGHT_UNAVAILABLE: 'CLAN_BALLOT_WEIGHT_UNAVAILABLE',  // 503 — the chain read degraded; ask again
};

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
const PERK_OPTIONS = {
    1: [
        { optionId: 'build_speed_1', perkId: 'clan_build_speed_1',
          title: 'Steady Hands', effect: '+5% build speed',
          description: 'The ancestors steady every hammer in the town.' },
        { optionId: 'harvest_yield_1', perkId: 'clan_harvest_yield_1',
          title: 'Full Baskets', effect: '+3% harvest yield',
          description: 'The ancestors bless the fields your people work.' },
    ],
    2: [
        { optionId: 'build_speed_2', perkId: 'clan_build_speed_2',
          title: 'Sure Hands', effect: '+10% build speed',
          description: 'Scaffolds rise without a wasted motion.' },
        { optionId: 'harvest_yield_2', perkId: 'clan_harvest_yield_2',
          title: 'Heavy Baskets', effect: '+6% harvest yield',
          description: 'What the fields give, they give generously.' },
        { optionId: 'wall_hp_1', perkId: 'clan_wall_hp_1',
          title: 'Old Stone', effect: '+5% wall HP',
          description: 'The stones remember standing, and stand a little longer.' },
    ],
    3: [
        { optionId: 'build_speed_3', perkId: 'clan_build_speed_3',
          title: 'Tireless Hands', effect: '+15% build speed',
          description: 'The work goes on while the town sleeps.' },
        { optionId: 'harvest_yield_3', perkId: 'clan_harvest_yield_3',
          title: 'Overflowing Baskets', effect: '+10% harvest yield',
          description: 'The fields answer the vigil that was kept over them.' },
        { optionId: 'wall_hp_2', perkId: 'clan_wall_hp_2',
          title: 'Deep Stone', effect: '+10% wall HP',
          description: 'What the ancestors laid down does not give way easily.' },
    ],
    4: [
        { optionId: 'new_building', perkId: 'clan_new_building',
          title: 'A Shape Remembered', effect: 'Unlocks a new building type',
          description: 'A structure your people had forgotten how to raise.' },
        { optionId: 'turret_variant', perkId: 'clan_turret_variant',
          title: 'The Watchful Tower', effect: 'Unlocks a defensive turret variant',
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
          description: 'The ancestors stir. A new shape is possible.' },
    ],
};

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
        // Computed by POSTGRES in the same statement, never by comparing Date.now().
        expired: r.expired === true,
    };
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
async function readLatestBallot(sql, clanId) {
    const rows = await sql`
        SELECT id, clan_id, proposed_by_wallet, tier, options, opened_at,
               closes_at, closed_at, winning_option,
               (closed_at IS NULL AND closes_at <= NOW()) AS expired
        FROM clan_ballots
        WHERE clan_id = ${clanId}
        ORDER BY opened_at DESC, id ASC
        LIMIT 1
    `;
    return rowToBallot(rows && rows[0] ? rows[0] : null);
}

/** ONE ballot by id, and only if it belongs to the caller's own clan (see above). */
async function readBallotInClan(sql, clanId, ballotId) {
    const rows = await sql`
        SELECT id, clan_id, proposed_by_wallet, tier, options, opened_at,
               closes_at, closed_at, winning_option,
               (closed_at IS NULL AND closes_at <= NOW()) AS expired
        FROM clan_ballots
        WHERE clan_id = ${clanId} AND id = ${ballotId}
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

async function readPerks(sql, clanId) {
    const rows = await sql`
        SELECT tier, perk_id, activated_at, expires_at
        FROM clan_perks
        WHERE clan_id = ${clanId}
        ORDER BY tier ASC
    `;
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
        tier: Number(r.tier),
        perkId: String(r.perk_id),
        activatedAt: r.activated_at,
        expiresAt: r.expires_at != null ? r.expires_at : null,
    }));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Open a ballot. `closesAt` is the epoch boundary readEpoch() returned — a value Postgres
 * computed, bound here, so the anchor arithmetic is not spelled a second time.
 *
 * A 23505 here is the partial unique index refusing a SECOND open ballot, which is
 * acceptance criterion 7's race arm and the caller answers as a 409.
 */
async function insertBallot(sql, clanId, wallet, tier, optionIds, closesAt) {
    const rows = await sql`
        INSERT INTO clan_ballots (clan_id, proposed_by_wallet, tier, options, opened_at, closes_at)
        VALUES (${clanId}, ${wallet}, ${tier}, ${JSON.stringify(optionIds)}::jsonb, NOW(), ${closesAt})
        RETURNING id, clan_id, proposed_by_wallet, tier, options, opened_at,
                  closes_at, closed_at, winning_option, FALSE AS expired
    `;
    return rowToBallot(rows && rows[0] ? rows[0] : null);
}

/**
 * Cast or MOVE one vote.
 *
 * ⛔ THE CONFLICT CLAUSE SETS option_id AND NOTHING ELSE — acceptance criterion 4,
 * "re-voting updates the option, not the weight". `weight` and `voted_at` are the
 * snapshot taken when the member FIRST voted, and a member who re-votes after their
 * stake or tenure changed keeps the weight they had, in both directions. This is the
 * same single-column discipline the WO-1844 invariant states for wallet_identity's
 * `last_seen_at` UPSERT (test/clan-vigil.test.js:939 pins that one).
 */
async function upsertVote(sql, ballotId, wallet, optionId, weight) {
    const rows = await sql`
        INSERT INTO clan_ballot_votes (ballot_id, wallet, option_id, voted_at, weight)
        VALUES (${ballotId}, ${wallet}, ${optionId}, NOW(), ${weight})
        ON CONFLICT (ballot_id, wallet) DO UPDATE SET
            option_id = EXCLUDED.option_id
        RETURNING wallet, option_id, weight::float8 AS weight, voted_at
    `;
    const r = rows && rows[0] ? rows[0] : null;
    if (!r) return null;
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
 * Activate a perk.
 *
 * ⛔ ON CONFLICT (clan_id, tier) DO UPDATE — the primary key is (clan_id, tier), so a
 * clan holds ONE perk per tier and a later winning ballot at the same tier REPLACES it.
 * That is an engineering reading of a schema the work order fixed, not an owner ruling;
 * the alternatives (refuse the write, or grow a history table) both contradict the
 * schema as written. Recorded in the work order's implementation record.
 *
 * expires_at is written NULL, always. See the migration's header.
 */
async function writePerk(sql, clanId, tier, perkId) {
    const rows = await sql`
        INSERT INTO clan_perks (clan_id, tier, perk_id, activated_at, expires_at)
        VALUES (${clanId}, ${tier}, ${perkId}, NOW(), NULL)
        ON CONFLICT (clan_id, tier) DO UPDATE SET
            perk_id = EXCLUDED.perk_id,
            activated_at = NOW(),
            expires_at = NULL
        RETURNING clan_id, tier, perk_id, activated_at, expires_at
    `;
    const r = rows && rows[0] ? rows[0] : null;
    if (!r) return null;
    return {
        tier: Number(r.tier),
        perkId: String(r.perk_id),
        activatedAt: r.activated_at,
        expiresAt: r.expires_at != null ? r.expires_at : null,
    };
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
        let perk = await findPerk(sql, clanId, ballot.tier);
        let perkWritten = false;
        if (passed && !perk) {
            perk = await tryWritePerk(sql, clanId, ballot.tier, perkIdFor(ballot.tier, ballot.winningOption));
            perkWritten = perk != null;
        }
        return { ballot: ballot, votes: votes, memberCount: memberCount,
                 decision: decision, perk: perk, closedNow: false, perkWritten: perkWritten };
    }

    // Expired and open: decide it, then try to be the one that closes it.
    const decision = decideBallot(votes, memberCount, clanWeight);
    const won = await closeBallot(sql, ballot.ballotId, decision.passed ? decision.winner : null);
    if (!won.closed) {
        // Somebody else closed it between our read and our write. Their row is the truth.
        const fresh = await readBallotInClan(sql, clanId, ballot.ballotId);
        return settleBallot(sql, clanId, fresh, opts);
    }

    const closedBallot = Object.assign({}, ballot, {
        closedAt: won.closedAt,
        winningOption: decision.passed ? decision.winner : null,
        expired: false,
    });

    let perk = null;
    if (decision.passed) {
        perk = await tryWritePerk(sql, clanId, ballot.tier, perkIdFor(ballot.tier, decision.winner));
    }
    return { ballot: closedBallot, votes: votes, memberCount: memberCount,
             decision: decision, perk: perk, closedNow: true, perkWritten: perk != null };
}

async function findPerk(sql, clanId, tier) {
    const perks = await readPerks(sql, clanId);
    return perks.find((p) => p.tier === Number(tier)) || null;
}

/**
 * NEVER THROWS. A perk that could not be written is re-attempted by the next read (see
 * settleBallot); a throw here would turn a WON ballot into a 500 and lose the close that
 * already committed.
 */
async function tryWritePerk(sql, clanId, tier, perkId) {
    if (!perkId) {
        console.warn('[clan-ballot] winning option has no perk id (tier ' + tier + ') — no perk written');
        return null;
    }
    try {
        return await writePerk(sql, clanId, tier, perkId);
    } catch (err) {
        console.error('[clan-ballot] perk write failed — the next read will retry it:', err && err.message);
        return null;
    }
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
 */
function toWire(state) {
    const s = state || {};
    const ballot = s.ballot || null;
    const decision = s.decision || null;
    const epoch = s.epoch || null;

    const body = {
        ok: true,
        headline: BALLOT_HEADLINE,
        epoch: epoch ? {
            index: epoch.epochIndex,
            started_at: epoch.startedAt,
            ends_at: epoch.endsAt,
            anchor: EPOCH_ANCHOR_ISO,
            seconds: EPOCH_SECONDS,
        } : null,
        tiers: tierWire(s.vigilWeight),
        vigil_weight: s.vigilWeight != null ? Number(s.vigilWeight) : null,
        vigil_degraded: s.vigilDegraded === true,
        ballot: null,
        result: null,
        perks: (s.perks || []).map((p) => {
            const desc = describePerk(p.perkId);
            return {
                tier: p.tier,
                perk_id: p.perkId,
                activated_at: p.activatedAt,
                expires_at: p.expiresAt,
                title: desc && desc.title ? desc.title : '',
                description: desc && desc.description ? desc.description : '',
            };
        }),
    };

    if (ballot) {
        const tallies = decision ? decision.tally.tallies : [];
        const turnout = decision ? decision.turnout : null;
        body.ballot = {
            ballot_id: ballot.ballotId,
            tier: ballot.tier,
            closed: ballot.closedAt != null,
            opened_at: ballot.openedAt,
            closes_at: ballot.closesAt,
            closed_at: ballot.closedAt,
            options: ballot.options.map((id) => {
                const o = describeOption(ballot.tier, id);
                const t = tallies.find((x) => x.optionId === id);
                return {
                    option_id: o.optionId,
                    title: o.title,
                    effect: o.effect,
                    description: o.description,
                    weight: t ? t.weight : 0,
                    voters: t ? t.voters : 0,
                };
            }),
            my_vote: s.myVote != null ? String(s.myVote) : null,
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

    if (ballot && ballot.closedAt != null && decision) {
        body.result = {
            closed: true,
            passed: decision.passed,
            reason: decision.reason,
            winning_option: ballot.winningOption,
            perk_id: s.perk ? s.perk.perkId : null,
        };
    }

    body.ceremony = ceremonyWire(s, ballot, decision, epoch);
    return body;
}

function mostRecentPerk(perks) {
    const list = perks || [];
    let best = null;
    let bestMs = -Infinity;
    for (const p of list) {
        const ms = parseTimeMs(p && p.activatedAt);
        if (ms == null) continue;
        if (ms >= bestMs) {
            bestMs = ms;
            best = p;
        }
    }
    if (best) return best;
    return list.length > 0 ? list[list.length - 1] : null;
}

function ceremonyPerk(s, ballot, decision) {
    const passed = !!(ballot && ballot.closedAt != null && decision && decision.passed);
    if (passed) {
        const perkId = (s.perk && s.perk.perkId) || perkIdFor(ballot.tier, ballot.winningOption);
        return describePerk(perkId);
    }
    const recent = mostRecentPerk(s.perks);
    return recent ? describePerk(recent.perkId) : null;
}

/**
 * Additive ceremony object. Always present. Word follows CURRENT vigil_weight,
 * never the ballot's tier number. perk_title/description never copy `effect`.
 */
function ceremonyWire(s, ballot, decision, epoch) {
    const unlocked = highestUnlockedTier(s.vigilWeight);
    const passed = !!(ballot && ballot.closedAt != null && decision && decision.passed);
    let epochIndex = null;
    if (ballot && ballot.closedAt != null) {
        epochIndex = settledEpochIndex(ballot);
    } else {
        const recent = mostRecentPerk(s.perks);
        if (recent && parseTimeMs(recent.activatedAt) != null) {
            epochIndex = epochIndexFromTimestamp(recent.activatedAt);
        }
    }
    const perk = ceremonyPerk(s, ballot, decision);
    return {
        epoch_index: epochIndex,
        word: TIER_WORDS[unlocked] || '',
        line: TIER_LINES[unlocked] || '',
        circle_name: s.circleName ? String(s.circleName) : '',
        perk_title: perk && perk.title ? String(perk.title) : '',
        perk_description: perk && perk.description ? String(perk.description) : '',
        passed: passed,
        next_ends_at: epoch && epoch.endsAt != null ? epoch.endsAt : null,
    };
}

/** Which tiers this clan's Vigil can currently open, and what each one offers. */
function tierWire(vigilWeight) {
    const out = [];
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier++) {
        out.push({
            tier: tier,
            threshold: TIER_THRESHOLDS[tier],
            // Tier 1's bar is "any Vigil at all"; meetsTier owns that asymmetry.
            unlocked: vigilWeight != null ? meetsTier(vigilWeight, tier) : null,
            options: tierOptions(tier).map((o) => ({
                option_id: o.optionId, title: o.title, effect: o.effect, description: o.description,
            })),
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
    insertBallot,
    upsertVote,
    closeBallot,
    writePerk,
    settleBallot,
    readVigilFor,
    uniqueViolation,
};
