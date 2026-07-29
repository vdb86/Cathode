// SPDX-License-Identifier: GPL-3.0-or-later
// Player action / control layer (renderer split, s115). The transport-button
// dispatch (activatePlayerButton) + play/pause toggle, open-channel, and the
// per-control toggles: aspect, SponsorBlock on/off, playback (repeat) mode,
// captions, screen-off, and the per-video control-label reset. Sits between the
// transport ROW (transport.js: the button strip + HUD paint) and the playback
// CORE (play/stopPlayback, still in app.js). State on pstate + state.sbEnabled.
// Only the CORE dep stopPlayback is injected (initPlayerActions); everything else
// is a one-way import from sibling feature modules.

import { toast, show, hide } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';
import { ASPECTS } from './pconst.js';
import { pBtn, updatePlayPause } from './transport.js';
import { openCogMenu, openPlayerMenu } from './playermenu.js';
import { seekBy } from './seek.js';
import { playPrev, playNext, minimize } from './bgqueue.js';
import { toggleLike, toggleDislike, toggleSubscribe, saveToWatchLater } from './videoactions.js';
import { toggleStats } from './stats.js';
import { closeSuggest } from './suggest.js';
import { toggleChat } from './livechat.js';
import { toggleComments } from './comments.js';
import { openChannelPage } from './feeds.js';
import { quickDownloadCurrent } from './downloads.js';

let stopPlayback = () => {};

export function initPlayerActions(deps) {
  if (deps && deps.stopPlayback) stopPlayback = deps.stopPlayback;
}

export function togglePlay() {
  if (video.paused) video.play().catch(() => {}); else video.pause();
  updatePlayPause();
}

export function activatePlayerButton(act) {
  act = act || pstate.P_BUTTONS[pstate.pCol];
  if (act === 'cog') return openCogMenu();
  if (act === 'playpause') togglePlay();
  else if (act === 'ff') seekBy(10);
  else if (act === 'rw') seekBy(-10);
  else if (act === 'prev') playPrev();
  else if (act === 'next') playNext();
  else if (act === 'like') toggleLike();
  else if (act === 'dislike') toggleDislike();
  else if (act === 'subscribe') toggleSubscribe();
  else if (act === 'cc') openPlayerMenu('cc');
  else if (act === 'audio') openPlayerMenu('audio');
  else if (act === 'speed') openPlayerMenu('speed');
  else if (act === 'quality') openPlayerMenu('quality');
  else if (act === 'save') saveToWatchLater();
  else if (act === 'sb') toggleSb();
  else if (act === 'repeat') openPlayerMenu('repeat');
  else if (act === 'aspect') openPlayerMenu('aspect');
  else if (act === 'stats') toggleStats();
  else if (act === 'screenoff') screenOff();
  else if (act === 'openchannel') openCurrentChannel();
  else if (act === 'livechat') toggleChat();
  else if (act === 'comments') toggleComments();
  else if (act === 'download') quickDownloadCurrent();
  else if (act === 'stop') stopPlayback('manual');
}

// Open the current video's channel from the player. Keep playback alive by
// minimizing into the rail (background), then open the channel page in
// browse; Back returns to browse with the video still playing in the rail.
function openCurrentChannel() {
  if (!pstate.currentChannelId) { toast('No channel for this video'); return; }
  const name = (pstate.currentVideoObj && pstate.currentVideoObj.author) || '';
  if (pstate.suggestOpen) closeSuggest();
  minimize();
  openChannelPage(pstate.currentChannelId, name);
}

export function applyAspect() {
  const a = ASPECTS[pstate.aspectIdx];
  video.style.objectFit = a.fit;
  video.style.transform = a.tf;
  const b = pBtn('aspect');
  const lab = b && b.querySelector('.plabel');
  if (lab) lab.textContent = a.label;
}

export function toggleSb() {
  state.sbEnabled = !state.sbEnabled;
  const b = pBtn('sb');
  if (b) b.classList.toggle('on', state.sbEnabled);
  toast('SponsorBlock skip ' + (state.sbEnabled ? 'on' : 'off'));
}

// Playback mode: the transport Repeat button opens a menu of the modes; the
// 'ended' handler acts on playbackMode. 'one' uses native <video> loop (so
// 'ended' never fires); the others let 'ended' decide next/pause/stop. The
// Repeat button lights up whenever the mode is anything other than 'next'.
export function applyPlaybackMode() {
  video.loop = (pstate.playbackMode === 'one');
  const b = pBtn('repeat');
  if (b) b.classList.toggle('on', pstate.playbackMode !== 'next');
}

// ---- captions ----
export async function applyCaption() {
  if (!pstate.shakaPlayer) return;
  const b = pBtn('cc');
  if (pstate.captionIdx === 0) {
    try { pstate.shakaPlayer.setTextTrackVisibility(false); } catch {}
    if (b) b.classList.remove('on');
    toast('Captions off');
    return;
  }
  const track = pstate.captionTracks[pstate.captionIdx - 1];
  if (!track) return;
  try {
    let tr = pstate.addedCaptions.get(track.url);
    if (!tr) {
      tr = await pstate.shakaPlayer.addTextTrackAsync(track.url, track.lang || 'und', 'caption', 'text/vtt', undefined, track.name);
      pstate.addedCaptions.set(track.url, tr);
    }
    pstate.shakaPlayer.selectTextTrack(tr);
    pstate.shakaPlayer.setTextTrackVisibility(true);
    if (b) b.classList.add('on');
    toast('Captions: ' + track.name);
  } catch (e) {
    toast('Captions unavailable');
    window.tv.logError('caption error: ' + (e && e.message));
  }
}

export function hideScreenOff() { hide('screen-off'); }

// Blackout the screen (audio keeps playing); any button restores it.
function screenOff() {
  show('screen-off');
  hide('player-hud');
  clearTimeout(pstate.hudTimer);
}

// Reset the toggle buttons' active state for a freshly opened video.
export function resetPlayerControlLabels() {
  const sb = pBtn('sb'); if (sb) sb.classList.toggle('on', state.sbEnabled); // reflect the SponsorBlock setting
  applyPlaybackMode(); // sets video.loop + the Repeat button's active state from playbackMode
  const cc = pBtn('cc'); if (cc) cc.classList.remove('on');    // captions off until chosen
}
