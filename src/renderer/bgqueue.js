// SPDX-License-Identifier: GPL-3.0-or-later
// Background playback + user queue + in-rail now-playing window/controls.
// Extracted from app.js (renderer ES-module split, s111).
//
// A backgrounded video keeps its <video> + Shaka/SABR session alive: the single
// <video> element is reparented into the rail's now-playing window (it never
// leaves the document, so it keeps playing), with a controls row + a Queue item
// below it. Expand = restore(); Back on the rail = stop. The user queue is
// explicit, survives a stop, and plays BEFORE the auto-suggested related list.
//
// State lives on pstate (bgPlaying/userQueue/upNext/prevStack/railCtrlIdx +
// currentVideoId/currentVideoObj/hudTimer/pRow/pCol) and state (currentSection/
// gridSection/currentPlaylistId/currentPlaylistName/mode). Peer imports cover
// util/dom/render/seek/seekpreview; Nav + Settings are globals. Everything that
// belongs to the player CORE or transport (play, stopPlayback, togglePlay,
// applyAspect, closePlayerMenu, pBtn) plus the SVG icon strings are injected via
// initBgQueue, since those stay app.js-local for now.

import { $, toast, show, hide } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';
import { renderVideoGrid } from './render.js';
import { hideSeekPreview } from './seekpreview.js';
import { resetSeekScrub } from './seek.js';

let play = () => {};
let stopPlayback = () => {};
let togglePlay = () => {};
let applyAspect = () => {};
let closePlayerMenu = () => {};
let pBtn = () => null;
let ICON = { play: '', pause: '', stop: '', trash: '', next: '' };

export function initBgQueue(deps) {
  if (!deps) return;
  if (deps.play) play = deps.play;
  if (deps.stopPlayback) stopPlayback = deps.stopPlayback;
  if (deps.togglePlay) togglePlay = deps.togglePlay;
  if (deps.applyAspect) applyAspect = deps.applyAspect;
  if (deps.closePlayerMenu) closePlayerMenu = deps.closePlayerMenu;
  if (deps.pBtn) pBtn = deps.pBtn;
  if (deps.icons) ICON = deps.icons;
}

// ---- in-rail now-playing window ----
function mountMiniVideo() {
  const slot = $('rail-np-video');
  if (slot && video.parentElement !== slot) slot.appendChild(video);
  video.style.transform = ''; video.style.objectFit = ''; // drop any full-screen aspect zoom so it fits the slot
}
function unmountMiniVideo() {
  const ov = $('player-overlay');
  if (ov && video.parentElement !== ov) ov.insertBefore(video, ov.firstChild);
}
function updateNowPlayingLabel() {
  const el = $('rail-np-label');
  if (el) el.textContent = pstate.currentVideoObj ? pstate.currentVideoObj.title : '';
}

// Show / hide the now-playing window + controls row (used when (un)minimizing).
export function showNowPlaying() {
  const np = $('rail-nowplaying'); if (np) np.classList.remove('hidden');
  const ctl = $('rail-controls'); if (ctl) ctl.classList.remove('hidden');
  updateNowPlayingLabel();
  updateRailControls();
}
function hideNowPlaying() {
  const np = $('rail-nowplaying'); if (np) np.classList.add('hidden');
  const ctl = $('rail-controls'); if (ctl) ctl.classList.add('hidden');
}

// The Queue rail item shows whenever the user queue is non-empty (it survives
// a stop, so it can appear with nothing playing).
export function updateRailQueueItem() {
  const el = $('rail-queue');
  if (!el) return;
  el.classList.toggle('hidden', pstate.userQueue.length === 0);
  const tx = $('rail-queue-tx');
  if (tx) tx.textContent = 'Queue (' + pstate.userQueue.length + ')';
}

// In-rail controls row: icons (set once at boot), focus + state.
const RAIL_CTLS = ['playpause', 'stop', 'next', 'clear'];
export function initRailControls() {
  const strip = $('rail-controls');
  if (!strip) return;
  const icons = { playpause: ICON.pause, stop: ICON.stop, next: ICON.next, clear: ICON.trash };
  strip.querySelectorAll('.npc').forEach((b) => {
    b.innerHTML = '<span class="picon">' + (icons[b.dataset.ctl] || '') + '</span>';
  });
}
export function applyRailCtrlFocus() {
  const strip = $('rail-controls');
  if (!strip) return;
  strip.querySelectorAll('.npc').forEach((b, i) => b.classList.toggle('active', i === pstate.railCtrlIdx));
}
function updateRailControls() {
  const strip = $('rail-controls');
  if (!strip) return;
  const pp = strip.querySelector('.npc[data-ctl="playpause"] .picon');
  if (pp) pp.innerHTML = video.paused ? ICON.play : ICON.pause;
  const next = strip.querySelector('.npc[data-ctl="next"]');
  if (next) next.classList.toggle('dim', !(pstate.userQueue.length || pstate.upNext.length));
  const clear = strip.querySelector('.npc[data-ctl="clear"]');
  if (clear) clear.classList.toggle('dim', !pstate.userQueue.length);
  applyRailCtrlFocus();
}
export function stepRailCtrl(dir) {
  const nx = pstate.railCtrlIdx + dir;
  if (nx < 0) return;                                       // left at the start: stay
  if (nx > RAIL_CTLS.length - 1) return Nav.move('right');  // right past the end: enter content
  pstate.railCtrlIdx = nx;
  applyRailCtrlFocus();
}
export function activateRailCtrl() {
  const ctl = RAIL_CTLS[pstate.railCtrlIdx];
  if (ctl === 'playpause') { togglePlay(); updateRailControls(); }
  else if (ctl === 'stop') stopPlayback('manual');
  else if (ctl === 'next') playNext();
  else if (ctl === 'clear') clearQueue();
}

