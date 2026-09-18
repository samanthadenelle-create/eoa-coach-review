// =============================================================================
// api/_lib/genesis-token.js — WO-1854 (clan WO-11). THE SEEKER GENESIS TOKEN READ.
// -----------------------------------------------------------------------------
// "Does this wallet hold a Seeker Genesis Token, and WHICH ONE." Read-only, never
// throws, takes a wallet address and nothing else — the same shape rule
// api/_lib/skr-staking.js enforces for the stake read (product rule 7): there is
// deliberately no parameter through which a caller could supply a mint, a proof or
// an answer.
//
// ⛔ THE CALLER MUST HAVE ALREADY PROVEN WALLET CONTROL. This module answers "what
// does address X hold", never "is the person asking X". SIWS / the ed25519 signature
// / a bound session is the identity proof, and it happens in wallet-auth.js before
// anything here is called. Solana Mobile's own guidance is blunt about the matching
// client-side hazard and it is repeated here because it is the whole reason this file
// is on the server: never decide entitlement client-side — a client can be patched,
// and a client-side `hasSGT` boolean is worth nothing.
//
// =============================================================================
// ⭐ EVERY FACT BELOW WAS MEASURED AGAINST MAINNET ON 2026-09-17, NOT INFERRED.
//   The work order said to verify before building; this is the record of doing it.
// -----------------------------------------------------------------------------
// ⛔ CORRECTION THAT CHANGES THE IMPLEMENTATION — GT2zuHVa… IS NOT A MINT.
//   WORK_ORDER_1854 line 6 calls GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4 the
//   "Genesis Token mint address" and says it was "already confirmed … earlier this
//   session (docs/SKR_ALANIA_ROOT_NETWORK_EXPLORATION_2026-09-17.md)". Both halves are
//   wrong and were checked rather than trusted (CLAUDE.md §11B A — a value copied from
//   a doc is hearsay until re-read at source):
//     * That doc contains NO address at all (grepped; its §"The Vigil, collective
//       edition" discusses the mechanism only). docs/CLAN_WORK_ORDERS_PROOFING_2026-09-17
//       .md:114 says outright it "was never confirmed against an authoritative source in
//       this project's own research".
//     * getAccountInfo(GT2zuHVa…) returns owner 11111111111111111111111111111111
//       (the System Program), space 0, ~8.97 SOL. That is a plain keypair account. It
//       cannot be a mint, and `getTokenAccountsByOwner`'s `mint:` filter pointed at it
//       would match NOTHING, forever, silently — the exact "wrong address here would
//       silently make every Genesis Token check fail" the proofing doc warned about.
//   The address IS correct, as the MINT AUTHORITY. Solana Mobile's own page
//   (docs.solanamobile.com/marketing/engaging-seeker-users, fetched 2026-09-17) lists it
//   as the Mint Authority and GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te as both the
//   Metadata Address and the token Group Address. The doc's own recipe is: SIWS, then
//   enumerate the wallet's Token-2022 accounts, skip empty ones, and require the mint's
//   mintAuthority + MetadataPointer + TokenGroupMember to match.
//
// ⛔ SO THERE IS ONE MINT PER DEVICE, NOT ONE MINT FOR ALL SEEKERS, and the work order's
//   fourth VERIFY item ("single mint per device or a collection") resolves to per-device.
//   Proven end to end from a real mint transaction on the authority
//   (2ZxxArSSkEmrmMogj27n…, read via getTransaction/jsonParsed):
//     wallet Bq1ntjWoEX19WbkxoTwpXPiRtDFbnE3MjbLnZcx3ZyNA
//     ATA    DJhuGfcCRejg2TdUypCwSwY6fzCTL1rKC3h8TPS5rDTy   amount 1, state FROZEN
//     mint   5H4VRJ378TMhhKK91fyAEN84LhnuFaooD93ojzkWW1Kp   supply 1, decimals 0
//   and that mint's own account carries, verbatim:
//     mintAuthority     GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4
//     freezeAuthority   GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4
//     metadataPointer   metadataAddress GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te
//     tokenGroupMember  group GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te, member 96167
//     permanentDelegate / mintCloseAuthority  both GT2zuHVa…
//   Because the mint is per device, the UNIQUENESS CHECK IS AGAINST THE MINT and never
//   against the token account — the ATA changes if the token moves between a single
//   owner's accounts (Solana Mobile notes it can, on a Seed Vault account change), while
//   the mint does not. The work order says the same thing; this is the proof of which
//   shape applies.
//
// ⛔ AND IT IS TOKEN-2022, NOT SPL-TOKEN. The mint is owned by
//   TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb. A Token-2022 account is INVISIBLE to a
//   getTokenAccountsByOwner filtered by the classic Tokenkeg program, so a reader that
//   inherits skr-staking's SPL assumptions finds nothing and reports `no_sgt` for a real
//   Seeker owner.
//
// -----------------------------------------------------------------------------
// ⭐ getTokenAccountsByOwnerV2 IS SUPPORTED BY THE PROVISIONED HELIUS PLAN — MEASURED.
//   The work order's third VERIFY item asked for this specifically and was right to:
//   it is a Helius extension, not a standard Solana RPC method. Against the endpoint in
//   .env.local's HELIUS_RPC_URL (host mainnet.helius-rpc.com, key in the query string —
//   the value is never written to a tracked file), on 2026-09-17:
//     getVersion                     -> 200, solana-core 4.3.0-rc.1
//     getTokenAccountsByOwnerV2      -> 200, real accounts, apiVersion 4.3.0-alpha.2
//     an unknown method              -> 200 with JSON-RPC error {code:-32601}
//   So no fallback was NEEDED. It is built anyway (see readToken2022Accounts) because a
//   plan change, a provider swap or an unset HELIUS_RPC_URL must degrade to the standard
//   method rather than make every Seeker look like a non-Seeker.
//
// ⛔ TWO TRAPS IN V2 THAT A V1-SHAPED READER WALKS STRAIGHT INTO, both measured:
//   1. `result.value` IS AN OBJECT, NOT AN ARRAY — `{accounts, paginationKey, count}`.
//      V1 returns the array directly. `value.map(...)` on a V2 response is a TypeError;
//      `Array.isArray(value)` on it is false, which in skr-staking's readSkrBalance
//      idiom would have become `invalid_response` — a degraded read, not a wrong one,
//      but still a Seeker reported as unreadable. Normalised once, in normalizeAccounts.
//   2. `paginationKey` IS NON-NULL ON THE LAST PAGE. Paging an owner with exactly two
//      accounts at limit 1 returned a key on page 1 AND on page 2; only a third page
//      would have come back empty. So a `while (paginationKey)` loop spends an extra
//      round trip per wallet forever, and a buggy variant of it never terminates. The
//      loop below stops when a page returns FEWER than `limit` accounts, which at the
//      real limit of 1000 means one round trip for every ordinary wallet.
//
// Files under api/_lib/ are NOT routed by Vercel (leading underscore). CommonJS.
// =============================================================================

