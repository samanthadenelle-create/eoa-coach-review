// =============================================================================
// api/_lib/clan.js — WO-1845 (clan step 2) + WO-1846 (step 3: roles, authorization
// and leader succession). ALL clan membership logic, in ONE place, with the
// database client INJECTED.
// -----------------------------------------------------------------------------
// The routes under api/clan/ are deliberately thin: CORS, raw body, auth,
// then one call into this file. Every rule that matters — the code alphabet, the
// validation bounds, the one-clan-per-wallet refusal, the leader guard — lives
// here exactly once, so test/clan-membership.test.js can prove all of it against
// a recording tagged-template mock with zero network, zero database and zero Unity
// (the pattern api/_lib/account-deletion.js established and
// test/wallet-identity.test.js exercises).
//
// ── THREE PROPERTIES THIS FILE IS WRITTEN AROUND ────────────────────────────
//
// 1. THE INVITE CODE IS MINTED SERVER-SIDE, AND IT IS THE POINT OF THE TICKET.
//    The client's ClanService.GenerateClanCode() (Assets/_Modules/Core/Services/
//    ClanService.cs:332) mints a 6-char code from the same alphabet and validates
//    NOTHING and collides with NOTHING, because there was no server to collide
//    with. Here the code is drawn with crypto.randomInt (never Math.random — a
//    predictable invite code is a joinable clan) and the DATABASE decides
//    uniqueness: on a 23505 against clans_code_key we draw again, up to
//    MAX_CODE_ATTEMPTS. There is deliberately NO pre-SELECT of the code, because
//    "is this code free" answered before the INSERT is a race, not a check.
//
// 2. ONE CLAN PER WALLET IS ENFORCED BY THE INDEX, NOT BY THE READ.
//    clan_members_one_clan_per_wallet (migration 0030) is the authority. The
//    friendly 409 comes from a cheap membership read, but the read is a COURTESY:
//    two simultaneous joins both pass it, and the second one is refused by the
//    database and mapped back to the identical 409 here. A check that only exists
//    in JS is a check two requests walk straight past.
//
// 3. EVERY MULTI-ROW WRITE IS ONE STATEMENT.
//    Creating a clan writes a clans row AND a clan_members row; leaving writes a
//    member removal AND (conditionally) a clan removal. The Neon HTTP driver sends
//    one statement per call, so a two-call version has a window in which a clan
//    exists with no leader, or a clan is removed while a join is landing in it.
//    Both are written as a single data-modifying CTE instead, which is atomic by
//    construction.
//
//    ⚠ AND THE SNAPSHOT RULE THAT SHAPES THE LEAVE STATEMENT: sub-statements in a
//    WITH clause all see the SAME snapshot, so the emptiness test canNOT be
//    "no rows in clan_members for this clan" — the row being removed by the sibling
//    CTE is still visible to it, and the clan would never be cleaned up. The
//    predicate is therefore "no member OTHER THAN me", which is both correct under
//    the shared snapshot and the honest statement of the question.
//
// ── WO-1846 ADDS A FOURTH PROPERTY, AND IT IS THE ONE THAT KEEPS ROLES HONEST ──
//
// 4. AUTHORIZATION IS CHECKED TWICE: ONCE TO ANSWER, ONCE TO ACT.
//    Every role write reads the caller's and the target's roles first — that read is
//    what produces the 403 / 409 / 404 the player sees, because a bare "0 rows
//    affected" cannot tell "you are not the Leader" from "they already are an
//    Officer". But the read is NOT the authority: the same predicates are repeated
//    INSIDE the UPDATE / DELETE (`AND role = 'member'`, plus an `EXISTS` re-asserting
//    the CALLER's role), so a caller demoted between the two calls cannot still act,
//    and a target promoted in that window is not double-promoted. Zero rows after a
//    read that said yes is reported as a RACE, never as a success. This is the same
//    belt-and-braces shape leaveClan already used for its leader guard.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore), so this is
// a library and never an endpoint. CommonJS, no npm dependencies.
// =============================================================================

'use strict';

const crypto = require('crypto');
// The wallet shape, IMPORTED rather than re-spelled. A kick/promote body names its
// target by address, and a second copy of WALLET_RE in this file is exactly the
// duplicated-state failure CLAUDE.md §5 / §8 describe: the day the canonical regex
// moves, the copy silently starts refusing valid wallets. wallet-auth.js requires
// nothing from this file, so there is no cycle.
const { isWalletId } = require('./wallet-auth');

// The spec alphabet, identical to the client's CodeAlphabet (ClanService.cs:333):
// no O/0, no I/1, so a code read aloud or off a screenshot cannot be mistyped into
// a different clan. The migration's clans_code_format CHECK is the same set
// expressed as a range, and the two must never disagree.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Mirrors CONSTRAINT clans_code_format in api/migrations/20260917_0030_clan_tables.sql.
// Validated HERE as well as there so a bad code is a 400 with a stable machine code
// rather than a 23514 surfacing as an opaque 500.
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const CODE_LEN = 6;
// Ten draws from 32^6 (~1.07 billion) codes. At any clan count this game will ever
// see, ten collisions in a row is not a collision problem, it is a broken database —
// so exhausting the loop is reported as a server failure and never as a bad request.
const MAX_CODE_ATTEMPTS = 10;

// Mirrors clans_name_len / clans_tag_len in the same migration.
const NAME_MIN = 1;
const NAME_MAX = 32;
const TAG_MIN = 1;
const TAG_MAX = 5;

const LEADER = 'leader';
const MEMBER = 'member';

// ── WO-1851 (clan WO-8): join-policy vocabulary ──────────────────────────────
// Owner ruling 2026-09-17: exactly two values. 'invite' (join requires the clan's
// code — the current, unchanged server default) and 'open' (anyone may join without
// a code — NOT built on this endpoint yet; storing it correctly now avoids a second
// migration once join-without-code ships). Mirrors clans_join_policy_valid in
// 20260917_0033_clan_join_policy_check.sql, and the two must never disagree.
const JOIN_POLICY_INVITE = 'invite';
const JOIN_POLICY_OPEN = 'open';

