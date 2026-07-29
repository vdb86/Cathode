// SPDX-License-Identifier: GPL-3.0-or-later
// Playback stats overlay (the #player-stats panel: resolution, codecs, bitrate,
// dropped/decoded frames, buffer, player size, video id). Extracted from app.js
// (renderer ES-module split, s99). Reads live data from Shaka + the <video>.
// The active Shaka player and current video id are reassigned in app.js, so
// they're supplied as accessor functions via initStats (imported bindings can't
// be reassigned across modules).

import { $, show, hide } from './util.js';
import { video } from './dom.js';

let statsTimer = null;
let getShaka = () => null;
let getVideoId = () => '';

export function initStats(deps) {
  if (deps.getShaka) getShaka = deps.getShaka;
  if (deps.getVideoId) getVideoId = deps.getVideoId;
}

export function hideStats() {
  hide('player-stats');
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}

function renderStats() {
  const el = $('player-stats');
  let lines = [];
  try {
    const shakaPlayer = getShaka();
    const tracks = shakaPlayer && shakaPlayer.getVariantTracks ? shakaPlayer.getVariantTracks() : [];
    const active = tracks.find((t) => t.active);
    const st = shakaPlayer && shakaPlayer.getStats ? shakaPlayer.getStats() : null;
    if (active) {
      lines.push('Resolution: ' + (active.width || '?') + 'x' + (active.height || '?') + (active.frameRate ? ' @ ' + Math.round(active.frameRate) + 'fps' : ''));
      lines.push('Video codec: ' + (active.videoCodec || active.codecs || '?'));
      lines.push('Audio codec: ' + (active.audioCodec || '?'));
      if (active.mimeType) lines.push('Container: ' + active.mimeType);
      const vb = active.videoBandwidth, ab = active.audioBandwidth;
      if (vb || ab) lines.push('Bitrate: ' + (vb ? Math.round(vb / 1000) + ' (v)' : '') + (ab ? ' / ' + Math.round(ab / 1000) + ' (a)' : '') + ' kbps');
      else if (active.bandwidth) lines.push('Bitrate: ' + Math.round(active.bandwidth / 1000) + ' kbps');
    } else {
      lines.push('Resolution: ' + video.videoWidth + 'x' + video.videoHeight + ' (progressive)');
    }
    if (st) {
      if (st.estimatedBandwidth) lines.push('Connection: ~' + Math.round(st.estimatedBandwidth / 1000) + ' kbps');
      lines.push('Dropped/decoded frames: ' + (st.droppedFrames || 0) + ' / ' + (st.decodedFrames || 0));
      if (st.liveLatency != null && isFinite(st.liveLatency) && st.liveLatency > 0) lines.push('Live latency: ' + st.liveLatency.toFixed(1) + 's');
    }
    const ahead = video.buffered.length ? (video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0;
    lines.push('Buffer ahead: ' + ahead.toFixed(1) + 's');
    lines.push('Player size: ' + video.clientWidth + 'x' + video.clientHeight + ' (native ' + video.videoWidth + 'x' + video.videoHeight + ')');
  } catch (e) { lines = ['stats unavailable']; }
  const vid = getVideoId();
  if (vid) lines.push('Video id: ' + vid);
  // build safely (avoid HTML injection from codec/mime strings)
  el.innerHTML = '';
  for (const l of lines) { const d = document.createElement('div'); d.textContent = l; el.appendChild(d); }
}

export function toggleStats() {
  if (!$('player-stats').classList.contains('hidden')) { hideStats(); return; }
  show('player-stats');
  renderStats();
  statsTimer = setInterval(renderStats, 1000);
}
