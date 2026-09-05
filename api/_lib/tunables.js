// =============================================================================
// api/_lib/tunables.js - PROD-022, the REMOTE KNOBS the Pi crash loop is bisected
// with. Read side, validation, and the one writer.
// -----------------------------------------------------------------------------
// Owner ruling 2026-09-02, verbatim:
//   "make the testing as robust as possible with as many solutions as
//    possible... all we really have to do is just flip a flag and possibly
//    redeploy"
//
// A WebGL rebuild costs about thirty minutes. PROD-022 is a P0 crash loop that
// reproduces inside Pi Browser on the owner's iPhone and NOWHERE else - desktop
// Chrome ran the identical build for 62 minutes. So every candidate mitigation
// ships in ONE build behind its OWN key, all defaulting to today's behaviour,
// and the bisect is flag flips against this table.
//
// -----------------------------------------------------------------------------
// ⛔ THIS FILE HOLDS NO DEFAULTS, AND THAT IS THE DESIGN.
// -----------------------------------------------------------------------------
// The defaults live in the BUILD, in DeNelle.Core.Ops.RemoteTunables.Registry,
// and they are the values the shipping code hardcoded before PROD-022 touched
// it. This table carries OVERRIDES ONLY. An empty table therefore means "today's
// behaviour", and there is exactly one place a default can be read - which is the
// duplicated-state failure CLAUDE.md sections 2, 5 and 16 keep warning about.
//
// The KEY LIST below is duplicated (client registry / this file / the operator
// CLI), and it is duplicated ON PURPOSE and only as an ALLOWLIST: a typo'd key
// must be REFUSED at write time rather than accepted and silently ignored by
// every client forever. It is a spell-check, never a source of truth.
//
// -----------------------------------------------------------------------------
// FAIL-TO-DEFAULT. Not fail-open, not fail-closed - nothing here is a seal.
// An unreachable table, a query timeout, a malformed row: readTunables answers
// ok=false, the endpoint reports readOk:false, and every client resolves every
// knob to its shipping default. There is no state in which a failure here can
// make the game behave differently from the build that shipped.
//
// CACHE POLICY mirrors api/_lib/maintenance.js: a short in-lambda memo so one
// warm instance does not re-query Neon per request in a burst. The knobs are
// flipped by a human during a bisect, so a few seconds of lag is invisible.
//
// CommonJS, no dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

/**
 * ALLOWLIST, kept in step BY HAND with DeNelle.Core.Ops.RemoteTunables.Registry
 * and with tools/client-tunables.mjs. It exists so a mistyped key is refused at
 * the moment it is written instead of being accepted and quietly ignored by every
 * client for the rest of the incident.
 *
 * `kind` is checked at write time for the same reason: '2' in a bool is a typo,
 * and the client would fall back to the default and log a bad-value line rather
 * than doing what the operator meant.
 */
