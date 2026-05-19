// =============================================================================
// api/_lib/clan-chat.js — WO-1873 + WO-1905. Cherry room ids for The Tavern.
// -----------------------------------------------------------------------------
// TWO rooms, one embed:
//   1. Global — every Remnant, one FIXED world room UUID.
//   2. Order — per-Order Cherry room = clans.cherry_room_id, created SERVER-SIDE by
//      api/_lib/cherry-rooms.js and sent to the client as `orderRoomId` (WO-2027).
//      ⛔ NOT clans.id: until 2026-09-24 the Order face opened clans.id, which our Postgres
//      mints and Cherry has never seen, so every Order showed "Could not load this chat".
//      clans.id is still the membership + REPORT key (api/clan/report-message.js).
//
// ⚠ WO-1905, THE "COMMONS -> GLOBAL" RENAME, AND WHAT IT ACTUALLY TOUCHED ON THE
// SERVER: nothing executable. The room's WIRE VALUE has been the string `global`
// since WO-1873 (normalizeRoomKind below, and `globalRoomId` on GET /api/clan/me);
// "Commons" existed only in PROSE in this module, api/clan/me.js,
// api/clan/report-message.js, api/_lib/clan.js and api/schema.sql, and those five
// now say Global. The player-facing LABEL is a client locale value
// (`clanChat.room.commons` - the KEY stays, the VALUE becomes "Global") and is a
// later Unity lane. api/migrations/20260919_0039_*.sql still reads "Commons" and
// is deliberately NOT edited: an applied migration is a frozen record.
//
// ⛔ THE GLOBAL UUID IS MINTED ONCE AND HELD HERE. Clients read it from
// GET /api/clan/me as `globalRoomId` and MUST NEVER hardcode it in C#. Rotating
// the room later is a one-line server change + a content push of this module.
// =============================================================================

'use strict';

/**
 * Fixed GLOBAL (world) Cherry room id. Shape: Postgres/Cherry UUID.
 *
 * ⚠ REPLACED 2026-09-21 (WO-1931). The previous value,
 * `f47ac10b-58cc-4372-a567-0e02b2c3d479`, was the RFC 4122 EXAMPLE UUID - a
 * plausible-looking placeholder that no Cherry tenant ever owned. This one is
 * the room the owner created at portal.cherry.fun alongside the re-created
 * embed app, and it is the ONLY room the Global face may point at.
 */
const GLOBAL_ROOM_ID = '960a1050-2101-4905-bab5-af31436443f3';

/**
 * The Cherry embed APP id (not a secret - it is in the served page's source and
 * in every iframe URL). Held here so the server that MINTS the app-trusted token
 * (api/cherry-embed-token.js, `app_id` claim) and the page that MOUNTS the embed
 * agree by construction.
 *
 * ⚠ site/clan-chat.html necessarily carries its own literal (a static page cannot
 * require() this module), so there ARE two copies. That is duplicated state, and
 * the cure is not vigilance: test/clan-chat-embed.test.js asserts the page's
 * `var CHERRY_APP_ID = '<id>'` equals this constant, so a change to one that
 * misses the other FAILS rather than shipping a token Cherry will not accept.
 *
 * ⛔ THE SECRET THAT SIGNS TOKENS FOR THIS APP IS `CHERRY_APP_SECRET`, an env var
 *    read only by api/cherry-embed-token.js. It must never appear in this file,
 *    in the page, in the bundle, or in a commit.
 *
 * History: `app_d4a59f373f0f` (2026-09-17 - WO-1858) returned HTTP 404
 * `Embed app ... not found` from chat.cherry.fun on 2026-09-21 and every chat
 * open rendered "Could not load this chat" (WO-1931 §2). Re-created by the owner
 * the same day; this is the new id.
 */
const CHERRY_APP_ID = '1720f55f-ee5b-4e6b-ae49-110caa78f931';

/**
 * Where the embed iframe is served from. Cherry's SDK defaults to this exact
 * origin; we pass it explicitly so the value is visible in our own source.
 * ⚠ THERE IS NO `apiUrl` OPTION - the SDK bundle (0.1.7, read at source
 * 2026-09-21) has no such field. Do not invent one.
 */
const CHERRY_EMBED_URL = 'https://embed.cherry.fun';