'use strict';

const { isFreshWithin } = require('./skr-staking');

/**
 * THE THREE OFFICIAL ADDRESSES. Sourced from Solana Mobile's own documentation and
 * each one re-read off a real on-chain account (see this file's header), not copied
 * from a summary.
 *
 * ⚠ SGT_MINT_AUTHORITY IS AN AUTHORITY, AND THE NAME SAYS SO DELIBERATELY. It was
 * called a "mint address" in the work order and that one word is what would have made
 * every check fail silently. A future edit that renames this to SGT_MINT is re-opening
 * the bug.
 */
const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const SGT_GROUP_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Helius' own documented page size for getTokenAccountsByOwnerV2. */
const V2_PAGE_LIMIT = 1000;

/**
 * Hard ceilings on the work ONE wallet's verification may cause.
 *
 * ⛔ THE MINT PROBE IS THE UNBOUNDED ONE, AND IT IS ATTACKER-CHOSEN. Enumerating the
 * token accounts is at most a couple of round trips; checking each DISTINCT MINT's
 * authority is one getAccountInfo per mint, and anyone can mint themselves ten thousand
 * worthless Token-2022 tokens and send one of each to a wallet they then register as a
 * vault signer. Without a cap, one register call fans out ten thousand RPC calls on a
 * shared, rate-limited, BILLED endpoint. Capped, a wallet carrying more junk than this
 * simply fails to prove an SGT, which is the correct answer for an address nobody can
 * read in bounded time — and it is reported as its own reason, never as `no_sgt`.
 */
const MAX_TOKEN_PAGES = 4;
const MAX_MINT_PROBES = 40;

