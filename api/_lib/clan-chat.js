// =============================================================================
// api/_lib/clan-chat.js — WO-1873 + WO-1905. Cherry room ids for The Tavern.
// -----------------------------------------------------------------------------
// TWO rooms, one embed:
//   1. Global — every Remnant, one FIXED world room UUID.
//   2. Order — per-clan room (clans.id), unchanged from WO-1847/1858.
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

/** Fixed GLOBAL (world) Cherry room id. Shape: Postgres/Cherry UUID. */
const GLOBAL_ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

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
    normalizeRoomKind,
};
