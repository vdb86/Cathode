// SPDX-License-Identifier: GPL-3.0-or-later
// Player transport HUD (renderer split, s114). The button-strip mechanics +
// seek-bar / HUD paint: filling the icon buttons, the saved-order layout, the
// row visibility/step/focus + button tooltip, the seek bar, the play/pause icon,
// the SponsorBlock seek-track markers, the speed/quality value labels, and
// showTransport (reveal the HUD + auto-hide). Display-only - no playback-core
// coupling. State lives on pstate (P_BUTTONS/_btnOrderSig/pRow/pCol/pMenu/
// hudTimer/speedIdx/qualityLabel) + state.sbSegments. app.js imports pBtn/
// initPlayerButtons/stepPlayerCol/updateSeekBar/updatePlayPause/renderSbMarkers/
// updateControlLabels/showTransport; pBtn/updateSeekBar/updateControlLabels are
// re-injected from here into bgqueue/videoactions/playermenu/seek at boot.

import { $, show, hide, fmtTime } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';
import { P_ICONS, P_WITH_LABEL, P_LABELS, SPEEDS, SVG_PLAY, SVG_PAUSE } from './pconst.js';
import { cogMenuActs } from './playermenu.js';
import { renderChapterMarkers, updateSeekPreview } from './seekpreview.js';
import { updateClock } from './clock.js';

function pButtonEls() { return Array.from(document.querySelectorAll('#player-buttons .pbtn')); }
export function pBtn(act) { return pButtonEls().find((b) => b.dataset.act === act); }

// Fill the icon-only player buttons once at boot (SVG + optional value label).
export function initPlayerButtons() {
  pButtonEls().forEach((b) => {
    const act = b.dataset.act;
    let html = '<span class="picon">' + (P_ICONS[act] || '') + '</span>';
    if (P_WITH_LABEL.has(act)) html += '<span class="plabel"></span>';
    b.innerHTML = html;
  });
  applyPlayerButtonOrder();
  applyPlayerButtonVisibility();
}

// Player > reorder buttons: lay the transport buttons out in the user's saved
// order (ui_settings.playerButtonOrder). play/pause and the cog (More) are
// ordinary reorderable buttons now; the cog just defaults to last (it trails
// `canon`). Rebuilds P_BUTTONS so the column navigation index (pCol) matches
// the on-screen order.
function applyPlayerButtonOrder() {
  const saved = Settings.get('playerButtonOrder') || [];
  const sig = saved.join(',');
  if (sig === pstate._btnOrderSig) return; // unchanged since last apply
  pstate._btnOrderSig = sig;
  const box = $('player-buttons');
  const els = {};
  pButtonEls().forEach((b) => { els[b.dataset.act] = b; });
  const canon = ['prev', 'rw', 'playpause', 'stop', 'ff', 'next', 'like', 'dislike', 'subscribe', 'cc', 'audio', 'speed', 'quality', 'save', 'sb', 'repeat', 'aspect', 'stats', 'screenoff', 'openchannel', 'livechat', 'comments', 'download', 'cog'];
  const order = saved.filter((a) => els[a]);
  canon.forEach((a) => { if (!order.includes(a)) order.push(a); });
  order.forEach((a) => { if (els[a]) box.appendChild(els[a]); });
  pstate.P_BUTTONS = order.filter((a) => els[a]);
}

// Whether a transport button is kept OUT of the visible row: the user hid it,
// moved it into the cog, or (Stop) background playback is off. The cog (More)
// button is ON by default; it can only be disabled when it holds NO reachable
// options - while it holds any, it stays visible regardless of the setting.
// (cogMenuActs - the buttons reachable through the cog menu - lives in playermenu.js.)
function pbtnRowHidden(act) {
  const hidden = Settings.get('hiddenPlayerButtons') || [];
  const cog = Settings.get('cogButtons') || [];
  const bgOff = !Settings.get('bgPlay'); // the Stop button only applies with background playback
  if (act === 'cog') {
    if (cogMenuActs().length > 0) return false;   // holds options -> always shown
    return hidden.includes('cog');                 // empty -> hidden only if disabled
  }
  if (act === 'stop' && bgOff) return true;
  if (act === 'livechat' && !pstate.hasLiveChat) return true; // only when the video actually has chat
  if (act === 'comments' && pstate.isLiveVideo) return true;  // no comments while a stream is live
  if (act === 'download' && pstate.isLiveVideo) return true;  // no downloading a live stream
  if (hidden.includes(act)) return true;
  if (cog.includes(act)) return true; // lives in the cog menu, not the row
  return false;
}
// Player > setup player buttons: hide the buttons kept out of the row, and
// skip them when moving the selector along the button row.
function applyPlayerButtonVisibility() {
  pButtonEls().forEach((b) => {
    b.classList.toggle('hidden', pbtnRowHidden(b.dataset.act));
  });
}
// Re-lay + re-hide the transport buttons without revealing the HUD. Called when
// per-video button availability changes after playback starts (e.g. the async
// live-chat probe resolves and the Live chat button should now appear/vanish).
export function refreshPlayerButtons() {
  applyPlayerButtonOrder();
  applyPlayerButtonVisibility();
}
export function stepPlayerCol(dir) {
  let c = pstate.pCol;
  for (let k = 0; k < pstate.P_BUTTONS.length; k++) {
    c += dir;
    if (c < 0 || c > pstate.P_BUTTONS.length - 1) return; // edge: stay put
    if (pbtnRowHidden(pstate.P_BUTTONS[c])) continue;
    pstate.pCol = c; return;
  }
}

