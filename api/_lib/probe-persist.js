'use strict';

// =============================================================================
// api/_lib/probe-persist.js - WO-2195: write a probe row to Neon ONLY when it
// means something.
// -----------------------------------------------------------------------------
// WHY THIS EXISTS: the Neon free-plan compute allowance (100 CU-hours/month)
// ran out on 2026-09-30. The three frequent probe crons
// (api/cron/swap-quote-probe.js and api/cron/api-health-probe.js every 15
// minutes, api/cron/applixir-read-probe.js hourly) each did an INSERT into
// analytics_events on EVERY run, so Neon was woken four times an hour by
// machines reporting "still fine". A woken Neon compute stays up until its
// idle-suspend timeout, so a 15-minute write cadence keeps it awake a large
// part of every hour with no player online at all.
//
// THE RULE (per probe key, kept in THIS MODULE'S MEMORY - no database read):
//   * 'first'      - this function instance has never seen the key (a cold
//                    start, which includes the first run after a deploy) -> WRITE.
//   * 'transition' - ok flipped (OK->DOWN or DOWN->OK)                  -> WRITE.
//   * 'heartbeat'  - a 6 h wall-clock slot boundary (00/06/12/18 UTC) was
//                    crossed since this key's last row                   -> WRITE.
//   * 'unchanged'  - same ok state, heartbeat not due                   -> NO DB CALL.
//
// The steady state therefore makes NO database call at all: not a write, and
// not a "what did I write last time" read either (a read wakes Neon exactly as
// much as a write does, so reading the last state back from Neon would have
// saved nothing).
//
// ⚠ WHAT IS UNPROVEN, AND HOW THE ROWS PROVE IT. Module memory dies when Vercel
// recycles the instance. If instances are recycled between two 15-minute ticks,
// every run is 'first' and this degrades to today's behaviour (a row per run) -
// never to a LOST reading. Nothing on this seat can measure the recycle rate,
// so every written row carries `write_reason`, `instance_id` and
// `skipped_since_last_write`; after deploy,
//     SELECT properties->>'write_reason', COUNT(*) ... GROUP BY 1
// names it in one read. If 'first' dominates, the follow-up is a shared store
// that is not Neon (Vercel Runtime Cache), not a longer heartbeat.
//
// WHAT A ROW NO LONGER MEANS: "a run happened". It now means "the state changed,
// or this is the 6-hourly proof the schedule is alive". `down_since` in
// api/admin/stats.js (first not-ok row after the last ok row) still dates an
// outage correctly because OK->DOWN always writes; `runs_in_window` there now
// counts ROWS, not runs. Every run still prints its full reading to the Vercel
// function log, so the per-run evidence is not lost - it moved to the log.
//
// ⛔ ok IS THE ONLY STATE. Latency, prices and error TEXT change on every run
// (an error string can carry a measured millisecond count), so comparing them
// would write every run and save nothing. A change of error text while still
// DOWN is not a transition; the 6 h heartbeat records the current text.
// =============================================================================

const crypto = require('crypto');

/** A row at least this often per key per instance, so "is the schedule alive" stays answerable. */
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

// ⭐ THE HEARTBEAT IS A WALL-CLOCK SLOT, NOT "6 h SINCE THIS KEY'S LAST ROW".
// Elapsed-time heartbeats drift apart: a key that flipped at 02:00 would next
// heartbeat at 08:00 while the others fire at 06:00, and every such key adds its
// own wake every 6 h forever. With slots, every key and both 15-minute crons
// heartbeat on the SAME tick (the first one after 00/06/12/18 UTC), so they
// share one Neon wake. Accepted cost: a cold start just before a boundary writes
// twice within minutes.
function slotOf(ms) {
    return Math.floor(ms / HEARTBEAT_MS);
}

/** Minted once per module load = once per function instance. Rows carry it. */
const INSTANCE_ID = crypto.randomBytes(4).toString('hex');

/** @type {Map<string, { ok: boolean, lastWriteAt: number, skipped: number }>} */
const memory = new Map();

function nowOf(opts) {
    if (opts && typeof opts.now === 'number') return opts.now;
    return Date.now();
}

/** The one piece of state compared across runs. */
function okOf(probe) {
    return !!(probe && probe.ok === true);
}

/**
 * Decide whether this reading earns a database row. Pure: does not mutate
 * memory - call commit() after the write was attempted.
 * @returns {{ write: boolean, reason: 'first'|'transition'|'heartbeat'|'unchanged',
 *             ok: boolean, previous_ok: boolean|null, last_write_at: number|null,
 *             skipped_since_last_write: number }}
 */
function decide(key, probe, opts) {
    const t = nowOf(opts);
    const ok = okOf(probe);
    const prev = memory.get(String(key));
    if (!prev) {
        return { write: true, reason: 'first', ok: ok, previous_ok: null,
                 last_write_at: null, skipped_since_last_write: 0 };
    }
    const base = { ok: ok, previous_ok: prev.ok, last_write_at: prev.lastWriteAt,
                   skipped_since_last_write: prev.skipped };
    if (prev.ok !== ok) return Object.assign({ write: true, reason: 'transition' }, base);
    if (slotOf(t) !== slotOf(prev.lastWriteAt)) return Object.assign({ write: true, reason: 'heartbeat' }, base);
    return Object.assign({ write: false, reason: 'unchanged' }, base);
}

/**
 * Record the outcome of a decide(). `wrote` = a write was ATTEMPTED against a
 * live handle without throwing. A write that threw is NOT committed, so the next
 * run retries it instead of believing the row landed.
 */
function commit(key, decision, wrote, opts) {
    const k = String(key);
    const t = nowOf(opts);
    const prev = memory.get(k);
    if (decision && decision.write) {
        if (!wrote) return;
        memory.set(k, { ok: !!decision.ok, lastWriteAt: t, skipped: 0 });
        return;
    }
    if (prev) prev.skipped += 1;
}

/**
 * True when any of these keys has never been written by this instance, or its
 * last row is in an earlier heartbeat slot. Used to gate the probes whose CHECK
 * ITSELF reads Neon (api-health-probe's `neon` and `api_health`), so they run
 * only when a row is due anyway.
 */
function isDue(keys, opts) {
    const t = nowOf(opts);
    for (const key of keys || []) {
        const prev = memory.get(String(key));
        if (!prev) return true;
        if (slotOf(t) !== slotOf(prev.lastWriteAt)) return true;
    }
    return false;
}

/** The row that is written: the probe verbatim plus the three proving fields. */
function stamp(probe, decision) {
    return Object.assign({}, probe || {}, {
        write_reason: decision ? decision.reason : null,
        instance_id: INSTANCE_ID,
        skipped_since_last_write: decision ? decision.skipped_since_last_write : 0,
    });
}

/** Test helper. */
function reset() {
    memory.clear();
}

module.exports = {
    HEARTBEAT_MS,
    slotOf,
    INSTANCE_ID,
    commit,
    decide,
    isDue,
    okOf,
    reset,
    stamp,
};
