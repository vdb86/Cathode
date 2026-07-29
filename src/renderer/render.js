// SPDX-License-Identifier: GPL-3.0-or-later
// Feed rendering: builds video/channel/playlist cards and paints the grid or
// category shelves. Extracted from app.js (renderer ES-module split, s95).
// Shared state (currentFeed, viewMode) lives in state.js; the #grid/#shelves/
// #section-title DOM handles come from dom.js. Nav / Settings / window.tv are
// classic-script globals.

import { $, show, hide } from './util.js';
import { grid, shelvesBox, title } from './dom.js';
import { state } from './state.js';

// ---------- rendering ----------

// DeArrow: swap in a crowdsourced title / thumbnail when enabled. Fire and
// forget; main gates on the DeArrow settings and returns nulls when it is off
// or has no data, so the YouTube title/thumbnail stays as-is.
function applyDeArrow(titleEl, imgEl, id) {
  if (!id || !window.tv.dearrowBranding) return;
  if (!Settings.da || !Settings.da('enabled')) return;
  window.tv.dearrowBranding(id).then((b) => {
    if (!b) return;
    if (b.title && titleEl) titleEl.textContent = b.title;
    if (b.thumbnail && imgEl) {
      // The DeArrow thumbnail generator can return 204 (queued / couldn't
      // generate) -> a blank image. Fail safe: if the swapped thumbnail fails
      // to load, revert to YouTube's original so no card is left blank.
      const orig = imgEl.src;
      imgEl.onerror = () => { imgEl.onerror = null; if (orig) imgEl.src = orig; };
      imgEl.src = b.thumbnail;
    }
  }).catch(() => {});
}
// Whether Shorts should be hidden (Settings > Interface > Hide Shorts). Read
// live so a change applies the next time a feed is rendered.
export function hideShortsOn() {
  return typeof Settings !== 'undefined' && Settings.get && !!Settings.get('hideShorts');
}
export function makeCard(v) {
  // Hide Shorts: return an empty fragment (appends nothing) so every render path
  // that calls makeCard drops the tile without extra per-caller checks.
  if (v && v.isShort && hideShortsOn()) return document.createDocumentFragment();
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = v.id;
  card.innerHTML = `
    <div class="thumb">
      <img loading="lazy" alt="" />
    </div>
    <div class="meta">
      <div class="title"></div>
      <div class="card-meta"></div>
    </div>`;
  card.querySelector('img').src = v.thumbnail || '';
  card.querySelector('.title').textContent = v.title;
  if (v.channelId) { card.dataset.channelId = v.channelId; card.dataset.author = v.author || ''; }
  if (v.feedbackToken) card.dataset.feedbackToken = v.feedbackToken;

  // Bottom-right thumbnail overlay: LIVE badge for live, else the duration.
  const thumb = card.querySelector('.thumb');
  if (v.isLive) {
    const b = document.createElement('span');
    b.className = 'badge-live';
    b.textContent = 'LIVE';
    thumb.appendChild(b);
  } else if (v.duration) {
    const b = document.createElement('span');
    b.className = 'badge-duration';
    b.textContent = v.duration;
    thumb.appendChild(b);
  }

  // Watched progress (from YouTube's resume overlay, percentWatched 0-100): a
  // red bar along the bottom of the thumbnail, plus a "watched" check once it's
  // essentially finished. Never on live tiles (a live stream isn't "watched").
  if (!v.isLive && typeof v.percentWatched === 'number' && v.percentWatched > 0) {
    const bar = document.createElement('div');
    bar.className = 'card-progress';
    const fill = document.createElement('div');
    fill.className = 'card-progress-fill';
    fill.style.width = Math.min(100, v.percentWatched) + '%';
    bar.appendChild(fill);
    thumb.appendChild(bar);
    if (v.percentWatched >= 90) {
      const w = document.createElement('span');
      w.className = 'badge-watched';
      w.textContent = '✓ Watched';
      thumb.appendChild(w);
    }
  }

  // One merged meta line under the title: channel • views • upload date.
  const metaText = [v.author, v.views, v.published].filter(Boolean).join(' • ');
  const metaEl = card.querySelector('.card-meta');
  metaEl.textContent = metaText;
  if (!metaText) metaEl.style.display = 'none';

  // Like/dislike counts on the card (Settings > Interface > Like / dislike
  // counts on cards). One RYD lookup per card (cached + deduped main-side).
  if (typeof Settings !== 'undefined' && Settings.get && Settings.get('ratingCountsCards') && !v.isLive && window.tv.rydGet) {
    const rEl = document.createElement('div');
    rEl.className = 'card-ratings';
    card.querySelector('.meta').appendChild(rEl);
    window.tv.rydGet(v.id).then((r) => {
      if (r && r.ok) rEl.textContent = '👍 ' + (r.likesText || '0') + '   👎 ' + (r.dislikesText || '0');
    }).catch(() => {});
  }

  applyDeArrow(card.querySelector('.title'), card.querySelector('img'), v.id);
  return card;
}
function makeChannelCard(ch) {
  const card = document.createElement('div');
  card.className = 'card channel-card';
  card.dataset.channel = ch.params || 'all';
  card.dataset.name = ch.name;
  if (ch.avatar) {
    const img = document.createElement('img');
    img.className = 'channel-avatar';
    img.loading = 'lazy';
    img.src = ch.avatar;
    card.appendChild(img);
  }
  const name = document.createElement('div');
  name.className = 'channel-name';
  name.textContent = ch.name;
  card.appendChild(name);
  return card;
}
export function makePlaylistCard(pl) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.playlist = pl.id;
  card.dataset.name = pl.title;
  card.innerHTML = `
    <div class="thumb">
      <img loading="lazy" alt="" />
    </div>
    <div class="meta">
      <div class="title"></div>
      <div class="card-meta"></div>
    </div>`;
  card.querySelector('img').src = pl.thumbnail || '';
  card.querySelector('.title').textContent = pl.title;
  card.querySelector('.card-meta').textContent = pl.count || 'Playlist';
  return card;
}
export function feedHasShelves(feed) {
  return feed && Array.isArray(feed.shelves) && feed.shelves.some((s) => s.videos && s.videos.length);
}
function renderGrid(feed) {
  document.body.classList.remove('pl-list'); // playlists 'list' layout is playlists-only
  grid.innerHTML = '';
  for (const v of feed.videos) grid.appendChild(makeCard(v));
}
export function buildShelfRow(shelf) {
  const row = document.createElement('div');
  row.className = 'shelf';
  row.dataset.title = shelf.title;
  const h = document.createElement('div');
  h.className = 'shelf-title';
  h.textContent = shelf.title;
  const strip = document.createElement('div');
  strip.className = 'shelf-strip';
  for (const v of shelf.videos) strip.appendChild(makeCard(v));
  row.appendChild(h);
  row.appendChild(strip);
  return row;
}
function renderShelves(feed) {
  shelvesBox.innerHTML = '';
  for (const shelf of feed.shelves) {
    if (!shelf.videos || !shelf.videos.length) continue;
    if (hideShortsOn() && /^shorts$/i.test(shelf.title || '')) continue; // drop the whole Shorts shelf
    shelvesBox.appendChild(buildShelfRow(shelf));
  }
}
// Render currentFeed in the active view (Home only). Falls back to grid when
// the feed has no shelves.
export function applyView() {
  const feed = state.currentFeed;
  if (!feed) return;
  title.textContent = feed.title;

  if (state.viewMode === 'shelves' && feedHasShelves(feed)) {
    renderShelves(feed);
    show('shelves'); hide('grid');
    Nav.setLayout('shelves');
  } else {
    renderGrid(feed);
    show('grid'); hide('shelves');
    Nav.setLayout('grid');
  }
  Nav.resetContent();
  $('content').scrollTop = 0;
  if (!feed.videos.length) {
    title.textContent += (feed.signedIn === false)
      ? ' - nothing to show yet; try Search, or sign in for recommendations'
      : ' (empty)';
  }
  Nav.apply();
}
export function renderFeed(feed) {
  state.currentFeed = feed;
  applyView();
}
// Plain video grid (used by search + channel views - no categories toggle).
export function renderVideoGrid(feed) {
  state.currentFeed = feed;
  title.textContent = feed.title;
  renderGrid(feed);
  show('grid'); hide('shelves');
  Nav.setLayout('grid');
  Nav.resetContent();
  $('content').scrollTop = 0;
  if (!feed.videos.length) title.textContent += ' (empty)';
  Nav.apply();
}
export function renderChannels(channels) {
  state.currentFeed = null;
  document.body.classList.remove('pl-list');
  title.textContent = 'Subscriptions';
  shelvesBox.innerHTML = '';
  grid.innerHTML = '';
  const list = Settings.get('channelSort') === 'az'
    ? channels.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    : channels;
  for (const ch of list) grid.appendChild(makeChannelCard(ch));
  show('grid'); hide('shelves');
  Nav.setLayout('grid');
  Nav.resetContent();
  $('content').scrollTop = 0;
  Nav.apply();
}
export function renderPlaylists(playlists, titleText) {
  const label = titleText || 'Playlists';
  state.currentFeed = null;
  document.body.classList.toggle('pl-list', Settings.get('playlistLayout') === 'list');
  title.textContent = playlists.length ? label : (label + ' (empty)');
  shelvesBox.innerHTML = '';
  grid.innerHTML = '';
  for (const pl of playlists) grid.appendChild(makePlaylistCard(pl));
  show('grid'); hide('shelves');
  Nav.setLayout('grid');
  Nav.resetContent();
  $('content').scrollTop = 0;
  Nav.apply();
}
// Music: a mixed grid of curated playlist cards + video cards. `titleText`
// lets Music 2 (real YouTube Music) reuse the same renderer with its label.
export function renderMusic(items, titleText) {
  state.currentFeed = null;
  document.body.classList.remove('pl-list');
  const label = titleText || 'Music';
  title.textContent = items.length ? label : (label + ' (empty)');
  shelvesBox.innerHTML = '';
  grid.innerHTML = '';
  for (const it of items) grid.appendChild(it.type === 'playlist' ? makePlaylistCard(it) : makeCard(it));
  show('grid'); hide('shelves');
  Nav.setLayout('grid');
  Nav.resetContent();
  $('content').scrollTop = 0;
  Nav.apply();
}