// ── WO-2043: IS THE ORDER ROOM OPENABLE IN THE EMBED? A SERVER SWITCH, NOT AN APK ────────
// Proven 2026-09-25 (lead, Seeker trace from site/clan-chat.html, WO-2042): the Order room
// cOlSQdWaioo1l8xrmpjL never loads in the Cherry embed - token_ok, event:ready, signedIn=true,
// then `GreeWebView onHttpError: 404` and `summary@20s ... messages=0`; the anonymous embed
// preview answers 404 for it and for a fresh API-created test room, 200 for Global. Until Cherry
// says how a project-created private room becomes openable in the embed, the Order face shows an
// honest in-game placeholder instead of Cherry's "Could not load this chat" card.
//
// The client reads `orderChatAvailable` off GET /api/clan/me and shows the placeholder unless it
// is `true`. So the placeholder is turned OFF by a Vercel env change or a one-line edit here,
// never by an APK:
//   ORDER_CHAT_AVAILABLE      env: 'true'|'1'|'on'|'yes' -> every bound Order room opens;
//                             'false'|'0'|'off'|'no' -> none does (bar the list below); unset or
//                             junk -> ORDER_CHAT_AVAILABLE_DEFAULT.
//   ORDER_CHAT_ENABLED_ROOMS  env: comma-separated Cherry room ids that open REGARDLESS of the
//                             switch - a known-good room (the owner's demo room) is enabled here
//                             or in ORDER_CHAT_ENABLED_ROOM_IDS below.
//   CHERRY_ORDER_DEMO_ROOM_ID (see the Order embed block below) - the owner's demo room opens too.
// A null room (not provisioned yet) is never available - there is nothing to open.

/** The switch's value when the env does not set it. false until Cherry fixes the embed. */
const ORDER_CHAT_AVAILABLE_DEFAULT = false;

/**
 * Cherry room ids that open in the embed even while the switch is off (the demo room is
 * handled by readOrderEmbedConfig, not here). Empty on purpose:
 * a room goes here only once an anonymous preview GET
 * (chat.cherry.fun/api/embed/preview/<CHERRY_APP_ID>/messages?roomId=<id>&limit=1) has been
 * measured at 200 for it. tools/wo2043-bind-demo-order-room.mjs binds such a room to an Order.
 */
const ORDER_CHAT_ENABLED_ROOM_IDS = Object.freeze([]);

function parseSwitch(raw) {
    const v = raw == null ? '' : String(raw).trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
    return null;
}

function parseRoomList(raw) {
    if (raw == null) return [];
    return String(raw).split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
}

/**
 * WO-2043. Whether the Order face may open `roomId` in the Cherry embed.
 * @param {string|null} roomId  clans.cherry_room_id (orderRoomId), or null while pending.
 * @param {object} [env]        process.env by default; tests pass their own.
 * @returns {{available:boolean, source:'no-room'|'demo-room'|'room-list'|'env'|'default'}}
 *          `source` names WHICH rule decided, for the one log line clan/me writes.
 */
function readOrderChatAvailability(roomId, env) {
    const e = env || process.env;
    const room = roomId == null ? '' : String(roomId).trim();
    if (room === '') return { available: false, source: 'no-room' };
    const demo = readOrderEmbedConfig(e).demoRoomId;
    if (demo !== null && room === demo) return { available: true, source: 'demo-room' };
    const listed = ORDER_CHAT_ENABLED_ROOM_IDS.indexOf(room) >= 0 ||
        parseRoomList(e.ORDER_CHAT_ENABLED_ROOMS).indexOf(room) >= 0;
    if (listed) return { available: true, source: 'room-list' };
    const sw = parseSwitch(e.ORDER_CHAT_AVAILABLE);
    if (sw !== null) return { available: sw, source: 'env' };
    return { available: ORDER_CHAT_AVAILABLE_DEFAULT, source: 'default' };
}