// ── WO-1847 (clan step 4): message reporting ─────────────────────────────────
// Cherry owns message persistence, so a reported id is an OPAQUE EXTERNAL STRING.
// clan_reports.message_id is TEXT with no foreign key (migration 0031 says why), which
// means this file is the only place its shape is ever checked. A ceiling is set because
// an unbounded TEXT column reachable from an authenticated endpoint is a cheap way to
// write megabytes per request; 200 is far above any id Cherry emits.
const MESSAGE_ID_MAX = 200;
// Postgres casts the parameter to UUID itself, and a malformed one raises 22P02 — which
// would surface as an opaque 500 rather than "you sent a bad clan id". Validated here for
// the same reason CODE_RE is: so a bad request is a 400 with a stable machine code.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// WO-1846. The third value clan_members_role_valid has always permitted; nothing
// assigned it until this ticket. One Leader per clan, unlimited Officers.
const OFFICER = 'officer';

/**
 * Stable machine codes, in the style of wallet-auth.AuthCode: each names a CLASS of
 * failure, none reveals anything about another wallet or another clan.
 *
 * ⚠ LEADER_MUST_TRANSFER IS lower_snake_case ON PURPOSE. The work order specifies the
 * literal body `{ error: 'leader_must_transfer' }` for that one refusal, so the string
 * is spelled exactly as the client will branch on it rather than normalised to match
 * its neighbours.
 */
const ClanCode = {
    BAD_NAME:             'CLAN_BAD_NAME',
    BAD_TAG:              'CLAN_BAD_TAG',
    BAD_CODE:             'CLAN_BAD_CODE',
    ALREADY_IN_CLAN:      'CLAN_ALREADY_IN_CLAN',
    NOT_FOUND:            'CLAN_NOT_FOUND',
    NOT_IN_CLAN:          'CLAN_NOT_IN_CLAN',
    LEADER_MUST_TRANSFER: 'leader_must_transfer',
    CODE_UNAVAILABLE:     'CLAN_CODE_UNAVAILABLE',
    IDENTITY_MISSING:     'CLAN_IDENTITY_MISSING',
    BAD_JOIN_POLICY:      'CLAN_BAD_JOIN_POLICY',     // 400 — not 'invite' or 'open'

    // ── WO-1846: the role-change refusals ────────────────────────────────────
    // ⛔ TARGET_NOT_IN_CLAN IS DELIBERATELY ONE CODE FOR TWO FACTS: "no such wallet
    //    anywhere" and "that wallet is in a DIFFERENT clan". Splitting them would
    //    turn /promote into a membership oracle — type addresses at it and learn who
    //    belongs to which clan. The target read is scoped by clan_id for the same
    //    reason, so the two cases are indistinguishable by construction, not by
    //    remembering to collapse them here.
    BAD_TARGET:           'CLAN_BAD_TARGET',          // 400 — missing or not wallet-shaped
    SELF_TARGET:          'CLAN_SELF_TARGET',         // 400 — a role op aimed at the caller
    TARGET_NOT_IN_CLAN:   'CLAN_TARGET_NOT_IN_CLAN',  // 404 — not a member of YOUR clan
    FORBIDDEN:            'CLAN_FORBIDDEN',           // 403 — the caller's role cannot do this
    TARGET_ROLE:          'CLAN_TARGET_ROLE',         // 409 — the target's role is wrong for this op
    RACED:                'CLAN_RACED',               // 409 — the read said yes, the write moved 0 rows

    // ── WO-1847: the message-report refusals ─────────────────────────────────
    BAD_CLAN_ID:          'CLAN_BAD_CLAN_ID',         // 400 — missing or not UUID-shaped
    BAD_MESSAGE_ID:       'CLAN_BAD_MESSAGE_ID',      // 400 — missing, blank, or over the ceiling
    // 403 — the caller is not a member of the clan they are reporting into. Deliberately
    // NOT split from "no such clan": answering those separately would turn /report-message
    // into a clan-existence oracle for any authenticated wallet. The single CTE cannot
    // tell them apart either, so the collapse is structural rather than remembered.
    REPORT_NOT_MEMBER:    'CLAN_REPORT_NOT_MEMBER',
};

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Normalise a clan name: trim, then bound to the migration's CHECK.
 * Rejects rather than truncates — a player who typed 40 characters should be told,
 * not silently handed a clan called something else.
 */
function normalizeName(raw) {
    const name = raw != null ? String(raw).trim() : '';
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
        return { ok: false, code: ClanCode.BAD_NAME };
    }
    return { ok: true, value: name };
}

/**
 * Normalise a clan tag: trim, UPPERCASE, then bound to the migration's CHECK.
 *
 * ⚠ THE BOUND HERE (1–5) IS THE SERVER'S, AND THE CLIENT'S IS NOT THE SAME. The
 * client truncates to 4 (ClanService.CreateClan, ClanService.cs:160) and its own
 * comment says "2–4 char clan tag". Nothing is reconciled here: this file enforces
 * the schema it ships against, and the discrepancy is on the record in the work
 * order's hand-back for a ruling before the gate-opening ticket.
 */
function normalizeTag(raw) {
    const tag = raw != null ? String(raw).trim().toUpperCase() : '';
    if (tag.length < TAG_MIN || tag.length > TAG_MAX) {
        return { ok: false, code: ClanCode.BAD_TAG };
    }
    return { ok: true, value: tag };
}

/**
 * Normalise an invite code: trim, UPPERCASE, then the exact format the migration
 * enforces. A code carrying an excluded character (O / 0 / I / 1) is a BAD REQUEST,
 * not a missing clan — telling the two apart is what stops a player retyping a
 * mistyped code forever.
 */
function normalizeCode(raw) {
    const code = raw != null ? String(raw).trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) {
        return { ok: false, code: ClanCode.BAD_CODE };
    }
    return { ok: true, value: code };
}

/**
 * Normalise an optional join-policy field: trim, lowercase, default to 'invite' when
 * absent or blank. Anything other than the two owner-ruled values is a BAD REQUEST —
 * never silently coerced to the default, which would let a client sending a stale
 * value (e.g. the client's old 'open'/'closed' vocabulary) believe its request
 * succeeded as something other than what it asked for.
 */
