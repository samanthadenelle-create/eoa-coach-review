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
// flipped by a human mid-bisect who then says "reload and tell me". s-maxage is
// therefore 10 s, matching api/maintenance.js rather than the 60 s
// api/dungeon-status.js uses. Total worst case to a running client is about 40 s:
// 10 s edge + the 30 s client poll.
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
//   Reply: { ok, version, readOk, reason, values: { "<key>": "<value>" } }
// =============================================================================

const { neon } = require('@neondatabase/serverless');
const { applyCors } = require('./_lib/http');
const { readTunables } = require('./_lib/tunables');

/** Payload schema version. The client parses forward-compatibly (RemoteTunables). */
const PAYLOAD_VERSION = 1;

module.exports = async (req, res) => {
    if (applyCors(req, res, 'GET, OPTIONS')) return;

    if (req.method !== 'GET') {
        return res.status(400).json({ error: 'Method not allowed' });
    }

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30');

    let sql = null;
    try { sql = neon(process.env.DATABASE_URL); }
    catch (_) { sql = null; }

    // readTunables never throws and never rejects; ok=false is the fail-to-default branch.
    const state = await readTunables(sql);

    return res.status(200).json({
        ok: true,
        version: PAYLOAD_VERSION,
        readOk: state.ok === true,
        reason: state.reason,
        values: state.ok ? state.values : {},
    });
};
