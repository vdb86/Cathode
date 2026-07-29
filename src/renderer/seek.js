// SPDX-License-Identifier: GPL-3.0-or-later
// Seeking + progressive scrubbing. Extracted from app.js (renderer split, s104).
// In 'instant' mode a press jumps immediately; in 'delayed'/'accelerated' a
// press moves a preview TARGET (no re-buffer) and the real seek commits once,
// after Skip-delay of no input or on OK. Accelerated climbs the enabled step
// ladder. Live is clamped to the seekable window.
//
// The scrub state (seekTarget + the ladder bookkeeping) is private here; app.js
// only observes it through scrubbing() / seekDisplayTime(). updateSeekBar +
// updateSeekPreview (HUD redraws) and the active Shaka player are injected via
// initSeek. Settings is a classic-script global.

import { $, fmtTime } from './util.js';
import { video } from './dom.js';

let seekTarget = null;   // pending target time (sec); null = not scrubbing
let seekStepIdx = 0;     // ladder index (accelerated)
let seekLastDir = 0;     // last scrub direction (+1/-1)
let seekLastStep = 0;    // last applied step (sec), for the badge
let seekCommitTimer = null;

// Injected from app.js.
let updateSeekBar = () => {};
let updateSeekPreview = () => {};
let getShaka = () => null;

export function initSeek(deps) {
  updateSeekBar = deps.updateSeekBar;
  updateSeekPreview = deps.updateSeekPreview;
  getShaka = deps.getShaka;
}

export function seekBy(delta) {
  const d = video.duration;
  let t = (video.currentTime || 0) + delta;
  t = isFinite(d) ? Math.max(0, Math.min(d - 0.5, t)) : Math.max(0, t);
  video.currentTime = t;
  updateSeekBar();
  updateSeekPreview();
}

export function scrubbing() { return seekTarget != null; }
export function seekDisplayTime() { return seekTarget != null ? seekTarget : (video.currentTime || 0); }

function seekBounds() {
  const shakaPlayer = getShaka();
  if (shakaPlayer && shakaPlayer.isLive && shakaPlayer.isLive()) {
    try { const r = shakaPlayer.seekRange(); if (r && isFinite(r.end)) return [r.start || 0, Math.max(r.start || 0, r.end - 1)]; } catch {}
  }
  const d = video.duration;
  return [0, (isFinite(d) && d > 0) ? d - 0.5 : (video.currentTime || 0)];
}
function seekLadderSecs() {
  const all = [5, 10, 15, 30, 60, 180, 300, 600, 900, 1800];
  const en = (Settings.get('seekSteps') || []).filter((v) => all.includes(v)).sort((a, b) => a - b);
  return en.length ? en : [10];
}
function stepHuman(s) { return s < 60 ? s + 's' : (Math.round(s / 60) + 'm'); }

export function seekPress(dir) {
  const sm = Settings.get('seekMode') || 'instant';
  if (sm === 'instant') { seekBy(dir * 10); return; }
  const b = seekBounds();
  if (seekTarget == null) { seekTarget = video.currentTime || 0; seekStepIdx = 0; seekLastDir = 0; }
  let step;
  if (sm === 'accelerated') {
    const ladder = seekLadderSecs();
    if (seekLastDir !== 0 && dir !== seekLastDir) seekStepIdx = 0; // reversed -> reset ramp
    seekStepIdx = Math.min(seekStepIdx, ladder.length - 1);
    step = ladder[seekStepIdx];
    if (seekStepIdx < ladder.length - 1) seekStepIdx++; // climb for the next press
  } else {
    step = 10; // delayed: fixed base step
  }
  seekLastStep = step;
  seekLastDir = dir;
  seekTarget = Math.max(b[0], Math.min(b[1], seekTarget + dir * step));
  renderSeekTarget();
  updateSeekPreview();
  clearTimeout(seekCommitTimer);
  seekCommitTimer = setTimeout(commitSeek, Settings.get('seekSkipDelay') || 750);
}

function renderSeekTarget() {
  const d = video.duration;
  const b = seekBounds();
  const span = (isFinite(d) && d > 0) ? d : (b[1] || 1);
  const pct = Math.max(0, Math.min(100, (seekTarget / span) * 100));
  const tgt = $('seek-target'), badge = $('seek-badge');
  if (tgt) { tgt.style.left = pct + '%'; tgt.classList.remove('hidden'); }
  if (badge) {
    const accel = Settings.get('seekMode') === 'accelerated';
    badge.textContent = fmtTime(seekTarget) + (accel && seekLastStep ? '  ·  ' + stepHuman(seekLastStep) : '');
    badge.style.left = pct + '%';
    badge.classList.remove('hidden');
  }
}
function hideSeekTarget() {
  const tgt = $('seek-target'); if (tgt) tgt.classList.add('hidden');
  const badge = $('seek-badge'); if (badge) badge.classList.add('hidden');
}
export function resetSeekScrub() {
  clearTimeout(seekCommitTimer);
  seekTarget = null; seekStepIdx = 0; seekLastDir = 0; seekLastStep = 0;
  hideSeekTarget();
}
export function commitSeek() {
  if (seekTarget == null) return;
  const t = seekTarget;
  resetSeekScrub();
  video.currentTime = t;
  updateSeekBar();
  updateSeekPreview();
}
export function cancelSeekScrub() {
  if (seekTarget == null) return false;
  resetSeekScrub();
  updateSeekBar();
  updateSeekPreview();
  return true;
}
