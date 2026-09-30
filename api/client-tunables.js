// =============================================================================
// api/client-tunables.js - Vercel Serverless Function (PROD-022)
// -----------------------------------------------------------------------------
// The knob table the game client reads so a candidate mitigation for the Pi
// Browser crash loop can be flipped WITHOUT a thirty-minute WebGL rebuild.
//
//   Owner ruling 2026-09-02, verbatim:
//     "make the testing as robust as possible with as many solutions as
//      possible... all we really have to do is just flip a flag and possibly
//      redeploy"
//
// READ-ONLY and PUBLIC, no auth. The same three reasons api/maintenance.js and
// api/dungeon-status.js give:
//   1. It must resolve before sign-in. These knobs govern BOOT-TIME asset policy,
//      which happens long before any identity exists.
//   2. Nothing is disclosed: eight key names the client already ships, and small
//      integers.
//   3. Auth would make every sign-in failure look like a configuration change.
//
// WRITES go through tools/client-tunables.mjs (DATABASE_URL, operator machine,
// driven by tools\command-centre.ps1 -Tunables) and through api/admin/ops.js,
// which is POST-only behind TWO secrets. No write surface is minted here - the
// public read endpoint must not also be the write endpoint.
//
// ⛔ THIS ENDPOINT CANNOT CHANGE HOW THE GAME BEHAVES BY FAILING. Every default
// lives in the BUILD (DeNelle.Core.Ops.RemoteTunables.Registry). A 404, a 500, a
// timeout, an empty table or malformed JSON all resolve, on the client, to the
// value the shipping code hardcoded. This table carries OVERRIDES ONLY, and an
// EMPTY table is the correct resting state - which is exactly what ships.
//
// ⭐ CACHE-CONTROL IS A TURNAROUND WINDOW, NOT A PERFORMANCE KNOB. These knobs are
// flipped by a human mid-bisect who then says "reload and tell me".
// ⭐ WO-2195 (2026-09-30, owner-delegated): s-maxage is now 120 s with
// stale-while-revalidate=300, up from 10/30. The Neon free-plan compute allowance
// ran out, and every client re-reads this route every 30 s, so a 10 s edge
// cache sent nearly every poll through to Neon (tunables + the realm stake
// read). The turnaround a running client sees is now about 150 s (120 s edge +
// the 30 s client poll); a region nobody polled for a while can serve ONE
// response up to 120 + 300 s old while it revalidates. Operator flips are
// minutes, not seconds, from here on. api/maintenance.js deliberately stays
// at 10 s: that window is an exploit-exposure window, not a turnaround.
//
// FAIL-SOFT: on any error this returns 200 with `readOk: false` and NO values,
// rather than a 500. The client treats that as "no overrides", which is the same
// thing it does when it cannot reach the endpoint at all.
//
// ⚠ vercel.json sets "git": { "deploymentEnabled": false } - PUSHING DOES NOT
//   DEPLOY. This endpoint stays dead until a deploy runs. Until it is deployed the
//   client sees a 404, drops its cache, and runs today's behaviour.
//
//   GET /api/client-tunables
//   Reply: { ok, version, readOk, reason, values: { "<key>": "<value>" },
//            realm: { living, staked_total_skr, threshold_skr, threshold_source,
//                     canopy_density01, reason },
//            order_epoch: { close_early_seconds, source, clamped, reason } }
//
// ⭐ WO-2061h - THE `realm` BLOCK IS WORLD STATE, NOT A KNOB OVERRIDE, and it rides HERE on
// purpose: this is the ONE route every client reads before sign-in and re-reads every 30 s,
// which is exactly the reach the owner's ruling needs ("should persist to all players showing
// it's living" - players with no Order included). It sits BESIDE `values`, never inside it, so
// the "overrides only" contract of `values` above is untouched. The server computes `living`
// (api/_lib/realm-stake.js) from the Command Center threshold; the client never compares
// numbers. It fails to living:false with a named reason, never to a guessed true.
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { applyCors } = require('./_lib/http');
const { readTunables, TUNABLE_KEYS } = require('./_lib/tunables');
const realmStake = require('./_lib/realm-stake');
const clanBallot = require('./_lib/clan-ballot');

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ SERVER-ONLY KEYS NEVER LEAVE THE SERVER (WO-1799).
// ─────────────────────────────────────────────────────────────────────────────
// This endpoint is PUBLIC and UNAUTHENTICATED. Every key it serves is a key any
// player can read. That is fine for a load-timeout or a spell colour and it is
// NOT fine for a knob the SERVER is authoritative for - the first of which is the
// storewide sale percentage (api/_lib/store-sale.js).
//
// A sale bps on a phone is a second opinion about money on a device we do not
// control: exactly the duplicated-state failure CLAUDE.md sections 2, 5 and 16
// each record a scar from, arriving through the money door. It is withheld here
// rather than "not read by the client", because what a client chooses to read is
// not a boundary - what the server sends is.
//
// ⚠ DERIVED FROM THE ALLOWLIST, NEVER A SECOND LIST. A hand-typed set of excluded
// names here would be the copy this whole rail's header refuses to make: the day a
// second serverOnly knob lands, that copy would ship its value to every phone.
const SERVER_ONLY_KEYS = new Set(
    TUNABLE_KEYS.filter((s) => s && s.serverOnly === true).map((s) => s.key));

