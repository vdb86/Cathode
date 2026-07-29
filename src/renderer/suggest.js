// SPDX-License-Identifier: GPL-3.0-or-later
// In-player suggestions drawer (Down while the HUD is hidden). Shrinks the
// video upward and shows the current video's related list as a focusable row;
// the video keeps playing. Select plays the picked video (handled by the router
// in app.js); Back/Up restores full screen. Extracted from app.js (renderer
// ES-module split, s108). All drawer state lives on pstate (relatedVideos /
// suggestOpen / suggestSel / suggestLoading / suggestExhausted); the only
// player-fn dependency is applyAspect, injected via initSuggest.

import { $, show, hide } from './util.js';
import { makeCard } from './render.js';
import { video } from './dom.js';
import { pstate } from './pstate.js';

let applyAspect = () => {};

export function initSuggest(deps) {
  if (deps && deps.applyAspect) applyAspect = deps.applyAspect;
}

// Warm the browser image cache for the related thumbnails at play time so the
// drawer paints instantly on its first open, instead of streaming ~40
// thumbnails over the network right when it opens (s107c). Image refs are held
// until each settles so they aren't GC'd mid-request; the list is reset per
// play so a prior video's prefetchers drop.
let _thumbPrefetch = [];
export function prefetchRelatedThumbs(list) {
  _thumbPrefetch = [];
  for (const v of (list || [])) {
    if (!v || !v.thumbnail) continue;
    const img = new Image();
    img.decoding = 'async';
    const done = () => { const i = _thumbPrefetch.indexOf(img); if (i >= 0) _thumbPrefetch.splice(i, 1); };
    img.onload = done; img.onerror = done;
    img.src = v.thumbnail;
    _thumbPrefetch.push(img);
  }
}

export function openSuggest() {
  pstate.suggestOpen = true;
  pstate.suggestSel = 0;
  $('player-overlay').classList.add('suggesting');
  video.style.transform = ''; video.style.objectFit = ''; // let the .suggesting CSS size the video
  show('player-suggest');
  clearTimeout(pstate.hudTimer);
  if (pstate.relatedVideos.length) {
    const _t0 = performance.now();
    renderSuggestDrawer();
    // s107c diagnostic: the drawer renders synchronously from relatedVideos (set
    // at play time), so this should be a few ms; if it's slow the cause is
    // elsewhere (data absent, or thumbnail image loading over the network).
    window.tv.logInfo('suggest drawer: ' + pstate.relatedVideos.length + ' related rendered in ' + Math.round(performance.now() - _t0) + 'ms (dearrow=' + !!(Settings.da && Settings.da('enabled')) + ')');
    return;
  }
  // No bundled related (the anon WEB watch_next_feed was empty for this video --
  // common for something reached via the queue). Show a loading state and pull
  // them on demand; warmRelated renders the drawer (or an empty message) when the
  // fetch settles. If a warm is already in flight (started at play), just wait.
  renderSuggestMessage('Loading suggestions…');
  warmRelated();
}

// Fetch related on demand when the bundled list was empty. Safe to call at play
// time (fire-and-forget) OR from openSuggest; it no-ops if related is already
// present or a fetch is in flight. Renders the drawer / an empty message if the
// drawer is open when it settles.
export async function warmRelated() {
  if (pstate.relatedVideos.length || pstate.suggestLoading) return;
  if (!pstate.currentVideoId || !window.tv.relatedFresh) return;
  const id = pstate.currentVideoId;
  pstate.suggestLoading = true;
  try {
    const r = await window.tv.relatedFresh(id, []);
    if (pstate.currentVideoId !== id) return; // moved on to another video
    pstate.relatedVideos = ((r && r.videos) || []).filter((v) => v && v.id !== id);
    prefetchRelatedThumbs(pstate.relatedVideos);
    window.tv.logInfo('warmRelated ' + id + ': ' + pstate.relatedVideos.length + ' related');
  } catch (e) { /* ignore -- treat as none */ }
  finally {
    if (pstate.currentVideoId === id) {
      pstate.suggestLoading = false;
      if (pstate.suggestOpen) {
        if (pstate.relatedVideos.length) renderSuggestDrawer();
        else renderSuggestMessage('No suggestions for this video');
      }
    } else {
      pstate.suggestLoading = false;
    }
  }
}

function renderSuggestMessage(msg) {
  const box = $('player-suggest');
  if (!box) return;
  box.innerHTML = '<div class="suggest-msg"></div>';
  box.firstChild.textContent = msg;
}

export function closeSuggest() {
  pstate.suggestOpen = false;
  hide('player-suggest');
  $('player-overlay').classList.remove('suggesting');
  applyAspect(); // restore the chosen aspect after the shrink
}

function renderSuggestDrawer() {
  const box = $('player-suggest');
  box.innerHTML = '';
  pstate.relatedVideos.forEach((v) => box.appendChild(makeCard(v)));
  applySuggestDrawerFocus();
}

export function applySuggestDrawerFocus() {
  const kids = $('player-suggest').children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('focused', i === pstate.suggestSel);
    if (i === pstate.suggestSel) kids[i].scrollIntoView({ inline: 'center', block: 'nearest' });
  }
}

// Append the next page of related videos when the user scrolls to the end of
// the drawer (watch-next continuation, fetched main-side). No-op once the feed
// is exhausted or a fetch is already in flight.
export async function loadMoreSuggest() {
  if (pstate.suggestLoading || pstate.suggestExhausted || !pstate.currentVideoId || !window.tv.moreRelated) return;
  pstate.suggestLoading = true;
  try {
    const have = pstate.relatedVideos.map((v) => v.id);
    const haveSet = new Set(have);
    const r = await window.tv.moreRelated(pstate.currentVideoId, have);
    const fresh = ((r && r.videos) || []).filter((v) => v && !haveSet.has(v.id));
    if (!fresh.length) { pstate.suggestExhausted = true; return; }
    if (!pstate.suggestOpen) return; // drawer closed while the fetch was in flight
    const box = $('player-suggest');
    const firstNew = pstate.relatedVideos.length;
    fresh.forEach((v) => { pstate.relatedVideos.push(v); box.appendChild(makeCard(v)); });
    pstate.suggestSel = firstNew;
    applySuggestDrawerFocus();
  } catch (e) { /* ignore -- treat as no more */ }
  finally { pstate.suggestLoading = false; }
}
