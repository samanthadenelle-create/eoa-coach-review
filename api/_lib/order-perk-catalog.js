// =============================================================================
// api/_lib/order-perk-catalog.js — WO-2031 (WO-2029 ticket 2). The Order epoch perks.
// -----------------------------------------------------------------------------
// ⛔ THE ONLY PERKS AN ORDER BALLOT MAY OFFER OR ACTIVATE. Three banners, each one a
// SHAPE (an emblem), never a colour and never a number:
//
//   id              name key                            emblem
//   banner_lantern  order.perk.banner_lantern.name      lantern
//   banner_tide     order.perk.banner_tide.name         wave
//   banner_gale     order.perk.banner_gale.name         gale
//
// Owner decisions, 2026-09-24 (WO-2029, all five answers confirmed): one active perk per
// Order, each epoch's winner replaces the last; the fixed three-option vote opens on its
// own every epoch. Ruling 3 (WO-1870:36, 2026-09-18) still binds: "Ballots may wake VISUAL
// + NARRATIVE outcomes only ... No stat edge, no troop types." So a record here carries NO
// effect field, and nothing that reads it may grow one.
//
// ⛔ NO ENGLISH PLAYER TEXT IN THIS FILE. The wire carries the catalog id, the emblem id
// and the name KEY; the client localizes the key (WO-2032, localization law). The English
// names in the table above are the owner's working titles, recorded for the locale lane —
// they are comments, and no code path can put them on the wire.
//
// `treeMotifId` is the WO-1921 visual key (ruling 2: gameplay identity and visual identity
// decoupled). No motif has been authored for the banners, so each one names the dormant
// motif explicitly — an unmapped perk must read dormant, never blank the Heart tree.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore). CommonJS.
// =============================================================================

'use strict';

/** The motif a perk with no authored tree art resolves to (WO-1921 §6b item 4). */
const DORMANT_MOTIF_ID = 'motif_dormant';

/**
 * The catalog, in presentation order. `optionId` and `perkId` are the SAME id on purpose:
 * a banner ballot option and the perk it activates are one thing, so a second id would be
 * a second name for one fact.
 */
const ORDER_PERKS = Object.freeze([
    Object.freeze({ optionId: 'banner_lantern', perkId: 'banner_lantern',
                    nameKey: 'order.perk.banner_lantern.name', emblem: 'lantern',
                    treeMotifId: DORMANT_MOTIF_ID }),
    Object.freeze({ optionId: 'banner_tide', perkId: 'banner_tide',
                    nameKey: 'order.perk.banner_tide.name', emblem: 'wave',
                    treeMotifId: DORMANT_MOTIF_ID }),
    Object.freeze({ optionId: 'banner_gale', perkId: 'banner_gale',
                    nameKey: 'order.perk.banner_gale.name', emblem: 'gale',
                    treeMotifId: DORMANT_MOTIF_ID }),
]);

/** The ids, in catalog order — the slate every automatic ballot opens with. */
const ORDER_PERK_IDS = Object.freeze(ORDER_PERKS.map((p) => p.optionId));

/** One record by id, or null. Never invents a record for an unknown id. */
function findOrderPerk(id) {
    if (id == null) return null;
    const s = String(id);
    if (s === '') return null;
    return ORDER_PERKS.find((p) => p.optionId === s) || null;
}

function isOrderPerkId(id) {
    return findOrderPerk(id) != null;
}

/**
 * The options an automatic ballot opens with. ONE function, so the slate cannot drift
 * from validation (WO-2028 §3.4 acceptance 9). The owner locked a fixed three-option vote
 * for the demo (WO-2029), so the answer is the whole catalog every epoch.
 */
function selectBallotOptions() {
    return ORDER_PERK_IDS.slice();
}

module.exports = {
    ORDER_PERKS,
    ORDER_PERK_IDS,
    DORMANT_MOTIF_ID,
    findOrderPerk,
    isOrderPerkId,
    selectBallotOptions,
};
