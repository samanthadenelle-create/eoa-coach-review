'use strict';

// =============================================================================
// api/cron/swap-quote-probe.js — WO-1902: the scheduled SKR swap-rail heartbeat.
// -----------------------------------------------------------------------------
// A thin shell, the same shape as api/cron/heart-pulse.js (read at source
// 2026-09-20): authenticate, run the probe, persist one row, answer with the
// result. ALL the logic lives in api/_lib/swap-quote-probe.js and is unit-tested
// with a mocked fetch in test/swap-probe.test.js.
//
// WHY A CRON AND NOT JUST THE DASHBOARD READ: the live probe on
// ?view=command answers "is it up RIGHT NOW", which is only ever true when
// somebody is looking. The owner discovered the dead v6 host by losing sales.
// This route runs unattended, so the HISTORY exists — "DOWN since 14:15" is a
// query over these rows, and it is the only thing that can date an outage.
//
// SCHEDULE: */15 * * * * in vercel.json. Worst-case detection latency 15 min.
// ⭐ WO-2195: the CHECK runs every tick; the Neon ROW does not. A row lands on
// the first run of an instance, on an ok flip, and as a 6 h heartbeat
// (api/_lib/probe-persist.js) - the Neon free-plan compute ran out on
// 2026-09-30 and a write every 15 min kept it awake. Every tick still logs its
// full reading to the Vercel function log.
// ⚠ UNVERIFIED FROM THIS SEAT: Vercel's HOBBY plan caps cron frequency at once
// per day and REJECTS a deployment whose schedule is finer. Every pre-existing
// cron in this repo is daily, which is suggestive but is NOT proof of the plan.
// The lead must confirm the plan before deploy; on Hobby the fallback is
// `0 */6 * * *` and the detection promise drops to six hours accordingly.
//
// AUTH — copied in shape from api/cron/heart-pulse.js:44-63: Authorization:
// Bearer <CRON_SECRET> (Vercel injects this on the scheduled invocation) OR
// X-Admin-Key == ADMIN_DASH_KEY, both SHA-256 then timingSafeEqual — never
// `===`, which is a timing oracle. Refusal is 400, never 401/403, and there are
// NO CORS headers: this is server-to-server.
//
// ⛔ NOT AN INJECTION ROUTE. It accepts no body, no mint, no host, no amount.
// The probed pair is a compile-time constant in _lib/swap-quote-probe.js, so a
// caller can never point this at an endpoint of their choosing.
//
// ⛔ A DEAD PROBE STILL ANSWERS 200. The HTTP status of THIS route reports
// whether the CHECK RAN, never whether Jupiter is healthy — those are different
// questions and conflating them would make the outage invisible to a monitor
// watching status codes. Jupiter's health is `probe.ok` in the body and in the
// persisted row.
// =============================================================================

const crypto = require('crypto');

// Constant-time secret compare. Hash both sides so timingSafeEqual is
// length-safe and never leaks length. Same shape as api/cron/heart-pulse.js:44.
function secretOk(given, expected) {
    if (!given || !expected) return false;
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = (req.headers || {})['authorization'] || '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (bearer && secretOk(bearer, cronSecret)) return true;
    }
    const adminKey = process.env.ADMIN_DASH_KEY;
    if (adminKey && secretOk((req.headers || {})['x-admin-key'], adminKey)) return true;
    return false;
}

module.exports = async (req, res) => {
    // No CORS surface — do NOT set Access-Control-Allow-Origin (never widen).

    // Vercel Cron issues GET; POST allowed for a manual admin run.
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(400).json({ error: 'Method not allowed' });
    }
    if (!isAuthorized(req)) {
        return res.status(400).json({ error: 'Unauthorized' });
    }

    const { probeJupiterQuote, summarize, EVENT_NAME } = require('../_lib/swap-quote-probe.js');

    // The probe itself never throws, so it runs OUTSIDE the db try/catch: a
    // database that is down must not cost us the reading, and the reading is
    // still returned in the response body where a Vercel log read finds it.
    const probe = await probeJupiterQuote({});

    // WO-1969: page Discord on OK->DOWN (and recover). Never throws; missing
    // DISCORD_WEBHOOK_URL = log/no-op. Must not change this route's HTTP 200 contract.
    try {
        const { emitProbeTransition } = require('../_lib/jupiter-fail-alert.js');
        await emitProbeTransition(probe, {});
    } catch (_) { /* alert must never break the probe response */ }

    try { console.log('[cron/swap-quote-probe] ' + summarize(probe) + ' ' + JSON.stringify(probe)); }
    catch (_) { /* a log must never break the request */ }

    // WO-2195: a row only on first-run / ok-transition / 6 h heartbeat. The
    // steady state makes NO database call - see api/_lib/probe-persist.js. The
    // Discord transition above is untouched and still runs on every tick.
    const persist = require('../_lib/probe-persist.js');
    const decision = persist.decide(EVENT_NAME, probe);

    let persisted = false;
    let persistError = null;
    if (decision.write) try { // intentional: the whole try/catch is this if's single statement - it runs only when a row is due
        // Required INSIDE the handler, not at module top level, so the probe
        // module and its tests never drag the DB driver onto the require path.
        const { neon } = require('@neondatabase/serverless');
        const { logApiEvent } = require('../_lib/audit.js');
        const sql = neon(process.env.DATABASE_URL);

        // ⚠ THE IDENTITY IS DELIBERATELY 'anonymous', matching the ops audit
        // write at api/_lib/ops.js:484. api/admin/stats.js EXCLUDES that bucket
        // from every distinct-player metric by construction (ANON_ID), so a
        // machine row can never be counted as a player. A bespoke sentinel id
        // would need an ANALYTICS_EXCLUDED_PLAYER_IDS entry to be safe, and an
        // env var somebody has to remember is not a guarantee.
        await logApiEvent(sql, 'anonymous', EVENT_NAME, persist.stamp(probe, decision));
        // ⚠ NOT A PROOF THE ROW LANDED. _lib/audit.logApiEvent:126-128 SWALLOWS
        // an insert failure with a console.warn, so this flag only says the
        // write was attempted against a live handle. That is why the full probe
        // result is echoed in the body above: the Vercel function log carries
        // the reading even on a night the insert never made it to Neon.
        persisted = true;
    } catch (err) {
        persistError = String((err && err.message) || err);
        try { console.error('[cron/swap-quote-probe] persist failed:', err); } catch (_) { /* noop */ }
    }
    persist.commit(EVENT_NAME, decision, persisted);
    try { console.log('[cron/swap-quote-probe] persist ' + (decision.write ? 'WRITE' : 'SKIP') + ' reason=' + decision.reason); }
    catch (_) { /* noop */ }

    // 200 = THE CHECK RAN. See the header: this status is never Jupiter's health.
    return res.status(200).json({
        success: true,
        ran_at: new Date().toISOString(),
        summary: summarize(probe),
        probe: probe,
        persist_attempted: persisted,
        persist_reason: decision.reason,
        persist_error: persistError,
    });
};