function applyPlayerFocus() {
  $('seek-track').classList.toggle('focused', pstate.pRow === 'seek');
  pButtonEls().forEach((b, i) => {
    const on = pstate.pRow === 'buttons' && i === pstate.pCol;
    b.classList.toggle('focused', on);
    if (on) b.scrollIntoView({ inline: 'center', block: 'nearest' });
  });
  updateButtonTip();
}

// Show the focused button's name as a small tooltip above it.
// Hidden on the seek row, while a slide-up menu is open, or when disabled.
function updateButtonTip() {
  const tip = $('player-tip');
  if (!tip) return;
  if (pstate.pMenu || pstate.pRow !== 'buttons' || Settings.get('playerButtonTips') === false) { tip.classList.add('hidden'); return; }
  const b = pButtonEls()[pstate.pCol];
  const act = b && b.dataset.act;
  const name = act && (P_LABELS[act] || (act === 'cog' ? 'More' : act));
  if (!b || !name) { tip.classList.add('hidden'); return; }
  tip.textContent = name;
  tip.classList.remove('hidden');
  const r = b.getBoundingClientRect();
  tip.style.left = (r.left + r.width / 2) + 'px';
  tip.style.top = (r.top - 40) + 'px';
}

export function updateSeekBar() {
  const d = video.duration;
  const cur = video.currentTime || 0;
  $('player-cur').textContent = fmtTime(cur);
  if (isFinite(d) && d > 0) {
    $('player-dur').textContent = (Settings.get('timeDisplay') === 'remaining') ? '-' + fmtTime(Math.max(0, d - cur)) : fmtTime(d);
    const pct = Math.min(100, (cur / d) * 100);
    $('seek-fill').style.width = pct + '%';
    $('seek-knob').style.left = pct + '%';
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= cur && cur <= video.buffered.end(i)) { buf = video.buffered.end(i); break; }
    }
    $('seek-buffered').style.width = Math.min(100, (buf / d) * 100) + '%';
  } else {
    // Live / unknown duration.
    $('player-dur').textContent = 'LIVE';
    $('seek-fill').style.width = '100%';
    $('seek-knob').style.left = '100%';
    $('seek-buffered').style.width = '100%';
  }
}

export function updatePlayPause() {
  const icon = video.paused ? SVG_PLAY : SVG_PAUSE;
  const btn = pBtn('playpause');
  const bi = btn && btn.querySelector('.picon');
  if (bi) bi.innerHTML = icon;
  const rpp = document.querySelector('#rail-controls .npc[data-ctl="playpause"] .picon');
  if (rpp) rpp.innerHTML = icon;
}

// Colour the SponsorBlock segments onto the seek track.
const SB_COLORS = {
  sponsor: '#00d400', selfpromo: '#ffff00', interaction: '#cc00ff',
  intro: '#00ffff', outro: '#0202ed', preview: '#008fd6',
  music_offtopic: '#ff9900', filler: '#7300ff'
};

export function renderSbMarkers() {
  const track = $('seek-track');
  if (!track) return;
  track.querySelectorAll('.sb-seg').forEach((e) => e.remove());
  if (Settings.sb('colorMarkers') === false) return; // markers cleared above, drawing suppressed
  const d = video.duration;
  if (!isFinite(d) || d <= 0 || !state.sbSegments.length) return;
  for (const seg of state.sbSegments) {
    const el = document.createElement('div');
    el.className = 'sb-seg';
    el.style.left = Math.max(0, (seg.start / d) * 100) + '%';
    el.style.width = Math.max(0.4, ((seg.end - seg.start) / d) * 100) + '%';
    el.style.background = SB_COLORS[seg.category] || '#00d400';
    track.appendChild(el);
  }
}

export function updateControlLabels() {
  const sp = pBtn('speed');
  const spl = sp && sp.querySelector('.plabel');
  if (spl) spl.textContent = SPEEDS[pstate.speedIdx] + 'x';
  const ql = pBtn('quality');
  const qll = ql && ql.querySelector('.plabel');
  if (qll) qll.textContent = pstate.qualityLabel;
  // Audio: show the current language code only on multi-language videos (blank
  // for single-audio, so ordinary videos don't get a stray label).
  const au = pBtn('audio');
  const aul = au && au.querySelector('.plabel');
  if (aul) aul.textContent = (pstate.audioTracks && pstate.audioTracks.length > 1 && pstate.audioLang) ? pstate.audioLang.toUpperCase() : '';
}

export function showTransport() {
  show('player-hud');
  updateSeekBar();
  renderSbMarkers();
  renderChapterMarkers();
  updatePlayPause();
  updateControlLabels();
  applyPlayerButtonOrder();
  applyPlayerButtonVisibility();
  applyPlayerFocus();
  updateSeekPreview();
  updateClock(); // reveal the player clock together with the HUD
  clearTimeout(pstate.hudTimer);
  const hudTo = Settings.get('hudTimeout');
  if (hudTo && hudTo > 0) pstate.hudTimer = setTimeout(() => { hide('player-hud'); updateClock(); }, hudTo * 1000);
}
