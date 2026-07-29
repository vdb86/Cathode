// SPDX-License-Identifier: GPL-3.0-or-later
// Network configuration: an optional user proxy and custom DNS-over-HTTPS (DoH)
// resolver, from Settings > Network. Persisted per account in ui_settings.json
// (proxyEnabled / proxyServer / proxyBypass / dohEnabled / dohServer).
//
// Coverage of the three mechanisms:
//   - session.defaultSession.setProxy  -> ALL Chromium traffic: the renderer's
//     video-stream (googlevideo) fetches, the offscreen PoToken window, and any
//     electron net requests. Supports http, https and socks proxies.
//   - undici setGlobalDispatcher(ProxyAgent) -> the MAIN-process global fetch()
//     that youtubei.js uses for feeds/metadata. undici's ProxyAgent handles
//     http(s) proxies only (socks is applied to the Chromium side but not here).
//   - app.configureHostResolver -> Chromium's DNS, so the DoH server governs
//     stream-side name resolution.
//
// Nothing here changes default behaviour: with the feature off we reset the
// session to a direct connection, clear the undici dispatcher, and put the host
// resolver back to automatic.

const { app, session } = require('electron');
const fs = require('fs');
const logger = require('./logger');
const activeaccount = require('./activeaccount');

let undici = null;
try { undici = require('undici'); } catch (e) { undici = null; }
let defaultDispatcher = null; // undici's original dispatcher, restored when off

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(activeaccount.file('ui_settings.json'), 'utf8'));
    return {
      proxyEnabled: !!s.proxyEnabled,
      proxyServer: String(s.proxyServer || '').trim(),
      proxyBypass: String(s.proxyBypass || '').trim(),
      dohEnabled: !!s.dohEnabled,
      dohServer: String(s.dohServer || '').trim()
    };
  } catch (e) {
    return { proxyEnabled: false, proxyServer: '', proxyBypass: '', dohEnabled: false, dohServer: '' };
  }
}

function proxyActive(s) { return s.proxyEnabled && !!s.proxyServer; }
function isSocks(server) { return /^socks/i.test(server); }

// True when the user has configured a proxy or a custom DoH resolver. Callers
// (innertube.js) use this to route their fetches through Electron's net stack
// so the proxy + DNS apply to feeds too, not just Chromium-side stream traffic.
function isActive(s) { s = s || readSettings(); return proxyActive(s) || (s.dohEnabled && !!s.dohServer); }

// Apply the proxy to Chromium (all sessions we own).
async function applyChromiumProxy(s) {
  const sess = session.defaultSession;
  if (!sess) return;
  try {
    if (proxyActive(s)) {
      await sess.setProxy({ proxyRules: s.proxyServer, proxyBypassRules: s.proxyBypass || undefined });
      logger.info('[network] Chromium proxy set:', s.proxyServer);
    } else {
      await sess.setProxy({ mode: 'direct' });
    }
  } catch (e) { logger.error('[network] setProxy failed:', e && e.message); }
}

// Apply the proxy to the main-process global fetch (youtubei.js) via undici.
// http(s) only; a socks proxy still covers the Chromium/stream side above.
function applyMainProxy(s) {
  if (!undici || !undici.setGlobalDispatcher) return;
  try {
    if (defaultDispatcher == null && undici.getGlobalDispatcher) defaultDispatcher = undici.getGlobalDispatcher();
    if (proxyActive(s) && !isSocks(s.proxyServer)) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(s.proxyServer));
      logger.info('[network] main fetch proxy set (undici):', s.proxyServer);
    } else {
      if (defaultDispatcher) undici.setGlobalDispatcher(defaultDispatcher);
      if (proxyActive(s) && isSocks(s.proxyServer)) logger.info('[network] socks proxy applied to streams only (main fetch stays direct)');
    }
  } catch (e) { logger.error('[network] undici proxy failed:', e && e.message); }
}

// Apply the custom DNS-over-HTTPS resolver to Chromium.
function applyDoh(s) {
  if (typeof app.configureHostResolver !== 'function') return;
  try {
    if (s.dohEnabled && s.dohServer) {
      app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [s.dohServer] });
      logger.info('[network] DoH resolver set:', s.dohServer);
    } else {
      app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: [] });
    }
  } catch (e) { logger.error('[network] configureHostResolver failed:', e && e.message); }
}

// Read the active account's settings and apply all three mechanisms. Safe to
// call at startup and again whenever the settings or active account change.
async function apply() {
  const s = readSettings();
  await applyChromiumProxy(s);
  applyMainProxy(s);
  applyDoh(s);
  return { ok: true, proxy: proxyActive(s), doh: !!(s.dohEnabled && s.dohServer) };
}

module.exports = { apply, readSettings, isActive };