function normalizeJoinPolicy(raw) {
    if (raw == null || raw === '') return { ok: true, value: JOIN_POLICY_INVITE };
    const value = String(raw).trim().toLowerCase();
    if (value !== JOIN_POLICY_INVITE && value !== JOIN_POLICY_OPEN) {
        return { ok: false, code: ClanCode.BAD_JOIN_POLICY };
    }
    return { ok: true, value: value };
}

/**
 * One invite code, drawn from CODE_ALPHABET with crypto.randomInt.
 *
 * ⛔ NEVER Math.random. An invite code is the entire access control on joining a
 * clan; a predictable one is a clan anybody can walk into. randomInt is also
 * modulo-bias free, which a `% alphabet.length` over random bytes is not.
 */
function generateClanCode() {
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) {
        out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return out;
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Flatten whatever the driver threw into one searchable string, and answer only for
 * a UNIQUE violation.
 *
 * Matched on the SQLSTATE **or** the message text on purpose: the Neon HTTP driver
 * surfaces Postgres error fields, but a wrapped or re-thrown error can arrive with
 * the code stripped and the text intact. Losing a 23505 here would turn "you are
 * already in a clan" into a 500, so both routes to the same fact are accepted.
 *
 * @returns {string|null} the flattened context, or null when this is not a 23505
 */
function uniqueViolation(err) {
    if (!err) return null;
    const sqlstate = err.code != null ? String(err.code) : '';
    const context = [err.constraint, err.constraint_name, err.detail, err.message, err.toString ? err.toString() : '']
        .filter(Boolean).map(String).join(' | ');
    if (sqlstate !== '23505' && !/duplicate key value/i.test(context)) return null;
    return context;
}

/** True when a 23505's context names the one-clan-per-wallet index or the members PK. */
function isMembershipCollision(context) {
    return /clan_members/i.test(String(context || ''));
}

/** True when a 23505's context names the clans.code unique constraint. */
function isCodeCollision(context) {
    return /clans_code/i.test(String(context || ''));
}

/**
 * A FOREIGN KEY violation onto wallet_identity — which in practice means exactly one
 * thing: migration 0029 is not on this database, or touchWalletIdentity degraded
 * fail-open and the identity row was never written. It is a DEPLOY fault, never the
 * player's, so it earns its own code and a 500 rather than a 400 that blames them.
 */
function identityForeignKeyViolation(err) {
    if (!err) return false;
    const sqlstate = err.code != null ? String(err.code) : '';
    const context = [err.constraint, err.constraint_name, err.detail, err.message]
        .filter(Boolean).map(String).join(' | ');
    if (sqlstate !== '23503' && !/violates foreign key/i.test(context)) return false;
    return /wallet_identity/i.test(context) || /wallet/i.test(context);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The caller's membership, or null. Shaped for the response AND used as the guard
 * read by create/join/leave, so there is one query that answers "where does this
 * wallet stand" instead of four spellings of it.
 *
 * @param {Function} sql     neon(...) tagged-template client
 * @param {string} wallet    a wallet whose ownership has ALREADY been proven
 */
async function readMembership(sql, wallet) {
    const rows = await sql`
        SELECT c.id AS clan_id, c.code, c.name, c.tag, c.join_policy, c.created_at,
               m.role, m.joined_at,
               (SELECT COUNT(*) FROM clan_members x WHERE x.clan_id = c.id)::int AS member_count
        FROM clan_members m
        JOIN clans c ON c.id = m.clan_id
        WHERE m.wallet = ${wallet}
        LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
        clanId: String(r.clan_id),
        code: r.code,
        name: r.name,
        tag: r.tag,
        joinPolicy: r.join_policy,
        createdAt: r.created_at,
        role: r.role,
        joinedAt: r.joined_at,
        memberCount: Number(r.member_count),
    };
}

/**
 * WO-1846. One member of ONE clan, or null.
 *
 * ⛔ SCOPED BY clan_id, AND THAT IS THE PRIVACY PROPERTY, NOT AN OPTIMISATION. Asked
 * as "SELECT ... WHERE wallet = $1" this read would answer "yes, they are in clan X"
 * for ANY address a caller cared to type, and /promote would be a membership lookup
 * service. Scoped to the caller's own clan, a stranger and a member of another clan
 * are the same answer: null.
 */
async function readMemberInClan(sql, clanId, wallet) {
    const rows = await sql`
        SELECT wallet, role, joined_at
        FROM clan_members
        WHERE clan_id = ${clanId} AND wallet = ${wallet}
        LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    return { wallet: String(rows[0].wallet), role: rows[0].role, joinedAt: rows[0].joined_at };
}

/**
 * WO-1846. Normalise the target wallet of a role operation.
 *
 * Shape-checked HERE so a garbage string is a 400 rather than a read that finds
 * nothing and reports a 404 — "that is not an address" and "they are not in your
 * clan" are different facts, exactly as normalizeCode distinguishes BAD_CODE from
 * NOT_FOUND. The shape rule itself is imported, never re-spelled (see the require).
 */
function normalizeTargetWallet(raw) {
    const wallet = raw != null ? String(raw).trim() : '';
    if (!isWalletId(wallet)) return { ok: false, code: ClanCode.BAD_TARGET };
    return { ok: true, value: wallet };
}

/**
 * WO-1846. The preamble every role operation shares: who is asking, who is the
 * target, and are they in the same clan.
 *
 * Returns a refusal in the {ok:false,status,code} shape the routes already answer,
 * or the caller's membership plus the target's row.
 */
async function readRoleContext(sql, callerWallet, rawTarget) {
    const target = normalizeTargetWallet(rawTarget);
    if (!target.ok) return { ok: false, status: 400, code: target.code };
    // Aimed at yourself: refused BEFORE any read. A self-promote is meaningless, and a
    // self-kick is a leave — which has its own endpoint AND its own succession rule, so
    // routing it through kick would be a Leader leaving with no successor chosen.
    if (target.value === String(callerWallet)) {
        return { ok: false, status: 400, code: ClanCode.SELF_TARGET };
    }

    const caller = await readMembership(sql, callerWallet);
    if (!caller) return { ok: false, status: 404, code: ClanCode.NOT_IN_CLAN };

    const member = await readMemberInClan(sql, caller.clanId, target.value);
    if (!member) return { ok: false, status: 404, code: ClanCode.TARGET_NOT_IN_CLAN };

    return { ok: true, caller: caller, target: member };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * WO-1846. Set one member's role, with the ENTIRE authorization restated inside the
 * statement.
 *
 * @param {string} fromRole  the role the target must still hold
 * @param {string} toRole    the role to write
 */
async function setMemberRole(sql, clanId, callerWallet, targetWallet, fromRole, toRole) {
    return sql`
        UPDATE clan_members SET role = ${toRole}
        WHERE clan_id = ${clanId}
          AND wallet = ${targetWallet}
          AND role = ${fromRole}
          AND EXISTS (
              SELECT 1 FROM clan_members c
              WHERE c.clan_id = ${clanId} AND c.wallet = ${callerWallet} AND c.role = ${LEADER}
          )
        RETURNING wallet, role
    `;
}

/**
 * Promote a Member to Officer. Leader only.
 *
 * @returns {Promise<{ok:true, clanId:string, wallet:string, role:string}
 *                 | {ok:false, status:number, code:string, detail?:object}>}
 */
async function promoteMember(sql, callerWallet, rawTarget) {
    const ctx = await readRoleContext(sql, callerWallet, rawTarget);
    if (!ctx.ok) return ctx;
    if (ctx.caller.role !== LEADER) {
        return { ok: false, status: 403, code: ClanCode.FORBIDDEN, detail: { role: ctx.caller.role } };
    }
    if (ctx.target.role !== MEMBER) {
        return { ok: false, status: 409, code: ClanCode.TARGET_ROLE, detail: { role: ctx.target.role } };
    }

    const rows = await setMemberRole(sql, ctx.caller.clanId, callerWallet, ctx.target.wallet, MEMBER, OFFICER);
    if (!rows || rows.length === 0) {
        return { ok: false, status: 409, code: ClanCode.RACED, detail: { op: 'promote' } };
    }
    return { ok: true, clanId: ctx.caller.clanId, wallet: String(rows[0].wallet), role: rows[0].role };
}

/** Demote an Officer to Member. Leader only. Mirror image of promoteMember. */
async function demoteMember(sql, callerWallet, rawTarget) {
    const ctx = await readRoleContext(sql, callerWallet, rawTarget);
    if (!ctx.ok) return ctx;
    if (ctx.caller.role !== LEADER) {
        return { ok: false, status: 403, code: ClanCode.FORBIDDEN, detail: { role: ctx.caller.role } };
    }
    if (ctx.target.role !== OFFICER) {
        return { ok: false, status: 409, code: ClanCode.TARGET_ROLE, detail: { role: ctx.target.role } };
    }

    const rows = await setMemberRole(sql, ctx.caller.clanId, callerWallet, ctx.target.wallet, OFFICER, MEMBER);
    if (!rows || rows.length === 0) {
        return { ok: false, status: 409, code: ClanCode.RACED, detail: { op: 'demote' } };
    }
    return { ok: true, clanId: ctx.caller.clanId, wallet: String(rows[0].wallet), role: rows[0].role };
}

/**
 * Remove a member from the clan (owner ruling, WO-1846: Officers may kick too).
 *
 *   Leader  → may remove any Member or Officer. Never themself (that is /leave).
 *   Officer → may remove a MEMBER ONLY. Never another Officer, never the Leader.
 *   Member  → never.
 *
 * ⛔ THE OFFICER'S NARROWER POWER IS IN THE `DELETE` PREDICATE TOO, not only in the
 * read above it: `(${callerRole} = 'leader' OR role = 'member')`. An Officer promoted
 * to Leader — or a Leader demoted to Officer — between the read and the write cannot
 * borrow the role they no longer hold, and the EXISTS clause pins that the caller
 * still holds the exact role the authorization decision was made on.
 */
async function kickMember(sql, callerWallet, rawTarget) {
    const ctx = await readRoleContext(sql, callerWallet, rawTarget);
    if (!ctx.ok) return ctx;

    const callerRole = ctx.caller.role;
    if (callerRole !== LEADER && callerRole !== OFFICER) {
        return { ok: false, status: 403, code: ClanCode.FORBIDDEN, detail: { role: callerRole } };
    }
    // An Officer aiming at anything other than a Member is a 403 and not a 409: the
    // refusal is about the CALLER's authority, not about the target being in an odd
    // state. The work order names 403 for exactly this case.
    if (callerRole === OFFICER && ctx.target.role !== MEMBER) {
        return {
            ok: false, status: 403, code: ClanCode.FORBIDDEN,
            detail: { role: callerRole, targetRole: ctx.target.role },
        };
    }
    // Nobody kicks a Leader. A Leader's own exit is succession (leaveClan); another
    // Leader row cannot exist, so this predicate is a guard against a corrupted table
    // rather than a reachable player action — and it costs nothing to hold.
    if (ctx.target.role === LEADER) {
        return { ok: false, status: 403, code: ClanCode.FORBIDDEN, detail: { targetRole: LEADER } };
    }

    // ⛔ THE ::text CAST IN THE PREDICATE BELOW IS LOAD BEARING. Every other comparison
    // in this file binds a parameter against a COLUMN, so Postgres infers its type. The
    // Officer narrowing compares two PARAMETERS to each other, and the Neon HTTP driver
    // sends parameters UNTYPED — parameter-equals-parameter with both sides unknown is
    // the "could not determine data type" class of 42P18, which would 500 every Officer
    // kick in production while a recording mock noticed nothing at all. One cast anchors
    // the comparison to text. (The cast is pinned by clan-roles.test.js for that reason.)
    const rows = await sql`
        DELETE FROM clan_members
        WHERE clan_id = ${ctx.caller.clanId}
          AND wallet = ${ctx.target.wallet}
          AND role <> ${LEADER}
          AND (${callerRole}::text = ${LEADER} OR role = ${MEMBER})
          AND EXISTS (
              SELECT 1 FROM clan_members c
              WHERE c.clan_id = ${ctx.caller.clanId}
                AND c.wallet = ${callerWallet}
                AND c.role = ${callerRole}
          )
        RETURNING wallet, role
    `;
    if (!rows || rows.length === 0) {
        return { ok: false, status: 409, code: ClanCode.RACED, detail: { op: 'kick' } };
    }
    return {
        ok: true,
        clanId: ctx.caller.clanId,
        wallet: String(rows[0].wallet),
        removedRole: rows[0].role,
        by: callerRole,
    };
}

/**
 * Create a clan and seat the caller as its Leader.
 *
 * ONE STATEMENT, two rows: the CTE inserts the clans row and feeds its generated id
 * straight into the clan_members insert, so there is no window in which a clan exists
 * with no leader and no way for a crash between two calls to leave one behind.
 *
 * @param {*} [rawJoinPolicy]  optional body.joinPolicy — 'invite' (default) or 'open'.
 *                              ⚠ 'open' is stored as requested, but join-without-code
 *                              SERVER BEHAVIOR is NOT built by this ticket (WO-1851):
 *                              joinClan below still requires the invite code regardless
 *                              of the clan's stored join_policy. Deliberate, known gap.
 * @returns {Promise<{ok:true, clanId:string, code:string, name:string, tag:string,
 *                    role:string, joinPolicy:string, createdAt:*}
 *                 | {ok:false, status:number, code:string, detail?:object}>}
 */
async function createClan(sql, wallet, rawName, rawTag, rawJoinPolicy) {
    const name = normalizeName(rawName);
    if (!name.ok) return { ok: false, status: 400, code: name.code };
    const tag = normalizeTag(rawTag);
    if (!tag.ok) return { ok: false, status: 400, code: tag.code };
    const joinPolicy = normalizeJoinPolicy(rawJoinPolicy);
    if (!joinPolicy.ok) return { ok: false, status: 400, code: joinPolicy.code };

    // Courtesy read (see property 2 in the header): gives the friendly refusal without
    // burning a code draw. The index is still the authority.
    const existing = await readMembership(sql, wallet);
    if (existing) {
        return { ok: false, status: 409, code: ClanCode.ALREADY_IN_CLAN, detail: { role: existing.role } };
    }

    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        const code = generateClanCode();
        let rows;
        try {
            rows = await sql`
                WITH new_clan AS (
                    INSERT INTO clans (code, name, tag, join_policy, created_by_wallet)
                    VALUES (${code}, ${name.value}, ${tag.value}, ${joinPolicy.value}, ${wallet})
                    RETURNING id, code, name, tag, join_policy, created_at
                ), new_member AS (
                    INSERT INTO clan_members (clan_id, wallet, role)
                    SELECT id, ${wallet}, ${LEADER} FROM new_clan
                    RETURNING clan_id, role, joined_at
                )
                SELECT new_clan.id, new_clan.code, new_clan.name, new_clan.tag,
                       new_clan.join_policy, new_clan.created_at,
                       new_member.role, new_member.joined_at
                FROM new_clan
                JOIN new_member ON new_member.clan_id = new_clan.id
            `;
        } catch (err) {
            const dup = uniqueViolation(err);
            // The membership index fired: another request seated this wallet between the
            // courtesy read and this insert. Same answer as the read would have given.
            if (dup && isMembershipCollision(dup)) {
                return { ok: false, status: 409, code: ClanCode.ALREADY_IN_CLAN, detail: { raced: true } };
            }
            // The code collided: draw again. THIS is the retry loop — the whole reason
            // there is no pre-SELECT of the code.
            if (dup && isCodeCollision(dup)) continue;
            if (identityForeignKeyViolation(err)) {
                return { ok: false, status: 500, code: ClanCode.IDENTITY_MISSING, detail: { migration: '0029' } };
            }
            throw err;
        }

        const r = rows && rows[0] ? rows[0] : null;
        if (!r) {
            // A CTE that inserted nothing and raised nothing should be impossible. Do not
            // paper over it with a cheerful 200.
            return { ok: false, status: 500, code: ClanCode.CODE_UNAVAILABLE, detail: { emptyReturning: true } };
        }
        return {
            ok: true,
            clanId: String(r.id),
            code: r.code,
            name: r.name,
            tag: r.tag,
            role: r.role,
            joinPolicy: r.join_policy,
            createdAt: r.created_at,
        };
    }

    return { ok: false, status: 500, code: ClanCode.CODE_UNAVAILABLE, detail: { attempts: MAX_CODE_ATTEMPTS } };
}

/**
 * Join an existing clan by invite code, as a Member.
 *
 * ONE STATEMENT again, and here it also closes a lookup race: resolving the code in a
 * first call and inserting in a second lets the clan be removed in between, which is
 * a 23503 on a clan that the player was just told exists. The CTE resolves and inserts
 * under one snapshot; a code that matches nothing returns zero rows, which is the 404.
 */
async function joinClan(sql, wallet, rawCode) {
    const code = normalizeCode(rawCode);
    if (!code.ok) return { ok: false, status: 400, code: code.code };

    const existing = await readMembership(sql, wallet);
    if (existing) {
        return { ok: false, status: 409, code: ClanCode.ALREADY_IN_CLAN, detail: { role: existing.role } };
    }

    let rows;
    try {
        rows = await sql`
            WITH target AS (
                SELECT id, code, name, tag, join_policy, created_at
                FROM clans
                WHERE code = ${code.value}
                LIMIT 1
            ), seated AS (
                INSERT INTO clan_members (clan_id, wallet, role)
                SELECT id, ${wallet}, ${MEMBER} FROM target
                RETURNING clan_id, role, joined_at
            )
            SELECT target.id, target.code, target.name, target.tag,
                   target.join_policy, target.created_at,
                   seated.role, seated.joined_at
            FROM target
            JOIN seated ON seated.clan_id = target.id
        `;
    } catch (err) {
        const dup = uniqueViolation(err);
        if (dup && isMembershipCollision(dup)) {
            return { ok: false, status: 409, code: ClanCode.ALREADY_IN_CLAN, detail: { raced: true } };
        }
        if (identityForeignKeyViolation(err)) {
            return { ok: false, status: 500, code: ClanCode.IDENTITY_MISSING, detail: { migration: '0029' } };
        }
        throw err;
    }

    const r = rows && rows[0] ? rows[0] : null;
    // Zero rows means the `target` CTE matched nothing, i.e. no clan carries that code.
    // The code was already format-validated above, so this is genuinely NOT FOUND and
    // not a malformed request.
    if (!r) return { ok: false, status: 404, code: ClanCode.NOT_FOUND };

    return {
        ok: true,
        clanId: String(r.id),
        code: r.code,
        name: r.name,
        tag: r.tag,
        role: r.role,
        joinPolicy: r.join_policy,
        createdAt: r.created_at,
    };
}

/**
 * Leave the caller's clan.
 *
 * ⚠ REWRITTEN BY WO-1846, AND THE OLD RULE IS RETIRED. Until 2026-09-17 a Leader
 * calling this got a 409 `leader_must_transfer`, because WO-1845 shipped before
 * succession had a rule and a Leader walking out would have left members with no
 * leader. Succession now exists (leaveAsLeader below), so a Leader leaving SUCCEEDS.
 * `ClanCode.LEADER_MUST_TRANSFER` is kept as the RACE label — the read said member and
 * the write moved nothing — because the client already branches on that literal string
 * and it still means "your leave did not happen, look at your role again".
 *
 * The non-leader path below is UNCHANGED, statement and all, including both halves of
 * the guard (`role <> 'leader'` in the statement as well as the read) and the snapshot
 * rule in the emptiness test described in this file's header.
 */
async function leaveClan(sql, wallet) {
    const existing = await readMembership(sql, wallet);
    if (!existing) return { ok: false, status: 404, code: ClanCode.NOT_IN_CLAN };
    if (existing.role === LEADER) return leaveAsLeader(sql, wallet, existing);

    const rows = await sql`
        WITH departed AS (
            DELETE FROM clan_members
            WHERE wallet = ${wallet} AND role <> ${LEADER}
            RETURNING clan_id
        ), emptied AS (
            DELETE FROM clans
            WHERE id IN (SELECT clan_id FROM departed)
              AND NOT EXISTS (
                  SELECT 1 FROM clan_members m
                  WHERE m.clan_id = clans.id AND m.wallet <> ${wallet}
              )
            RETURNING id
        )
        SELECT (SELECT COUNT(*) FROM departed)::int AS departed_rows,
               (SELECT COUNT(*) FROM emptied)::int  AS emptied_rows
    `;

    const r = rows && rows[0] ? rows[0] : { departed_rows: 0, emptied_rows: 0 };
    const departed = Number(r.departed_rows) || 0;
    if (departed === 0) {
        // The read said member, the write removed nothing: the row changed underneath us.
        // Report it rather than claiming a removal that did not happen.
        return { ok: false, status: 409, code: ClanCode.LEADER_MUST_TRANSFER, detail: { raced: true } };
    }
    return { ok: true, clanId: existing.clanId, clanRemoved: (Number(r.emptied_rows) || 0) > 0 };
}

/**
 * WO-1846. A LEADER leaves: succession, in ONE STATEMENT.
 *
 * The rule (work order §"Leader succession"): the oldest Officer by joined_at becomes
 * Leader; failing that the oldest Member; failing that the clan is deleted.
 *
 * ⛔ WHY ALL THREE WRITES ARE ONE STATEMENT. The Neon HTTP driver sends one statement
 * per call with no transaction across calls, so "promote the successor" and "delete the
 * old leader" as two calls has a window containing TWO leaders, and a crash between
 * them leaves it there permanently. As three sequential calls the window also contains
 * a clan with NO leader. A data-modifying CTE is atomic by construction and is the same
 * shape createClan and the member path already use.
 *
 * ⛔ AND THE SNAPSHOT RULE AGAIN, in two places:
 *   • `successor` must exclude the leaver BY WALLET (`m.wallet <> $1`). The DELETE in
 *     the sibling `departed` CTE is invisible to it — every sub-statement reads the
 *     same snapshot — so without that predicate the leaver could elect themself.
 *   • `disbanded`'s emptiness test is likewise "no member OTHER THAN me", never "no
 *     rows in clan_members". When a successor exists the predicate is false and the
 *     clan survives; when the Leader is the sole member it is true and the clan goes.
 *     One statement therefore covers both branches with no `if` in JavaScript at all.
 *
 * ⛔ THE ORDER BY IS FULLY DETERMINISTIC ON PURPOSE. `(role = 'officer') DESC` puts
 * Officers ahead of Members (the work order's two-tier preference), `joined_at ASC` is
 * "oldest", and `wallet ASC` breaks a tie — two members can share a joined_at to the
 * microsecond in a seeded or scripted clan, and an unordered pick would make succession
 * non-reproducible, which is the kind of bug nobody can ever reproduce on purpose.
 */
async function leaveAsLeader(sql, wallet, existing) {
    const rows = await sql`
        WITH mine AS (
            SELECT m.clan_id
            FROM clan_members m
            WHERE m.wallet = ${wallet} AND m.role = ${LEADER}
        ), successor AS (
            SELECT m.clan_id, m.wallet, m.role
            FROM clan_members m
            JOIN mine ON mine.clan_id = m.clan_id
            WHERE m.wallet <> ${wallet}
            ORDER BY (m.role = ${OFFICER}) DESC, m.joined_at ASC, m.wallet ASC
            LIMIT 1
        ), promoted AS (
            UPDATE clan_members SET role = ${LEADER}
            WHERE (clan_id, wallet) IN (SELECT clan_id, wallet FROM successor)
            RETURNING wallet, role
        ), departed AS (
            DELETE FROM clan_members
            WHERE wallet = ${wallet} AND clan_id IN (SELECT clan_id FROM mine)
            RETURNING clan_id
        ), disbanded AS (
            DELETE FROM clans
            WHERE id IN (SELECT clan_id FROM mine)
              AND NOT EXISTS (
                  SELECT 1 FROM clan_members m
                  WHERE m.clan_id = clans.id AND m.wallet <> ${wallet}
              )
            RETURNING id
        )
        SELECT (SELECT COUNT(*) FROM departed)::int  AS departed_rows,
               (SELECT COUNT(*) FROM disbanded)::int AS disbanded_rows,
               (SELECT wallet FROM promoted LIMIT 1)  AS new_leader,
               (SELECT role FROM successor LIMIT 1)   AS successor_prior_role
    `;

    const r = rows && rows[0] ? rows[0] : { departed_rows: 0, disbanded_rows: 0 };
    const departed = Number(r.departed_rows) || 0;
    if (departed === 0) {
        // The read said leader and the write removed nothing: the row moved underneath
        // us. Reported as the literal the client already branches on (see leaveClan's
        // note), never as a cheerful 200 for a leave that did not happen.
        return { ok: false, status: 409, code: ClanCode.LEADER_MUST_TRANSFER, detail: { raced: true } };
    }

    const clanDeleted = (Number(r.disbanded_rows) || 0) > 0;
    const newLeader = r.new_leader != null ? String(r.new_leader) : null;
    if (!clanDeleted && !newLeader) {
        // A clan that was neither handed to a successor nor deleted is exactly the
        // leaderless state this whole function exists to prevent. Say so loudly rather
        // than returning ok and leaving it for a player to discover.
        console.error('[clan] succession left a clan with no leader:', existing.clanId);
        return { ok: false, status: 500, code: ClanCode.RACED, detail: { succession: 'no_leader' } };
    }

    return {
        ok: true,
        clanId: existing.clanId,
        clanRemoved: clanDeleted,
        clanDeleted: clanDeleted,
        newLeader: newLeader,
        successionFrom: r.successor_prior_role != null ? String(r.successor_prior_role) : null,
    };
}

/**
 * Normalise a clan id: trim, then the UUID shape Postgres would otherwise reject with
 * 22P02. Answered as a BAD REQUEST rather than a 500, and never as NOT FOUND — a
 * malformed id is the client's mistake, a missing clan is a fact about the database,
 * and telling them apart is what stops a client retrying a typo forever.
 */
function normalizeClanId(raw) {
    const id = raw != null ? String(raw).trim() : '';
    if (!UUID_RE.test(id)) return { ok: false, code: ClanCode.BAD_CLAN_ID };
    return { ok: true, value: id };
}

/**
 * Normalise an external (Cherry) message id: trim, require non-empty, bound to
 * MESSAGE_ID_MAX. NOT pattern-matched beyond that on purpose — the id belongs to
 * Cherry's schema, not this one, and a regex guessing at its format here would reject
 * valid reports the first time Cherry changed it.
 */
function normalizeMessageId(raw) {
    const id = raw != null ? String(raw).trim() : '';
    if (id.length < 1 || id.length > MESSAGE_ID_MAX) {
        return { ok: false, code: ClanCode.BAD_MESSAGE_ID };
    }
    return { ok: true, value: id };
}

/**
 * Record a report against one Cherry message, by a member of the clan it was sent in.
 *
 * ONE STATEMENT, and here that is the membership CHECK as well as the write (property 3
 * in this file's header): the INSERT's rows come from a SELECT over clan_members, so a
 * caller who is not a member of that clan inserts ZERO rows and there is no window in
 * which a membership read passes and a leave lands before the insert. A separate
 * "am I a member" SELECT followed by an INSERT is two answers to one question.
 *
 * ⚠ ZERO ROWS IS THE REFUSAL, AND IT IS AMBIGUOUS ON PURPOSE. It means "you are not a
 * member of that clan" OR "that clan does not exist", and both answer 403 with the same
 * code — see ClanCode.REPORT_NOT_MEMBER for why collapsing them is the security
 * property and not a lost distinction.
 *
 * ⛔ NOTHING READS THIS TABLE IN THIS TICKET. WO-1265 required that reporting exist
 * before free-text chat shipped; the admin review surface is deferred. A write-only
 * table is the deliberate shape, so do not "finish" it by adding a read here.
 *
 * @param {Function} sql        neon(...) tagged-template client
 * @param {string} wallet       a wallet whose ownership has ALREADY been proven
 * @param {*} rawClanId         body.clanId
 * @param {*} rawMessageId      body.messageId
 * @returns {Promise<{ok:true, reportId:string, clanId:string}
 *                 | {ok:false, status:number, code:string, detail?:object}>}
 */
async function reportMessage(sql, wallet, rawClanId, rawMessageId) {
    const clanId = normalizeClanId(rawClanId);
    if (!clanId.ok) return { ok: false, status: 400, code: clanId.code };
    const messageId = normalizeMessageId(rawMessageId);
    if (!messageId.ok) return { ok: false, status: 400, code: messageId.code };

    let rows;
    try {
        rows = await sql`
            INSERT INTO clan_reports (reporter_wallet, message_id, clan_id)
            SELECT ${wallet}, ${messageId.value}, m.clan_id
            FROM clan_members m
            WHERE m.clan_id = ${clanId.value}::uuid AND m.wallet = ${wallet}
            RETURNING id, clan_id, reported_at
        `;
    } catch (err) {
        // The same deploy fault createClan/joinClan map: migration 0029 or 0031 is not on
        // this database, so the reporter's wallet_identity row is not there to reference.
        // A deploy fault is never the player's fault, so it is a 500 and not a 400.
        if (identityForeignKeyViolation(err)) {
            return { ok: false, status: 500, code: ClanCode.IDENTITY_MISSING, detail: { migration: '0029/0031' } };
        }
        throw err;
    }

    const r = rows && rows[0] ? rows[0] : null;
    if (!r) return { ok: false, status: 403, code: ClanCode.REPORT_NOT_MEMBER };

    return { ok: true, reportId: String(r.id), clanId: String(r.clan_id) };
}

// ── WO-1850 (clan WO-7): the leaderboard ────────────────────────────────────

// Mirrors api/leaderboard/get.js's own clamp — same DEFAULT/MAX shape, kept as a
// SEPARATE pair of constants because WO-7's acceptance criteria pin this endpoint's
// numbers (default 50, max 100) independently of whatever the unrelated leaderboard
// ever does with its own. Copying the values is fine; sharing the constant across two
// unrelated features is how one change silently moves the other's contract.
const LEADERBOARD_DEFAULT_LIMIT = 50;
const LEADERBOARD_MAX_LIMIT = 100;

/**
 * Clamp a requested top-N to [1, LEADERBOARD_MAX_LIMIT], defaulting when absent or
 * not a finite number. Never throws — a garbage ?limit= is a clamp, not a 400,
 * matching api/leaderboard/get.js's own clampInt so the two routes read the same to
 * a client that queries both.
 */
function clampLeaderboardLimit(raw) {
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v)) return LEADERBOARD_DEFAULT_LIMIT;
    return Math.min(LEADERBOARD_MAX_LIMIT, Math.max(1, v));
}

