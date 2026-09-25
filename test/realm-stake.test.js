// =============================================================================
// test/realm-stake.test.js - WO-2061h. The realm "living" rule and the Circle canopy curve.
// -----------------------------------------------------------------------------
// Owner rulings 2026-09-25, verbatim:
//   "If total orders have over 200k staked should persist to all players showing it's living"
//   "The total should be tunable from the command center"
//   "The higher the stake the more alive it displays" / "For all the circle"
// Zero network, zero database: the stake sum runs against a fake sql tag.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const realm = require('../api/_lib/realm-stake');
const config = require('../api/_lib/realm-config.json');
const { TUNABLE_KEYS } = require('../api/_lib/tunables');
const ballot = require('../api/_lib/clan-ballot');

const UNITS = 1000000n; // SKR is 6 decimals (heartbound-resonance-config.json chain.skrBaseUnits)

/** A fake neon tag answering the stake sum with `skr` whole SKR (or throwing). */
function stakeSql(skr, opts = {}) {
    const calls = [];
    const fn = (strings, ...values) => {
        const text = strings.join(' ? ');
        calls.push({ text, values });
        if (opts.throws) return Promise.reject(new Error(opts.throws));
        if (opts.empty) return Promise.resolve([]);
        const raw = (BigInt(Math.round(skr)) * UNITS).toString();
        return Promise.resolve([{ total_raw: raw, stakers: 3 }]);
    };
    fn.calls = calls;
    return fn;
}

const TUNABLES_EMPTY = { ok: true, values: {}, reason: 'ok' };

test('the default threshold is the owner\'s 200,000, in ONE place', () => {
    assert.equal(config.livingStakeThresholdSkr, 200000);
    assert.equal(realm.DEFAULT_THRESHOLD_SKR, 200000);
});

test('living is strictly OVER the threshold: 199,999 -> false, 200,000 -> false, 200,001 -> true', () => {
    assert.equal(realm.isLiving(199999, 200000), false);
    assert.equal(realm.isLiving(200000, 200000), false, '"over 200k" - equal is not over');
    assert.equal(realm.isLiving(200001, 200000), true);
    assert.equal(realm.isLiving(NaN, 200000), false);
});

test('readRealm: 199,999 total -> not living; 200,001 -> living; the Circle-independent block', async () => {
    const low = await realm.readRealm(stakeSql(199999), TUNABLES_EMPTY);
    assert.equal(low.living, false);
    assert.equal(low.staked_total_skr, 199999);
    assert.equal(low.threshold_skr, 200000);
    assert.equal(low.threshold_source, 'default');
    assert.equal(low.canopy_density01, 0);

    const high = await realm.readRealm(stakeSql(200001), TUNABLES_EMPTY);
    assert.equal(high.living, true);
    assert.equal(high.staked_total_skr, 200001);
    assert.equal(high.canopy_density01, config.realmLivingCanopy01);
});

test('the Command Center row moves the line: 150,000 flips a 175,000 total to living', async () => {
    const tun = { ok: true, values: { 'realm.livingStakeThresholdSkr': '150000' }, reason: 'ok' };
    const r = await realm.readRealm(stakeSql(175000), tun);
    assert.equal(r.living, true);
    assert.equal(r.threshold_skr, 150000);
    assert.equal(r.threshold_source, 'tunable');
    // ...and without the row the same total is NOT living (default 200,000).
    const d = await realm.readRealm(stakeSql(175000), TUNABLES_EMPTY);
    assert.equal(d.living, false);
    assert.equal(d.threshold_skr, 200000);
    assert.equal(d.threshold_source, 'default');
});

