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
    normalizeRoomKind,
};
