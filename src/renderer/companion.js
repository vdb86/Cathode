// SPDX-License-Identifier: GPL-3.0-or-later
// Companion remote command dispatch (renderer side). Receives authed phone
// commands the main process forwards over window.tv.onCompanionCommand and
// executes them through the SAME paths on-device input uses. v1 is "controller
// + now-playing"; this is the CONTROLLER half (Phase 2: nav / section / text /
// transport / act). Phase 3 adds open + openList; Phase 4 broadcasts state back.
//
// Wired by app.js via initCompanion(deps) so the player / feed / search
// functions stay owned by app.js (same injection pattern as initVideoMenu etc.).

// Phone nav keys -> the 'tvinput' CustomEvent actions the app.js router handles.
const NAV = { up: 'up', down: 'down', left: 'left', right: 'right', ok: 'select', back: 'back', menu: 'longpress' };

let deps = {};

// Extract an 11-char YouTube video id from a bare id or any share URL
// (watch?v=, youtu.be/, /shorts/, /embed/, /live/). Falls back to the first
// id-shaped run in the string.
function parseVideoId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') { const id = u.pathname.slice(1).split('/')[0]; if (/^[\w-]{11}$/.test(id)) return id; }
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  } catch { /* not a URL */ }
  const m = s.match(/[\w-]{11}/);
  return m ? m[0] : null;
}

function fire(action) { window.dispatchEvent(new CustomEvent('tvinput', { detail: { action } })); }
function nav(key, long) {
  if (key === 'ok' && long) return fire('longpress');
  const action = NAV[key];
  if (action) fire(action);
}

function transport(cmd, value) {
  const t = deps.transport || {};
  const fn = t[cmd];
  if (typeof fn === 'function') fn(value);
}

function act(cmd) {
  const a = deps.act || {};
  if (typeof a[cmd] === 'function') a[cmd]();
}

function trackCmd(msg) {
  const tk = deps.track || {};
  if (msg.kind === 'caption') {
    if (msg.off) return tk.caption && tk.caption(0);           // off
    if (msg.index != null) return tk.caption && tk.caption(Number(msg.index) || 0); // 0=off, 1..N
    return tk.captionToggle && tk.captionToggle();             // no index -> toggle
  }
  if (msg.kind === 'audio') return tk.audio && tk.audio(msg.id || msg.code); // language code
  if (msg.kind === 'quality') return tk.quality && tk.quality(msg.id != null ? msg.id : msg.value); // 'auto' | height
}

function handle(t, msg) {
  msg = msg || {};
  try {
    switch (t) {
      case 'nav': return nav(msg.key, msg.long);
      case 'section': return deps.section && deps.section(msg.name);
      case 'profile': return deps.switchProfile && deps.switchProfile(msg.id);
      case 'text': return deps.search && deps.search(msg.value, msg.submit);
      case 'edit': return deps.edit && deps.edit(msg.op);
      case 'transport': return transport(msg.cmd, msg.value);
      case 'act': return act(msg.cmd);
      case 'track': return trackCmd(msg);
      case 'sync': { lastStateSig = ''; lastQueueSig = ''; report(); return; } // phone asked for a fresh push
      case 'open': {
        const id = parseVideoId(msg.videoId || msg.url);
        if (!id) return;
        if (msg.mode === 'queue') return deps.queue && deps.queue(id);
        return deps.playNow && deps.playNow(id, msg.profileId);
      }
      case 'openList': {
        if (msg.kind === 'search') return deps.search && deps.search(msg.query || msg.id, true);
        if (msg.kind === 'channel') return deps.openChannel && deps.openChannel(msg.id, msg.name);
        if (msg.kind === 'playlist') return deps.openPlaylist && deps.openPlaylist(msg.id, msg.name);
        return;
      }
      // track (caption/audio/quality) = later. Unknown types are ignored.
    }
  } catch (e) { /* a malformed command must never break the app */ }
}

// ---- state broadcast TV -> phone (Phase 4) ----
// Poll once a second and push what changed: full `state` on a key change,
// `position` every tick while a video is loaded, `queue` on a change. Gated on
// hasClients so nothing is built when no phone is connected.
let hasClients = false;
let lastClients = 0;
let reportTimer = null;
let lastStateSig = '';
let lastQueueSig = '';
const r0 = (n) => Math.round(Number(n) || 0);
function pushOut(method, payload) { try { if (window.tv && window.tv[method]) window.tv[method](payload); } catch { /* ignore */ } }

function report() {
  if (!hasClients || typeof deps.getStatus !== 'function') return;
  let st; try { st = deps.getStatus(); } catch { return; }
  if (!st) return;
  const np = st.nowPlaying || null;
  const cap = st.captions || null, aud = st.audio || null, qual = st.quality || null;
  const sb = st.sponsorblock || null;
  const sig = [
    st.mode, st.bgPlaying ? 1 : 0,
    np ? np.videoId : '', np ? (np.paused ? 1 : 0) : '', np ? r0(np.duration) : '', np ? (np.speed || 1) : '',
    cap ? (cap.on ? 1 : 0) + ':' + (cap.index || 0) : '', aud ? (aud.current || '') : '', qual ? (qual.current || '') : '',
    sb ? (sb.enabled ? 1 : 0) : ''
  ].join('|');
  if (sig !== lastStateSig) {
    lastStateSig = sig;
    pushOut('companionState', { mode: st.mode, bgPlaying: !!st.bgPlaying, nowPlaying: np, captions: cap, audio: aud, quality: qual, sponsorblock: sb });
  }
  if (np) pushOut('companionPosition', { position: r0(np.position), duration: r0(np.duration), paused: !!np.paused });
  const q = st.queue || [];
  const qsig = q.map((x) => x.videoId).join(',');
  if (qsig !== lastQueueSig) { lastQueueSig = qsig; pushOut('companionQueue', { items: q, index: 0 }); }
}

export function initCompanion(d) {
  deps = d || {};
  if (window.tv && window.tv.onCompanionCommand) {
    window.tv.onCompanionCommand((m) => { if (m && m.t) handle(m.t, m.msg); });
  }
  if (window.tv && window.tv.onCompanionClients) {
    window.tv.onCompanionClients((n) => {
      const c = Number(n) || 0;
      hasClients = c > 0;
      // Any INCREASE (incl. a 2nd concurrent phone) resets the change signatures
      // and pushes current state immediately, so a freshly connected phone gets
      // now-playing + queue without waiting for the next change.
      if (c > lastClients) { lastStateSig = ''; lastQueueSig = ''; report(); }
      lastClients = c;
    });
  }
  if (!reportTimer) reportTimer = setInterval(report, 1000);
}