/** The public subset of an override map: everything the server does not keep. */
function publicValues(values) {
    const out = {};
    for (const key of Object.keys(values || {})) {
        if (SERVER_ONLY_KEYS.has(key)) continue;
        out[key] = values[key];
    }
    return out;
}

/** Payload schema version. The client parses forward-compatibly (RemoteTunables). */
const PAYLOAD_VERSION = 1;

module.exports = async (req, res) => {
    if (applyCors(req, res, 'GET, OPTIONS')) return;

    if (req.method !== 'GET') {
        return res.status(400).json({ error: 'Method not allowed' });
    }

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=300');

    let sql = null;
    try { sql = neon(process.env.DATABASE_URL); }
    catch (_) { sql = null; }

    // readTunables never throws and never rejects; ok=false is the fail-to-default branch.
    const state = await readTunables(sql);

    // WO-2061h: never throws (readRealm fails to living:false with a named reason).
    let realm;
    try { realm = await realmStake.readRealm(sql, state); }
    catch (err) {
        realm = { living: false, staked_total_skr: null, threshold_skr: realmStake.DEFAULT_THRESHOLD_SKR,
                  threshold_source: 'default', canopy_density01: 0,
                  reason: 'REALM_READ_THREW: ' + ((err && err.message) || String(err)) };
    }

    return res.status(200).json({
        ok: true,
        version: PAYLOAD_VERSION,
        readOk: state.ok === true,
        reason: state.reason,
        values: state.ok ? publicValues(state.values) : {},
        realm: realm,
        order_epoch: orderEpochBlock(state),
    });
};

/**
 * The Order ballot close-early override AS THE SERVER RESOLVED IT (owner-delegated
 * 2026-09-30). Like `realm`, it sits BESIDE `values`, never inside it: the raw row is a
 * serverOnly key and stays withheld above; this block is the clamped value the server is
 * actually applying, which is what the Command Center card shows as "Now". Nothing on a phone
 * reads it (the ballot wire already carries the effective close times). Never throws.
 */
function orderEpochBlock(state) {
    try {
        const r = clanBallot.resolveCloseEarlySeconds(state);
        return { close_early_seconds: r.seconds, source: r.source, clamped: r.clamped, reason: r.why };
    } catch (err) {
        return { close_early_seconds: clanBallot.EPOCH_CLOSE_EARLY_DEFAULT_SECONDS, source: 'default',
                 clamped: false, reason: 'ORDER_EPOCH_RESOLVE_THREW: ' + ((err && err.message) || String(err)) };
    }
}

module.exports._test = { SERVER_ONLY_KEYS, publicValues, PAYLOAD_VERSION, orderEpochBlock };