test('a junk or unreadable threshold row falls back to the default, and says why', () => {
    assert.deepEqual(realm.resolveThreshold({ ok: true, values: { 'realm.livingStakeThresholdSkr': '0' } }).thresholdSkr, 200000);
    assert.equal(realm.resolveThreshold({ ok: true, values: { 'realm.livingStakeThresholdSkr': 'x' } }).source, 'default');
    const unread = realm.resolveThreshold({ ok: false, values: {}, reason: 'TABLE_UNREADABLE' });
    assert.equal(unread.source, 'default');
    assert.match(unread.why, /TABLE_UNREADABLE/);
});

test('missing stake data -> living FALSE with a NAMED reason, never a guessed true', async () => {
    const threw = await realm.readRealm(stakeSql(0, { throws: 'neon down' }), TUNABLES_EMPTY);
    assert.equal(threw.living, false);
    assert.equal(threw.staked_total_skr, null);
    assert.match(threw.reason, /^STAKE_READ_FAILED/);

    const empty = await realm.readRealm(stakeSql(0, { empty: true }), TUNABLES_EMPTY);
    assert.equal(empty.living, false);
    assert.equal(empty.reason, 'STAKE_READ_EMPTY');

    const none = await realm.readRealm(null, TUNABLES_EMPTY);
    assert.equal(none.living, false);
    assert.equal(none.reason, 'NO_SQL_HANDLE');
});

test('the sums read PERSISTED verified stake (skr_stake_snapshots x clan_members), never RPC, never heartbound_state', async () => {
    const sql = stakeSql(1000);
    const nowMs = Date.parse('2026-09-25T20:00:00Z');
    await realm.readStakeSum(sql, null, { nowMs, graceSeconds: 86400 });
    await realm.readStakeSum(sql, 'clan-1', { nowMs, graceSeconds: 86400 });
    assert.equal(sql.calls.length, 2);
    for (const c of sql.calls) {
        assert.match(c.text, /FROM\s+clan_members\s+cm\s+JOIN\s+skr_stake_snapshots\s+ss\s+ON\s+ss\.player_id\s*=\s*cm\.wallet/i);
        assert.match(c.text, /SUM\(ss\.active_staked_raw\)/);
        assert.match(c.text, /ss\.verification_status = 'VERIFIED'/);
        assert.match(c.text, /ss\.active_staked_raw IS NOT NULL/);
        assert.match(c.text, /ss\.verified_at\s*>=\s*\?/, 'freshness is measured from the last SUCCESS (verified_at)');
        assert.doesNotMatch(c.text, /heartbound_state|last_actual_stake|last_attempt_at/,
            'heartbound_state has no live writer (SKR audit 2026-09-25 blocker 1)');
    }
    assert.deepEqual(realm.COUNTED_STATUSES, ['VERIFIED'], 'the SQL literal and the export must agree');
    assert.match(sql.calls[1].text, /cm\.clan_id\s*=/);
    assert.deepEqual(sql.calls[0].values, ['2026-09-24T20:00:00.000Z'], 'realm: only the cutoff is bound');
    assert.deepEqual(sql.calls[1].values, ['clan-1', '2026-09-24T20:00:00.000Z']);
});

// ---------------------------------------------------------------------------------------------
// WO-2061o: a fixture fake that APPLIES the WHERE clause the SQL spells, over rows shaped like
// clan_members x skr_stake_snapshots, so the sums are asserted as results, not only as text.
// ---------------------------------------------------------------------------------------------
const NOW_MS = Date.parse('2026-09-25T20:00:00Z');
const HOUR = 3600 * 1000;
function snapshotSql(rows) {
    const calls = [];
    const fn = (strings, ...values) => {
        const text = strings.join(' ? ');
        calls.push({ text, values });
        const byClan = /cm\.clan_id\s*=/.test(text);
        const clanId = byClan ? values[0] : null;
        const cutoffMs = Date.parse(values[values.length - 1]);
        const hit = rows.filter((r) => (!byClan || r.clan_id === clanId) &&
            r.status === 'VERIFIED' && r.raw != null &&
            r.verified_at != null && Date.parse(r.verified_at) >= cutoffMs);
        const total = hit.reduce((a, r) => a + BigInt(r.raw), 0n);
        return Promise.resolve([{ total_raw: total.toString(), stakers: hit.length }]);
    };
    fn.calls = calls;
    return fn;
}
const iso = (msAgo) => new Date(NOW_MS - msAgo).toISOString();
const skrRaw = (whole) => (BigInt(whole) * UNITS).toString();

