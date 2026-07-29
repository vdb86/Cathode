// SPDX-License-Identifier: GPL-3.0-or-later
// Per-video actions on the current player video: Like / Dislike / Subscribe
// (raw TV InnerTube writes) and Watch Later add/remove. Extracted from app.js
// (renderer ES-module split, s110). Rating/subscribe state is optimistic and
// per-session (lives on pstate); Watch Later membership is the lazy-loaded
// state.wlIds Set. The only DOM dependency is pBtn (find a transport button by
// action), injected via initVideoActions since it stays app.js-local.

import { toast } from './util.js';
import { state } from './state.js';
import { pstate } from './pstate.js';

let pBtn = () => null;

export function initVideoActions(deps) {
  if (deps && deps.pBtn) pBtn = deps.pBtn;
}

// Like / Dislike / Subscribe (raw TV InnerTube actions). State is optimistic
// and per-session: YouTube's current like/subscribe state can't be read
// cheaply on the TV client (an authed watch page crashes youtubei.js' TV
// parser), so buttons start un-highlighted at play() and reflect what the
// user does here. Like/Dislike are mutually exclusive; pressing an already-
// active one clears the rating (removelike).
export function updateRatingButtons() {
  const lb = pBtn('like'); if (lb) lb.classList.toggle('on', pstate.currentRating === 'like');
  const db = pBtn('dislike'); if (db) db.classList.toggle('on', pstate.currentRating === 'dislike');
  const sub = pBtn('subscribe'); if (sub) sub.classList.toggle('on', pstate.currentSubscribed);
}

export async function toggleLike() {
  if (!pstate.currentVideoId) return;
  const next = pstate.currentRating === 'like' ? 'none' : 'like';
  try {
    await window.tv.rate(pstate.currentVideoId, next);
    pstate.currentRating = next; updateRatingButtons();
    toast(next === 'like' ? 'Liked' : 'Like removed');
  } catch (e) { toast('Couldn’t like: ' + (e.message || 'error')); }
}

export async function toggleDislike() {
  if (!pstate.currentVideoId) return;
  const next = pstate.currentRating === 'dislike' ? 'none' : 'dislike';
  try {
    await window.tv.rate(pstate.currentVideoId, next);
    pstate.currentRating = next; updateRatingButtons();
    toast(next === 'dislike' ? 'Disliked' : 'Dislike removed');
  } catch (e) { toast('Couldn’t dislike: ' + (e.message || 'error')); }
}

export async function toggleSubscribe() {
  if (!pstate.currentChannelId) { toast('No channel for this video'); return; }
  const next = !pstate.currentSubscribed;
  try {
    await window.tv.setSubscribed(pstate.currentChannelId, next);
    pstate.currentSubscribed = next; updateRatingButtons();
    toast(next ? 'Subscribed' : 'Unsubscribed');
  } catch (e) { toast('Couldn’t update subscription: ' + (e.message || 'error')); }
}

// Watch Later membership (lazy-loaded) so Save can TOGGLE add/remove.
export async function ensureWatchLater() {
  if (state.wlIds) return state.wlIds;
  try {
    const feed = await window.tv.playlistFeed('WL', 'Watch Later');
    state.wlIds = new Set((feed.videos || []).map((v) => v.id));
  } catch (e) { state.wlIds = new Set(); }
  return state.wlIds;
}

export function updateSaveButton() {
  const b = pBtn('save');
  if (b) b.classList.toggle('on', !!(state.wlIds && pstate.currentVideoId && state.wlIds.has(pstate.currentVideoId)));
}

export async function toggleWatchLater(id) {
  if (!id) return;
  await ensureWatchLater();
  const inWL = state.wlIds.has(id);
  try {
    if (inWL) { await window.tv.removeFromPlaylist('WL', id); state.wlIds.delete(id); toast('Removed from Watch Later'); }
    else { await window.tv.addToPlaylist('WL', id); state.wlIds.add(id); toast('Saved to Watch Later'); }
  } catch (e) { toast('Couldn’t update Watch Later: ' + (e.message || 'error')); return; }
  updateSaveButton();
}

export function saveToWatchLater() { toggleWatchLater(pstate.currentVideoId); }
