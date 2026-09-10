// =============================================================================
// api/_lib/solana-pda.js — Program Derived Address derivation, dependency-free.
// -----------------------------------------------------------------------------
// WO-1674 (HEART-001). The backend must derive the SKR UserStake PDA itself,
// because product rule 7 forbids trusting the client for anything about the
// stake — INCLUDING which account to read.
//
// ⛔ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT FIVE LINES OF sha256.
//
//   A PDA is *defined* as a 32-byte value that is NOT a valid ed25519 public
//   key. Derivation is: for bump = 255, 254, ... take
//
//       candidate = sha256(seeds || [bump] || programId || "ProgramDerivedAddress")
//
//   and RETURN THE FIRST CANDIDATE THAT IS OFF THE CURVE. Roughly half of all
//   candidates ARE on the curve, so an implementation that skips the on-curve
//   test returns the wrong address for about half of all inputs — and the wrong
//   address is still 32 bytes of valid base58, so it does not look wrong. It
//   reads back ACCOUNT_NOT_FOUND, which this feature's own status model treats
//   as "this player has no stake". A staker would be told they have no stake,
//   silently, for reasons no log line would name. That is the failure this file
//   is written to make impossible.
//
//   The Unity client gets the on-curve test for free from
//   Solana.Unity.Wallet.PublicKey.TryFindProgramAddress
//   (Assets/_Modules/Wallet/NativeSkrStakeQuery.cs:52-54). Node has no such
//   dependency here: package.json carries tweetnacl + bs58 and deliberately NOT
//   @solana/web3.js (WO-1674 §6: "a 200 kB SDK for two getAccountInfo calls is
//   not the trade"). tweetnacl.lowlevel exposes the field primitives but NOT
//   `unpackneg`, so the decompression below is written out in BigInt.
//
// THE MATH (RFC 8032 §5.1.3, ed25519 point decompression):
//   p = 2^255 - 19,  d = -121665 * inv(121666) mod p
//   A compressed point is 32 little-endian bytes: the low 255 bits are y, the
//   top bit is the sign of x. A y is on the curve iff x exists with
//       x^2 = (y^2 - 1) / (d*y^2 + 1)   (mod p)
//   Solved by the standard candidate root x = u*v^3 * (u*v^7)^((p-5)/8) and a
//   check of v*x^2 against +u and -u.
//
// PROVEN, not asserted (CLAUDE.md §11B). test/solana-pda.test.js checks:
//   • a freshly generated tweetnacl ed25519 public key IS on the curve (by
//     construction it must be — so a false here means the test is broken);
//   • every PDA this file returns is NOT on the curve (the defining property);
//   • determinism across calls.
//   And the RESULT for WO-1674 records the live cross-check: a REAL UserStake
//   account fetched from mainnet re-derives, byte for byte, from the `user`
//   pubkey stored inside it. That is the only test that proves the seeds, the
//   ordering and the on-curve rule all at once against something we did not
//   write ourselves.
//
// CommonJS, no exports beyond the two functions. Files under api/_lib/ are not
// routed by Vercel (leading underscore), so this is a library, never a route.
// =============================================================================

const crypto = require('crypto');

/** The ed25519 prime field modulus, 2^255 - 19. */
const P = (1n << 255n) - 19n;

/** The curve constant d = -121665 / 121666 (mod p). Computed, never pasted. */
let D_CACHE = null;

/** The literal ASCII suffix every PDA hash ends with. Part of the definition. */
const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');

/** The largest bump seed; derivation counts DOWN from here. */
const MAX_BUMP = 255;

/** Modular exponentiation over BigInt. Square-and-multiply, constant shape. */
function powMod(base, exp, mod) {
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % mod;
        b = (b * b) % mod;
        e >>= 1n;
    }
    return result;
}

/** Modular inverse via Fermat: a^(p-2) mod p. p is prime, so this is total. */
function invMod(a, mod) {
    return powMod(a, mod - 2n, mod);
}

/** d = -121665 * inv(121666) mod p, computed once. */
function curveD() {
    if (D_CACHE === null) {
        D_CACHE = ((P - 121665n) * invMod(121666n, P)) % P;
    }
    return D_CACHE;
}

