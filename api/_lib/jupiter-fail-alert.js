'use strict';

// =============================================================================
// api/_lib/jupiter-fail-alert.js -- WO-1969: page Discord on Jupiter rail fails.
// -----------------------------------------------------------------------------
// WHY: 2026-09-20 Jupiter v6 DNS death looked like player abandon (quotes >>
// consumed). Probe tiles != paging. Owner: alert EVERY Jupiter call fail.
//
// CONTRACT (same as tools/status-post.mjs):
//   * Missing DISCORD_WEBHOOK_URL -> log + no-op. Never throw. Never paint fail OK.
//   * Webhook URL is NEVER logged (length/shape only).
//   * Discord success = HTTP 204; judge by status code.
//   * First fail ALWAYS sends. Identical keys in the window are suppressed.
//   * Owner-test wallets (isOwnerIdentity + optional OWNER_TEST_WALLET_PREFIXES)
//     -> log only, no Discord.
//
// Emitters: cron/swap-quote-probe (probe_down), events/track (client quote/sign).
// Files under api/_lib/ are NOT routed by Vercel.
// =============================================================================

const crypto = require('crypto');

let ownerIdentity;
try {
    ownerIdentity = require('./owner-identity');
} catch (_) {
    ownerIdentity = { isOwnerIdentity: () => false, OWNER_IDENTITY: '' };
}

const DEFAULT_DEDUP_MS = 10 * 60 * 1000; // 10 min sliding window
const PROBE_REMINDER_MS = 60 * 60 * 1000; // 1h while still DOWN
const WALLET_PREFIX_LEN = 8;
const CONTENT_MAX = 1900;

/** @type {Map<string, { count: number, firstAt: number, lastSentAt: number }>} */
const dedupStore = new Map();

/** Probe transition memory (warm instance best-effort). */
let lastProbeOk = null;
let lastProbeDownSentAt = 0;

function nowMs(opts) {
    if (opts && typeof opts.now === 'number') return opts.now;
    if (opts && opts.now instanceof Date) return opts.now.getTime();
    return Date.now();
}

function clip(s, n) {
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n) + '...' : str;
}

function walletPrefix(wallet) {
    if (wallet == null || wallet === '') return null;
    const w = String(wallet).trim();
    if (!w || w === 'anonymous' || w === 'unverified') return null;
    return w.slice(0, WALLET_PREFIX_LEN);
}

function readWebhook(env) {
    const e = env || process.env;
    const v = e.DISCORD_WEBHOOK_URL;
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
}

