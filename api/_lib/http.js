// =============================================================================
// api/_lib/http.js — shared HTTP plumbing for the serverless functions
// -----------------------------------------------------------------------------
// Three things every endpoint needs and three things that were each re-invented
// (or MISSING) per file before this:
//
//   1. CORS + preflight.  api/trace.js and api/bug-report.js set CORS headers;
//      api/game/save.js, api/game/load.js and api/auth/nonce.js did NOT. That is
//      invisible on Android (UnityWebRequest is a native socket — no CORS), and
//      FATAL on WebGL/pinet: a cross-origin request carrying a CUSTOM header
//      (X-Wallet / X-Nonce / X-Signature / X-Guest-Id) triggers an OPTIONS
//      PREFLIGHT, and an endpoint that neither answers OPTIONS nor advertises the
//      header names has its request blocked by the browser BEFORE the function
//      runs. So the web build could never have saved even with perfect auth.
//
//   2. A QUIET failure response.  Owner law: errors are quiet for the player,
//      LOUD in the db. quietFail() emits a minimal, non-secret body — a stable
//      machine code plus a short correlation ref — and nothing else. No stack, no
//      SQL text, no wallet, no "reason" prose the client might render as a wall
//      of JSON. The matching detail goes to the db via _lib/audit.js under the
//      SAME ref, so a support question ("code AUTH_NONCE_REPLAYED / ref 3f9a21c8")
//      resolves to one row.
//
//   3. Raw body reading.  The wallet signature covers the EXACT raw bytes, so
//      save.js must disable the body parser and collect the Buffer itself. That
//      loop lived inline in save.js; it lives here now with a hard size cap, so a
//      hostile client cannot stream an unbounded body into a function's memory
//      before we have even decided who they are.
//
// CommonJS, zero dependencies. Files under api/_lib/ are NOT routed by Vercel
// (leading underscore), so this is a library, never an endpoint.
// =============================================================================

const crypto = require('crypto');

// Every custom header any endpoint in this project reads. Advertised wholesale on
// the preflight response — a missing name here is a silently blocked web request,
// which is exactly the class of bug this file exists to end.
const ALLOWED_HEADERS = [
    'Content-Type',
    'Accept',
    'X-Wallet',
    'X-Nonce',
    'X-Signature',
    'X-Guest-Id',
    'X-Client-Version',
    'X-Trace-Session',
    'X-Trace-Build',
    'X-Admin-Key',
].join(', ');

/**
 * Apply permissive CORS and answer an OPTIONS preflight.
 *
 * Origin is '*' and no credentials are used (auth travels in explicit headers,
 * never cookies), so this widens nothing: every one of these endpoints already
 * authenticates per-request, and the two that must NOT be browser-reachable
 * (admin/db, admin/cleanup) keep their own key check — cleanup deliberately sets
 * no CORS at all.
 *
 * @param {object} req  the incoming request
 * @param {object} res  the response
 * @param {string} methods  e.g. 'POST, OPTIONS'
 * @returns {boolean} true when the request was a preflight and is now FINISHED —
 *                    the caller must return immediately.
 */
function applyCors(req, res, methods) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', methods || 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', '86400');   // cache the preflight for a day
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return true;
    }
    return false;
}

/**
 * A short, non-secret correlation id. Printed in the response, the runtime log
 * and the analytics row so three places can be joined by eye.
 */
function newRef() {
    return crypto.randomBytes(4).toString('hex');
}

/**
 * The QUIET half of "quiet for the player, loud in the db".
 *
 * The body is deliberately three short fields. `code` is a stable enum the client
 * may branch on (e.g. "your session expired, retrying") — it names a CLASS of
 * failure and never leaks which wallet, which nonce, or what the server knows.
 * Everything diagnostic lives under `ref` in the db.
 *
 * @param {object} res
 * @param {number} status  200 | 400 | 401 | 404 | 500 (project constraint)
 * @param {string} code    a stable machine code (see wallet-auth.AuthCode)
 * @param {string} ref     the correlation ref (from newRef)
 */
function quietFail(res, status, code, ref) {
    return res.status(status).json({ ok: false, code: code, ref: ref });
}

/**
 * Collect the raw request body into a Buffer, aborting past `maxBytes`.
 *
 * The cap is enforced DURING the stream (not after), so an oversized upload is
 * cut off rather than buffered in full. Callers get a distinguishable error
 * (err.code === 'BODY_TOO_LARGE') so they can answer with a real code instead of
 * a generic 500.
 *
 * @param {object} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes) {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 1024 * 1024;
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let done = false;

        req.on('data', (chunk) => {
            if (done) return;
            total += chunk.length;
            if (total > limit) {
                done = true;
                const err = new Error('body exceeds ' + limit + ' bytes');
                err.code = 'BODY_TOO_LARGE';
                try { req.destroy(); } catch (_) { /* already gone */ }
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', (err) => { if (!done) { done = true; reject(err); } });
    });
}

/**
 * Read the body as EXACT bytes when possible, and say so when it is not.
 *
 * WHY THIS EXISTS (a real, silent break found 2026-08-02): api/game/save.js had
 *
 *     module.exports.config = { api: { bodyParser: false } };   // line 23
 *     module.exports = async (req, res) => { ... };             // line 36
 *
 * The second line REPLACES the exports object and throws the `config` away, so
 * the runtime's body parser was never actually disabled. The parser drains the
 * request stream, after which the handler's own `req.on('data')` collector gets
 * nothing — and a late 'end' listener on an already-ended stream never fires, so
 * the read hangs until the function or the client's 15s timeout kills it. The
 * ordering is fixed at the bottom of save.js; this helper makes the failure
 * survivable and, above all, VISIBLE if it ever comes back.
 *
 * `exact` is false when the bytes had to be reconstructed from an already-parsed
 * body. Re-serialising JSON does NOT reproduce the original byte sequence (key
 * order, spacing), so a wallet signature CANNOT be verified against it — the
 * caller must refuse the wallet rail with a distinct code rather than reporting a
 * bogus AUTH_BAD_SIGNATURE and sending everyone hunting the wrong bug.
 *
 * @returns {Promise<{buffer: Buffer, exact: boolean}>}
 */
async function readBodyExact(req, maxBytes) {
    const alreadyParsed = req && req.body != null && typeof req.body !== 'undefined';
    const streamSpent = !!(req && (req.readableEnded === true || req.complete === true));

    if (alreadyParsed && streamSpent) {
        let buf;
        try {
            buf = Buffer.isBuffer(req.body) ? req.body
                : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8')
                : Buffer.from(JSON.stringify(req.body), 'utf8');
        } catch (_) {
            buf = Buffer.alloc(0);
        }
        // A Buffer/string body IS the original bytes; only an object body was
        // re-serialised and is therefore inexact.
        const exact = Buffer.isBuffer(req.body) || typeof req.body === 'string';
        return { buffer: buf, exact: exact };
    }

    const buffer = await readRawBody(req, maxBytes);
    return { buffer: buffer, exact: true };
}

module.exports = {
    ALLOWED_HEADERS,
    applyCors,
    newRef,
    quietFail,
    readRawBody,
    readBodyExact,
};