/**
 * Is this 32-byte value a valid ed25519 point (i.e. a possible public key)?
 *
 * Returns FALSE for anything that is not exactly 32 bytes, for a non-canonical
 * y (y >= p), and for a y with no square root — all of which are exactly the
 * cases a PDA is allowed to be. A `true` here means the candidate must be
 * REJECTED as a PDA, because a private key could exist for it.
 *
 * @param {Buffer|Uint8Array} bytes 32-byte compressed point
 * @returns {boolean}
 */
function isOnCurve(bytes) {
    if (!bytes || bytes.length !== 32) return false;

    const buf = Buffer.from(bytes);
    const sign = (buf[31] >> 7) & 1;

    // y is the low 255 bits, little-endian.
    let y = 0n;
    for (let i = 31; i >= 0; i--) {
        const b = i === 31 ? (buf[i] & 0x7f) : buf[i];
        y = (y << 8n) | BigInt(b);
    }

    // A non-canonical y is not a valid encoding of any point.
    if (y >= P) return false;

    const d = curveD();
    const y2 = (y * y) % P;
    const u = (y2 - 1n + P) % P;          // y^2 - 1
    const v = (d * y2 + 1n) % P;          // d*y^2 + 1

    if (v === 0n) return false;

    // Candidate root: x = u * v^3 * (u * v^7)^((p-5)/8)
    const v2 = (v * v) % P;
    const v3 = (v2 * v) % P;
    const v4 = (v2 * v2) % P;
    const v7 = (v4 * v3) % P;
    const uv7 = (u * v7) % P;
    let x = (u * v3) % P;
    x = (x * powMod(uv7, (P - 5n) / 8n, P)) % P;

    const vxx = (v * ((x * x) % P)) % P;

    if (vxx !== u) {
        if ((vxx + u) % P === 0n) {
            // x = x * 2^((p-1)/4), the second candidate root.
            x = (x * powMod(2n, (P - 1n) / 4n, P)) % P;
        } else {
            return false;   // no square root exists — off the curve.
        }
    }

    // x = 0 with a sign bit set is not a valid encoding.
    if (x === 0n && sign === 1) return false;

    return true;
}

/**
 * Normalise one seed to a Buffer and enforce the protocol's 32-byte seed limit.
 * A longer seed is a programming error here, not a runtime condition: it would
 * produce an address the on-chain program can never re-derive.
 */
function toSeedBuffer(seed, index) {
    const buf = Buffer.isBuffer(seed) ? seed : Buffer.from(seed);
    if (buf.length > 32) {
        throw new Error('seed ' + index + ' is ' + buf.length + ' bytes; the maximum is 32');
    }
    return buf;
}

/**
 * Derive the canonical PDA for `seeds` under `programId`.
 *
 * Counts bumps DOWN from 255 and returns the FIRST off-curve candidate, which
 * is what "the" PDA means — an on-chain program deriving the same address does
 * exactly this, so any other rule produces an address the program will reject.
 *
 * @param {Array<Buffer|Uint8Array>} seeds
 * @param {Buffer|Uint8Array} programId 32 bytes
 * @returns {{address: Buffer, bump: number}}
 * @throws when no bump in 255..0 lands off the curve (probability ~2^-256; a
 *         throw here means the inputs are wrong, never that we were unlucky).
 */
function findProgramAddress(seeds, programId) {
    if (!Array.isArray(seeds)) throw new Error('seeds must be an array');
    const program = Buffer.from(programId);
    if (program.length !== 32) throw new Error('programId must be 32 bytes');

    const parts = seeds.map(toSeedBuffer);

    for (let bump = MAX_BUMP; bump >= 0; bump--) {
        const hash = crypto.createHash('sha256');
        for (const part of parts) hash.update(part);
        hash.update(Buffer.from([bump]));
        hash.update(program);
        hash.update(PDA_MARKER);
        const candidate = hash.digest();

        if (!isOnCurve(candidate)) {
            return { address: candidate, bump: bump };
        }
    }

    throw new Error('no off-curve program address found for the supplied seeds');
}

module.exports = { isOnCurve, findProgramAddress, P, MAX_BUMP };
