// SPDX-License-Identifier: GPL-3.0-or-later
// Companion command server (CouchTube side). A LAN WebSocket server that the
// phone "CouchTube Remote" app pairs with to drive the app: navigation,
// playback, text entry, link-share, and a now-playing / queue readout streamed
// back. v1 is "controller + now-playing" (the phone does NOT browse the
// library). Full wire protocol + phases live in PLANS.md "Companion command
// server". Opt-in: only started when the global companionEnabled pref is on.
//
// Dependencies (run npm install): "ws" (WebSocket server) and "bonjour-service"
// (mDNS advertising). Both are required lazily inside start()/advertiseMdns() so
// a missing module surfaces as a logged error rather than crashing app boot.
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const logger = require('./logger');

const DEFAULT_PORT = 8878;
const PIN_TTL_MS = 3 * 60 * 1000; // pairing PIN lifetime (single-use as well)
const PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_VERSION = 1;   // oldest phone protocol we still accept
const MAX_PAYLOAD = 64 * 1024;     // reject oversized frames (memory abuse guard)
const MAX_SOCKETS = 8;             // cap concurrent connections
const HEARTBEAT_MS = 30000;        // ping idle sockets; reap the unresponsive
const CMD_WINDOW_MS = 10000;       // rate-limit window
const CMD_MAX = 300;               // max messages per window per socket
const PAIR_FAIL_MAX = 5;           // wrong-PIN attempts before dropping the socket
const MDNS_REANNOUNCE_MS = 30000;  // re-broadcast the mDNS record on this interval

// Accept connections only from LAN / private ranges - never a routable public
// peer. Covers IPv4 private + loopback/link-local, IPv6 loopback/ULA/link-local,
// and IPv4-mapped IPv6 (::ffff:a.b.c.d).
function isPrivateAddress(addr) {
  if (!addr) return false;
  let a = String(addr);
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) a = m[1];
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;              // IPv4 link-local
  if (/^fe80:/i.test(a) || /^f[cd]/i.test(a)) return true; // IPv6 link-local + ULA
  return false;
}

let wss = null;             // ws WebSocketServer
let heartbeat = null;       // ping/pong reaper interval
let bonjour = null;         // Bonjour instance
let mdnsService = null;
let mdnsTimer = null;       // periodic re-announce interval
let port = DEFAULT_PORT;
let tvName = 'CouchTube'; // default device name shown to phones; overridden by opts.tvName when the user sets one
let commandHandler = null;  // (type, msg, ctx) -> void; set by index.js (renderer bridge)
let onDeviceChangeCb = null;// () -> void; lets the UI refresh the paired/connected list
let onPairRequestCb = null; // (info) -> void; phone asked to pair -> TV shows the PIN
let pairing = null;         // { pin, expires } while pairing mode is active
const sockets = new Set();  // live ws connections; each carries ._ct = { authed, deviceId, name }

// ---- token store (Data/companion.json) --------------------------------------
function storeFile() { return path.join(app.getPath('userData'), 'companion.json'); }
function loadStore() {
  try { const s = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); if (s && Array.isArray(s.devices)) return s; }
  catch { /* absent / unreadable: fresh store */ }
  return { devices: [] };
}
function saveStore(s) {
  try { fs.writeFileSync(storeFile(), JSON.stringify(s)); }
  catch (e) { logger.error('[companion] store write failed:', e && e.message); }
}
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// Only the SHA-256 of each device token is persisted; the raw token lives only
// on the phone. Match is timing-safe (hex hashes are always equal length).
function tokenMatches(token) {
  const h = sha256(token || '');
  for (const d of loadStore().devices) {
    try {
      if (d.tokenHash && d.tokenHash.length === h.length &&
          crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(h))) return d;
    } catch { /* length mismatch: skip */ }
  }
  return null;
}

// ---- LAN address ------------------------------------------------------------
function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

// ---- pairing ----------------------------------------------------------------
function enterPairing() {
  const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  pairing = { pin, expires: Date.now() + PIN_TTL_MS };
  return pairingInfo();
}
function exitPairing() { pairing = null; }
function pairingActive() { return !!(pairing && pairing.expires > Date.now()); }
function pairingInfo() {
  const active = pairingActive();
  const host = lanIp();
  const pin = active ? pairing.pin : null;
  // QR payload the phone scans: host + port + one-time PIN.
  const qr = active ? ('couchtube://pair?host=' + host + '&port=' + port + '&pin=' + pin) : null;
  // ttlMs lets the TV pairing modal auto-close when the PIN expires.
  const ttlMs = active ? Math.max(0, pairing.expires - Date.now()) : 0;
  return { active, host, port, pin, qr, ttlMs, running: isRunning() };
}