// ── WO-2043 TASK D: THE ORDER ROOM HAS ITS OWN CHERRY EMBED APP ─────────────────────────────
// Proven 2026-09-25 (lead, read-only): the owner created a SECOND chat embed in the Cherry portal.
// Its room `fbb02476-b118-41bb-a913-9d5af272c4e1` ("Queens Order", public, app.appId 0557eb8b-...)
// answers the anonymous embed preview GET
//   chat.cherry.fun/api/embed/preview/0557eb8b-564b-4160-a86c-582b071a278c/messages?roomId=fbb02476-...
// with 200 - while every room created with the project API key or in the portal against the
// Global app answers 404 (cOlSQdWaioo1l8xrmpjL, g98gz6bMAPFXYtX92Viw). So the Order face mounts the
// ORDER embed app, and its app-trusted token is signed with THAT app's secret:
//   CHERRY_APP_SECRET_ORDER  (env, server-side ONLY - read by api/cherry-embed-token.js, never
//                             printed, never in this file, the page, the bundle or a commit)
// THE ONE PLACE the demo mapping lives ("hard-coded for the demo", owner) - env overrides first:
//   CHERRY_ORDER_EMBED_APP_ID  env, default ORDER_EMBED_APP_ID_DEFAULT
//   CHERRY_ORDER_DEMO_ROOM_ID  env, default ORDER_DEMO_ROOM_ID_DEFAULT; 'none' turns the demo off.
// ⚠ site/clan-chat.html carries its own copy of the default app id (`var ORDER_EMBED_APP_ID`) as
// the fallback for an APK that does not pass `appId` in the page URL; test/cherry-embed-token-order.test.js
// pins the two equal (the CHERRY_APP_ID precedent). The Global face is untouched: CHERRY_APP_ID +
// CHERRY_APP_SECRET, exactly as before.
// ⛔ This module does NOT bind the room to any Order. clans.cherry_room_id is set by the lead
// (tools/wo2043-bind-demo-order-room.mjs); until it is, no Order's orderRoomId equals the demo room.

/** The Order embed app the owner created 2026-09-25 (portal.cherry.fun). Not a secret. */
const ORDER_EMBED_APP_ID_DEFAULT = '0557eb8b-564b-4160-a86c-582b071a278c';

/** Its public room, measured at preview 200 on 2026-09-25. Not a secret. */
const ORDER_DEMO_ROOM_ID_DEFAULT = 'fbb02476-b118-41bb-a913-9d5af272c4e1';

const EMBED_APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WO-2043. The Order face's embed app id and demo room, env first, then the defaults above.
 * A malformed env app id is IGNORED (the default is used) rather than handed to a page.
 * @returns {{appId:string, demoRoomId:string|null, appIdSource:'env'|'default'}}
 */
function readOrderEmbedConfig(env) {
    const e = env || process.env;
    const rawApp = String(e.CHERRY_ORDER_EMBED_APP_ID || '').trim();
    const appFromEnv = EMBED_APP_ID_RE.test(rawApp);
    const rawRoom = String(e.CHERRY_ORDER_DEMO_ROOM_ID || '').trim();
    let demoRoomId = ORDER_DEMO_ROOM_ID_DEFAULT;
    if (rawRoom.toLowerCase() === 'none') demoRoomId = null;
    else if (/^[A-Za-z0-9_-]{8,64}$/.test(rawRoom)) demoRoomId = rawRoom;
    return {
        appId: appFromEnv ? rawApp : ORDER_EMBED_APP_ID_DEFAULT,
        demoRoomId: demoRoomId,
        appIdSource: appFromEnv ? 'env' : 'default',
    };
}

/**
 * Normalise a roomKind query/body value.
 * Wire accepts `global|order` (player-facing Order) and `circle` as a wire alias
 * for order (legacy wording). Player-facing captions never say Circle.
 * @returns {{ok:true, value:'global'|'order'}|{ok:false, code:string}}
 */
function normalizeRoomKind(raw) {
    const k = raw != null ? String(raw).trim().toLowerCase() : '';
    if (k === 'global') return { ok: true, value: 'global' };
    if (k === 'order' || k === 'circle') return { ok: true, value: 'order' };
    return { ok: false, code: 'CLAN_BAD_ROOM_KIND' };
}

module.exports = {
    GLOBAL_ROOM_ID,
    CHERRY_APP_ID,
    CHERRY_EMBED_URL,
    ORDER_EMBED_APP_ID_DEFAULT,
    ORDER_DEMO_ROOM_ID_DEFAULT,
    readOrderEmbedConfig,
    ORDER_CHAT_AVAILABLE_DEFAULT,
    ORDER_CHAT_ENABLED_ROOM_IDS,
    readOrderChatAvailability,
    normalizeRoomKind,
};
