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

test('the sums read PERSISTED verified stake (heartbound_state x clan_members), never RPC', async () => {
    const sql = stakeSql(1000);
    await realm.readStakeSum(sql, null);
    await realm.readStakeSum(sql, 'clan-1');
    assert.equal(sql.calls.length, 2);
    for (const c of sql.calls) {
        assert.match(c.text, /FROM\s+clan_members\s+cm\s+JOIN\s+heartbound_state\s+hs\s+ON\s+hs\.player_id\s*=\s*cm\.wallet/i);
        assert.match(c.text, /last_actual_stake/);
        assert.match(c.text, /IN \('ACTIVE', 'STALE'\)/);
    }
    assert.deepEqual(realm.COUNTED_STATUSES, ['ACTIVE', 'STALE'], 'the SQL literal and the export must agree');
    assert.match(sql.calls[1].text, /cm\.clan_id\s*=/);
    assert.deepEqual(sql.calls[1].values, ['clan-1']);
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
