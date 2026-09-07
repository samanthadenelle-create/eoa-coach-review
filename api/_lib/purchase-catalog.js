'use strict';

// MON-1147 server-owned canary contract + WO-1158 server-issued price quotes.
// The client may name a SKU. It may never choose the amount, the recipient, or
// the RATE the verifier accepts.
//
// ⛔ TWO KINDS OF PRICE LIVE IN THIS FILE AND THEY ARE NOT THE SAME THING.
//
//   1. PINNED (the two canaries). Their `amountBaseUnits` is a PROTOCOL CONSTANT
//      — a proof-of-rail, not a sale. The verifier checks it by exact equality
//      and the client mirrors it verbatim (PackCatalog.IsServerPinnedSku).
//      PRICE-PARITY LAW: a build/deploy is forbidden unless the automated parity
//      gate proves every pinned row here equals both canonical client mirrors
//      after exact decimal conversion to base units.
//
//   2. QUOTED (every real pack). Priced in USD, PAID in SKR, so the SKR amount
//      depends on the rate at the moment of purchase. There is no constant to
//      pin. The SERVER resolves the rate, computes the integer base units, and
//      hands the client a short-lived, single-use quote. The client transfers
//      exactly that and does NO arithmetic of its own.
//
// ⛔ WHY A CLIENT-RESOLVED PRICE COULD NEVER WORK: /verify runs AFTER the
// transfer settles. If the client resolves N and the server expects M, the
// purchase fails with THE MONEY ALREADY GONE and nothing granted. And the
// trigger is a MARKET MOVE, not a deploy — nobody is watching when it fires.
// Same paid-but-not-granted family as the 6-vs-9 decimals near-miss, arriving
// through a different door.

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

// ⛔ SKR DECIMALS ARE PER-NETWORK AND THERE IS NO NETWORK-AGNOSTIC ANSWER.
// Our DEVNET TEST mint (3BwWSAUZ...AB77N) is 9. Solana Mobile's real MAINNET SKR
// (SKRbvo6Gf7...NPGZhW3) is 6. Reading one for the other is a 1000x error on a
// real transfer, and the verifier cannot save it (it runs after settlement).
// Both figures below are read off their own mint, never from a doc or a sibling
// network. This table is the ONLY place a quote may learn decimals.
const SKR_DECIMALS_BY_NETWORK = Object.freeze({ 'devnet': 9, 'mainnet-beta': 6 });

// ── The USD ANCHOR LADDER — server-authoritative (WO-1158 §5) ────────────────
// The authored 1.99 / 2.99 / 4.99 / 9.99 / 19.99 / 49.99 ladder people already
// understand. This is the ONLY number a human authors for a real pack: the SKR
// figure is DERIVED from it at purchase time and is never authored anywhere.
//
// ⚠ MIRROR LAW: this table must equal the `pricing.usd` of the canonical client
// authoring EXACTLY. test/purchases.quote.test.js proves it on every run. If the
// two ever disagree, the SERVER's figure is what the player is charged against
// and what the card must display (§5: two prices on one screen is worse than a
// stale one).
//
// ⛔ THE MIRROR HAS TWO SOURCE FILES, NOT ONE — corrected 2026-08-24 (WO-1165 §2).
// This comment named packs.json alone, and named the wrong test file. Because of
// that, the Monthly Ledger cards — authored with real `pricing.usd` in
// battle_monthly.json, 30 days of grants each — sat OUTSIDE this table and
// outside any check that would have noticed: usdAnchor() -> null ->
// buildQuoteBody() -> null -> no quote -> unbuyable, silently, on the live rail.
// The client sources are:
//   * Assets/{Resources,StreamingAssets}/Data/Canonical/packs.json  -> packs[]
//   * Assets/{Resources,StreamingAssets}/Data/Canonical/battle_monthly.json
//                                                        -> monthlyCards[]
// Adding a sellable SKU to EITHER file without a row here now FAILS the mirror
// test. Do not add a third authoring file without extending that test in the
// same edit — an unenforced mirror is a hope, not a law.
const USD_ANCHORS = Object.freeze({
    'hearth-spark': 4.99,
    'keepers-satchel': 4.99,
    'folks-thanks': 9.99,
    'patron-of-elarion': 19.99,
    'founders-vow': 49.99,
    'frostfall-bundle': 9.99,
    'embergrove-bundle': 9.99,
    'bloomtide-bundle': 4.99,
    'starters-hand': 4.99,
    'echo-patron-pack': 19.99,
    'hero-wardrobe-pack': 9.99,
    'realm-defender-bundle': 9.99,
    'builders-cache': 19.99,
    // WO-1449: the $1.99 first-buy micro (packs.json `builders-hour`). Small basket
    // + ONE temporary builder crew for six hours - a CONSUMABLE, nothing permanent.
    'builders-hour': 1.99,
    'impulse-wood-small': 1.99,
    'impulse-wood-medium': 2.99,
    'impulse-wood-large': 4.99,
    'impulse-iron-small': 1.99,
    'impulse-iron-medium': 2.99,
    'impulse-iron-large': 4.99,
    'impulse-stone-small': 1.99,
    'impulse-stone-medium': 2.99,
    'impulse-stone-large': 4.99,
    'impulse-crystals-small': 1.99,
    'impulse-crystals-medium': 2.99,
    'impulse-crystals-large': 4.99,
    'permanent-builder': 9.99,
    // ── Monthly Ledger cards (battle_monthly.json `monthlyCards[]`, WO-1165 §2) ──
    // Read off the canonical file, not off a doc or a work order. A 30-claim pool,
    // so the grant drips BELOW the storage cap over 30 sessions instead of dumping
    // above it once, where the overflow is discarded (WO-1165 §3).
    'monthly-wayfarer': 4.99,
    'monthly-keeper': 9.99,
});

