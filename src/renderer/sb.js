// SPDX-License-Identifier: GPL-3.0-or-later
// SponsorBlock: the per-playback segment auto-skip / notify / ask logic + the
// "Skip <category>?" prompt, driven by the <video> timeupdate loop. Extracted
// from app.js (renderer ES-module split, s103).
//
// Shared state on state.js (app.js also touches these): state.sbSegments (set by
// play(), drawn by renderSbMarkers), state.sbEnabled (set by play(), toggled by
// toggleSb, read by resetPlayerControlLabels), state.sbAskSeg (read by the
// player router to know an OK press should skip). The de-dupe sets + the ask
// timer are private here. Settings is a classic-script global.

import { $, toast } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';

const sbSkipped = new Set();
let sbAskTimer = null; // auto-hide timer for the ask prompt
const sbAskDismissed = new Set(); // segment uuids whose ask prompt has timed out

export function resetSponsorBlock() {
  state.sbSegments = [];
  sbSkipped.clear();
  state.sbAskSeg = null;
  sbAskDismissed.clear();
  clearTimeout(sbAskTimer);
  hideSbPrompt();
}

function sbCategoryLabel(cat) {
  const m = {
    sponsor: 'sponsor', selfpromo: 'self-promo', interaction: 'interaction reminder',
    intro: 'intro', outro: 'outro', preview: 'preview/recap',
    music_offtopic: 'non-music section', filler: 'filler'
  };
  return m[cat] || cat;
}
function showSbPrompt(seg) {
  const el = $('sb-prompt');
  if (!el) return;
  el.textContent = 'Skip ' + sbCategoryLabel(seg.category) + '?  Press OK (A / Enter)';
  el.classList.remove('hidden');
  clearTimeout(sbAskTimer);
  const secs = Settings.sb('askDuration'); // 0 = keep until the segment ends
  if (secs && secs > 0) {
    sbAskTimer = setTimeout(() => {
      sbAskDismissed.add(seg.uuid); // don't offer this segment again
      state.sbAskSeg = null;
      hideSbPrompt();
    }, secs * 1000);
  }
}
function hideSbPrompt() { const el = $('sb-prompt'); if (el) el.classList.add('hidden'); }
export function skipAskSegment() {
  if (!state.sbAskSeg) return;
  const seg = state.sbAskSeg;
  sbSkipped.add(seg.uuid);
  const target = Math.min(seg.end, (video.duration || seg.end) - 0.1);
  video.currentTime = Math.max(target, video.currentTime);
  state.sbAskSeg = null;
  clearTimeout(sbAskTimer);
  hideSbPrompt();
}

video.addEventListener('timeupdate', () => {
  if (state.mode !== 'player' || !state.sbEnabled || !state.sbSegments.length || video.seeking) return;
  const minDur = Settings.sb('minDuration') || 0;
  const action = Settings.sb('action') || 'notify'; // skip | notify | ask
  const t = video.currentTime;
  // Re-arm any segment the playhead is now BEFORE (the user seeked back): drop
  // it from the skipped/dismissed sets so re-entering it triggers the action
  // (skip / notify / ask) again, instead of being ignored the second time.
  for (const seg of state.sbSegments) {
    if (t < seg.start - 0.5) { sbSkipped.delete(seg.uuid); sbAskDismissed.delete(seg.uuid); }
  }
  let active = null;
  for (const seg of state.sbSegments) {
    if (minDur && (seg.end - seg.start) < minDur) continue;
    if (sbSkipped.has(seg.uuid)) continue;
    if (t >= seg.start && t < seg.end - 0.2) { active = seg; break; }
  }
  if (action === 'ask') {
    // Don't auto-skip: show a prompt and let the user press OK (handled in the
    // player input router). The prompt auto-hides after askDuration; a
    // timed-out (dismissed) segment isn't offered again. Clear once past it.
    if (active && !sbAskDismissed.has(active.uuid)) {
      if (state.sbAskSeg !== active) { state.sbAskSeg = active; showSbPrompt(active); }
    } else if (state.sbAskSeg) {
      state.sbAskSeg = null; clearTimeout(sbAskTimer); hideSbPrompt();
    }
    return;
  }
  if (active) {
    sbSkipped.add(active.uuid);
    const target = Math.min(active.end, (video.duration || active.end) - 0.1);
    video.currentTime = Math.max(target, t);
    if (action !== 'skip') toast('Skipped: ' + active.category);
  }
});
