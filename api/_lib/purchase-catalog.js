'use strict';

// MON-1147 server-owned canary contract. The client may name a SKU, but it may
// never choose the amount or recipient the verifier accepts.
const DEVNET_PACKS = Object.freeze({
    'hearth-spark': Object.freeze({ currency: 'SKR', amountBaseUnits: 20_000_000_000, decimals: 9 }),
});

function purchaseContract(network, sku) {
    if (network !== 'devnet') return null;
    const row = DEVNET_PACKS[sku];
    const recipient = String(process.env.SOLANA_DEVNET_PURCHASE_RECIPIENT || '').trim();
    const recipientAta = String(process.env.SOLANA_DEVNET_PURCHASE_RECIPIENT_ATA || '').trim();
    const mint = String(process.env.SOLANA_DEVNET_SKR_MINT || '').trim();
    if (!row || !recipient || !recipientAta || !mint) return null;
    return { network, sku, currency: row.currency, amountBaseUnits: row.amountBaseUnits,
        decimals: row.decimals, mint, recipient, recipientAta };
}

module.exports = { DEVNET_PACKS, purchaseContract };