/**
 * WO-1850 (clan WO-7). Rank every clan by an HONEST-TODAY placeholder metric and
 * return the top `limit`.
 *
 * ⚠ THE METRIC IS A NAMED PLACEHOLDER, NOT THE SPEC'S REAL ONE — read this before
 * "fixing" it. `docs/SKR Integtration.md:525-526` (the WO-7 draft) names the ranking
 * basis as `clan_vigil_weight` (WO-9: percentage-of-SKR-staked × tenure, summed across
 * members), with an explicit fallback: `member_count × days_since_created`, "so WO-7
 * can ship before WO-9; once WO-9 lands, the metric switches." `clan_vigil_weight`
 * does NOT exist anywhere in this schema or codebase (grepped at source, 2026-09-17 —
 * zero hits under api/ or in any migration) and WO-9 is unbuilt, so this function
 * implements ONLY the fallback. Wiring the real Vigil weight in is WO-1852+
 * territory (it depends on WO-1851's gate being open first, per the numbering
 * banner's own dependency chain) and is explicitly OUT of this ticket's scope.
 *
 * ⛔ THE SHAPE IS BUILT SO THE FUTURE SWAP IS A ONE-COLUMN CHANGE. Every caller-facing
 * name is already metric-neutral (`metric`, never `memberDays` or similar), and the
 * ranking column lives in exactly one place — the `ranked` CTE's `days_since_created`
 * and the outer SELECT's `metric` expression. Swapping in a real `clan_vigil_weight`
 * column later means replacing the `member_count * days_since_created` expression in
 * ONE SELECT with a reference to that column (or a join onto whatever WO-9 lands it
 * in); the route, the response shape, the ORDER BY direction and the tie-break all
 * stay exactly as they are.
 *
 * ⛔ NEVER SELECT A WALLET COLUMN HERE. `clans.created_by_wallet` and every
 * `clan_members.wallet` sit one join away and are never referenced — a leaderboard
 * is a public-shaped ranking surface, and the standing rule elsewhere in this API
 * (api/admin/stats.js) is that a wallet address is never rendered where a rank or a
 * count would do.
 *
 * Ties are broken by `created_at ASC` (older clans rank higher on ties) per the WO's
 * own acceptance criterion — and it is also what keeps the order fully deterministic:
 * two clans created in the same instant would otherwise sort non-reproducibly, the
 * same "unordered pick" hazard leaveAsLeader's ORDER BY exists to close.
 *
 * @param {Function} sql   neon(...) tagged-template client
 * @param {number} limit   already clamped by clampLeaderboardLimit
 * @returns {Promise<Array<{rank:number, clanId:string, name:string, tag:string,
 *                          metric:number, memberCount:number}>>}
 */
