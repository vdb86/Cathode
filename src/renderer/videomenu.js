// SPDX-License-Identifier: GPL-3.0-or-later
// Video context menu builders: the popup that long-pressing a video card opens
// (Play / Play next / Add to queue / Open channel / Remove from playlist|history
// / Save-to Watch Later / Add to playlist...). Extracted from app.js (renderer
// ES-module split, s101). These drive the generic overlay engine in menu.js.
//
// The player/nav actions the items trigger (play, queue ops, open channel/
// playlist, Watch Later toggle) live mid-file in app.js, so they're injected
// via initVideoMenu rather than imported (importing app.js would be a cycle).
// Nav + window.tv are classic-script globals; the feed caches live on state.

import { toast } from './util.js';
import { grid } from './dom.js';
import { state } from './state.js';
import { showMenu, renderMenu, closeMenu } from './menu.js';
import { quickDownload, openFormatMenu } from './downloads.js';

let menuVideo = null; // {id, channelId, author, feedbackToken, thumbnail, title} the menu targets

// Injected app.js actions (set at boot by initVideoMenu).
let play = () => {};
let addToQueue = () => {};
let removeFromQueue = () => {};
let openChannelPage = () => {};
let toggleWatchLater = () => {};
let openPlaylist = () => {};

export function initVideoMenu(deps) {
  play = deps.play;
  addToQueue = deps.addToQueue;
  removeFromQueue = deps.removeFromQueue;
  openChannelPage = deps.openChannelPage;
  toggleWatchLater = deps.toggleWatchLater;
  openPlaylist = deps.openPlaylist;
}

async function menuAdd(playlistId, label) {
  try {
    await window.tv.addToPlaylist(playlistId, menuVideo.id);
    toast('Added to ' + label);
  } catch (e) {
    toast('Couldn’t add: ' + (e.message || 'error'));
  }
  closeMenu();
}

async function openPlaylistPicker() {
  renderMenu([{ label: 'Loading…', run: () => {} }], 'Add to playlist');
  let playlists = [];
  try { playlists = (await window.tv.playlists(true)).playlists || []; } // force a fresh sync each time
  catch (e) { toast('Couldn’t load playlists'); return closeMenu(); }
  // Liked videos (id 'LL' / "Liked videos") isn't a real add target - drop it.
  playlists = playlists.filter((pl) => pl.id !== 'LL' && !/^liked\b/i.test(pl.title || ''));
  // NOTE: no 'New playlist' option - the TVHTML5 client can't create real
  // YouTube playlists (playlist/create 400s; the TV client's own "create"
  // makes a local-only playlist that never syncs).
  const items = playlists.map((pl) => ({ label: pl.title, run: () => menuAdd(pl.id, pl.title) }));
  if (!items.length) items.push({ label: '(no playlists found)', run: () => {} });
  renderMenu(items, 'Add to playlist', showMainMenu);
}

function showMainMenu() {
  const v = menuVideo;
  const items = [];
  items.push({ label: 'Play', run: () => { closeMenu(); play(v.id); } });
  items.push({ label: 'Play next', run: () => { closeMenu(); addToQueue(v, true); } });
  items.push({ label: 'Add to queue', run: () => { closeMenu(); addToQueue(v, false); } });
  if (state.currentSection === 'queue') items.push({ label: 'Remove from queue', run: () => { closeMenu(); removeFromQueue(v.id); } });
  if (v.channelId) items.push({ label: 'Open channel', run: () => { closeMenu(); openChannelPage(v.channelId, v.author); } });
  // Inside a playlist / Watch Later: offer to remove this video from it.
  if (state.currentPlaylistId) items.push({ label: 'Remove from ' + (state.currentPlaylistName || 'playlist'), run: () => menuRemoveFromPlaylist() });
  if (state.currentSection === 'history' && v.feedbackToken) items.push({ label: 'Remove from history', run: () => menuRemoveFromHistory() });
  if (state.currentPlaylistId !== 'WL') {
    const inWL = state.wlIds && state.wlIds.has(v.id);
    items.push({ label: inWL ? 'Remove from Watch Later' : 'Save to Watch Later', run: () => { closeMenu(); toggleWatchLater(v.id); } });
  }
  items.push({ label: 'Add to playlist…', run: () => openPlaylistPicker() });
  items.push({ label: 'Quick download', run: () => { closeMenu(); quickDownload({ videoId: v.id, title: v.title }); } });
  items.push({ label: 'Advanced download', run: () => openFormatMenu({ videoId: v.id, title: v.title }, false, showMainMenu) });
  renderMenu(items, v.title);
}

