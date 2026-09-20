// =============================================================================
// GET /api/wallet/skr-balance?address=<base58>
// -----------------------------------------------------------------------------
// Public chain read for the WebGL Night Market chip. WebGLWalletProvider.GetBalance
// used to return default(WalletBalance) so PackStore painted
// "SKR balance unavailable right now" even after Connect Wallet (itch 2026-09-20).
// Token accounts are public; CORS is open so itch + defenders-webgl can call us.
// Real zero (no token accounts) is { ok:true, skr:0 } — PackStore still maps
// skr<=0 to UNAVAILABLE (WO-1334 never-laundered zero). A positive skr is Known.
// =============================================================================
'use strict';

const { readSkrBalance, toDisplaySkr, mainnetRpcUrl } = require('../_lib/skr-staking');

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

    const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    if (!address || address.length < 32 || address.length > 64) {
        return res.status(400).json({ ok: false, error: 'bad address' });
    }

    const url = mainnetRpcUrl();
    if (!url) {
        return res.status(503).json({ ok: false, error: 'RPC_UNAVAILABLE' });
    }

    const read = await readSkrBalance(url, address);
    if (!read.ok) {
        return res.status(502).json({ ok: false, error: read.reason || 'rpc_failed' });
    }

    const skr = Number(toDisplaySkr(read.balanceRaw));
    return res.status(200).json({
        ok: true,
        skr: Number.isFinite(skr) ? skr : 0,
        accountCount: read.accountCount,
        slot: read.slot,
    });
};
