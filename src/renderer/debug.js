// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer-side debug capture. Loaded as a classic script BEFORE app.js so the
// error hooks are in place for the earliest failures.
//
// Two tiers:
//   Always on  - uncaught errors, unhandled promise rejections, and console.error
//                / console.warn are forwarded to couchtube.log. These are rare and
//                are exactly what a crash report needs.
//   Debug only - console.log / console.info are ALSO mirrored to the log, so a
//                debug session captures the full renderer chatter. Toggled live by
//                the About settings switch via window.CTDebug.setEnabled().
//
// The native console still prints as normal; we only ADD a forward to the file.
(function () {
  var tv = window.tv || {};
  var mirrorLogs = false; // console.log/info mirroring (debug mode)

  function send(fn, parts) {
    try {
      var msg = parts.map(function (a) {
        if (a instanceof Error) return (a.stack || a.message);
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      }).join(' ');
      if (fn) fn(msg.slice(0, 4000));
    } catch (e) { /* logging must never throw */ }
  }

  // Uncaught errors + rejections (always).
  window.addEventListener('error', function (e) {
    if (e && e.error) send(tv.logError, ['[window.onerror]', e.error, '@', (e.filename || '') + ':' + (e.lineno || '')]);
    else if (e) send(tv.logError, ['[window.onerror]', e.message || 'error', '@', (e.filename || '') + ':' + (e.lineno || '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e ? e.reason : null;
    send(tv.logError, ['[unhandledrejection]', r || 'unknown']);
  });

  // Wrap console methods, preserving the native behaviour.
  var native = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.error = function () { var a = [].slice.call(arguments); native.error.apply(console, a); send(tv.logError, ['[console.error]'].concat(a)); };
  console.warn = function () { var a = [].slice.call(arguments); native.warn.apply(console, a); send(tv.logError, ['[console.warn]'].concat(a)); };
  console.log = function () { var a = [].slice.call(arguments); native.log.apply(console, a); if (mirrorLogs) send(tv.logDebug, ['[console.log]'].concat(a)); };
  console.info = function () { var a = [].slice.call(arguments); native.info.apply(console, a); if (mirrorLogs) send(tv.logDebug, ['[console.info]'].concat(a)); };

  window.CTDebug = {
    setEnabled: function (on) { mirrorLogs = !!on; },
    isEnabled: function () { return mirrorLogs; }
  };

  // Sync the initial mirror state from the persisted main-side flag.
  if (tv.debugGet) {
    try { tv.debugGet().then(function (r) { mirrorLogs = !!(r && r.enabled); }).catch(function () {}); } catch (e) {}
  }
})();