test('empty snapshots -> total 0, not living (a real zero, reason stated)', async () => {
    const r = await realm.readRealm(snapshotSql([]), TUNABLES_EMPTY, { nowMs: NOW_MS, graceSeconds: 86400 });
    assert.equal(r.staked_total_skr, 0);
    assert.equal(r.living, false);
    assert.equal(r.reason, 'total at or below threshold');
    const c = await realm.readStakeSum(snapshotSql([]), 'clan-a', { nowMs: NOW_MS, graceSeconds: 86400 });
    assert.equal(c.ok, true);
    assert.equal(c.totalSkr, 0);
    assert.equal(c.members, 0);
});

test('a snapshot older than the writer\'s grace window is ignored; failed/NO_STAKE/never-verified rows never count', async () => {
    const rows = [
        { clan_id: 'clan-a', status: 'VERIFIED', raw: skrRaw(8000), verified_at: iso(5 * HOUR) },   // counts
        { clan_id: 'clan-a', status: 'VERIFIED', raw: skrRaw(90000), verified_at: iso(25 * HOUR) }, // stale
        { clan_id: 'clan-a', status: 'NO_STAKE', raw: '0', verified_at: iso(1 * HOUR) },
        { clan_id: 'clan-a', status: 'RPC_UNAVAILABLE', raw: null, verified_at: null },             // first try failed
    ];
    const s = await realm.readStakeSum(snapshotSql(rows), 'clan-a', { nowMs: NOW_MS, graceSeconds: 86400 });
    assert.equal(s.totalSkr, 8000);
    assert.equal(s.members, 1);
    assert.equal(s.cutoffIso, iso(24 * HOUR));
    // A wider window (the env knob) admits the 25-hour row: the bound is the writer's, not ours.
    const wide = await realm.readStakeSum(snapshotSql(rows), 'clan-a', { nowMs: NOW_MS, graceSeconds: 2 * 86400 });
    assert.equal(wide.totalSkr, 98000);
});

test('the default window IS skr-staking\'s staleGraceSeconds() - no second staleness number', () => {
    const skr = require('../api/_lib/skr-staking');
    const c = realm.freshnessCutoff({ nowMs: NOW_MS });
    assert.equal(c.graceSeconds, skr.staleGraceSeconds());
    assert.equal(c.cutoffIso, new Date(NOW_MS - skr.staleGraceSeconds() * 1000).toISOString());
});

test('realm sums the members of ALL Orders ("total orders"); the Circle sums only its own', async () => {
    const rows = [
        { clan_id: 'clan-a', status: 'VERIFIED', raw: skrRaw(120000), verified_at: iso(1 * HOUR) },
        { clan_id: 'clan-a', status: 'VERIFIED', raw: skrRaw(30000), verified_at: iso(2 * HOUR) },
        { clan_id: 'clan-b', status: 'VERIFIED', raw: skrRaw(60000), verified_at: iso(3 * HOUR) },
    ];
    const opts = { nowMs: NOW_MS, graceSeconds: 86400 };
    const a = await realm.readStakeSum(snapshotSql(rows), 'clan-a', opts);
    const b = await realm.readStakeSum(snapshotSql(rows), 'clan-b', opts);
    assert.equal(a.totalSkr, 150000);
    assert.equal(b.totalSkr, 60000);
    // Neither Order alone is over 200k; together (210k) they are - the realm is ALL Orders.
    const r = await realm.readRealm(snapshotSql(rows), TUNABLES_EMPTY, opts);
    assert.equal(r.staked_total_skr, 210000);
    assert.equal(r.living, true);
    assert.equal(r.threshold_skr, 200000);
});

