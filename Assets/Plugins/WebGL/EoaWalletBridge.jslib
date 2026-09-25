// =============================================================================
// EoaWalletBridge.jslib — sign an OPAQUE base64 Solana transaction in the browser.
// -----------------------------------------------------------------------------
// WHY THIS EXISTS AND WHY IT IS NOT THE SDK'S OWN PATH.
//
// The Solana Unity SDK's WebGL wallet bridge already signs
// (Packages/.../SolanaWalletAdapterWebGL.jslib:57-84, base64 in / base64 out), and
// for a LEGACY transaction the SDK's C# wrapper is the right door. But its wrapper
// round-trips the bytes through Solana.Unity.Rpc.Models.Transaction
// (SolanaWalletAdapterWebGL.cs:154-158 serialise, :220 deserialise), and the pinned
// SDK 1.2.9 has no VersionedTransaction model in that path — so a Jupiter v0 swap
// cannot survive the trip. WalletService.cs:882-884 records exactly that.
//
// ⭐ MEASURED 2026-09-22, not assumed. The CDN bundle the SDK loads
// (@magicblock-labs/unity-wallet-adapter@1.2.1, fetched and read) implements
// signTransaction as:
//     const n = Buffer.from(t,"base64");
//     let r; try { r = Transaction.from(n) } catch(e) { r = VersionedTransaction.deserialize(n) }
//     return await wallet.signTransaction(r)
// — i.e. the PAGE side already handles v0 both ways, and `.serialize()` works on
// both models. So the wall is the C# wrapper, not the browser. Going straight to the
// page global carries v0 end to end with no new transaction model in Unity.
//
// ⛔ THE WALLET NAME PROBLEM, STATED HONESTLY. The lib's sign entry points take the
// wallet's NAME, and it exposes NO accessor for the connected one (its adapter array
// is module-private — read in the bundle, 2026-09-22). The SDK keeps the name in a
// PRIVATE STATIC (`_currentWallet`, SolanaWalletAdapterWebGL.cs:53) with no getter.
// So this file CAPTURES it at the only moment it is observable: the lib's own
// connectWallet call. EoaWalletBridgeInstall() must run BEFORE the SDK loads the CDN
// script; it installs an accessor property on window.walletAdapterLib, so the CDN's
// own `window.walletAdapterLib = N` assignment lands in our setter and we wrap
// connectWallet on the way through. If the global already exists we wrap in place.
//
// ⛔ AND WHEN THE NAME IS UNKNOWN WE REFUSE. There is deliberately NO fallback that
// tries wallets in turn to see which one answers: a pay path must never guess which
// wallet to ask. An xNFT host needs no name at all and is tried first.
//
// SHAPE: begin / poll / result / release, not a callback. A polled handle needs no
// delegate marshalling and no GameObject, and it lets the C# side apply its own
// deadline — which is what turns "the sheet never came back" into a reported
// refusal instead of a hang.
// =============================================================================
mergeInto(LibraryManager.library, {

  $EoaWalletBridgeState: {
    installed: false,
    walletName: null,
    nextHandle: 1,
    slots: {},
  },

  // Returns 1 when the capture hook is in place (or already was), 0 when it could
  // not be installed. Never throws into Unity.
  EoaWalletBridgeInstall__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeInstall: function () {
    var S = EoaWalletBridgeState;
    try {
      if (S.installed) return 1;

      var wrap = function (lib) {
        if (!lib || lib.__eoaWrapped) return lib;
        var original = lib.connectWallet;
        if (typeof original === 'function') {
          lib.connectWallet = function (name) {
            try { S.walletName = name; } catch (e) {}
            return original.apply(lib, arguments);
          };
        }
        try { lib.__eoaWrapped = true; } catch (e) {}
        return lib;
      };

      if (window.walletAdapterLib) {
        wrap(window.walletAdapterLib);
      } else {
        var stored;
        Object.defineProperty(window, 'walletAdapterLib', {
          configurable: true,
          enumerable: true,
          get: function () { return stored; },
          set: function (v) { stored = wrap(v); },
        });
      }
      S.installed = true;
      return 1;
    } catch (err) {
      console.error('[EoaWalletBridge] install failed: ' + (err && err.message));
      return 0;
    }
  },

  // The captured wallet name, or an empty string. Read for diagnostics and for the
  // refusal message when it is missing.
  EoaWalletBridgeWalletName__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeWalletName: function () {
    var S = EoaWalletBridgeState;
    var name = (window.xnft && window.xnft.solana) ? 'XNFT' : (S.walletName || '');
    var size = lengthBytesUTF8(name) + 1;
    var ptr = _malloc(size);
    stringToUTF8(name, ptr, size);
    return ptr;
  },

  // Start a signature. Returns a handle > 0, or 0 when the request could not even
  // be started (no host, no captured wallet name).
  EoaWalletBridgeSignBegin__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeSignBegin: function (txPtr) {
    var S = EoaWalletBridgeState;
    var handle = S.nextHandle++;
    var slot = { state: 0, value: '' };   // 0 pending, 1 done, 2 error
    S.slots[handle] = slot;
    try {
      var base64 = UTF8ToString(txPtr);
      var signer;
      var reownSigned = false;
      // ⛔ WO-1958: THE JUPITER ARM COMES FIRST, AND IT HAS TO.
      // On the Jupiter path WebGLWalletProvider.Connect returns BEFORE the Solana
      // SDK adapter is built, so `window.walletAdapterLib` never loads and
      // `S.walletName` is never captured — the two arms below would both miss and
      // this would refuse with "the connected wallet name was never captured",
      // which would be true and completely misleading. The Reown provider is the
      // signer for that session, so it is asked first.
      // The bundle returns base64 (it owns the web3.js that can deserialise a v0),
      // so this arm is base64-in / base64-out and needs the re-serialise below
      // SKIPPED — hence `reownSigned`.
      if (window.eoaWalletConnect && window.eoaWalletConnect.canSign &&
          window.eoaWalletConnect.canSign()) {
        reownSigned = true;
        signer = window.eoaWalletConnect.signTransactionBase64(base64);
      } else if (window.xnft && window.xnft.solana && window.xnft.solana.signTransaction) {
        // The xNFT host takes a transaction OBJECT. getTransactionFromStr was read
        // in the bundle 2026-09-22 and carries the same legacy/v0 fallback pair, so
        // an opaque v0 survives this branch too.
        signer = Promise.resolve().then(function () {
          var tx = window.walletAdapterLib.getTransactionFromStr(base64);
          return window.xnft.solana.signTransaction(tx);
        });
      } else if (window.walletAdapterLib && S.walletName) {
        signer = window.walletAdapterLib.signTransaction(S.walletName, base64);
      } else {
        slot.state = 2;
        slot.value = window.walletAdapterLib
          ? 'the connected wallet name was never captured - call EoaWalletBridgeInstall before connecting'
          : 'the browser wallet bridge is not loaded';
        return handle;
      }
      Promise.resolve(signer).then(function (signed) {
        if (!signed) {
          slot.state = 2;
          slot.value = 'the wallet returned no signed transaction (cancelled or refused)';
          return;
        }
        // The Reown arm already returned BASE64 (it serialises inside the bundle,
        // where the web3.js that can handle a v0 actually lives), so re-serialising
        // it here would call .serialize() on a string and throw.
        if (reownSigned) {
          slot.value = String(signed);
          slot.state = 1;
          return;
        }
        // .serialize() is defined on BOTH Transaction and VersionedTransaction in
        // the page's web3.js, which is what makes this arm version-agnostic.
        slot.value = Buffer.from(signed.serialize()).toString('base64');
        slot.state = 1;
      }).catch(function (err) {
        slot.state = 2;
        slot.value = (err && err.message) ? err.message : 'the wallet refused the signature';
      });
    } catch (err) {
      slot.state = 2;
      slot.value = (err && err.message) ? err.message : 'sign could not be started';
    }
    return handle;
  },

  // 0 pending, 1 done, 2 error, 3 unknown handle.
  EoaWalletBridgeSignPoll__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeSignPoll: function (handle) {
    var S = EoaWalletBridgeState;
    var slot = S.slots[handle];
    if (!slot) return 3;
    return slot.state;
  },

  // The signed base64 when poll said 1, the error text when it said 2.
  EoaWalletBridgeSignResult__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeSignResult: function (handle) {
    var S = EoaWalletBridgeState;
    var slot = S.slots[handle];
    var value = slot ? String(slot.value || '') : '';
    var size = lengthBytesUTF8(value) + 1;
    var ptr = _malloc(size);
    stringToUTF8(value, ptr, size);
    return ptr;
  },

  EoaWalletBridgeSignRelease__deps: ['$EoaWalletBridgeState'],
  EoaWalletBridgeSignRelease: function (handle) {
    var S = EoaWalletBridgeState;
    delete S.slots[handle];
  },

  // ===========================================================================
  // WO-1957 — the mobile-browser wallet handoff.
  //
  // ⛔ WHY THIS IS A SEPARATE DOOR AND NOT A FIX TO THE SDK'S PICKER. The CDN
  // bundle ALREADY holds the Solflare universal link and already fires it on the
  // owner's browser (its gate is `ua.includes("iphone") && ua.includes("safari")`,
  // and iOS Chrome's UA ends `Safari/604.1`). But that connect() arm is
  // `return void(...)`, so the bundle returns undefined, so
  // SolanaWalletAdapterWebGL.jslib throws and OnWalletConnected(null) raises
  // `Login cancelled` (SolanaWalletAdapterWebGL.cs:198) — MEASURED in the owner's
  // iPhone session, web_trace wt-a73bdc1d3350, 2026-09-22 12:12:26Z. A REDIRECT AND
  // A CANCEL ARE INDISTINGUISHABLE TO THAT CODE. So C# asks the page FIRST, and only
  // opens the picker when a picker can actually help.
  //
  // Every entry point degrades to a refusal when wallet-handoff.js is absent: a
  // cached older template must never abort a newer runtime.
  // ===========================================================================

  // JSON: {mobile, injected, injectedName, framed, returned, targets}. '{}' when the
  // page module is missing, which the C# side reads as "no opinion — use the picker".
  EoaWalletHandoffCapability: function () {
    var json = '{}';
    try {
      if (window.eoaWalletHandoff && window.eoaWalletHandoff.capabilityJson) {
        json = String(window.eoaWalletHandoff.capabilityJson() || '{}');
      }
    } catch (err) {
      console.error('[EoaWalletHandoff] capability failed: ' + (err && err.message));
    }
    var size = lengthBytesUTF8(json) + 1;
    var ptr = _malloc(size);
    stringToUTF8(json, ptr, size);
    return ptr;
  },

  // 1 when a navigation was STARTED. Never 1 on a guess: the module returns false
  // when it has no deeplink for that target, and Jupiter deliberately has none.
  EoaWalletHandoffOpen: function (idPtr) {
    try {
      var id = UTF8ToString(idPtr);
      if (!window.eoaWalletHandoff || !window.eoaWalletHandoff.open) {
        console.error('[EoaWalletHandoff] open refused: wallet-handoff.js is not loaded');
        return 0;
      }
      return window.eoaWalletHandoff.open(id) ? 1 : 0;
    } catch (err) {
      console.error('[EoaWalletHandoff] open failed: ' + (err && err.message));
      return 0;
    }
  },

  // ===========================================================================
  // WO-1958 — the JUPITER MOBILE door (Reown / WalletConnect).
  //
  // ⭐ WHAT IS PROVEN, so nobody re-derives it and nobody softens it either.
  // Jupiter Mobile IS a registered WalletConnect wallet — explorer entry
  // `0ef262ca2a56b88d179c93a21383fee4e135bd7bc6680e5c2356ff8e38301037`,
  // `"mobile":{"native":"jupiter://","universal":null}`, sdks `sign_v1`+`sign_v2`,
  // chain `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (queried 2026-09-22). Reown
  // AppKit turns that into a SAME-DEVICE deeplink: CoreHelperUtil.formatNativeUrl
  // builds `jupiter://wc?uri=<encoded>` and w3m-connecting-wc-mobile calls
  // `openHref(redirect, isIframe() ? '_top' : '_self')`. So WO-1957 section 1g's
  // "not claimed, and the docs point the other way" is CORRECTED: the mechanism
  // exists and it is the one Jupiter's own React adapter drives.
  //
  // ⚠ AND WHAT IS NOT PROVEN: that iOS Chrome actually launches a custom scheme
  // with no universal link to fall back on, and that this WebGL tab survives the
  // app switch. Both are owner-device facts, not readable from here.
  //
  // ⛔ THE BUNDLE IS INJECTED HERE, NOT LOADED BY THE PAGE. AppKit + the Solana
  // adapter + a WalletConnect provider is multi-megabyte, and this page already
  // dies at loader 90% on iOS Safari from payload alone. Boot cost stays zero;
  // the bytes are fetched on the connect tap.
  //
  // Same begin/poll/result/release handle shape as the sign path above: the C#
  // side keeps its own deadline, which is what turns "the sheet never came back"
  // into a reported refusal instead of a hang.
  // ===========================================================================

  // 1 when the bundle is loaded and usable, 0 when it is absent. Distinguishing
  // "never loaded" from "loaded and refused" is the point - they get different
  // sentences in front of the player.
  EoaJupiterAvailable: function () {
    try {
      return (window.eoaWalletConnect && window.eoaWalletConnect.available &&
              window.eoaWalletConnect.available()) ? 1 : 0;
    } catch (err) { return 0; }
  },

  // 1 when a Reown projectId reached the page (reown-config.js is generated by
  // `npm run web:bundle` from the gitignored reown.config.json). 0 means the door
  // will refuse with reason=no-project-id, and the C# side says so BEFORE opening
  // anything rather than after.
  EoaJupiterConfigured: function () {
    try {
      if (window.eoaWalletConnect && window.eoaWalletConnect.projectIdConfigured) {
        return window.eoaWalletConnect.projectIdConfigured() ? 1 : 0;
      }
      return (typeof window.EOA_REOWN_PROJECT_ID === 'string' &&
              window.EOA_REOWN_PROJECT_ID !== '') ? 1 : 0;
    } catch (err) { return 0; }
  },

  // Start the connect. Returns a handle > 0 ALWAYS - even a refusal gets a handle,
  // so the C# side reads one uniform result channel and never has to interpret a 0.
  EoaJupiterConnectBegin__deps: ['$EoaWalletBridgeState'],
  EoaJupiterConnectBegin: function (walletPtr) {
    var S = EoaWalletBridgeState;
    var handle = S.nextHandle++;
    var slot = { state: 0, value: '' };   // 0 pending, 1 done, 2 error
    S.slots[handle] = slot;
    try {
      var wallet = UTF8ToString(walletPtr) || 'jupiter';

      var run = function () {
        var started;
        try {
          started = window.eoaWalletConnect.connect(wallet);
        } catch (err) {
          started = Promise.resolve({ state: 'refused', reason: 'failed',
                                      detail: (err && err.message) || 'connect threw' });
        }
        Promise.resolve(started).then(function (snap) {
          snap = snap || {};
          // ⛔ NEVER A BARE FAILURE. Every outcome carries its reason code, because
          // the whole of WO-1957 is that a redirect and a cancel arriving as the
          // same sentence cost the owner a day.
          slot.value = JSON.stringify(snap);
          slot.state = (snap.state === 'connected' && snap.address) ? 1 : 2;
        }).catch(function (err) {
          slot.value = JSON.stringify({ state: 'refused', reason: 'failed',
                                        detail: (err && err.message) || 'connect rejected' });
          slot.state = 2;
        });
      };

      if (window.eoaWalletConnect && window.eoaWalletConnect.connect) {
        run();
        return handle;
      }

      // Lazy-load, then run. A load failure is a NAMED refusal, not a hang.
      var el = document.createElement('script');
      el.src = 'wallet-connect.bundle.js';
      el.async = true;
      el.onload = function () {
        if (window.eoaWalletConnect && window.eoaWalletConnect.connect) { run(); return; }
        slot.value = JSON.stringify({ state: 'refused', reason: 'no-bundle',
          detail: 'wallet-connect.bundle.js loaded but published no eoaWalletConnect global' });
        slot.state = 2;
      };
      el.onerror = function () {
        slot.value = JSON.stringify({ state: 'refused', reason: 'no-bundle',
          detail: 'wallet-connect.bundle.js is not on this build - run `npm run web:bundle` ' +
                  'and commit the artifact before shipping the Jupiter door' });
        slot.state = 2;
      };
      document.head.appendChild(el);
    } catch (err) {
      slot.value = JSON.stringify({ state: 'refused', reason: 'failed',
                                    detail: (err && err.message) || 'connect could not be started' });
      slot.state = 2;
    }
    return handle;
  },

  // 0 pending, 1 done, 2 error, 3 unknown handle - identical to the sign path so
  // there is ONE polling contract in this file, not two.
  EoaJupiterConnectPoll__deps: ['$EoaWalletBridgeState'],
  EoaJupiterConnectPoll: function (handle) {
    var S = EoaWalletBridgeState;
    var slot = S.slots[handle];
    if (!slot) return 3;
    return slot.state;
  },

  // The snapshot JSON: {state, reason, address, detail, projectId}. Present for
  // BOTH poll==1 and poll==2, which is why the C# side always has a reason code.
  EoaJupiterConnectResult__deps: ['$EoaWalletBridgeState'],
  EoaJupiterConnectResult: function (handle) {
    var S = EoaWalletBridgeState;
    var slot = S.slots[handle];
    var value = slot ? String(slot.value || '{}') : '{}';
    var size = lengthBytesUTF8(value) + 1;
    var ptr = _malloc(size);
    stringToUTF8(value, ptr, size);
    return ptr;
  },

  EoaJupiterConnectRelease__deps: ['$EoaWalletBridgeState'],
  EoaJupiterConnectRelease: function (handle) {
    var S = EoaWalletBridgeState;
    delete S.slots[handle];
  },

  // ===========================================================================
  // WO-2037 add-on — MESSAGE signing through the Jupiter (Reown) session.
  //
  // ⛔ MEASURED DEFECT (owner iPhone, live build 385039, 2026-09-25): after a
  // successful Jupiter connect, `[Flow:Wallet] MintSessionAsync aborted (no signer)
  // why=explicit-connect`, then Order Chat "Sign in with your wallet". The C#
  // provider could only sign messages through the Magicblock `_adapter`, which the
  // Jupiter door never builds. These two entries give it the Reown provider's
  // signMessage instead.
  //
  // Result channel: the SAME slots and the SAME EoaWalletBridgeSignPoll /
  // EoaWalletBridgeSignResult / EoaWalletBridgeSignRelease as the transaction
  // path — one polling contract in this file. Value on success = BASE64 of the raw
  // signature bytes (C# base58-encodes). ⛔ Never logs the message or signature.
  // ===========================================================================

  // 1 when a Reown/WalletConnect provider is connected and exposes signMessage.
  EoaJupiterCanSignMessage: function () {
    try {
      return (window.eoaWalletConnect && window.eoaWalletConnect.canSignMessage &&
              window.eoaWalletConnect.canSignMessage()) ? 1 : 0;
    } catch (err) { return 0; }
  },

  EoaJupiterSignMessageBegin__deps: ['$EoaWalletBridgeState'],
  EoaJupiterSignMessageBegin: function (textPtr) {
    var S = EoaWalletBridgeState;
    var handle = S.nextHandle++;
    var slot = { state: 0, value: '' };   // 0 pending, 1 done, 2 error
    S.slots[handle] = slot;
    try {
      var text = UTF8ToString(textPtr);
      if (!window.eoaWalletConnect || !window.eoaWalletConnect.signMessageBase64) {
        slot.state = 2;
        slot.value = 'wallet-connect.bundle.js is not loaded, so there is no Jupiter session to sign with';
        return handle;
      }
      Promise.resolve(window.eoaWalletConnect.signMessageBase64(text)).then(function (b64) {
        if (!b64) {
          slot.state = 2;
          slot.value = 'the wallet returned no signature (cancelled or refused)';
          return;
        }
        slot.value = String(b64);
        slot.state = 1;
      }).catch(function (err) {
        slot.state = 2;
        slot.value = (err && err.message) ? err.message : 'the wallet refused to sign the message';
      });
    } catch (err) {
      slot.state = 2;
      slot.value = (err && err.message) ? err.message : 'message sign could not be started';
    }
    return handle;
  },

  // The wallet id we came back FROM, or ''. Read off `?eoaWallet=` at page load,
  // because the wallet's in-app browser is a different browsing context and
  // sessionStorage does not travel.
  EoaWalletHandoffReturn: function () {
    var id = '';
    try {
      if (window.eoaWalletHandoff && window.eoaWalletHandoff.returned) {
        id = String(window.eoaWalletHandoff.returned() || '');
      }
    } catch (err) { id = ''; }
    var size = lengthBytesUTF8(id) + 1;
    var ptr = _malloc(size);
    stringToUTF8(id, ptr, size);
    return ptr;
  },
});
