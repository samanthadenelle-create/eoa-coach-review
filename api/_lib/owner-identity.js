'use strict';

// =============================================================================
// api/_lib/owner-identity.js - WHO IS THE OWNER, asked in exactly one place.
// -----------------------------------------------------------------------------
// Owner ruling 2026-09-06 20:45, verbatim: "im the one account that should have
// no guards" - after her own account was refused LINK01 on device with
// "You have reached the promo code limit for this account" (PLAYER_LIMIT_REACHED,
// api/promo/redeem.js step 5). She authors the codes; the anti-abuse rails were
// stopping the operator from testing her own campaign.
//
// ⛔ THERE IS EXACTLY ONE OWNER-WALLET AUTHORITY IN THIS PROJECT, AND IT IS NOT HERE.
// It is `MAINNET_CANARY_OWNER` in ./purchase-catalog.js:32, where `walletAllowed()`
// already grants the owner an exemption of precisely the same shape ("the owner
// wallet may buy any sold SKU on mainnet; everyone else needs the env switch").
// This module IMPORTS that constant. It does not re-type the address, and it must
// never grow into a list: the moment "the owner" is two strings in two files, one of
// them goes stale, which is the failure mode CLAUDE.md 2/5/16 are all written about.
//
// ⚠ RECORDED DEVIATION (CLAUDE.md 11B-B). The WO-1533 dispatch said this helper should
// "read the same env var". MEASURED: there is no env var - `grep -rn "OWNER_WALLET" api/`
// returns nothing, and the owner identity is a hardcoded `const`. Adding `OWNER_WALLET`
// here would CREATE the second source of truth the instruction exists to prevent, so the
// constant is reused instead. If it should become env-driven later, purchase-catalog.js
// is the one file to change and this helper inherits it for free.
//
// ⛔ NOT PUT IN api/_lib/wallet-auth.js, its otherwise-natural home: that file carries
// another lane's uncommitted work at the time of writing (WO-1533 6).
//
// ⛔ THIS FUNCTION ANSWERS "IS THIS STRING THE OWNER'S ID". IT DOES NOT AUTHENTICATE.
// A caller MUST have proven the identity first (wallet-auth.authenticate* -> an ed25519
// signature over the exact body bytes, or a server-issued session) AND must check that
// the proof was not the guest rail. `isOwnerIdentity(body.playerId)` on its own is
// worthless - anyone can type the owner's address into a JSON body. The one caller
// today spells that out as:
//     const ownerBypass = auth.unproven !== true && isOwnerIdentity(playerId);
// =============================================================================

const { MAINNET_CANARY_OWNER } = require('./purchase-catalog');

/** The single owner identity, normalised once. */
const OWNER_IDENTITY = String(MAINNET_CANARY_OWNER || '').trim();

/**
 * True only for the owner's own proven identity.
 *
 * Exact string equality, deliberately: a guest id (`guest-local-<64 hex>`) cannot
 * collide with a base58 wallet, so no shape test is needed to keep guests out, and
 * anything looser (prefix, case-insensitive, a list) would widen a bypass that is
 * meant to reach exactly one account.
 *
 * @param {*} playerId the ALREADY-AUTHENTICATED player id
 * @returns {boolean}
 */
function isOwnerIdentity(playerId) {
    if (OWNER_IDENTITY === '') return false;
    if (playerId == null) return false;
    return String(playerId).trim() === OWNER_IDENTITY;
}

module.exports = { isOwnerIdentity, OWNER_IDENTITY };
