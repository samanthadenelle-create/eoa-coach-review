'use strict';

// MON-1147 server-owned canary contract. The client may name a SKU, but it may
// never choose the amount or recipient the verifier accepts.
// PRICE-PARITY LAW: a build/deploy is forbidden unless the automated parity gate
// proves every row here equals both canonical client mirrors after exact decimal
// conversion to base units. Never update this table without updating canon first.
const DEVNET_CANARY_SKU = 'hearth-spark';
const MAINNET_CANARY_SKU = 'mainnet-wood-canary';
const MAINNET_SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
const MAINNET_CANARY_OWNER = 'CHKKFkPGz8VZfjpsZjJTqfAUW7vMpdNkkqCVuCcZsfkC';
const DEVNET_PACKS = Object.freeze({
    [DEVNET_CANARY_SKU]: Object.freeze({ currency: 'SKR', amountBaseUnits: 25_000_000_000, decimals: 9 }),
});
const MAINNET_PACKS = Object.freeze({
    // ⛔ 6 DECIMALS, NOT 9 - corrected 2026-08-22. Mainnet SKR (SKRbvo6Gf7...NPGZhW3) reports
    // decimals: 6 on-chain, confirmed by the owner from the explorer. The 9 came from OUR OWN
    // DEVNET TEST MINT (3BwWSAUZ...AB77N), which genuinely is 9 - see the Devnet row above, which
    // is correct and must NOT be 'fixed' to match this one. At 9 decimals this row authorised
    // 1_000_000_000 base units = 1,000 SKR against a 6-decimal mint, a 1000x overcharge on a row
    // whose entire purpose is to move exactly 1 SKR.
    //
    // ⚠ AND THE VERIFIER CANNOT PROTECT THE FUNDS: /verify runs AFTER the transfer settles, so a
    // 9-vs-6 mismatch fails the check with the money already gone - 1,000 SKR sent, no entitlement
    // granted. Any figure that decides an on-chain AMOUNT must be read off the mint before the
    // first transaction, never carried over from a doc or a sibling network.
    [MAINNET_CANARY_SKU]: Object.freeze({ currency: 'SKR', amountBaseUnits: 1_000_000, decimals: 6 }),
});

function mainnetCanaryEnabled() {
    return String(process.env.MAINNET_CANARY_ENABLED || '').trim().toLowerCase() === 'true';
}

function walletAllowed(network, sku, wallet) {
    if (network !== 'mainnet-beta') return true;
    return sku === MAINNET_CANARY_SKU && mainnetCanaryEnabled() &&
        String(wallet || '').trim() === MAINNET_CANARY_OWNER;
}

function purchaseContract(network, sku) {
    const mainnet = network === 'mainnet-beta';
    if (network !== 'devnet' && !mainnet) return null;
    if (mainnet && !mainnetCanaryEnabled()) return null;
    const row = (mainnet ? MAINNET_PACKS : DEVNET_PACKS)[sku];
    const prefix = mainnet ? 'SOLANA_MAINNET' : 'SOLANA_DEVNET';
    const recipient = String(process.env[`${prefix}_PURCHASE_RECIPIENT`] || '').trim();
    const recipientAta = String(process.env[`${prefix}_PURCHASE_RECIPIENT_ATA`] || '').trim();
    const mint = mainnet
        ? MAINNET_SKR_MINT
        : String(process.env.SOLANA_DEVNET_SKR_MINT || '').trim();
    if (!row || !recipient || !recipientAta || !mint) return null;
    return { network, sku, currency: row.currency, amountBaseUnits: row.amountBaseUnits,
        decimals: row.decimals, mint, recipient, recipientAta };
}

module.exports = { DEVNET_CANARY_SKU, DEVNET_PACKS, MAINNET_CANARY_SKU, MAINNET_PACKS,
    MAINNET_SKR_MINT, MAINNET_CANARY_OWNER, mainnetCanaryEnabled, walletAllowed, purchaseContract };