/**
 * The per-wallet cache window, and it is the SAME sixty seconds WO-1852 chose for the
 * Vigil read — reusing that file's one freshness comparison (isFreshWithin) rather than
 * inventing a second rule, exactly as skr-staking's VIGIL_CACHE_TTL_SECONDS note
 * requires. A vault registration verifies every signer, and a clan's Vigil read may ask
 * about the same signers moments later.
 */
const SGT_CACHE_TTL_SECONDS = 60;

/** In-process, therefore PER WARM LAMBDA. The same honest bound skr-staking states. */
const sgtCache = new Map();

/** Test seam. Never called by production code. */
function _resetSgtCache() {
    sgtCache.clear();
}

/**
 * The RPC endpoint for the Genesis Token read.
 *
 * ⛔ HELIUS FIRST, AND NOT BECAUSE IT IS NICER. getTokenAccountsByOwnerV2 is a
 * Helius-specific extension; SOLANA_MAINNET_RPC_URL may point at any provider and will
 * answer -32601. Both are usable — the V1 fallback exists for exactly that — but
 * preferring the endpoint that supports the documented recipe means the ordinary path is
 * the paged one.
 *
 * ⚠ UNSET IS NOT A FALLBACK TO ANOTHER NETWORK, it is a degraded read. The SGT is a
 * mainnet-only artifact; silently inheriting a devnet URL would report every Seeker
 * owner as a non-owner, which is skr-staking's mainnetRpcUrl note in a different key.
 */
function sgtRpcUrl() {
    const helius = process.env.HELIUS_RPC_URL;
    if (typeof helius === 'string' && helius.trim() !== '') return helius.trim();
    const mainnet = process.env.SOLANA_MAINNET_RPC_URL;
    return typeof mainnet === 'string' && mainnet.trim() !== '' ? mainnet.trim() : null;
}

/**
 * One JSON-RPC call. Never throws.
 *
 * ⚠ WHY THIS IS NOT skr-staking's rpcCall, WHICH IS OTHERWISE THE SAME SHAPE. That one
 * collapses EVERY `payload.error` into `rpc_unavailable` and discards the code. This
 * file's whole fallback decision turns on ONE code — -32601, "Method not found",
 * measured above — so it has to survive to the caller. Duplicating a transport for no
 * reason would be the copy CLAUDE.md §16 forbids; duplicating it because the two need
 * different error contracts is the reason the rule has an exception. The contract
 * difference is the point, and it is asserted in the tests.
 */
async function rpcCall(url, method, params) {
    let payload;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
        });
        if (!resp.ok) return { ok: false, reason: 'rpc_unavailable', http: resp.status };
        payload = await resp.json();
    } catch (_) {
        return { ok: false, reason: 'rpc_unavailable' };
    }
    if (!payload) return { ok: false, reason: 'rpc_unavailable' };
    if (payload.error) {
        const code = Number(payload.error.code);
        return {
            ok: false,
            reason: code === -32601 ? 'method_not_found' : 'rpc_error',
            rpcCode: Number.isFinite(code) ? code : null,
        };
    }
    return { ok: true, result: payload.result };
}

/**
 * ONE SEAM FOR THE TWO RESPONSE SHAPES. V1 hands back an array; V2 hands back
 * `{accounts, paginationKey, count}`. Normalised here and nowhere else, so no caller
 * has to know which method answered — trap 1 in this file's header.
 *
 * Returns null (never []) when the value is NEITHER shape: an absent value is not an
 * empty one, and reporting "unparseable" as "holds nothing" is how an outage becomes a
 * fabricated non-Seeker. Same rule readSkrBalance states for the same reason.
 */
function normalizeAccounts(value) {
    if (Array.isArray(value)) return { accounts: value, paginationKey: null };
    if (value && Array.isArray(value.accounts)) {
        return {
            accounts: value.accounts,
            paginationKey: value.paginationKey != null ? String(value.paginationKey) : null,
        };
    }
    return null;
}

/**
 * Pull the `{mint, amount, state}` out of one jsonParsed token-account entry.
 *
 * ⛔ A MISSING `parsed` IS A FAILURE, NOT AN EMPTY ACCOUNT. jsonParsed silently
 * degrades to base64 when the node cannot parse an account, and a Token-2022 account
 * with an unfamiliar extension is a real candidate for that. Treating it as "no mint"
 * would drop a genuine SGT.
 */
