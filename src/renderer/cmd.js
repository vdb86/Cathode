// SPDX-License-Identifier: GPL-3.0-or-later
// Playback command hooks (pre-roll / start / post-roll shell commands).
// Extracted from app.js (renderer ES-module split, s105).
//
// SECURITY (s83): only an EVENT NAME crosses the IPC. Main reads the configured
// command string from the active account's ui_settings itself (app:playbackEvent),
// so the renderer can never execute arbitrary strings. The checks here are just
// to skip needless IPC; main re-checks everything. commandVars supplies the
// substitution values for the pre/post-roll command templates; main quotes each
// for the Windows shell and fills {event}/{trigger} itself.
//
// The current video object / id / channel id live in app.js (broadly used by the
// player) and are read here through accessors injected via initCmd. Settings +
// window.tv are classic-script globals.

import { video } from './dom.js';
import { state } from './state.js';

let getVideoObj = () => null;
let getVideoId = () => '';
let getChannelId = () => '';

export function initCmd(deps) {
  getVideoObj = deps.getVideoObj;
  getVideoId = deps.getVideoId;
  getChannelId = deps.getChannelId;
}

// NB: at pre-roll time the streams haven't been fetched yet, so title / channel /
// duration are only populated for start/post-roll (pre-roll gets the id + url +
// account, plus an explicit videoId passed in from play()).
function commandVars() {
  const v = getVideoObj() || {};
  const vid = v.id || getVideoId() || '';
  let dur = '';
  try { if (isFinite(video.duration) && video.duration > 0) dur = String(Math.round(video.duration)); } catch (e) {}
  return {
    videoId: vid,
    url: vid ? 'https://www.youtube.com/watch?v=' + vid : '',
    title: v.title || '',
    channel: v.author || '',
    channelId: getChannelId() || '',
    duration: dur,
    account: state.currentAccountName || 'Guest'
  };
}

export function runPreCommand(firstPlay, videoId) {
  if (Settings.get('preCmdEnabled') !== true) return;
  if ((Settings.get('preCmdTrigger') || 'every') === 'first' && !firstPlay) return;
  const vars = commandVars();
  if (videoId) { vars.videoId = videoId; vars.url = 'https://www.youtube.com/watch?v=' + videoId; }
  if (window.tv.playbackEvent) window.tv.playbackEvent('pre', vars).catch(() => {});
}

// Fires when the video actually starts playing (after the stream loads), so
// {title}/{channel}/{duration} are populated -- unlike the pre-roll command,
// which runs before the fetch.
export function runStartCommand(firstPlay) {
  if (Settings.get('startCmdEnabled') !== true) return;
  if ((Settings.get('startCmdTrigger') || 'every') === 'first' && !firstPlay) return;
  if (window.tv.playbackEvent) window.tv.playbackEvent('start', commandVars()).catch(() => {});
}

export function runPostCommand(reason) { // reason: 'end' (natural end) | 'stop' (manual stop)
  if (Settings.get('postCmdEnabled') !== true) return;
  if (window.tv.playbackEvent) window.tv.playbackEvent(reason === 'end' ? 'post-end' : 'post-stop', commandVars()).catch(() => {});
}