export function openVideoMenu(el) {
  menuVideo = {
    id: el.dataset.id,
    channelId: el.dataset.channelId || '',
    author: el.dataset.author || '',
    feedbackToken: el.dataset.feedbackToken || '',
    thumbnail: el.querySelector('img') ? el.querySelector('img').src : '',
    title: el.querySelector('.title') ? el.querySelector('.title').textContent : ''
  };
  showMenu();
  showMainMenu();
}

// After removing a card, keep the selector where the user was: focus the
// card that slid into the removed one's place (next sibling), else the
// previous card, else fall back to the first item. Without this the removal
// handlers called Nav.resetContent(), which jumped the selector to position 0.
function removeCardKeepFocus(card) {
  if (!card) { Nav.resetContent(); Nav.apply(); return; }
  let nb = card.nextElementSibling;
  if (!nb || !nb.classList.contains('card')) nb = card.previousElementSibling;
  if (nb && !nb.classList.contains('card')) nb = null;
  card.remove();
  if (nb && nb.isConnected) Nav.focusElement(nb);
  else { Nav.resetContent(); Nav.apply(); }
}

// Remove the focused video from the playlist / Watch Later we're viewing.
async function menuRemoveFromPlaylist() {
  const plId = state.currentPlaylistId;
  const plName = state.currentPlaylistName || 'playlist';
  const vidId = menuVideo.id;
  closeMenu();
  toast('Removing…');
  try {
    await window.tv.removeFromPlaylist(plId, vidId);
    toast('Removed from ' + plName);
    if (plId === 'WL' && state.wlIds) state.wlIds.delete(vidId);
    if (state.currentFeed && Array.isArray(state.currentFeed.videos)) state.currentFeed.videos = state.currentFeed.videos.filter((x) => x.id !== vidId);
    removeCardKeepFocus(grid.querySelector('.card[data-id="' + vidId + '"]'));
  } catch (e) {
    toast('Couldn’t remove: ' + (e.message || 'error'));
  }
}

// Remove the focused video from the account's watch History.
async function menuRemoveFromHistory() {
  const token = menuVideo.feedbackToken;
  const vidId = menuVideo.id;
  closeMenu();
  toast('Removing…');
  try {
    await window.tv.removeFromHistory(token);
    toast('Removed from history');
    if (state.currentFeed && Array.isArray(state.currentFeed.videos)) state.currentFeed.videos = state.currentFeed.videos.filter((x) => x.id !== vidId);
    removeCardKeepFocus(grid.querySelector('.card[data-id="' + vidId + '"]'));
  } catch (e) {
    toast('Couldn’t remove: ' + (e.message || 'error'));
  }
}

// Long-press on a playlist card (Open / Remove). NOTE: currently UNWIRED -- the
// input router only opens a menu for video cards (data-id), because the TV
// client can't delete a real YouTube playlist (playlist/delete 400s). Kept
// intact for a possible future wiring; exported so a caller could use it.
export function openPlaylistCardMenu(el) {
  const id = el.dataset.playlist;
  const name = el.dataset.name || 'this playlist';
  menuVideo = null;
  showMenu();
  renderMenu([
    { label: 'Open', run: () => { closeMenu(); openPlaylist(id, name); } },
    { label: 'Remove playlist', run: () => removePlaylistCard(id, name) }
  ], name);
}

async function removePlaylistCard(id, name) {
  closeMenu();
  toast('Removing…');
  try {
    await window.tv.removePlaylist(id);
    toast('Removed “' + name + '”');
    if (state.currentPlaylists) state.currentPlaylists = state.currentPlaylists.filter((p) => p.id !== id);
    removeCardKeepFocus(grid.querySelector('.card[data-playlist="' + id + '"]'));
  } catch (e) {
    toast('Couldn’t remove: ' + (e.message || 'error'));
  }
}