// ---- devices ----------------------------------------------------------------
function connectedIds() {
  return new Set([...sockets].filter((s) => s._ct && s._ct.authed && s._ct.deviceId).map((s) => s._ct.deviceId));
}
function listDevices() {
  const conn = connectedIds();
  return loadStore().devices.map((d) => ({ id: d.id, name: d.name, paired: d.paired, connected: conn.has(d.id) }));
}
function unpair(id) {
  const store = loadStore();
  store.devices = store.devices.filter((d) => d.id !== id);
  saveStore(store);
  for (const s of sockets) { if (s._ct && s._ct.deviceId === id) { try { s.close(); } catch { /* already gone */ } } }
  fireDeviceChange();
  return listDevices();
}
// Revoke every paired device (and drop their live sockets).
function unpairAll() {
  saveStore({ devices: [] });
  for (const s of sockets) { try { s.close(1000, 'unpaired'); } catch { /* ignore */ } }
  fireDeviceChange();
  return [];
}
// One active connection per device: close any OTHER socket for the same device
// when it (re)pairs or re-auths, so reconnects don't leave ghosts.
function dropOtherSockets(keep, deviceId) {
  for (const s of sockets) {
    if (s !== keep && s._ct && s._ct.deviceId === deviceId) { try { s.close(1000, 'replaced'); } catch { /* ignore */ } }
  }
}
function fireDeviceChange() { if (typeof onDeviceChangeCb === 'function') { try { onDeviceChangeCb(); } catch { /* ignore */ } } }

// ---- send helpers -----------------------------------------------------------
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* socket closing */ } }
// Broadcast a state/queue/position message to every authenticated phone.
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const s of sockets) { if (s._ct && s._ct.authed) { try { s.send(data); } catch { /* skip */ } } }
}