const TUNABLE_KEYS = [
    { key: 'pi.eagerStructureWarm', kind: 'bool' },
    { key: 'pi.awaitInitBeforeFirstLoad', kind: 'bool' },
    { key: 'pi.disableRemoteStructureArt', kind: 'bool' },
    { key: 'assets.maxConcurrentRequests', kind: 'int' },
    { key: 'pi.requestTimeoutSeconds', kind: 'int' },
    { key: 'assets.maxRequestAttempts', kind: 'int' },
    { key: 'visuals.missLogCap', kind: 'int' },
    { key: 'trace.assetVerbosity', kind: 'int' },
    // WO-1306 - NOT a PROD-022 knob. The mage's drain return rate, as an integer
    // percent of the damage actually dealt. Build default 100 = today (heal ==
    // damage dealt). Owner ruling 2026-09-02: "be smart, dont make it need a code
    // change, make it tweakable from a db call" - so balance rides the SAME rail
    // rather than growing a second configuration mechanism.
    { key: 'combat.drainReturnPct', kind: 'int' },
    // WO-1327 - NOT PROD-022 knobs either. Two VFX FEEL/PERF dials that had to be
    // code-side because the numbers they replace are baked into a prefab inside a
    // GITIGNORED art pack (Assets/Spells Pack/), where a hand-edit cannot be
    // reviewed, cannot be committed, and is erased by the next re-import.
    //   vfx.particleBouncePct  - build default 0: a world-colliding VFX particle
    //     stops at the surface it hits and dies, instead of ricocheting off every
    //     layer with zero energy loss and coming back to the caster. 100 = leave
    //     the pack's authored collision alone.
    //   vfx.maxParticleLights  - build default 4: concurrent real-time point
    //     lights ONE spawned VFX host may drive. Spell_Fire_9 authored 25.
    { key: 'vfx.particleBouncePct', kind: 'int' },
    { key: 'vfx.maxParticleLights', kind: 'int' },
    // WO-1330 - NOT PROD-022 knobs. The THREE levers of the one over-time engine
    // (DeNelle.Core.Combat.OverTimeEngine), shared by every damage-over-time and
    // every heal-over-time effect rather than duplicated per ability.
    //   combat.overTimeTickMs        - build default 1000: milliseconds between
    //     pulses. Exactly the "const float tick = 1f" the two shipped DoT
    //     coroutines hardcoded. Cadence only - total delivery is invariant.
    //   combat.overTimeMagnitudePct  - build default 100: percent scale on each
    //     pulse's size, both signs.
    //   combat.overTimeDurationPct   - build default 100: percent scale on each
    //     effect's duration, both signs.
    { key: 'combat.overTimeTickMs', kind: 'int' },
    { key: 'combat.overTimeMagnitudePct', kind: 'int' },
    { key: 'combat.overTimeDurationPct', kind: 'int' },
    // WO-1343 - NOT PROD-022 knobs, and not balance either: this is a CREATIVE
    // choice the owner has explicitly not made. She tagged one Night Store aura,
    // then a second ("i added another option for REalm store, not sure which will
    // be best"), then asked whether the seven Aura_* spell prefabs could cycle
    // "slowly one after another instead ... IF THE OTHER ONE DOESNT LOOK GOOD".
    // Three candidates and a conditional, all of which need to be seen on a
    // device. Building one and discarding the rest would either pick for her or
    // cost a 30-minute rebuild per opinion, so all of it ships and the choice is
    // a row here. Her FIRST pick is the build default; nothing promotes the others.
    //   vfx.nightStoreAuraMode        - build default 0: her first tagged key
    //     (NightStoreoption_Aura). 1 = her second (Store_Aura). 2 = walk the seven
    //     Aura_* prefabs one at a time. 3 = the Marker8 ring this build replaced.
    //   vfx.nightStoreAuraCadenceMin  - build default 30: her "every 30~min". In a
    //     burst mode a tick re-fires the burst; in rotate mode it advances the walk.
    //   vfx.nightStoreAuraFamilyMask  - build default 127: which of the seven may
    //     be selected (1 Arcane, 2 Dark, 4 Fire, 8 Ice, 16 Light, 32 Nature,
    //     64 Storm). Inert unless mode is 2.
    //   vfx.nightStoreAuraBurstRepeatSec - build default 0 (OFF): extra re-fires of
    //     the burst inside one cadence period. Both store candidates are MEASURED
    //     one-shots, so 0 is her spec read literally.
    { key: 'vfx.nightStoreAuraMode', kind: 'int' },
    { key: 'vfx.nightStoreAuraCadenceMin', kind: 'int' },
    { key: 'vfx.nightStoreAuraFamilyMask', kind: 'int' },
    { key: 'vfx.nightStoreAuraBurstRepeatSec', kind: 'int' },
    // WO-1374 - NOT PROD-022 knobs. THE RAID REWARD TABLE, from the north-star map
    // docs/PROGRAM_RAID_ECONOMY_2026-09-04.md, whose section 12.7 says in capitals
    // that every number in it is a tunable. This is the curve the owner sets BY
    // FEEL: how much a raid pays, and how much better raiding has to get before it
    // pays more.
    //   raid.lootWoodBase   - build default 1800: wood at a PERFECT run (3 stars
    //     AND 100% razed) on a Camp I-tier base, before the camp multiplier.
    //   raid.lootIronBase   - build default 1100: the same for iron.
    //   the five ladder rungs - percent of that base by result, per the map:
    //     failed 18 (the middle of its stated 15-20 band, and deliberately not 0),
    //     1 star 50, 2 stars 75, 3 stars 100, 3 stars + 100% destruction 110.
    // (!) These two bases are the ONE place in this file where a default is NOT
    // today's shipped behaviour - today a raid pays zero wood and zero iron, which
    // is the defect the work order exists to close, and the map states the target
    // outright. Same shape as combat.drainReturnPct shipping at her 60. Setting
    // both bases to 0 restores the old food-and-crystals-only payout exactly.
    // (!) GOLD IS HERE NOW. The fork WO-1374 was blocked on was CLOSED at commit
    // 281902df0: troops cost GOLD, they ALSO take time, and a second gold spend
    // hires mercenaries to skip the clock. Gold is FOUR knobs, not one, because
    // the map publishes a DESIGNED target per camp (2200 / 3100 / 4500 / 6500)
    // sized at 125-140% of that camp's expected army replacement cost - and it is
    // deliberately NOT multiplied by the camp's rewardMultiplier, since x1.5 of
    // 2200 is 3300 and her Camp II number is 3100.
    //   raid.lootCrystalsBase / ...PerStar - build defaults 20 and 2: a perfect
    //     clear pays 26 crystals, DOWN from the 55 this build used to pay, and not
    //     multiplied by the camp multiplier either. "Crystals are timer
    //     compression" - it is the one reward in the map's table that decreases.
    { key: 'raid.lootWoodBase', kind: 'int' },
    { key: 'raid.lootIronBase', kind: 'int' },
    { key: 'raid.lootFailPct', kind: 'int' },
    { key: 'raid.lootOneStarPct', kind: 'int' },
    { key: 'raid.lootTwoStarPct', kind: 'int' },
    { key: 'raid.lootThreeStarPct', kind: 'int' },
    { key: 'raid.lootPerfectPct', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp1', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp2', kind: 'int' },
    { key: 'raid.lootCoinsBaseCamp3', kind: 'int' },
    { key: 'raid.lootCoinsBaseBastion', kind: 'int' },
    { key: 'raid.lootCrystalsBase', kind: 'int' },
    { key: 'raid.lootCrystalsPerStar', kind: 'int' },
    //   raid.starterArmySize - build default 3: free Footmen granted the first time
    //     a save has a Barracks (map section 2, "the first army is free"). Once per
    //     save, so a rebuilt Barracks is not a troop faucet. 0 disables it.
    { key: 'raid.starterArmySize', kind: 'int' },
    // WO-1379 HEARTFIRE - the raid PACING charge, and it is a CHARGE, NOT A
    // CURRENCY: never earned, traded, stored, gifted or bought, so neither key
    // below is a price and neither may ever be joined to a wallet or a purchase.
    //   raid.heartfireMaxCharges   - build default 3: how many expeditions the
    //     Heart can sustain at once. Charges STACK to this ceiling so a player who
    //     sleeps or works is not punished.
    //   raid.heartfireRegenSeconds - build default 14400 (4 h) per charge. It
    //     ships EQUAL to the shortest authored per-camp cooldown on purpose, which
    //     is what keeps "a player holding Heartfire always has somewhere to spend
    //     it" true. Raising it past that shortest cooldown breaks the criterion.
    { key: 'raid.heartfireMaxCharges', kind: 'int' },
    { key: 'raid.heartfireRegenSeconds', kind: 'int' },
    // WO-1388 BUILDER'S HOUR - NOT a PROD-022 knob. How long the +1 Builder crew
    // sold by the $1.99 'builders-hour' pack lasts, in seconds.
    //   economy.packTemporaryBuilderSeconds - build default 21600 (6 h, the owner's
    //     number). A charge bought while a window is running is DEFERRED behind it,
    //     never stacked and never burned. 0 refuses the grant and keeps the charge
    //     deferred. Convenience compresses TIME, never sells power - this is a
    //     duration and nothing else.
    { key: 'economy.packTemporaryBuilderSeconds', kind: 'int' },
    // WO-1384b NIGHT MARKET GLOW - NOT PROD-022 knobs. Three FEEL levers on the
    // HUD's permanent store card: a soft rounded ring plus three comets chasing
    // the card's perimeter. Read when the HUD builds the card; clamped there.
    //   hud.nightMarketGlowLapSec      - build default 5 (seconds per lap, 1..60).
    //   hud.nightMarketGlowAlphaPct    - build default 35 (peak alpha %, 0..100).
    //   hud.nightMarketGlowPaletteMask - build default 7 (Gold=1|Amber=2|Rose=4,
    //     0..7; an empty mask resolves to Gold alone, never to nothing).
    { key: 'hud.nightMarketGlowLapSec', kind: 'int' },
    { key: 'hud.nightMarketGlowAlphaPct', kind: 'int' },
    { key: 'hud.nightMarketGlowPaletteMask', kind: 'int' },
];