// ── Quote lifetime ──────────────────────────────────────────────────────────
// ⛔ AN UNEXPIRING QUOTE IS A FREE OPTION ON A VOLATILE ASSET. A player could sit
// on a favourable rate indefinitely and exercise it after the market moved.
const QUOTE_TTL_SECONDS = 300;          // 5 minutes — the ticket's outer bound.
// ⚠ AND THE OPPOSITE FAILURE IS WORSE. Wallet approval is a HUMAN action with no
// countdown (PackStore.Purchase says so out loud), and chain finality is not
// instant. Judging expiry by "when /verify happened" would refuse a purchase the
// player made in good time — with the money already gone. So expiry is judged
// against the transaction's OWN blockTime (the moment the player actually paid),
// plus this grace for clock skew between the RPC and us.
const QUOTE_SETTLEMENT_GRACE_SECONDS = 180;

// ── The rate oracle — SERVER SIDE, CACHED, FAIL-CLOSED ──────────────────────
// ⛔ NO NEW RUNTIME DEPENDENCY. package.json at the repo root is the Vercel
// deployment; a plain fetch does this.
const RATE_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=seeker';
const RATE_SOURCE = 'coingecko:seeker:low_24h';
const RATE_CACHE_MS = 120_000;
const RATE_TIMEOUT_MS = 8_000;

let _rateCache = null;      // { usdPerSkr, source, fetchedAtMs }
let _rateInFlight = null;