function ownerTestPrefixes(env) {
    const e = env || process.env;
    const raw = e.OWNER_TEST_WALLET_PREFIXES || e.OWNER_TEST_WALLETS || '';
    return String(raw)
        .split(/[,;\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
}

/**
 * True when this wallet should never page Discord (owner + tagged test wallets).
 */
function isOwnerTestWallet(wallet, env) {
    if (wallet == null || wallet === '') return false;
    const w = String(wallet).trim();
    if (!w) return false;
    if (ownerIdentity.isOwnerIdentity(w)) return true;
    const prefixes = ownerTestPrefixes(env);
    for (let i = 0; i < prefixes.length; i++) {
        if (w === prefixes[i] || w.startsWith(prefixes[i])) return true;
    }
    return false;
}

/**
 * Classify a fail into the WO-1969 taxonomy.
 * @returns {{ stage: string, error_code: string }}
 */
function classifyFail(input) {
    const src = input || {};
    if (src.stage) {
        return {
            stage: String(src.stage),
            error_code: clip(src.error_code || src.error || 'unknown', 120),
        };
    }
    // Probe
    if (src.probe === true || src.source === 'probe') {
        return {
            stage: 'jupiter.probe_down',
            error_code: clip(src.error || src.error_code || 'probe_down', 120),
        };
    }
    // Client analytics: swap_quote_result
    if (src.eventName === 'swap_quote_result') {
        const http = Number(src.httpStatus);
        const err = String(src.error || '');
        if (Number.isFinite(http) && http > 0 && http !== 200) {
            return { stage: 'jupiter.quote_http_fail', error_code: clip('HTTP ' + http + (err ? ' ' + err : ''), 120) };
        }
        return { stage: 'jupiter.quote_refuse', error_code: clip(err || 'quote_refuse', 120) };
    }
    // Client analytics: swap_sign_result
    if (src.eventName === 'swap_sign_result') {
        const outcome = String(src.outcome || '');
        if (outcome === 'refused' || outcome === 'refused-presim') {
            return { stage: 'client.wallet_sign_refuse', error_code: clip(src.error || outcome, 120) };
        }
        if (outcome === 'error') {
            return { stage: 'jupiter.swap_fail', error_code: clip(src.error || 'swap_error', 120) };
        }
        return { stage: 'client.modal', error_code: clip(src.error || outcome || 'modal', 120) };
    }
    if (src.eventName === 'swap_modal_fail' || src.stageHint === 'modal') {
        return { stage: 'client.modal', error_code: clip(src.error || 'modal', 120) };
    }
    return {
        stage: clip(src.fallbackStage || 'jupiter.quote_http_fail', 80),
        error_code: clip(src.error || src.error_code || 'unknown', 120),
    };
}

function dedupKey(parts) {
    const stage = parts.stage || '';
    const code = parts.error_code || '';
    const sku = parts.sku || '';
    const network = parts.network || '';
    const quoteId = parts.quote_id || '';
    // Collapse retries of the same quote_id+stage; otherwise stage+code+sku+network.
    const raw = quoteId
        ? ['qid', stage, quoteId].join('|')
        : [stage, code, sku, network].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Decide whether to send. First fail always sends.
 * @returns {{ send: boolean, reason: string, count: number, digest?: boolean }}
 */
function shouldSend(key, opts) {
    const windowMs = (opts && opts.dedupMs) || DEFAULT_DEDUP_MS;
    const t = nowMs(opts);
    const prev = dedupStore.get(key);
    if (!prev) {
        dedupStore.set(key, { count: 1, firstAt: t, lastSentAt: t });
        return { send: true, reason: 'first', count: 1 };
    }
    prev.count += 1;
    if (t - prev.lastSentAt < windowMs) {
        return { send: false, reason: 'dedup', count: prev.count };
    }
    prev.lastSentAt = t;
    return { send: true, reason: 'window_elapsed', count: prev.count, digest: true };
}

/** Test helper: clear in-memory dedup + probe state. */
function resetDedupState() {
    dedupStore.clear();
    lastProbeOk = null;
    lastProbeDownSentAt = 0;
}

function formatDiscordContent(payload) {
    const p = payload || {};
    const lines = [
        '**JUPITER FAIL** `' + (p.stage || '?') + '`',
        'error=' + clip(p.error_code || p.error || '', 200),
        'network=' + (p.network || '?'),
        'sku=' + (p.sku || '-'),
        'quote_id=' + (p.quote_id || '-'),
        'wallet_prefix=' + (p.wallet_prefix || '-'),
    ];
    if (p.http != null) lines.push('http=' + p.http);
    if (p.latency_ms != null) lines.push('latency_ms=' + p.latency_ms);
    if (p.count && p.count > 1) lines.push('still_failing_count=' + p.count);
    if (p.note) lines.push(clip(p.note, 200));
    let content = lines.join('\n');
    if (content.length > CONTENT_MAX) content = content.slice(0, CONTENT_MAX - 20) + '\n...(truncated)';
    return content;
}

/**
 * POST to Discord webhook. Never throws. Never logs the URL.
 * @returns {Promise<{ ok: boolean, skipped?: string, http?: number }>}
 */
async function postDiscord(content, opts) {
    const env = (opts && opts.env) || process.env;
    const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
    const url = readWebhook(env);
    if (!url) {
        try {
            console.log('[jupiter-fail-alert] SKIP no DISCORD_WEBHOOK_URL (len=0)');
        } catch (_) { /* noop */ }
        return { ok: true, skipped: 'no_webhook' };
    }
    if (typeof fetchImpl !== 'function') {
        try {
            console.log('[jupiter-fail-alert] SKIP fetch_unavailable');
        } catch (_) { /* noop */ }
        return { ok: true, skipped: 'fetch_unavailable' };
    }
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(content || '').slice(0, CONTENT_MAX) }),
        });
        const http = Number(res && res.status);
        if (http === 204) {
            try { console.log('[jupiter-fail-alert] OK Discord 204'); } catch (_) { /* noop */ }
            return { ok: true, http: 204 };
        }
        try {
            console.log('[jupiter-fail-alert] FAIL Discord HTTP ' + http);
        } catch (_) { /* noop */ }
        return { ok: false, http: http };
    } catch (err) {
        try {
            console.log('[jupiter-fail-alert] FAIL Discord threw: ' + clip(err && err.message, 120));
        } catch (_) { /* noop */ }
        return { ok: false, http: null };
    }
}

/**
 * Emit a Jupiter (or client-stage) fail alert.
 * Always safe: never throws to callers.
 *
 * @param {object} input
 * @param {object} [opts]  { fetch, env, now, dedupMs, force }
 * @returns {Promise<{ sent: boolean, skipped?: string, stage?: string, key?: string, count?: number }>}
 */