// Reset background presentation (full-screen play + stop): move the video back
// to the overlay and hide the now-playing window/controls. The user queue is
// NOT touched here -- it survives a stop.
export function clearBg() {
  pstate.bgPlaying = false;
  unmountMiniVideo();
  hideNowPlaying();
  updateRailQueueItem();
}

// Present the current video in the rail: reparent the <video> into the rail
// window (it keeps playing) and hide the full-screen overlay.
export function applyBgStyle() {
  hide('player-overlay');
  mountMiniVideo();
  closePlayerMenu();
}

// Leave the full-screen player but keep playing (Back when Background playback
// is on). Focus returns to browse; the video plays on in the rail.
export function minimize() {
  if (!pstate.currentVideoId) return stopPlayback();
  pstate.bgPlaying = true;
  clearTimeout(pstate.hudTimer);
  hideSeekPreview();
  resetSeekScrub();
  applyBgStyle();
  showNowPlaying();
  updateRailQueueItem();
  state.mode = 'browse';
  Nav.apply();
}

// Expand the rail window back to full screen.
export function restore() {
  if (!pstate.currentVideoId) { clearBg(); return; }
  pstate.bgPlaying = false;
  unmountMiniVideo();
  applyAspect();          // reapply the chosen aspect (mounting cleared the inline transform/fit)
  hideNowPlaying();
  show('player-overlay');
  hide('player-hud'); // enter clean, no HUD -- same as a fresh play(); a nav key reveals it
  state.mode = 'player';
  pstate.pRow = 'buttons'; pstate.pCol = 2;
}

// ---- user queue (explicit; survives stop; plays before related videos) ----
export function addToQueue(v, front) {
  const item = { id: v.id, title: v.title || '', author: v.author || '', thumbnail: v.thumbnail || '' };
  if (front) pstate.userQueue.unshift(item); else pstate.userQueue.push(item);
  updateRailControls(); updateRailQueueItem(); updateQueueButtons();
  toast(front ? 'Playing next' : 'Added to queue');
}
export function removeFromQueue(id) {
  const i = pstate.userQueue.findIndex((q) => q.id === id);
  if (i < 0) return;
  pstate.userQueue.splice(i, 1);
  updateRailControls(); updateRailQueueItem(); updateQueueButtons();
  if (state.currentSection === 'queue') renderQueue();
  toast('Removed from queue');
}
function clearQueue() {
  if (!pstate.userQueue.length) return;
  pstate.userQueue = [];
  updateRailControls(); updateRailQueueItem(); updateQueueButtons();
  if (state.currentSection === 'queue') renderQueue();
  toast('Queue cleared');
}
function renderQueue() {
  renderVideoGrid({ title: 'Queue', videos: pstate.userQueue.slice() });
}
export function openQueue() {
  state.currentSection = 'queue';
  state.gridSection = null;
  state.currentPlaylistId = null; state.currentPlaylistName = null;
  renderQueue();
}
// Select a card in the Queue view: play it and drop it from the queue.
export function playQueueCard(el) {
  const id = el.dataset.id;
  const i = pstate.userQueue.findIndex((q) => q.id === id);
  if (i >= 0) pstate.userQueue.splice(i, 1);
  updateRailControls(); updateRailQueueItem(); updateQueueButtons();
  play(id, { keepQueue: true, background: pstate.bgPlaying });
  if (pstate.bgPlaying) renderQueue(); // stay in the queue view, drop the played item
}

// Activate a video card. While background-playing, honour the "new video"
// settings: queue it, or replace (full screen or staying in the rail window).
export function playFromCard(el) {
  const id = el.dataset.id;
  if (!pstate.bgPlaying) return play(id);
  if ((Settings.get('bgSelectAction') || 'replace') === 'queue') {
    const t = el.querySelector('.title');
    const img = el.querySelector('img');
    return addToQueue({ id: id, title: t ? t.textContent : '', author: el.dataset.author || '', thumbnail: img ? img.src : '' }, false);
  }
  if ((Settings.get('bgSelectView') || 'fullscreen') === 'mini') return play(id, { background: true });
  return play(id); // replace, full screen
}

// ---- up-next queue (autoplay + Next/Previous) ----
export function updateQueueButtons() {
  const nb = pBtn('next'); if (nb) nb.classList.toggle('dim', !(pstate.userQueue.length || pstate.upNext.length));
  const pb = pBtn('prev'); if (pb) pb.classList.toggle('dim', !pstate.prevStack.length);
}

export function playNext() {
  // The explicit user queue plays first, then the auto-suggested related list.
  const n = pstate.userQueue.length ? pstate.userQueue.shift() : (pstate.upNext.length ? pstate.upNext.shift() : null);
  if (!n) { toast('Nothing up next'); return; }
  if (pstate.currentVideoObj) pstate.prevStack.push(pstate.currentVideoObj);
  updateRailControls(); updateRailQueueItem();
  play(n.id, { keepQueue: true, background: pstate.bgPlaying });
}

export function playPrev() {
  if (!pstate.prevStack.length) { toast('No previous video'); return; }
  const p = pstate.prevStack.pop();
  play(p.id, { keepQueue: true, background: pstate.bgPlaying });
}