function readTokenAccountEntry(entry) {
    const info = entry && entry.account && entry.account.data
        && entry.account.data.parsed && entry.account.data.parsed.info;
    if (!info || typeof info.mint !== 'string') return null;
    const amount = info.tokenAmount && typeof info.tokenAmount.amount === 'string'
        ? info.tokenAmount.amount : null;
    if (amount === null) return null;
    return {
        pubkey: entry.pubkey != null ? String(entry.pubkey) : null,
        mint: info.mint,
        amount: amount,
        state: info.state != null ? String(info.state) : null,
    };
}

/**
 * EVERY TOKEN-2022 ACCOUNT THIS WALLET OWNS, paged, with the V1 fallback.
 *
 * Reports WHICH method answered (`via`) so a test can prove the fallback actually
 * fires and an operator can see, in one field, whether the Helius path is live.
 *
 * @returns {Promise<{ok:true, accounts:Array, via:'v2'|'v1', pages:number,
 *                    truncated:boolean} | {ok:false, reason:string}>}
 */
async function readToken2022Accounts(url, walletAddress) {
    const v2 = await readViaV2(url, walletAddress);
    if (v2.ok) return v2;
    // ONLY a missing method falls back. An rpc_unavailable must NOT be retried on the
    // other method: a dead endpoint is dead for both, and retrying doubles the load on
    // something already failing (the stampede skr-staking's cache note guards against).
    if (v2.reason !== 'method_not_found') return v2;

    const r = await rpcCall(url, 'getTokenAccountsByOwner', [
        walletAddress,
        { programId: TOKEN_2022_PROGRAM_ID },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, reason: r.reason, rpcCode: r.rpcCode || null };
    const norm = normalizeAccounts(r.result && r.result.value);
    if (!norm) return { ok: false, reason: 'invalid_response' };
    return { ok: true, accounts: norm.accounts, via: 'v1', pages: 1, truncated: false };
}

/** The paged V2 read. See trap 2 in this file's header for why the loop ends as it does. */
async function readViaV2(url, walletAddress) {
    const accounts = [];
    let paginationKey = null;
    let pages = 0;

    for (;;) {
        const config = { encoding: 'jsonParsed', commitment: 'confirmed', limit: V2_PAGE_LIMIT };
        if (paginationKey) config.paginationKey = paginationKey;

        const r = await rpcCall(url, 'getTokenAccountsByOwnerV2', [
            walletAddress, { programId: TOKEN_2022_PROGRAM_ID }, config,
        ]);
        if (!r.ok) return { ok: false, reason: r.reason, rpcCode: r.rpcCode || null };

        const norm = normalizeAccounts(r.result && r.result.value);
        if (!norm) return { ok: false, reason: 'invalid_response' };

        pages += 1;
        for (const entry of norm.accounts) accounts.push(entry);

        // A SHORT PAGE IS THE LAST PAGE. The key is non-null even when it is, so it
        // cannot be the terminator (measured — header trap 2).
        if (norm.accounts.length < V2_PAGE_LIMIT) {
            return { ok: true, accounts: accounts, via: 'v2', pages: pages, truncated: false };
        }
        if (!norm.paginationKey) {
            return { ok: true, accounts: accounts, via: 'v2', pages: pages, truncated: false };
        }
        if (pages >= MAX_TOKEN_PAGES) {
            // Say it, do not hide it. A wallet this large cannot be read in bounded
            // time, and `truncated` is what stops the caller reading the partial list
            // as a complete one.
            return { ok: true, accounts: accounts, via: 'v2', pages: pages, truncated: true };
        }
        paginationKey = norm.paginationKey;
    }
}

/**
 * IS THIS MINT A SEEKER GENESIS TOKEN? Three independent conditions, all three
 * required, exactly as Solana Mobile's page specifies them.
 *
 * ⛔ THE AUTHORITY CHECK ALONE IS A FORGERY VECTOR, AND MUST NEVER BE "SIMPLIFIED" TO.
 * `InitializeMint` takes the mint authority as a PLAIN PUBKEY ARGUMENT — it is not a
 * signer of that instruction. So ANYONE can create a Token-2022 mint that names
 * GT2zuHVa… as its mintAuthority, mint nothing with it (they cannot, they lack the key),
 * and still present a mint whose `mintAuthority` field reads exactly right. An
 * authority-only test would hand hardware-backed status to a wallet holding a token it
 * minted itself.
 *
 * ⭐ THE TOKEN-GROUP MEMBERSHIP IS THE LOAD-BEARING CHECK. Initializing a
 * TokenGroupMember requires the GROUP'S update authority to sign, so `state.group ===
 * GT22s89…` is a fact only Solana Mobile could have written. The metadata pointer is the
 * third leg and is checked because the official recipe checks it. All three, always —
 * fewer is a reading of the recipe rather than the recipe.
 *
 * Returns a REASON on refusal so the tests (and a future debugging session) can tell
 * "wrong authority" from "right authority, wrong group" — never one opaque false.
 */
function classifyMint(parsedInfo) {
    if (!parsedInfo || typeof parsedInfo !== 'object') {
        return { sgt: false, reason: 'mint_unparseable' };
    }
    if (parsedInfo.mintAuthority !== SGT_MINT_AUTHORITY) {
        return { sgt: false, reason: 'wrong_mint_authority' };
    }
    const extensions = Array.isArray(parsedInfo.extensions) ? parsedInfo.extensions : [];
    const find = (name) => extensions.find((e) => e && e.extension === name);

    const pointer = find('metadataPointer');
    if (!pointer || !pointer.state || pointer.state.metadataAddress !== SGT_GROUP_ADDRESS) {
        return { sgt: false, reason: 'metadata_pointer_mismatch' };
    }
    const member = find('tokenGroupMember');
    if (!member || !member.state || member.state.group !== SGT_GROUP_ADDRESS) {
        return { sgt: false, reason: 'group_member_mismatch' };
    }
    return {
        sgt: true,
        memberNumber: member.state.memberNumber != null ? Number(member.state.memberNumber) : null,
    };
}

/** Fetch one mint account, jsonParsed. Never throws. */
async function readMint(url, mint) {
    const r = await rpcCall(url, 'getAccountInfo', [
        mint, { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, reason: r.reason };
    const value = r.result && r.result.value;
    if (!value) return { ok: false, reason: 'account_not_found' };
    if (value.owner !== TOKEN_2022_PROGRAM_ID) return { ok: false, reason: 'not_token_2022' };
    const parsed = value.data && value.data.parsed;
    if (!parsed || parsed.type !== 'mint' || !parsed.info) {
        return { ok: false, reason: 'mint_unparseable' };
    }
    return { ok: true, info: parsed.info, slot: r.result.context && r.result.context.slot };
}

/**
 * FIND THIS WALLET'S SEEKER GENESIS TOKEN MINT. The one network entry point.
 *
 * ⛔ `no_sgt` AND `rpc_unavailable` ARE DIFFERENT ANSWERS AND MUST NEVER COLLAPSE. The
 * first means "we looked and this wallet holds none" — a real, actionable refusal a
 * Leader can fix by removing a signer. The second means "we could not look", and
 * reporting it as the first would tell a genuine Seeker owner their device is not a
 * Seeker, during someone else's outage. This is the same distinction fetchAccount draws
 * between account_not_found and rpc_unavailable, and for the identical reason.
 *
 * ⛔ AND IF A WALLET HOLDS TWO SGTs, THE PICK IS DETERMINISTIC. Solana Mobile notes the
 * token can move between one owner's own accounts on a Seed Vault account change, so a
 * wallet transiently holding two is not absurd. Sorting the candidate mints and taking
 * the first means two reads of the same wallet bind the same mint — an arbitrary pick
 * would let a retry rebind, and rebinding is what the uniqueness index treats as a
 * different device. Every candidate is reported in `allMints` so the choice is visible.
 *
 * @param {string} walletAddress base58 wallet whose control the caller ALREADY proved
 * @param {{rpcUrl?:string, nowSeconds?:number, noCache?:boolean}} [opts] test seams only
 * @returns {Promise<{ok:true, mint:string, memberNumber:number|null, via:string,
 *                    allMints:string[], fromCache:boolean}
 *                 | {ok:false, reason:string, detail?:object, fromCache?:boolean}>}
 */
async function findSgtMint(walletAddress, opts) {
    const options = opts || {};
    const nowSeconds = Number.isFinite(options.nowSeconds)
        ? options.nowSeconds : Math.floor(Date.now() / 1000);

    const key = typeof walletAddress === 'string' ? walletAddress : '';
    if (!options.noCache) {
        const hit = sgtCache.get(key);
        if (hit && isFreshWithin(hit.atSeconds, nowSeconds, SGT_CACHE_TTL_SECONDS)) {
            return Object.assign({}, hit.result, { fromCache: true });
        }
    }
    const result = await findSgtMintUncached(walletAddress, options);
    // ⛔ FAILURES ARE CACHED TOO, for the reason skr-staking's vigilCache states: a vault
    // registration verifies every signer, so an unreadable endpoint would otherwise cost
    // (signers x mints) round trips on every retry and turn an outage into a stampede.
    sgtCache.set(key, { atSeconds: nowSeconds || 1, result: result });
    return result;
}

/** The uncached body of findSgtMint. Never throws. */
async function findSgtMintUncached(walletAddress, options) {
    if (!walletAddress || typeof walletAddress !== 'string') {
        return { ok: false, reason: 'wallet_missing', fromCache: false };
    }
    const url = options.rpcUrl || sgtRpcUrl();
    if (!url) return { ok: false, reason: 'rpc_url_unset', fromCache: false };

    const listing = await readToken2022Accounts(url, walletAddress);
    if (!listing.ok) {
        return {
            ok: false,
            reason: listing.reason === 'invalid_response' ? 'invalid_response' : 'rpc_unavailable',
            detail: { rpcReason: listing.reason, rpcCode: listing.rpcCode || null },
            fromCache: false,
        };
    }

    // Skip EMPTY accounts, per the official recipe. A zero-balance ATA for an SGT mint
    // is the residue of a transfer away from this wallet — the account survives, the
    // token does not, and counting it would keep proving a device the wallet gave up.
    const mints = [];
    const seen = new Set();
    for (const entry of listing.accounts) {
        const acct = readTokenAccountEntry(entry);
        if (!acct) {
            // An entry we cannot parse is not an entry we can dismiss.
            return {
                ok: false, reason: 'invalid_response',
                detail: { unparseableTokenAccount: true }, fromCache: false,
            };
        }
        if (acct.amount === '0') continue;
        if (seen.has(acct.mint)) continue;
        seen.add(acct.mint);
        mints.push(acct.mint);
    }

    if (mints.length === 0) {
        // A clean look that found nothing, and the ONE place `no_sgt` may be returned
        // from a successful enumeration.
        return { ok: false, reason: 'no_sgt', detail: { tokenAccounts: listing.accounts.length,
            via: listing.via, truncated: listing.truncated }, fromCache: false };
    }

    if (mints.length > MAX_MINT_PROBES || listing.truncated) {
        // Deliberately NOT `no_sgt` — see MAX_MINT_PROBES. We did not finish looking.
        return {
            ok: false, reason: 'too_many_mints',
            detail: { mints: mints.length, cap: MAX_MINT_PROBES, truncated: listing.truncated },
            fromCache: false,
        };
    }

    mints.sort();   // deterministic probe order AND deterministic pick — see the header
    const candidates = [];
    let firstMemberNumber = null;
    for (const mint of mints) {
        const m = await readMint(url, mint);
        if (!m.ok) {
            if (m.reason === 'rpc_unavailable') {
                return { ok: false, reason: 'rpc_unavailable',
                    detail: { whileProbingMint: true }, fromCache: false };
            }
            continue;   // not_token_2022 / account_not_found / unparseable: not an SGT
        }
        const verdict = classifyMint(m.info);
        if (verdict.sgt) {
            if (candidates.length === 0) firstMemberNumber = verdict.memberNumber;
            candidates.push(mint);
        }
    }

    if (candidates.length === 0) {
        return { ok: false, reason: 'no_sgt',
            detail: { probed: mints.length, via: listing.via }, fromCache: false };
    }

    return {
        ok: true,
        mint: candidates[0],
        memberNumber: firstMemberNumber,
        via: listing.via,
        allMints: candidates,
        fromCache: false,
    };
}

module.exports = {
    SGT_MINT_AUTHORITY,
    SGT_GROUP_ADDRESS,
    TOKEN_2022_PROGRAM_ID,
    V2_PAGE_LIMIT,
    MAX_TOKEN_PAGES,
    MAX_MINT_PROBES,
    SGT_CACHE_TTL_SECONDS,
    sgtRpcUrl,
    // pure
    normalizeAccounts,
    readTokenAccountEntry,
    classifyMint,
    // network
    rpcCall,
    readMint,
    readToken2022Accounts,
    findSgtMint,
    _resetSgtCache,
};
