// SPDX-License-Identifier: GPL-3.0-or-later
// Feeds / sections / nav: section loaders, channel/playlist/channel-page drill-in
// + their Back handlers, the Home grid<->categories toggle, and infinite scroll
// (vertical load-more + horizontal shelf load-more + the feed-chunk appenders).
// Extracted from app.js (renderer split, s106). Clean leaf: no player deps.
// Nav (nav.js) and window.tv (preload) are globals; everything else is imported.

import { toast, busy } from './util.js';
import { grid, shelvesBox, title } from './dom.js';
import { state } from './state.js';
import {
  makeCard, makePlaylistCard, buildShelfRow, hideShortsOn,
  renderFeed, renderVideoGrid, renderChannels, renderPlaylists, renderMusic,
} from './render.js';

let lastOpenedPlaylistId = null; // the playlist card we opened, to restore focus on Back
let channelReturn = null;        // snapshot to return to after opening a channel from the context menu
let listOrigin = 'playlists';    // which list a playlist was opened from: 'playlists' | 'music'
let loadingMore = false;
let loadingShelf = false;
export const moreExhausted = new Set();

  function feedErrorHint(e) {
    if (/parse|parser|decipher|signature|innertube/i.test(e.message)) {
      toast('If this keeps happening, run: npm install youtubei.js@latest');
    }
  }

  function mergeShelvesInto(target, incoming) {
    const findIdx = (t) => target.findIndex((s) => s.title === t);
    for (const chunk of incoming) {
      const at = findIdx(chunk.title);
      if (at >= 0) target[at].videos.push(...chunk.videos);
      else if (chunk.title === 'More') target.push({ title: 'More', videos: chunk.videos.slice() });
      else {
        const moreIdx = findIdx('More');
        target.splice(moreIdx >= 0 ? moreIdx : target.length, 0, { title: chunk.title, videos: chunk.videos.slice() });
      }
    }
  }

  function applyMoreShelves(chunks) {
    const rowByTitle = (t) => {
      for (const r of shelvesBox.querySelectorAll('.shelf')) if (r.dataset.title === t) return r;
      return null;
    };
    for (const chunk of chunks) {
      if (!chunk.videos || !chunk.videos.length) continue;
      if (hideShortsOn() && /^shorts$/i.test(chunk.title || '')) continue; // drop the Shorts shelf
      const existing = rowByTitle(chunk.title);
      if (existing) {
        const strip = existing.querySelector('.shelf-strip');
        const shown = new Set(Array.from(strip.querySelectorAll('.card')).map((c) => c.dataset.id));
        for (const v of chunk.videos) if (v.id && !shown.has(v.id)) { strip.appendChild(makeCard(v)); shown.add(v.id); }
      } else if (chunk.title === 'More') {
        shelvesBox.appendChild(buildShelfRow(chunk));
      } else {
        const moreRow = rowByTitle('More');
        const row = buildShelfRow(chunk);
        if (moreRow) shelvesBox.insertBefore(row, moreRow);
        else shelvesBox.appendChild(row);
      }
    }
  }

  // Append a batch of videos / shelf chunks to the current view + currentFeed.
  // Shared by scroll load-more AND the background streaming chunks (s53).
  // dedupe=true for pushed chunks: they can interleave with scroll pulls, so
  // filter against what's already shown/held before appending.
  function applyFeedChunk(videos, shelves, dedupe) {
    if ((!videos || !videos.length) && (!shelves || !shelves.length)) return;
    videos = videos || []; shelves = shelves || [];
    if (dedupe && state.currentFeed && Array.isArray(state.currentFeed.videos)) {
      const have = new Set(state.currentFeed.videos.map((v) => v.id));
      videos = videos.filter((v) => v.id && !have.has(v.id));
    }
    if (state.currentFeed) {
      if (Array.isArray(state.currentFeed.videos)) state.currentFeed.videos.push(...videos);
      if (Array.isArray(state.currentFeed.shelves)) mergeShelvesInto(state.currentFeed.shelves, shelves);
    }
    if (Nav.mode === 'shelves') applyMoreShelves(shelves);
    else {
      const shown = dedupe ? new Set(Array.from(grid.querySelectorAll('.card')).map((c) => c.dataset.id)) : null;
      for (const v of videos) {
        if (shown && shown.has(v.id)) continue;
        grid.appendChild(makeCard(v));
      }
    }
    Nav.apply();
  }

  // Append streamed Music items (playlist/video cards) to the grid + state.currentMusic,
  // deduped by type+id. Music's item shape differs from applyFeedChunk's
  // videos/shelves, so it has its own appender (used by the s55 feed-chunk
  // streaming). Only called while Music is the visible grid.
  function appendMusicItems(items) {
    if (!items || !items.length) return;
    const key = (it) => it.type + ':' + it.id;
    const have = new Set((state.currentMusic || []).map(key));
    const fresh = items.filter((it) => it && it.id && !have.has(key(it)));
    if (!fresh.length) return;
    if (state.currentMusic) state.currentMusic.push(...fresh); else state.currentMusic = fresh.slice();
    for (const it of fresh) grid.appendChild(it.type === 'playlist' ? makePlaylistCard(it) : makeCard(it));
    Nav.apply();
  }

  async function maybeLoadMore(force) {
    if (loadingMore || !state.gridSection || state.mode !== 'browse') return;
    if (!force && !Nav.nearEnd()) return;
    if (moreExhausted.has(state.gridSection)) { window.tv.logError('load-more: ' + state.gridSection + ' marked exhausted (skipping)'); return; }
    loadingMore = true;
    const sec = state.gridSection; // the section this fetch is for (may change during the await)
    window.tv.logInfo('load-more: fetching for ' + sec); // diagnostic
    const busyTimer = setTimeout(() => busy(true), 400); // only surface if slow
    try {
      const res = await window.tv.more(sec, Nav.mode);
      // Async-gap guard: window.tv.more is a round-trip, so the user may have
      // navigated away or opened Settings while it was in flight. If the grid
      // section changed/nulled, we left browse mode, or the settings category grid
      // is now up (body.settings-cats), do NOT append -- else these feed cards
      // bleed onto whatever screen is now showing (the "videos appear on the
      // Settings grid at startup" bug: ensureFilled -> maybeLoadMore mid-fetch).
      if (state.gridSection !== sec || state.mode !== 'browse' || document.body.classList.contains('settings-cats')) return;
      if (res.items) { // music: mixed playlist/video cards
        if (res.items.length) {
          if (state.currentMusic) state.currentMusic.push(...res.items);
          for (const it of res.items) grid.appendChild(it.type === 'playlist' ? makePlaylistCard(it) : makeCard(it));
          Nav.apply();
        }
        // Latch only when the backend says the mood chips are genuinely used up
        // (exhausted:true). While a Music snapshot is showing and the refresh
        // hasn't armed the scroll cursor yet, exhausted is false -> keep retrying.
        if (res.exhausted === true || (res.exhausted === undefined && !res.items.length)) moreExhausted.add(state.gridSection);
      } else {
        const videos = res.videos || [];
        const shelves = res.shelves || [];
        applyFeedChunk(videos, shelves, false);
        // Latch only when the backend says there's genuinely nothing left (page
        // cursors gone + -- in grid view -- no unseen shelf tokens). A pull that
        // merely returned dupes this round is NOT the end: a later scroll retries
        // deeper. Legacy sections without the flag (search) latch on an empty pull.
        if (res.exhausted === true || (res.exhausted === undefined && !videos.length && !shelves.length)) {
          moreExhausted.add(state.gridSection);
        }
      }
    } catch (e) {
      window.tv.logError('load-more(' + state.gridSection + ') error: ' + (e && e.message));
      // moving again retries
    } finally {
      clearTimeout(busyTimer);
      busy(false);
      loadingMore = false;
    }
  }

  // Screen-fill: after a section first loads, make sure the grid fills the
  // viewport (plus a bit) so the user never sees a half-empty screen when the
  // first fetch returned only a few videos. Keeps fetching (bypassing the
  // near-end gate) until the content overflows, nothing more comes, or the
  // section is exhausted. Fire-and-forget; aborts if the user navigates away.
  async function ensureFilled(token) {
    const content = document.getElementById('content');
    if (!content) return;
    for (let guard = 0; guard < 6; guard++) {
      if (token !== state.loadToken || !state.gridSection || state.mode !== 'browse') return;
      if (moreExhausted.has(state.gridSection)) return;
      if (content.scrollHeight > content.clientHeight * 1.2) return; // filled + a bit
      const before = grid.children.length;
      await maybeLoadMore(true);
      if (token !== state.loadToken) return;
      if (grid.children.length === before) return; // nothing added -> stop
    }
  }

  // Horizontal (within-row) load-more: when the selector is on the LAST card of
  // a category shelf and the user presses Right, fetch more of THAT shelf and
  // append the new cards to its strip. Only fires in the
  // categories (shelves) view. 'More' (the leftover bucket) has no own tokens
  // so it's skipped -- it grows via the vertical grid load-more.
  async function maybeLoadMoreShelf() {
    if (loadingShelf || state.mode !== 'browse' || Nav.mode !== 'shelves') return;
    if (!Nav.atRowEnd()) return;
    const el = Nav.current();
    const row = el && el.closest && el.closest('.shelf');
    if (!row) return;
    const rowTitle = row.dataset.title;
    if (!rowTitle || rowTitle === 'More' || row.dataset.exhausted === '1') return;
    loadingShelf = true;
    const busyTimer = setTimeout(() => busy(true), 400);
    try {
      const res = await window.tv.moreShelf(state.gridSection, rowTitle);
      const fresh = (res && res.videos) || [];
      const shelfIds = (res && res.ids) || [];
      const exhausted = !!(res && res.exhausted);
      const strip = row.querySelector('.shelf-strip');
      const shown = new Set(Array.from(strip.querySelectorAll('.card')).map((c) => c.dataset.id));
      // Candidate objects: freshly fetched + everything we already hold flat
      // (shelf videos pulled into the flat grid by the vertical drain live here).
      const byId = new Map(((state.currentFeed && state.currentFeed.videos) || []).map((v) => [v.id, v]));
      for (const v of fresh) byId.set(v.id, v);
      // Append shelf-owned videos not yet in the strip, in shelf order.
      const orderedIds = shelfIds.length ? shelfIds : fresh.map((v) => v.id);
      const appended = [];
      for (const id of orderedIds) {
        if (!id || shown.has(id)) continue;
        const v = byId.get(id);
        if (!v) continue;
        strip.appendChild(makeCard(v)); shown.add(id); appended.push(v);
      }
      if (!appended.length) { if (exhausted) row.dataset.exhausted = '1'; return; }
      // Reflect into currentFeed.shelves so a grid<->categories toggle keeps them.
      if (state.currentFeed && Array.isArray(state.currentFeed.shelves)) {
        const sh = state.currentFeed.shelves.find((s) => s.title === rowTitle);
        if (sh) for (const v of appended) if (!sh.videos.some((x) => x.id === v.id)) sh.videos.push(v);
      }
      Nav.apply();
    } catch (e) {
      window.tv.logError('shelf load-more(' + rowTitle + ') error: ' + (e && e.message));
    } finally {
      clearTimeout(busyTimer);
      busy(false);
      loadingShelf = false;
    }
  }

  async function loadSection(section) {
    document.body.classList.remove('settings-cats'); // leave the settings fit-grid layout
    state.currentSection = section;
    const my = ++state.loadToken;
    state.gridSection = null;
    state.currentPlaylistId = null; state.currentPlaylistName = null;
    moreExhausted.delete(section);
    title.textContent = 'Loading…';
    grid.innerHTML = '';
    shelvesBox.innerHTML = '';
    try {
      if (section === 'home') {
        const feed = await window.tv.home();
        if (my !== state.loadToken) return; // user navigated away while loading -- don't steal focus
        // Boot loads Home fire-and-forget; if the user reached Settings while it
        // was fetching, the settings grid is up (body.settings-cats) -- don't paint
        // Home over it.
        if (document.body.classList.contains('settings-cats')) return;
        if (feed.fallback) toast('Personalized feed unavailable - showing Popular (details in log file)');
        renderFeed(feed);
        state.gridSection = 'home';
      } else if (section === 'subscriptions') {
        const { channels } = await window.tv.subscriptionChannels();
        if (my !== state.loadToken) return;
        state.subsChannels = channels;
        renderChannels(channels);
        // channel LIST has no video load-more
      } else if (section === 'playlists') {
        const { playlists } = await window.tv.playlists();
        if (my !== state.loadToken) return;
        state.currentPlaylists = playlists;
        listOrigin = 'playlists';
        renderPlaylists(playlists, 'Playlists');
        // playlist LIST has no video load-more
      } else if (section === 'music') {
        // Music = REAL YouTube Music (music.youtube.com): songs / music videos
        // (playable) + playlist cards (drill in), with infinite scroll.
        const { items } = await window.tv.music();
        if (my !== state.loadToken) return;
        state.currentMusic = items;
        listOrigin = 'music';
        renderMusic(items);
        state.gridSection = 'music';
      } else if (section === 'watchlater') {
        const feed = await window.tv.playlistFeed('WL', 'Watch Later');
        if (my !== state.loadToken) return;
        state.currentPlaylistId = 'WL'; state.currentPlaylistName = 'Watch Later';
        renderVideoGrid(feed);
        state.gridSection = 'playlist';
      } else {
        // Generic browse-id sections: trending, music, history (flat grid).
        const feed = await window.tv.section(section);
        if (my !== state.loadToken) return;
        renderVideoGrid(feed);
        state.gridSection = section;
      }
    } catch (e) {
      if (my !== state.loadToken) return;
      title.textContent = 'Failed to load: ' + e.message;
      feedErrorHint(e);
    }
    // Top up short first pages so the screen is fully populated (non-blocking).
    if (my === state.loadToken && state.gridSection) ensureFilled(my);
  }

  async function openChannel(name, channelKey) {
    state.currentSection = 'channel';
    const my = ++state.loadToken;
    state.gridSection = null;
    state.currentPlaylistId = null; state.currentPlaylistName = null;
    moreExhausted.delete('channel');
    title.textContent = 'Loading…';
    grid.innerHTML = '';
    shelvesBox.innerHTML = '';
    try {
      const params = channelKey === 'all' ? '' : channelKey;
      const feed = await window.tv.channelFeed(params, name);
      if (my !== state.loadToken) return;
      renderVideoGrid(feed);
      state.gridSection = 'channel';
    } catch (e) {
      if (my !== state.loadToken) return;
      title.textContent = 'Failed to load: ' + e.message;
      feedErrorHint(e);
    }
  }

  function backToChannels() {
    state.currentSection = 'subscriptions';
    state.gridSection = null;
    if (state.subsChannels) renderChannels(state.subsChannels);
    else loadSection('subscriptions');
  }

  async function openPlaylist(id, name) {
    state.currentSection = 'playlist';
    const my = ++state.loadToken;
    lastOpenedPlaylistId = id; // remember it so Back restores focus to this card
    state.gridSection = null;
    state.currentPlaylistId = id; state.currentPlaylistName = name;
    moreExhausted.delete('playlist');
    title.textContent = 'Loading…';
    grid.innerHTML = '';
    shelvesBox.innerHTML = '';
    try {
      const feed = await window.tv.playlistFeed(id, name);
      if (my !== state.loadToken) return;
      renderVideoGrid(feed);
      state.gridSection = 'playlist';
    } catch (e) {
      if (my !== state.loadToken) return;
      title.textContent = 'Failed to load: ' + e.message;
      feedErrorHint(e);
    }
  }

  function backToPlaylists() {
    state.currentSection = listOrigin; // 'playlists' | 'music'
    if (listOrigin === 'music') {
      state.gridSection = 'music';
      if (state.currentMusic) renderMusic(state.currentMusic); else loadSection('music');
    } else {
      state.gridSection = null;
      if (state.currentPlaylists) renderPlaylists(state.currentPlaylists, 'Playlists'); else loadSection('playlists');
    }
    // Restore focus to the playlist card we opened (if the list rendered
    // synchronously from cache; the loadSection fallback re-focuses first).
    if (lastOpenedPlaylistId) {
      const card = grid.querySelector('.card[data-playlist="' + lastOpenedPlaylistId + '"]');
      if (card) Nav.focusElement(card);
    }
  }

  // Open an arbitrary channel (from the video context menu). Back returns to
  // the screen we came from (one level), restored by backFromChannelPage.
  async function openChannelPage(channelId, name) {
    const _cur = Nav.current();
    channelReturn = {
      section: state.currentSection, feed: state.currentFeed, gridSection: state.gridSection,
      playlistId: state.currentPlaylistId, playlistName: state.currentPlaylistName,
      focusId: _cur && _cur.dataset ? (_cur.dataset.id || _cur.dataset.playlist || null) : null
    };
    state.currentSection = 'channelpage';
    const my = ++state.loadToken;
    state.gridSection = null;
    state.currentPlaylistId = null; state.currentPlaylistName = null;
    moreExhausted.delete('channelpage');
    title.textContent = 'Loading…';
    grid.innerHTML = '';
    shelvesBox.innerHTML = '';
    try {
      const feed = await window.tv.channelPage(channelId, name);
      if (my !== state.loadToken) return;
      renderVideoGrid(feed);
      state.gridSection = 'channelpage';
    } catch (e) {
      if (my !== state.loadToken) return;
      title.textContent = 'Failed to load: ' + e.message;
      feedErrorHint(e);
    }
  }

  // Return from a context-menu channel page to the screen we came from (one
  // level). Re-renders that screen from cache and restores the focused card.
  function backFromChannelPage() {
    const r = channelReturn;
    channelReturn = null;
    if (!r) return Nav.focusRail();
    state.currentSection = r.section;
    state.gridSection = r.gridSection;
    state.currentPlaylistId = r.playlistId;
    state.currentPlaylistName = r.playlistName;
    if (r.section === 'subscriptions' && state.subsChannels) renderChannels(state.subsChannels);
    else if (r.section === 'playlists' && state.currentPlaylists) renderPlaylists(state.currentPlaylists, 'Playlists');
    else if (r.section === 'music' && state.currentMusic) renderMusic(state.currentMusic);
    else if (r.feed && r.section === 'home') renderFeed(r.feed);
    else if (r.feed) renderVideoGrid(r.feed);
    else return loadSection(r.section || 'home');
    if (r.focusId) {
      const el = grid.querySelector('.card[data-id="' + r.focusId + '"], .card[data-playlist="' + r.focusId + '"]');
      if (el) Nav.focusElement(el);
    }
  }

export {
  feedErrorHint, applyFeedChunk, appendMusicItems,
  maybeLoadMore, maybeLoadMoreShelf, loadSection, openChannel, backToChannels,
  openPlaylist, backToPlaylists, openChannelPage, backFromChannelPage,
};
