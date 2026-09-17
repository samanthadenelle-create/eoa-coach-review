// =============================================================================
// api/_lib/clan.js — WO-1845 (clan step 2). ALL clan membership logic, in ONE
// place, with the database client INJECTED.
// -----------------------------------------------------------------------------
// The four routes under api/clan/ are deliberately thin: CORS, raw body, auth,
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
// Files under api/_lib/ are NOT routed by Vercel (leading underscore), so this is
// a library and never an endpoint. CommonJS, no dependencies.
// =============================================================================

'use strict';

const crypto = require('crypto');

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

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a clan and seat the caller as its Leader.
 *
 * ONE STATEMENT, two rows: the CTE inserts the clans row and feeds its generated id
 * straight into the clan_members insert, so there is no window in which a clan exists
 * with no leader and no way for a crash between two calls to leave one behind.
 *
 * @returns {Promise<{ok:true, clanId:string, code:string, name:string, tag:string,
 *                    role:string, joinPolicy:string, createdAt:*}
 *                 | {ok:false, status:number, code:string, detail?:object}>}
 */
async function createClan(sql, wallet, rawName, rawTag) {
    const name = normalizeName(rawName);
    if (!name.ok) return { ok: false, status: 400, code: name.code };
    const tag = normalizeTag(rawTag);
    if (!tag.ok) return { ok: false, status: 400, code: tag.code };

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
                    INSERT INTO clans (code, name, tag, created_by_wallet)
                    VALUES (${code}, ${name.value}, ${tag.value}, ${wallet})
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
 * ⛔ A LEADER CANNOT LEAVE, and that is a DELIBERATE HOLE, not an oversight: WO-1846
 * defines succession, and until it has, letting a Leader walk out would leave a clan
 * with members and no leader — a state no later ticket has a rule for. The refusal is
 * a 409 carrying the work order's literal `leader_must_transfer`.
 *
 * The guard is in BOTH places: read the role, and also `role <> 'leader'` in the
 * statement itself, so a role change landing between the two cannot slip a leader out.
 *
 * ⚠ THE CLAN CLEANUP IS REACHABLE ONLY FOR A LAST NON-LEADER MEMBER, which — while a
 * leader can never leave — means it fires only for a clan whose leader row is already
 * gone by some other path. It is implemented because the work order specifies it; it
 * is not today's live behaviour, and saying so is cheaper than someone later reading
 * it as dead code and removing it.
 */
async function leaveClan(sql, wallet) {
    const existing = await readMembership(sql, wallet);
    if (!existing) return { ok: false, status: 404, code: ClanCode.NOT_IN_CLAN };
    if (existing.role === LEADER) {
        return {
            ok: false,
            status: 409,
            code: ClanCode.LEADER_MUST_TRANSFER,
            detail: { clanId: existing.clanId, memberCount: existing.memberCount },
        };
    }

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

module.exports = {
    CODE_ALPHABET,
    CODE_RE,
    CODE_LEN,
    MAX_CODE_ATTEMPTS,
    NAME_MIN, NAME_MAX, TAG_MIN, TAG_MAX,
    LEADER, MEMBER,
    ClanCode,
    normalizeName,
    normalizeTag,
    normalizeCode,
    generateClanCode,
    uniqueViolation,
    isMembershipCollision,
    isCodeCollision,
    identityForeignKeyViolation,
    readMembership,
    createClan,
    joinClan,
    leaveClan,
};