async function getLeaderboard(sql, limit) {
    const rows = await sql`
        WITH ranked AS (
            SELECT
                c.id AS clan_id,
                c.name,
                c.tag,
                c.created_at,
                (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id)::int AS member_count,
                GREATEST(EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400.0, 0)::float8 AS days_since_created
            FROM clans c
        )
        SELECT
            ROW_NUMBER() OVER (
                ORDER BY (member_count * days_since_created) DESC, created_at ASC
            ) AS rank,
            clan_id, name, tag, member_count,
            (member_count * days_since_created) AS metric
        FROM ranked
        ORDER BY (member_count * days_since_created) DESC, created_at ASC
        LIMIT ${limit}
    `;
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
        rank: Number(r.rank),
        clanId: String(r.clan_id),
        name: r.name,
        tag: r.tag,
        metric: Number(r.metric),
        memberCount: Number(r.member_count),
    }));
}

module.exports = {
    CODE_ALPHABET,
    CODE_RE,
    CODE_LEN,
    MAX_CODE_ATTEMPTS,
    NAME_MIN, NAME_MAX, TAG_MIN, TAG_MAX,
    LEADER, MEMBER, OFFICER,
    ClanCode,
    normalizeName,
    normalizeTag,
    normalizeCode,
    generateClanCode,
    // ── WO-1851 (clan WO-8) — join-policy vocabulary ─────────────────────────
    JOIN_POLICY_INVITE,
    JOIN_POLICY_OPEN,
    normalizeJoinPolicy,
    uniqueViolation,
    isMembershipCollision,
    isCodeCollision,
    identityForeignKeyViolation,
    readMembership,
    createClan,
    joinClan,
    leaveClan,
    // ── WO-1846 ─────────────────────────────────────────────────────────────
    readMemberInClan,
    normalizeTargetWallet,
    readRoleContext,
    promoteMember,
    demoteMember,
    kickMember,
    leaveAsLeader,
    // ── WO-1847 (clan step 4) — message reporting ───────────────────────────
    MESSAGE_ID_MAX,
    UUID_RE,
    normalizeClanId,
    normalizeMessageId,
    reportMessage,
    // ── WO-1850 (clan WO-7) — leaderboard ───────────────────────────────────
    LEADERBOARD_DEFAULT_LIMIT,
    LEADERBOARD_MAX_LIMIT,
    clampLeaderboardLimit,
    getLeaderboard,
};