function mainnetCanaryEnabled() {
    return String(process.env.MAINNET_CANARY_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * Who may transact on a network.
 *
 * ⛔ DEVNET IS OPEN, MAINNET IS NOT. Everything below is the mainnet half.
 *
 * ⭐ WIDENED 2026-08-23 (owner ruling, WO-1159 phase 2). Until now mainnet allowed
 * EXACTLY ONE SKU — the 1-SKR canary — for one wallet. That was correct while the
 * canary was the only thing being proven, but it silently blocked the whole ladder:
 * the client shipped go-live (RealmStorePurchase ON, the mainnet payment refusal
 * replaced) while THIS function still answered canary-only, so every store card read
 * "Price unavailable" and the two halves of go-live disagreed with the server winning.
 *
 * The owner's risk argument, and it holds: the published dApp Store build is still on
 * the OLD client (Devnet, purchase flag off), so the only mainnet client in existence
 * is her own sideloaded APK — and every payout resolves to her own treasury.
 *
 * ⛔ SO THE WIDENING IS DELIBERATELY NARROW, IN TWO LAYERS:
 *   1. The OWNER WALLET may buy any sold SKU on mainnet. That is what unblocks her
 *      test, and it can reach nobody else.
 *   2. EVERY OTHER WALLET still needs MAINNET_SALES_ENABLED=true — an ENV switch, so
 *      public mainnet sales can be opened (or shut) without a code change or a deploy
 *      of this file. It defaults CLOSED: absent env == refused.
 *
 * ⚠ The canary keeps its ORIGINAL, STRICTER gate untouched — owner wallet AND
 * MAINNET_CANARY_ENABLED. It is a proof-of-rail, not a sale, and widening sales must
 * never widen it.
 *
 * ⭐ THE TREASURY PRECONDITION IS MET. The revenue vault's Squads threshold is 2-of-3, timeLock 0, RE-VERIFIED ON CHAIN 2026-08-24 (`node tools/treasury-verify.mjs 9wbHbKuirtKai5e3ajvdpzdRYVpuxpAH4DUnERkVtBzj --multisig BcHLoNCsnGD6oegywkP19PALKMQYoFeQWTvmPLmp22no` -> "multisig is 2-of-3, timeLock 0 - production-shaped").
 * No multisig blocker remains on MAINNET_SALES_ENABLED.
 *
 * ⚠ This comment asserted a 1-of-1 blocker until 2026-08-24 and it was STALE. Do not
 * re-cache a threshold here from any doc - the verifier reads it from chain.
 */
function mainnetSalesEnabled() {
    return String(process.env.MAINNET_SALES_ENABLED || '').trim().toLowerCase() === 'true';
}

function walletAllowed(network, sku, wallet) {
    if (network !== 'mainnet-beta') return true;
    const w = String(wallet || '').trim();

    // The canary is a proof-of-rail, not a sale. Its gate is unchanged and stricter.
    if (sku === MAINNET_CANARY_SKU) {
        return mainnetCanaryEnabled() && w === MAINNET_CANARY_OWNER;
    }

    // A real sale: the owner always; anyone else only behind the env switch.
    return w === MAINNET_CANARY_OWNER || mainnetSalesEnabled();
}

/** True when the backend PINS this SKU's on-chain amount (canary, not a sale). */
function isPinnedSku(network, sku) {
    const table = network === 'mainnet-beta' ? MAINNET_PACKS : DEVNET_PACKS;
    return Object.prototype.hasOwnProperty.call(table, sku);
}

function purchaseContract(network, sku) {
    const mainnet = network === 'mainnet-beta';
    if (network !== 'devnet' && !mainnet) return null;
    if (mainnet && !mainnetCanaryEnabled()) return null;
    const row = (mainnet ? MAINNET_PACKS : DEVNET_PACKS)[sku];
    const rail = purchaseRail(network);
    if (!row || !rail) return null;
    return { network, sku, currency: row.currency, amountBaseUnits: row.amountBaseUnits,
        decimals: row.decimals, mint: rail.mint, recipient: rail.recipient,
        recipientAta: rail.recipientAta };
}

/**
 * The network's transfer destination + mint, from env. Shared by the pinned
 * contract and the quote path so the two can never learn a different treasury.
 */
function purchaseRail(network) {
    const mainnet = network === 'mainnet-beta';
    if (network !== 'devnet' && !mainnet) return null;
    const prefix = mainnet ? 'SOLANA_MAINNET' : 'SOLANA_DEVNET';
    const recipient = String(process.env[`${prefix}_PURCHASE_RECIPIENT`] || '').trim();
    const recipientAta = String(process.env[`${prefix}_PURCHASE_RECIPIENT_ATA`] || '').trim();
    const mint = mainnet
        ? MAINNET_SKR_MINT
        : String(process.env.SOLANA_DEVNET_SKR_MINT || '').trim();
    const decimals = SKR_DECIMALS_BY_NETWORK[network];
    if (!recipient || !recipientAta || !mint || !Number.isInteger(decimals)) return null;
    return { network, mint, recipient, recipientAta, decimals };
}

/** The authored USD anchor for a SKU, or null when the SKU is not sold. */
function usdAnchor(sku) {
    const usd = USD_ANCHORS[sku];
    return typeof usd === 'number' && usd > 0 ? usd : null;
}

/**
 * ⚠ THE ROUNDING RULE — A PRICING DECISION, NOT A DETAIL, AND IT FAVOURS US.
 *
 * `ceil(usd / usdPerSkr)` rounds UP TO A WHOLE SKR. Against a $2.99 pack at
 * $0.00755954/SKR the exact figure is 395.53 SKR and the player is charged 396 —
 * always at least spot, never less, and up to one whole SKR more.
 *
 * This is EXACTLY what the client did before WO-1158 (`SkrValuationOracle
 * .SkrForUsd`) and it is implemented here UNCHANGED so the move to server-issued
 * quotes changes WHO decides the number and not WHAT the number is. It is
 * carried forward, not endorsed: WO-1158 §3 flagged the rule as the owner's to
 * rule on. Whoever changes it changes a price.
 *
 * The rate used is the 24h LOW, which compounds the same direction: a low
 * denominator yields MORE SKR. Both halves of that are deliberate and both were
 * on the same ruling.
 *
 * ⭐ THE RULING LANDED 2026-08-23 (owner, verbatim: "i think low over 24 is ok").
 * BOTH HALVES STAND — the 24h-low rate source AND the ceil()-to-a-whole-SKR
 * rounding. This is no longer carried-forward-unendorsed behaviour; it is the
 * authored pricing policy, and this comment is the record of that.
 *
 * The decision was made against measured numbers, not in the abstract. Live at
 * ruling time: low_24h $0.00755954 vs current_price $0.00803436, so a $2.99 pack
 * priced at 396 SKR under this policy against 373 SKR at spot — about 6% more,
 * before ceil() adds its share. WO-1162 §2 proposed replacing this with a short-
 * lived current/executable quote; that proposal is DECLINED and the ticket's §2
 * is closed. Re-opening it needs a NEW owner ruling, not a refactor.
 *
 * ⛔ WHAT THIS RULING DOES NOT LICENSE: silently drifting the policy in either
 * direction. It is now pinned by the pricing regressions (freshness, expiry,
 * rounding, source identity, fail-closed). If a future seat believes spot pricing
 * is better, that is an argument to put to the owner — not a change to make.
 *
 * @returns {{skr:number, amountBaseUnits:string}|null} base units as a decimal
 *          STRING — the exact integer the client must transfer, never re-derived.
 */
function quoteAmount(usd, usdPerSkr, decimals) {
    if (!(typeof usd === 'number' && Number.isFinite(usd) && usd > 0)) return null;
    if (!(typeof usdPerSkr === 'number' && Number.isFinite(usdPerSkr) && usdPerSkr > 0)) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const skr = Math.ceil(usd / usdPerSkr);
    if (!Number.isSafeInteger(skr) || skr <= 0) return null;
    // Integer math from here on: a float multiply by 10^9 is not exact.
    const amountBaseUnits = (BigInt(skr) * (10n ** BigInt(decimals))).toString();
    return { skr, amountBaseUnits };
}

/**
 * Read the SKR/USD rate, server side, cached.
 *
 * ⛔ FAILS CLOSED. Returns null when the market is unreachable or answers
 * nonsense. There is deliberately NO fallback to a stale value and NO fallback
 * to a catalog price: charging a made-up number is worse than refusing to sell.
 * The caller must refuse the quote with a worded reason.
 *
 * ⚠ A third-party rate source is a third-party dependency ON THE MONEY PATH, so
 * every quote records WHICH source and WHICH value backed it. A disputed charge
 * has to be reconstructable months later.
 */
async function fetchSkrUsdRate(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (_rateCache && now - _rateCache.fetchedAtMs < RATE_CACHE_MS) return _rateCache;
    if (_rateInFlight) return _rateInFlight;

    _rateInFlight = (async () => {
        let controller = null;
        let timer = null;
        try {
            if (typeof AbortController === 'function') {
                controller = new AbortController();
                timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, RATE_TIMEOUT_MS);
            }
            const response = await fetch(RATE_URL, {
                headers: { Accept: 'application/json' },
                signal: controller ? controller.signal : undefined,
            });
            if (!response || !response.ok) return null;
            const rows = await response.json();
            if (!Array.isArray(rows) || rows.length === 0) return null;
            const low = Number(rows[0] && rows[0].low_24h);
            if (!Number.isFinite(low) || low <= 0) return null;
            _rateCache = { usdPerSkr: low, source: RATE_SOURCE, fetchedAtMs: now };
            return _rateCache;
        } catch (_) {
            return null;      // fail closed — never a stale or invented price
        } finally {
            if (timer) clearTimeout(timer);
            _rateInFlight = null;
        }
    })();
    return _rateInFlight;
}

/** Test hook: drop the cached rate so a case can drive the fetch path. */
function _resetRateCache() { _rateCache = null; _rateInFlight = null; }

/**
 * Build the un-persisted body of a quote for one SKU. Pure given a rate — the
 * caller persists it and stamps the id/expiry.
 * @returns {object|null} null when the SKU is not sold on this network.
 */
function buildQuoteBody(network, sku, rate, discountBps = null) {
    const rail = purchaseRail(network);
    const usd = usdAnchor(sku);
    if (!rail || usd == null || !rate || !(rate.usdPerSkr > 0)) return null;
    const bps = discountBps;
    const hasDiscount = typeof bps === 'number' && Number.isInteger(bps) && bps > 0 && bps < 10_000;
    const quotedUsd = hasDiscount ? usd * (10_000 - bps) / 10_000 : usd;
    const amount = quoteAmount(quotedUsd, rate.usdPerSkr, rail.decimals);
    if (!amount) return null;
    return {
        sku, network, currency: 'SKR',
        amountBaseUnits: amount.amountBaseUnits,
        skrAmount: amount.skr,
        decimals: rail.decimals,
        mint: rail.mint,
        recipient: rail.recipient,
        recipientAta: rail.recipientAta,
        usdAnchor: usd,
        // Display facts from the same server calculation that priced amountBaseUnits.
        // The client may format these; it may never derive either one.
        usdEffective: quotedUsd,
        usdSaving: hasDiscount ? usd - quotedUsd : null,
        discountBps: hasDiscount ? bps : null,
        discountLabel: hasDiscount ? `${bps / 100}% shortfall discount` : null,
        rate: rate.usdPerSkr,
        rateSource: rate.source,
    };
}

/** That network's pinned (canary) SKUs. */
function pinnedSkus(network) {
    return Object.keys(network === 'mainnet-beta' ? MAINNET_PACKS : DEVNET_PACKS);
}

/** Every SKU quotable on a network: the sold ladder minus that network's pinned canary. */
function quotableSkus(network) {
    return Object.keys(USD_ANCHORS).filter(sku => !isPinnedSku(network, sku));
}

/**
 * Is a quote still good for a payment made at `paidAtMs`?
 *
 * ⚠ `paidAtMs` is the transaction's OWN blockTime, not "now". See
 * QUOTE_SETTLEMENT_GRACE_SECONDS: judging a settled payment by wall-clock at
 * verify time refuses honest players whose money has already moved.
 */
function quoteValidAtPayment(expiresAtMs, paidAtMs) {
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(paidAtMs)) return false;
    return paidAtMs <= expiresAtMs + QUOTE_SETTLEMENT_GRACE_SECONDS * 1000;
}

