// =============================================================================
// wallet-handoff.js — the mobile-browser wallet handoff door (WO-1957).
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS, stated from measurement and not from a premise.
//
// The wallet-adapter CDN bundle the Solana SDK loads
// (@magicblock-labs/unity-wallet-adapter@1.2.1 — DOWNLOADED AND READ at source
// 2026-09-22) already registers a Solflare adapter whose readyState is `Loadable`
// in EVERY browser, and whose connect() already performs
//     window.location.href = `https://solflare.com/ul/v1/browse/${href}?ref=${origin}`
// when `isIosAndRedirectable()` is true — which it IS on iPhone Chrome, because
// that gate is `ua.includes("iphone") && ua.includes("safari")` and iOS Chrome's UA
// ends `CriOS/… Mobile/15E148 Safari/604.1`.
//
// ⛔ SO THE REDIRECT IS NOT MISSING. WHAT IS MISSING IS THAT IT RETURNS NOTHING.
// That connect() arm is `return void(...)`, so the bundle's connectWallet returns
// undefined, so SolanaWalletAdapterWebGL.jslib throws "Unable to connect to: X",
// so OnWalletConnected(null) raises `Login cancelled`
// (SolanaWalletAdapterWebGL.cs:198). MEASURED in the owner's own iPhone session,
// web_trace `wt-a73bdc1d3350`, 2026-09-22 12:12:26Z:
//     [Flow:Wallet] Connect FAILED: Exception: Login cancelled — staying disconnected.
// A redirect and a cancel are INDISTINGUISHABLE to that code. That is the bug.
//
// ⛔ AND MWA CANNOT HELP AN iPHONE. The bundle gates SolanaMobileWalletAdapter on a
// literal `/android/i` userAgent test; on any iPhone it logs "MobileWalletAdapter:
// Not mobile" and registers nothing.
//
// This module is the PAGE half of the fix. It does not redirect on its own and it
// never runs automatically: it answers three questions and performs one navigation
// when C# asks for it (EoaWalletBridge.jslib → WebGLWalletProvider).
//
//   eoaWalletHandoff.capability()  -> {mobile, injected, injectedName, framed, returned, targets}
//   eoaWalletHandoff.open(id)      -> true when a navigation was started
//   eoaWalletHandoff.returned()    -> the wallet id we came back from, or ''
//
// LOCALE GAP, NAMED (WO-1927 precedent): a WebGL template has no locale seam, so
// the one player-visible string here is the English canonical value inline. Every
// other player-facing sentence in this flow is produced in C# and routes through
// the locale normally.
// =============================================================================
(function (global) {
  'use strict';

  // The two targets whose browse deeplink was READ AT SOURCE in the CDN bundle
  // (and, for Solflare, confirmed against docs.solflare.com .../other-methods/browse).
  // ⛔ JUPITER IS DELIBERATELY ABSENT. @jup-ag/jup-mobile-adapter is a REACT HOOK
  // (`useWrappedReownAdapter`) with no UMD/CDN build, its docs describe QR scanning,
  // and NOTHING in them claims a same-device mobile-browser deeplink. Adding a
  // `jupiter` row here would be inventing a URL. See eoaJupiterMobileAdapter below.
  var TARGETS = {
    solflare: 'https://solflare.com/ul/v1/browse/',
    phantom: 'https://phantom.app/ul/browse/'
  };

  var RETURN_PARAM = 'eoaWallet';

  // Captured at load, BEFORE the marker is stripped from the address bar.
  var returnedFrom = '';

  function trace(line) {
    try {
      if (typeof global.piTraceEmit === 'function') global.piTraceEmit(line, false);
      else if (global.console && global.console.info) global.console.info(line);
    } catch (e) { /* telemetry never blocks a connect */ }
  }

  function ua() {
    try { return String((global.navigator && global.navigator.userAgent) || ''); }
    catch (e) { return ''; }
  }

  // iPadOS 13+ reports a DESKTOP Macintosh UA, so the token test alone misses every
  // iPad — the touch-point probe is the only reliable tell and it is why this is not
  // a one-line regex.
  function isMobileBrowser() {
    var s = ua();
    if (/android|iphone|ipod|ipad|iemobile|blackberry|opera mini/i.test(s)) return true;
    try {
      if (/Macintosh/i.test(s) && global.navigator &&
          typeof global.navigator.maxTouchPoints === 'number' &&
          global.navigator.maxTouchPoints > 1) return true;
    } catch (e) { /* hardened browsers hide maxTouchPoints; fall through */ }
    return false;
  }

  // "Are we already INSIDE a wallet's in-app browser?" — if so the ordinary
  // Wallet-Standard path works unchanged and this module must stay out of the way.
  function injectedName() {
    try {
      if (global.xnft && global.xnft.solana) return 'xnft';
      if (global.solflare && global.solflare.isSolflare) return 'solflare';
      if (global.phantom && global.phantom.solana) return 'phantom';
      if (global.backpack) return 'backpack';
      if (global.solana && global.solana.isPhantom) return 'phantom';
    } catch (e) { /* cross-origin property access can throw; absence is the answer */ }
    return '';
  }

  function framed() {
    try { return global.top !== global.self; } catch (e) { return true; }
  }

  // The URL we hand the wallet is OUR url plus the return marker, because the
  // wallet's in-app browser is a DIFFERENT browsing context: sessionStorage does not
  // travel, so the crumb has to ride the query string.
  function returnUrl(id) {
    var href;
    try { href = String(global.location.href); } catch (e) { return ''; }
    try {
      var u = new URL(href);
      u.searchParams.set(RETURN_PARAM, id);
      return u.toString();
    } catch (e) {
      // No URL constructor (or an opaque href): fall back to string surgery rather
      // than dropping the marker, which would cost us the whole return leg.
      var sep = href.indexOf('?') >= 0 ? '&' : '?';
      return href + sep + RETURN_PARAM + '=' + encodeURIComponent(id);
    }
  }

  function deeplink(id) {
    var base = TARGETS[id];
    if (!base) return '';
    var target = returnUrl(id);
    if (!target) return '';
    var origin = '';
    try { origin = String(global.location.origin || ''); } catch (e) { origin = ''; }
    return base + encodeURIComponent(target) + '?ref=' + encodeURIComponent(origin);
  }

  // The navigation ladder. Each rung is wrapped, and a rung that throws is a fact we
  // report rather than a silent dead button (CLAUDE.md §12: no silent failures).
  //
  // ⚠ UNPROVEN: whether rung 2 works inside the itch iframe. itch serves the game
  // cross-origin (measured: `framed=true href=https://html-classic.itch.zone/...`)
  // and its sandbox flags were not read. Instrumented, not claimed.
  function navigate(url) {
    if (!framed()) {
      try { global.top.location.href = url; return 'top'; }
      catch (e) { trace('[EoaWalletHandoff] top navigation threw: ' + (e && e.message)); }
    }
    try {
      var w = global.open(url, '_blank');
      if (w) return 'popup';
      trace('[EoaWalletHandoff] window.open returned null (popup blocked)');
    } catch (e) {
      trace('[EoaWalletHandoff] window.open threw: ' + (e && e.message));
    }
    try { global.top.location.href = url; return 'top-framed'; }
    catch (e) { trace('[EoaWalletHandoff] framed top navigation threw: ' + (e && e.message)); }
    try { global.location.href = url; return 'self'; }
    catch (e) { trace('[EoaWalletHandoff] self navigation threw: ' + (e && e.message)); }
    return '';
  }

  function open(id) {
    var url = deeplink(id);
    if (!url) {
      // The one refusal a player could plausibly hit, and the English canonical
      // value is inline here because a template has no locale seam (see header).
      trace('[EoaWalletHandoff] no deeplink for target "' + String(id) +
            '" - that wallet cannot be opened from a browser.');
      return false;
    }
    trace('[EoaWalletHandoff] opening ' + id + ' framed=' + framed() + ' url=' + url);
    var how = navigate(url);
    trace('[EoaWalletHandoff] navigation via=' + (how || 'NONE') + ' target=' + id);
    return how !== '';
  }

  function capability() {
    var name = injectedName();
    return {
      mobile: isMobileBrowser(),
      injected: name !== '',
      injectedName: name,
      framed: framed(),
      returned: returnedFrom,
      targets: Object.keys(TARGETS)
    };
  }

  // Read the return marker at load, then strip it so a reload does not look like a
  // second handoff. replaceState, never assign — assigning would reload the page and
  // the player would watch the game boot twice.
  (function readReturnMarker() {
    try {
      var search = String(global.location.search || '');
      var m = search.match(new RegExp('[?&]' + RETURN_PARAM + '=([^&]*)'));
      if (!m) return;
      returnedFrom = decodeURIComponent(m[1] || '');
      if (!TARGETS[returnedFrom]) returnedFrom = '';
      if (global.history && global.history.replaceState) {
        var stripped = search.replace(new RegExp('([?&])' + RETURN_PARAM + '=[^&]*&?', ''), '$1')
                             .replace(/[?&]$/, '');
        global.history.replaceState(null, '', global.location.pathname +
          (stripped && stripped !== '?' ? stripped : '') + (global.location.hash || ''));
      }
    } catch (e) { /* the marker is a nicety; a boot never depends on it */ }
  })();

  global.eoaWalletHandoff = {
    capability: capability,
    capabilityJson: function () {
      try { return JSON.stringify(capability()); } catch (e) { return '{}'; }
    },
    open: open,
    deeplink: deeplink,
    returned: function () { return returnedFrom; },
    isMobileBrowser: isMobileBrowser,
    injectedName: injectedName,
    RETURN_PARAM: RETURN_PARAM
  };

  // ---------------------------------------------------------------------------
  // The Jupiter Mobile Adapter stub — a placeholder that TELLS THE TRUTH.
  //
  // ⛔ A REOWN projectId IS NECESSARY AND NOT SUFFICIENT. @jup-ag/jup-mobile-adapter
  // exports the React hook `useWrappedReownAdapter` and requires React 18+ /
  // Next.js 13+ / Reown AppKit 1.6.0+; no UMD or CDN build is published. This page is
  // a hand-written Unity WebGL template with NO bundler step — tools/build-page-buffer.mjs
  // exists because even npm `buffer` had to be hand-built into a browser global. So a
  // projectId alone unlocks nothing here, and the two refusals below say so in
  // different words on purpose.
  // ---------------------------------------------------------------------------
  global.eoaJupiterMobileAdapter = {
    init: function (opts) {
      var projectId = (opts && opts.projectId) ? String(opts.projectId) : '';
      if (!projectId) {
        trace('[EoaJupiterMobileAdapter] REFUSED: no Reown projectId is configured. ' +
              'Create one at https://dashboard.reown.com/ and pass it as projectId.');
        return { ok: false, reason: 'no-project-id' };
      }
      trace('[EoaJupiterMobileAdapter] REFUSED: a projectId is present but this page ' +
            'cannot load @jup-ag/jup-mobile-adapter - it is a React hook with no UMD/CDN ' +
            'build, and this Unity WebGL template has no bundler step. The projectId is ' +
            'necessary, not sufficient. See WO-1957 section 1g.');
      return { ok: false, reason: 'no-bundler' };
    }
  };

  // Node (the regression suite) requires this file directly; browsers ignore it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.eoaWalletHandoff;
  }
})(typeof window !== 'undefined' ? window : globalThis);