// ---- message handling -------------------------------------------------------
function handleMessage(ws, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const t = msg && msg.t;
  if (!t) return;
  const st = ws._ct;

  // Rate limit: silently drop a socket that floods us (per-socket sliding window).
  const now = Date.now();
  if (now - st.cmdWindow > CMD_WINDOW_MS) { st.cmdWindow = now; st.cmdCount = 0; }
  if (++st.cmdCount > CMD_MAX) return;

  if (t === 'ping') return send(ws, { t: 'pong' });
  if (t === 'hello') {
    // Version negotiation: refuse a remote that needs a newer CouchTube.
    if (msg.minVersion && Number(msg.minVersion) > PROTOCOL_VERSION) {
      return send(ws, { t: 'error', code: 'version', message: 'This remote needs a newer CouchTube. Please update CouchTube.' });
    }
    return send(ws, { t: 'hello', tvName, version: PROTOCOL_VERSION, minVersion: MIN_SUPPORTED_VERSION, needsPair: !st.authed });
  }

  // Pre-auth: only pairing / auth are accepted.
  if (!st.authed) {
    // Phone-initiated pairing: the phone found us and the user tapped "Pair".
    // Mint a PIN (if pairing isn't already active) and ask the TV UI to display
    // it (onPairRequest brings the window to the front + fullscreen), then tell
    // the phone pairing is ready so it shows its PIN-entry screen. The phone
    // still has to submit the correct PIN via `pair`, so this cannot pair a
    // device on its own.
    if (t === 'pairRequest') {
      if (!pairingActive()) enterPairing();
      const info = pairingInfo();
      if (typeof onPairRequestCb === 'function') {
        try { onPairRequestCb(info); } catch (e) { logger.error('[companion] onPairRequest threw:', e && e.message); }
      }
      logger.info('[companion] pair requested by a phone; PIN shown on TV');
      return send(ws, { t: 'pairing', ok: true, ttlMs: info.ttlMs });
    }
    if (t === 'pair') {
      if (!pairingActive()) return send(ws, { t: 'error', code: 'pairing_off', message: 'Pairing is not active' });
      if (String(msg.pin || '') !== pairing.pin) {
        // Brute-force guard: drop the socket after too many wrong PINs.
        if (++st.pairFails >= PAIR_FAIL_MAX) {
          send(ws, { t: 'error', code: 'too_many', message: 'Too many attempts' });
          try { ws.close(1008, 'too many attempts'); } catch { /* ignore */ }
          return;
        }
        return send(ws, { t: 'error', code: 'bad_pin', message: 'Wrong PIN' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const device = {
        id: crypto.randomUUID(),
        name: String(msg.name || 'Phone').slice(0, 40),
        tokenHash: sha256(token),
        paired: Date.now()
      };
      const store = loadStore(); store.devices.push(device); saveStore(store);
      st.authed = true; st.deviceId = device.id; st.name = device.name;
      exitPairing(); // PIN is single-use
      dropOtherSockets(ws, device.id);
      logger.info('[companion] paired new device:', device.name);
      fireDeviceChange();
      return send(ws, { t: 'paired', token, tvName, version: PROTOCOL_VERSION });
    }
    if (t === 'auth') {
      const d = tokenMatches(msg.token);
      if (!d) return send(ws, { t: 'error', code: 'bad_token', message: 'Not paired' });
      st.authed = true; st.deviceId = d.id; st.name = d.name;
      dropOtherSockets(ws, d.id);
      logger.info('[companion] device authed:', d.name);
      fireDeviceChange();
      return send(ws, { t: 'authed', ok: true, tvName, version: PROTOCOL_VERSION });
    }
    return send(ws, { t: 'error', code: 'unauth', message: 'Authenticate first' });
  }

  // Authed: hand off to the command handler (renderer bridge, wired in index.js).
  if (typeof commandHandler === 'function') {
    try { commandHandler(t, msg, { reply: (o) => send(ws, o), device: { id: st.deviceId, name: st.name } }); }
    catch (e) { logger.error('[companion] command handler threw:', e && e.message); }
  }
}

// ---- lifecycle --------------------------------------------------------------
function start(opts) {
  opts = opts || {};
  if (wss) return true; // already running
  port = opts.port || DEFAULT_PORT;
  if (opts.tvName) tvName = opts.tvName;
  if (opts.onCommand) commandHandler = opts.onCommand;
  if (opts.onDeviceChange) onDeviceChangeCb = opts.onDeviceChange;
  if (opts.onPairRequest) onPairRequestCb = opts.onPairRequest;

  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); }
  catch (e) { logger.error('[companion] "ws" module missing - run npm install:', e && e.message); return false; }

  try {
    wss = new WebSocketServer({ port, maxPayload: MAX_PAYLOAD });
    wss.on('connection', (ws, req) => {
      const addr = req && req.socket && req.socket.remoteAddress;
      // LAN-only: refuse any non-private peer outright.
      if (!isPrivateAddress(addr)) { logger.error('[companion] rejected non-LAN connection from', addr); try { ws.close(1008, 'LAN only'); } catch { /* ignore */ } return; }
      // Cap concurrent connections.
      if (sockets.size >= MAX_SOCKETS) { try { ws.close(1013, 'Too many connections'); } catch { /* ignore */ } return; }
      ws._ct = { authed: false, deviceId: null, name: null, cmdWindow: Date.now(), cmdCount: 0, pairFails: 0 };
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      sockets.add(ws);
      ws.on('message', (data) => handleMessage(ws, data.toString()));
      ws.on('close', () => { sockets.delete(ws); fireDeviceChange(); });
      ws.on('error', () => { /* connection-level errors are non-fatal */ });
      send(ws, { t: 'hello', tvName, version: PROTOCOL_VERSION, minVersion: MIN_SUPPORTED_VERSION, needsPair: true });
    });
    wss.on('error', (e) => logger.error('[companion] server error:', e && e.message));
    // Heartbeat: ping every socket; terminate any that missed the previous pong.
    heartbeat = setInterval(() => {
      for (const ws of sockets) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS);
    logger.info('[companion] server listening on port', port);
  } catch (e) {
    logger.error('[companion] start failed:', e && e.message);
    wss = null;
    return false;
  }
  advertiseMdns();
  return true;
}

function advertiseMdns() {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
    mdnsService = bonjour.publish({
      name: tvName,
      type: 'couchtube',
      port,
      txt: { name: tvName, version: String(PROTOCOL_VERSION), port: String(port) }
    });
    logger.info('[companion] mDNS advertising _couchtube._tcp on port', port);
    // bonjour-service re-announces on an exponential backoff (1s, 3s, 9s ... up to
    // 1h), so after the first minute the gaps get large and a phone that starts
    // browsing late can miss the unsolicited announcement (it then depends on its
    // own query being answered). Send a fresh unsolicited announcement on a fixed
    // interval so late-joining phones pick the TV up within ~30s. This re-responds
    // with the SAME records (no goodbye / TTL-0), so it does not churn the entry.
    if (mdnsTimer) { clearInterval(mdnsTimer); mdnsTimer = null; }
    mdnsTimer = setInterval(() => {
      try {
        if (bonjour && bonjour.server && bonjour.server.mdns && mdnsService && typeof mdnsService.records === 'function') {
          bonjour.server.mdns.respond(mdnsService.records());
        }
      } catch (e) { /* transient mDNS respond error: ignore, next tick retries */ }
    }, MDNS_REANNOUNCE_MS);
    if (mdnsTimer.unref) mdnsTimer.unref();
  } catch (e) {
    logger.error('[companion] mDNS unavailable (bonjour-service missing?):', e && e.message);
  }
}

function stop() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (mdnsTimer) { clearInterval(mdnsTimer); mdnsTimer = null; }
  for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
  sockets.clear();
  if (mdnsService) { try { mdnsService.stop(); } catch { /* ignore */ } mdnsService = null; }
  if (bonjour) { try { bonjour.destroy(); } catch { /* ignore */ } bonjour = null; }
  if (wss) { try { wss.close(); } catch { /* ignore */ } wss = null; }
  pairing = null;
  logger.info('[companion] server stopped');
}

function isRunning() { return !!wss; }
function connectedCount() { return [...sockets].filter((s) => s._ct && s._ct.authed).length; }

module.exports = {
  start, stop, isRunning, connectedCount,
  enterPairing, exitPairing, pairingInfo,
  listDevices, unpair, unpairAll, broadcast
};
