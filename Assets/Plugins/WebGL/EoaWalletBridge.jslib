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
      if (window.xnft && window.xnft.solana && window.xnft.solana.signTransaction) {
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
});