async function emitJupiterFail(input, opts) {
    try {
        const src = input || {};
        const env = (opts && opts.env) || process.env;
        const classified = classifyFail(src);
        const network = src.network || env.SOLANA_NETWORK || env.NETWORK || 'mainnet';
        const sku = src.sku != null ? String(src.sku) : null;
        const quoteId = src.quote_id != null ? String(src.quote_id) : (src.quoteId != null ? String(src.quoteId) : null);
        const wallet = src.wallet != null ? src.wallet : src.playerId;
        const prefix = walletPrefix(wallet);

        if (isOwnerTestWallet(wallet, env)) {
            try {
                console.log('[jupiter-fail-alert] SKIP owner-test wallet_prefix=' + (prefix || '-') +
                    ' stage=' + classified.stage);
            } catch (_) { /* noop */ }
            return { sent: false, skipped: 'owner_test', stage: classified.stage };
        }

        const key = dedupKey({
            stage: classified.stage,
            error_code: classified.error_code,
            sku: sku || '',
            network: String(network),
            quote_id: quoteId || '',
        });

        const decision = (opts && opts.force)
            ? { send: true, reason: 'force', count: 1 }
            : shouldSend(key, opts);

        if (!decision.send) {
            try {
                console.log('[jupiter-fail-alert] DEDUP stage=' + classified.stage +
                    ' count=' + decision.count + ' key=' + key);
            } catch (_) { /* noop */ }
            return { sent: false, skipped: 'dedup', stage: classified.stage, key: key, count: decision.count };
        }

        const payload = {
            stage: classified.stage,
            error_code: classified.error_code,
            error: classified.error_code,
            sku: sku,
            quote_id: quoteId,
            wallet_prefix: prefix,
            network: String(network),
            http: src.http != null ? src.http : (src.httpStatus != null ? src.httpStatus : null),
            latency_ms: src.latency_ms != null ? src.latency_ms : (src.elapsedMs != null ? src.elapsedMs : null),
            count: decision.count,
            note: decision.digest ? 'still failing (dedup window elapsed)' : null,
        };

        const content = formatDiscordContent(payload);
        const post = await postDiscord(content, opts);
        if (post.skipped) {
            return { sent: false, skipped: post.skipped, stage: classified.stage, key: key, count: decision.count };
        }
        return { sent: !!post.ok, stage: classified.stage, key: key, count: decision.count, http: post.http };
    } catch (err) {
        try {
            console.log('[jupiter-fail-alert] emit swallowed: ' + clip(err && err.message, 120));
        } catch (_) { /* noop */ }
        return { sent: false, skipped: 'emit_threw' };
    }
}

/**
 * Probe-specific path: OK->DOWN immediate; while DOWN <=1 reminder/hour; DOWN->OK recover.
 * Never throws.
 */
async function emitProbeTransition(probe, opts) {
    try {
        const p = probe || {};
        const t = nowMs(opts);
        const ok = p.ok === true;

        if (ok) {
            if (lastProbeOk === false) {
                lastProbeOk = true;
                lastProbeDownSentAt = 0;
                const content = '**JUPITER RECOVERED** `jupiter.probe_down` -> OK\n' +
                    'checked_at=' + (p.checked_at || new Date(t).toISOString());
                await postDiscord(content, opts);
                return { sent: true, skipped: null, transition: 'down_to_ok' };
            }
            lastProbeOk = true;
            return { sent: false, skipped: 'already_ok', transition: 'ok' };
        }

        // DOWN
        const wasOk = lastProbeOk;
        lastProbeOk = false;

        if (wasOk === false && lastProbeDownSentAt > 0 && (t - lastProbeDownSentAt) < PROBE_REMINDER_MS) {
            try {
                console.log('[jupiter-fail-alert] probe still DOWN; reminder suppressed');
            } catch (_) { /* noop */ }
            return { sent: false, skipped: 'probe_reminder_window', transition: 'still_down' };
        }

        lastProbeDownSentAt = t;
        const result = await emitJupiterFail({
            probe: true,
            source: 'probe',
            error: p.error,
            http: p.http,
            latency_ms: p.latency_ms,
            network: (opts && opts.network) || 'mainnet',
        }, Object.assign({}, opts, { force: true }));

        return Object.assign({ transition: wasOk === false ? 'still_down_reminder' : 'ok_to_down' }, result);
    } catch (err) {
        try {
            console.log('[jupiter-fail-alert] probe transition swallowed: ' + clip(err && err.message, 120));
        } catch (_) { /* noop */ }
        return { sent: false, skipped: 'probe_threw' };
    }
}

/**
 * Map a client analytics event onto emitJupiterFail when it is a fail.
 * Returns null when the event is not a fail worth paging.
 */
function maybeAlertFromAnalyticsEvent(eventName, props, playerId, opts) {
    const name = String(eventName || '');
    const p = props && typeof props === 'object' ? props : {};
    if (name === 'swap_quote_result') {
        if (p.ok === true || p.ok === 'true') return null;
        return emitJupiterFail({
            eventName: name,
            httpStatus: p.httpStatus,
            error: p.error,
            sku: p.sku || p.selection,
            quote_id: p.quote_id || p.quoteId,
            wallet: playerId,
            network: p.network,
            latency_ms: p.elapsedMs,
        }, opts);
    }
    if (name === 'swap_sign_result') {
        const outcome = String(p.outcome || '');
        if (outcome === 'ok') return null;
        return emitJupiterFail({
            eventName: name,
            outcome: outcome,
            error: p.error,
            sku: p.selection || p.sku,
            wallet: playerId,
            network: p.network,
            latency_ms: p.elapsedMs,
        }, opts);
    }
    return null;
}

module.exports = {
    emitJupiterFail,
    emitProbeTransition,
    maybeAlertFromAnalyticsEvent,
    classifyFail,
    shouldSend,
    dedupKey,
    isOwnerTestWallet,
    walletPrefix,
    formatDiscordContent,
    postDiscord,
    resetDedupState,
    readWebhook,
    DEFAULT_DEDUP_MS,
    PROBE_REMINDER_MS,
};
