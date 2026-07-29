// SPDX-License-Identifier: GPL-3.0-or-later
// Chapters + seek-preview thumbnails: the chapter segment markers drawn on the
// seek track, and the storyboard-thumbnail + chapter-name preview shown above
// the knob while the timeline is focused. Extracted from app.js (renderer
// ES-module split, s109). All state lives on pstate (chapters / storyboard /
// pRow). Reads the scrub position from seek.js via seekDisplayTime (one-way
// import; seek.js still receives updateSeekPreview through initSeek, so there is
// no circular dependency). No dependency injection needed.

import { $ } from './util.js';
import { video } from './dom.js';
import { pstate } from './pstate.js';
import { seekDisplayTime } from './seek.js';

export function renderChapterMarkers() {
  const track = $('seek-track');
  if (!track) return;
  track.querySelectorAll('.chap-seg').forEach((e) => e.remove());
  const d = video.duration;
  if (!isFinite(d) || d <= 0 || !pstate.chapters.length) return;
  for (const c of pstate.chapters) {
    if (c.start <= 0) continue;
    const el = document.createElement('div');
    el.className = 'chap-seg';
    el.style.left = Math.min(100, (c.start / d) * 100) + '%';
    track.appendChild(el);
  }
}

function currentChapterTitle(t) {
  let title = '';
  for (const c of pstate.chapters) { if (t >= c.start) title = c.title; else break; }
  return title;
}

export function hideSeekPreview() { const el = $('seek-preview'); if (el) el.classList.add('hidden'); }

// Show a storyboard thumbnail (+ current chapter name) above the knob while
// the timeline is focused. Best-effort: hides if no storyboard/chapter.
export function updateSeekPreview() {
  const box = $('seek-preview');
  if (!box) return;
  const d = video.duration;
  if (Settings.get('seekPreview') === false || pstate.pRow !== 'seek' || !isFinite(d) || d <= 0 || (!pstate.storyboard && !pstate.chapters.length)) { box.classList.add('hidden'); return; }
  const t = seekDisplayTime();
  // Align horizontally to the seek TRACK (not the full HUD), in px.
  const trk = $('seek-track'), hud = $('player-hud');
  if (trk && hud) {
    const tr = trk.getBoundingClientRect(), hr = hud.getBoundingClientRect();
    box.style.left = (tr.left - hr.left + (t / d) * tr.width) + 'px';
  } else {
    box.style.left = Math.min(100, (t / d) * 100) + '%';
  }
  const thumb = box.querySelector('.seek-preview-thumb');
  const label = box.querySelector('.seek-preview-label');
  let hasThumb = false;
  if (pstate.storyboard && pstate.storyboard.templateUrl && pstate.storyboard.cols && pstate.storyboard.rows && pstate.storyboard.interval && pstate.storyboard.width) {
    try {
      const perSprite = pstate.storyboard.cols * pstate.storyboard.rows;
      let idx = Math.floor((t * 1000) / pstate.storyboard.interval);
      if (pstate.storyboard.count) idx = Math.min(idx, pstate.storyboard.count - 1);
      const spriteNum = Math.floor(idx / perSprite);
      const tile = idx % perSprite;
      const col = tile % pstate.storyboard.cols;
      const row = Math.floor(tile / pstate.storyboard.cols);
      const url = pstate.storyboard.templateUrl
        .replace(/\$L/g, pstate.storyboard.level)
        .replace(/\$N|\$M/g, spriteNum)
        .replace(/\$width/g, pstate.storyboard.width)
        .replace(/\$height/g, pstate.storyboard.height);
      thumb.style.width = pstate.storyboard.width + 'px';
      thumb.style.height = pstate.storyboard.height + 'px';
      thumb.style.backgroundImage = 'url("' + url + '")';
      thumb.style.backgroundSize = (pstate.storyboard.cols * pstate.storyboard.width) + 'px ' + (pstate.storyboard.rows * pstate.storyboard.height) + 'px';
      thumb.style.backgroundPosition = '-' + (col * pstate.storyboard.width) + 'px -' + (row * pstate.storyboard.height) + 'px';
      thumb.style.display = 'block';
      hasThumb = true;
    } catch { thumb.style.display = 'none'; }
  } else { thumb.style.display = 'none'; }
  const chap = currentChapterTitle(t);
  if (chap) { label.textContent = chap; label.style.display = 'block'; } else { label.style.display = 'none'; }
  if (hasThumb || chap) box.classList.remove('hidden'); else box.classList.add('hidden');
}