/** A quote row the client may still PAY against (checked before the wallet prompt). */
function quoteOfferable(expiresAtMs, nowMs) {
    return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && nowMs < expiresAtMs;
}

/**
 * The exact-equality transfer contract /verify checks the chain against, derived
 * from a PERSISTED QUOTE ROW.
 *
 * ⛔ NOTHING HERE IS READ FROM THE REQUEST BODY. That is the whole point of the
 * WO: the amount, mint, decimals and destination all come from the row the
 * SERVER issued. A client that transfers a different number produces a
 * transfer_contract_mismatch, which is what "a tampered amount is refused"
 * actually means in code.
 */
function contractFromQuoteRow(row) {
    if (!row) return null;
    const decimals = Number(row.decimals);
    const amount = String(row.amount_base_units == null ? '' : row.amount_base_units);
    if (!/^\d+$/.test(amount) || amount === '0') return null;
    if (!Number.isInteger(decimals) || decimals < 0) return null;
    return {
        network: String(row.network || ''),
        sku: String(row.sku || ''),
        currency: String(row.currency || 'SKR'),
        amountBaseUnits: amount,
        decimals,
        mint: String(row.mint || ''),
        recipient: String(row.recipient || ''),
        recipientAta: String(row.recipient_ata || ''),
    };
}

module.exports = { DEVNET_CANARY_SKU, DEVNET_PACKS, MAINNET_CANARY_SKU, MAINNET_PACKS,
    MAINNET_SKR_MINT, MAINNET_CANARY_OWNER, SKR_DECIMALS_BY_NETWORK, USD_ANCHORS,
    QUOTE_TTL_SECONDS, QUOTE_SETTLEMENT_GRACE_SECONDS, RATE_SOURCE,
    mainnetCanaryEnabled, walletAllowed, purchaseContract, purchaseRail, isPinnedSku,
    usdAnchor, quoteAmount, pinnedSkus, fetchSkrUsdRate, buildQuoteBody, quotableSkus,
    quoteValidAtPayment, quoteOfferable, contractFromQuoteRow, _resetRateCache };
