// Self-test for the companion server (src/main/companion.js) WITHOUT Electron.
// Stubs the 'electron' module (companion.js + logger.js only need app.getPath /
// isPackaged / getAppPath), starts the server on a test port, then drives a real
// ws client through the full handshake: hello -> pair -> command -> reconnect ->
// auth. Exercises pairing, single-use PIN, token auth, and command dispatch.
//
// Run:  node scripts/companion-selftest.js
const os = require('os');
const Module = require('module');

// ---- stub electron so companion.js / logger.js load outside Electron ----
const fakeElectron = {
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const companion = require('../src/main/companion');
const WebSocket = require('ws');

const PORT = 8799;
let savedToken = null;
let failed = false;
const log = (...a) => console.log(...a);
const fail = (m) => { failed = true; console.error('FAIL:', m); };

const started = companion.start({
  tvName: 'SelfTestTV',
  port: PORT,
  onCommand: (t, msg, ctx) => { log('  server got command:', t, JSON.stringify(msg)); ctx.reply({ t: 'ack', for: t }); }
});
if (!started) { fail('server did not start'); process.exit(1); }
const info = companion.enterPairing();
log('pairing info:', info);
if (!info.pin || !info.qr) fail('enterPairing did not return pin/qr');

// ---- client 1: pair, send a command, expect ack ----
const c1 = new WebSocket('ws://127.0.0.1:' + PORT);
c1.on('message', (d) => {
  const m = JSON.parse(d.toString());
  log('c1 <=', JSON.stringify(m));
  if (m.t === 'hello') c1.send(JSON.stringify({ t: 'pair', pin: info.pin, name: 'SelfTest Phone' }));
  else if (m.t === 'paired') {
    if (!m.token) fail('paired without token');
    savedToken = m.token;
    c1.send(JSON.stringify({ t: 'nav', key: 'up' }));
  } else if (m.t === 'ack') {
    if (m.for !== 'nav') fail('ack for wrong command');
    log('PASS: pair + command dispatch');
    c1.close();
    testReusePinRejected();
  } else if (m.t === 'error') fail('unexpected error on c1: ' + m.code);
});
c1.on('error', (e) => fail('c1 socket error: ' + e.message));

// ---- client 2: the PIN was single-use, so a fresh pair must be rejected ----
function testReusePinRejected() {
  const c2 = new WebSocket('ws://127.0.0.1:' + PORT);
  c2.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') c2.send(JSON.stringify({ t: 'pair', pin: info.pin, name: 'Intruder' }));
    else if (m.t === 'error' && m.code === 'pairing_off') { log('PASS: single-use PIN rejected reuse'); c2.close(); testAuthReconnect(); }
    else if (m.t === 'paired') { fail('reused PIN was accepted'); c2.close(); testAuthReconnect(); }
  });
  c2.on('error', (e) => fail('c2 socket error: ' + e.message));
}

// ---- client 3: reconnect with the saved token (no pairing) ----
function testAuthReconnect() {
  const c3 = new WebSocket('ws://127.0.0.1:' + PORT);
  c3.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') c3.send(JSON.stringify({ t: 'auth', token: savedToken }));
    else if (m.t === 'authed' && m.ok) {
      log('PASS: token reconnect authed');
      const devices = companion.listDevices();
      log('paired devices:', JSON.stringify(devices));
      if (devices.length !== 1) fail('expected exactly 1 paired device, got ' + devices.length);
      // Phase 4: a server-side broadcast must reach the authed socket.
      companion.broadcast({ t: 'state', mode: 'player', nowPlaying: { videoId: 'abc12345678', paused: false } });
    } else if (m.t === 'state') {
      if (m.mode === 'player' && m.nowPlaying && m.nowPlaying.videoId === 'abc12345678') log('PASS: state broadcast received');
      else fail('state broadcast payload wrong');
      c3.close();
      testVersionReject();
    } else if (m.t === 'error') fail('auth reconnect failed: ' + m.code);
  });
  c3.on('error', (e) => fail('c3 socket error: ' + e.message));
}

// ---- client 4: a remote needing a newer protocol is rejected ----
function testVersionReject() {
  const c4 = new WebSocket('ws://127.0.0.1:' + PORT);
  let asked = false, done = false;
  c4.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello' && !asked) { asked = true; return c4.send(JSON.stringify({ t: 'hello', minVersion: 99 })); }
    if (m.t === 'error' && m.code === 'version' && !done) { done = true; log('PASS: version negotiation rejects newer-only remote'); c4.close(); testPinBruteForce(); }
  });
  c4.on('error', (e) => fail('c4 socket error: ' + e.message));
}

// ---- client 5: too many wrong PINs drops the socket ----
function testPinBruteForce() {
  const info2 = companion.enterPairing(); // fresh PIN
  const wrong = info2.pin === '000000' ? '111111' : '000000';
  const c5 = new WebSocket('ws://127.0.0.1:' + PORT);
  let bad = 0, gotTooMany = false;
  c5.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') return c5.send(JSON.stringify({ t: 'pair', pin: wrong }));
    if (m.t === 'error' && m.code === 'bad_pin') { bad++; return c5.send(JSON.stringify({ t: 'pair', pin: wrong })); }
    if (m.t === 'error' && m.code === 'too_many') { gotTooMany = true; }
  });
  c5.on('close', () => {
    if (gotTooMany && bad >= 4) log('PASS: PIN brute-force capped after ' + bad + ' wrong tries');
    else fail('PIN brute-force not capped (bad=' + bad + ', tooMany=' + gotTooMany + ')');
    companion.exitPairing();
    finish();
  });
  c5.on('error', () => { /* close handler asserts */ });
}

function finish() {
  // clean up the paired device so repeat runs start fresh
  const d = companion.listDevices()[0];
  if (d) companion.unpair(d.id);
  companion.stop();
  log(failed ? '\n=== SELFTEST FAILED ===' : '\n=== SELFTEST PASSED ===');
  process.exit(failed ? 1 : 0);
}

setTimeout(() => { fail('timed out'); finish(); }, 8000);