/** How long one warm lambda may reuse a read of the table. */
const MEMO_TTL_MS = 5000;

/** A query that has not answered in this long is treated as unreachable. */
const QUERY_TIMEOUT_MS = 2500;

/** Values are short. Anything longer is not a knob. */
const VALUE_MAX_LEN = 32;

let s_memo = null;
let s_memoAt = 0;

/** The spec for one key, or null when the key is not one of ours. */
function specFor(key) {
    if (typeof key !== 'string') return null;
    for (const spec of TUNABLE_KEYS) {
        if (spec.key === key) return spec;
    }
    return null;
}

/** True when `key` is an allowlisted knob. */
function isKnownKey(key) {
    return specFor(key) !== null;
}

/**
 * Validate a value against its key's kind. Returns the NORMALIZED string to
 * store ('0'/'1' for bools, a canonical decimal for ints), or null when the
 * value is unusable.
 */
function normalizeValue(key, raw) {
    const spec = specFor(key);
    if (!spec) return null;
    if (raw == null) return null;

    const s = String(raw).trim();
    if (!s || s.length > VALUE_MAX_LEN) return null;

    if (spec.kind === 'bool') {
        const low = s.toLowerCase();
        if (low === '1' || low === 'true' || low === 'on') return '1';
        if (low === '0' || low === 'false' || low === 'off') return '0';
        return null;
    }

    if (!/^-?\d{1,9}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return String(n);
}

/**
 * Read every knob row. NEVER throws, NEVER rejects.
 *
 * @param {Function} sql neon(...) client, or null
 * @returns {Promise<{ok: boolean, values: object, rows: object, reason: string}>}
 *   ok=false means the table could not be read. The client then resolves every
 *   knob to its SHIPPING DEFAULT, which is today's behaviour - so a failure here
 *   can never change how the game behaves.
 */
async function readTunables(sql) {
    const now = Date.now();
    if (s_memo && (now - s_memoAt) < MEMO_TTL_MS) {
        return s_memo;
    }

    if (!sql) {
        try {
            console.warn('[tunables] no sql handle - every knob resolves to its shipping default');
        } catch (_) { /* logging must never break a request */ }
        return { ok: false, values: {}, rows: {}, reason: 'NO_SQL_HANDLE' };
    }

    let rows = null;
    try {
        // The timeout is the whole point of the race: a hung Neon socket must
        // resolve in bounded time rather than hold the request until the platform
        // kills it. A hang and an outage are the same answer here.
        rows = await Promise.race([
            sql`SELECT key, value, updated_by, updated_at FROM client_tunables`,
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error('tunables query timeout')), QUERY_TIMEOUT_MS)),
        ]);
    } catch (err) {
        try {
            console.warn('[tunables] table unreadable (' + (err && err.message) +
                         ') - every knob resolves to its shipping default');
        } catch (_) { /* noop */ }
        // NOT memoised. One blip must not hold a stale answer for the warm life
        // of the instance - the same reasoning api/_lib/maintenance.js records.
        return { ok: false, values: {}, rows: {}, reason: 'QUERY_FAILED' };
    }

    // ⚠ SHAPE-CHECK BEFORE WALKING. A driver that answers with a STRING is
    // perfectly iterable in JavaScript and would walk characters, yielding
    // { ok: true, values: {} } - the right OUTCOME by the wrong ROUTE. ok:true
    // means "we read the table", which is a claim we could not make. This is the
    // identical trap api/_lib/maintenance.js documents; it is repeated because it
    // was found in production, not because it is theoretical.
    const rowList = Array.isArray(rows) ? rows
        : (rows && Array.isArray(rows.rows) ? rows.rows : null);
    if (rowList === null) {
        try { console.warn('[tunables] query returned a non-array result - reported as unreadable'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    const values = {};
    const meta = {};
    let ignored = 0;
    try {
        for (const r of rowList) {
            const key = r && r.key != null ? String(r.key) : '';
            if (!isKnownKey(key)) { ignored++; continue; }
            const value = r.value != null ? String(r.value) : '';
            values[key] = value;
            meta[key] = {
                value: value,
                updatedAt: r.updated_at != null ? String(r.updated_at) : null,
                updatedBy: r.updated_by != null ? String(r.updated_by) : null,
            };
        }
    } catch (err) {
        try { console.warn('[tunables] malformed rows (' + (err && err.message) + ')'); }
        catch (_) { /* noop */ }
        return { ok: false, values: {}, rows: {}, reason: 'MALFORMED_ROWS' };
    }

    if (ignored > 0) {
        // NOT an outage, and deliberately different from maintenance.js's
        // all-rows-malformed rule: an unrecognised key here is FORWARD
        // COMPATIBILITY (a newer build's knob), not corruption. An empty result
        // is the correct, expected resting state of this table, so it must never
        // be reported as unreadable.
        try { console.warn('[tunables] ignored ' + ignored + ' row(s) naming an unregistered key'); }
        catch (_) { /* noop */ }
    }

    const good = { ok: true, values: values, rows: meta, reason: 'OK' };
    s_memo = good;
    s_memoAt = now;
    return good;
}

/**
 * Set one knob. UPSERT, never "ON CONFLICT DO NOTHING" - a write that silently
 * did not land would send the owner chasing a build during an incident. Reads the
 * row BACK rather than trusting the statement.
 *
 * @throws when the key or value is not allowlisted, or the write returned no row.
 */
async function setTunable(sql, key, value, operator) {
    const spec = specFor(key);
    if (!spec) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const normalized = normalizeValue(key, value);
    if (normalized === null) {
        const err = new Error('BAD_TUNABLE_VALUE');
        err.code = 'BAD_TUNABLE_VALUE';
        throw err;
    }

    const rows = await sql`
        INSERT INTO client_tunables (key, value, updated_by, updated_at)
        VALUES (${key}, ${normalized}, ${operator}, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        RETURNING key, value, updated_by, updated_at`;
    if (!rows || !rows.length) {
        const err = new Error('WRITE_RETURNED_NO_ROW');
        err.code = 'WRITE_RETURNED_NO_ROW';
        throw err;
    }
    s_memo = null;
    s_memoAt = 0;
    return rows[0];
}

/**
 * Delete one knob's row, returning that knob to its SHIPPING DEFAULT.
 *
 * ⭐ CLEARING IS NOT "SETTING IT TO 0". Clearing removes the override entirely, so
 * the client answers whatever the build hardcodes - which for an int knob such as
 * pi.requestTimeoutSeconds is 20, not 0. This is the one-word way back to today's
 * behaviour and it is why the operator surface exposes it separately.
 *
 * @returns {Promise<{key: string, existed: boolean}>}
 */
async function clearTunable(sql, key) {
    if (!isKnownKey(key)) {
        const err = new Error('UNKNOWN_TUNABLE_KEY');
        err.code = 'UNKNOWN_TUNABLE_KEY';
        throw err;
    }
    const rows = await sql`DELETE FROM client_tunables WHERE key = ${key} RETURNING key`;
    s_memo = null;
    s_memoAt = 0;
    return { key: key, existed: !!(rows && rows.length) };
}

/** Test hook: drop the warm-instance memo so a test can drive consecutive states. */
function _resetMemo() {
    s_memo = null;
    s_memoAt = 0;
}

module.exports = {
    TUNABLE_KEYS,
    MEMO_TTL_MS,
    QUERY_TIMEOUT_MS,
    VALUE_MAX_LEN,
    specFor,
    isKnownKey,
    normalizeValue,
    readTunables,
    setTunable,
    clearTunable,
    _resetMemo,
};