test('the threshold comes from the Command Center tunable over snapshot data', async () => {
    const rows = [{ clan_id: 'clan-a', status: 'VERIFIED', raw: skrRaw(8213), verified_at: iso(5 * HOUR) }];
    const opts = { nowMs: NOW_MS, graceSeconds: 86400 };
    const dflt = await realm.readRealm(snapshotSql(rows), TUNABLES_EMPTY, opts);
    assert.equal(dflt.living, false);
    assert.equal(dflt.threshold_source, 'default');
    const tun = { ok: true, values: { 'realm.livingStakeThresholdSkr': '8000' }, reason: 'ok' };
    const knob = await realm.readRealm(snapshotSql(rows), tun, opts);
    assert.equal(knob.living, true);
    assert.equal(knob.threshold_skr, 8000);
    assert.equal(knob.threshold_source, 'tunable');
});

test('base units convert through the resonance table (6 decimals), fractions kept', () => {
    assert.equal(realm.rawToSkr('200001000000'), 200001);
    assert.equal(realm.rawToSkr('1500000'), 1.5);
    assert.equal(realm.rawToSkr('0'), 0);
    assert.ok(Number.isNaN(realm.rawToSkr('not-a-number')));
});

test('Circle canopy: no vote -> 0; any resolved vote -> at least the minimum; full at the stated stake', () => {
    const min = config.circleCanopy.minAtResolvedVote01;
    const full = config.circleCanopy.fullAtStakeSkr;
    assert.equal(realm.circleCanopyDensity(false, 1e9), 0, 'no resolved vote, no leaves - whatever the stake');
    assert.equal(realm.circleCanopyDensity(true, 0), min);
    assert.equal(realm.circleCanopyDensity(true, NaN), min, 'unknown stake: the minimum, never guessed up');
    assert.equal(realm.circleCanopyDensity(true, full / 2), Math.round((min + (1 - min) * 0.5) * 1000) / 1000);
    assert.equal(realm.circleCanopyDensity(true, full), 1);
    assert.equal(realm.circleCanopyDensity(true, full * 10), 1, 'bounded');
});

test('toWire carries circle_staked_skr + canopy_density01, 0 without an active banner', () => {
    const noBanner = ballot.toWire({ vigilWeight: 0.5, perks: [], circleStakedSkr: 50000 });
    assert.equal(noBanner.canopy_density01, 0);
    assert.equal(noBanner.circle_staked_skr, 50000);
    const withBanner = ballot.toWire({
        vigilWeight: 0.5, circleStakedSkr: config.circleCanopy.fullAtStakeSkr,
        perks: [{ tier: 0, perkId: 'banner_gale', epochIndex: 129, activatedAt: 'T', expiresAt: null }],
    });
    assert.equal(withBanner.canopy_density01, 1);
    const unknown = ballot.toWire({
        vigilWeight: 0.5,
        perks: [{ tier: 0, perkId: 'banner_tide', epochIndex: 129, activatedAt: 'T', expiresAt: null }],
    });
    assert.equal(unknown.circle_staked_skr, null);
    assert.equal(unknown.canopy_density01, config.circleCanopy.minAtResolvedVote01);
});

test('the threshold knob is a writable serverOnly key the public payload never serves', () => {
    const spec = TUNABLE_KEYS.find((k) => k.key === 'realm.livingStakeThresholdSkr');
    assert.ok(spec, 'allowlisted');
    assert.equal(spec.serverOnly, true);
    assert.equal(spec.kind, 'int');
    const tunablesRoute = require('../api/client-tunables.js');
    assert.equal(tunablesRoute._test.SERVER_ONLY_KEYS.has('realm.livingStakeThresholdSkr'), true);
    assert.deepEqual(tunablesRoute._test.publicValues({ 'realm.livingStakeThresholdSkr': '150000' }), {},
        'the client is told living, never the rule');
});
