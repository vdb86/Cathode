// SPDX-License-Identifier: GPL-3.0-or-later
// Download feature (renderer leaf, s122). The player + context-menu download
// actions, the live download-queue cache, the Downloads sidebar screen, the
// advanced "choose format" popup, and completion toasts. All the heavy lifting
// (spawning yt-dlp, the serial queue, progress, notifications) is main-side in
// main/downloads.js; this module is the UI + a mirror of the queue state pushed
// over IPC (window.tv.onDlQueueUpdate).
//
// Follows the s117 split rule: a leaf module, imported by app.js / playeractions
// / videomenu; it imports only sideways (util/dom/state/pstate/menu/transport)
// and never back, so the graph stays acyclic.

import { $, show, hide, toast } from './util.js';
import { grid, shelvesBox, title } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';
import { showMenu, renderMenu, closeMenu } from './menu.js';
import { pBtn, showTransport } from './transport.js';

let q = [];            // mirror of the main-side queue, newest-last
let dlReady = false;   // both binaries installed (gates the rail item)

export function initDownloads() {
  if (window.tv.onDlQueueUpdate) window.tv.onDlQueueUpdate(onQueue);
  if (window.tv.onDlNotify) window.tv.onDlNotify((n) => { if (n && n.toast) toast(n.text); });
  if (window.tv.onDlStateChange) window.tv.onDlStateChange((st) => { dlReady = !!(st && st.ready); updateRail(); });
  // Gate the rail item on a FAST file-existence check (no --version spawn) so it
  // is correct almost immediately at boot, instead of popping in seconds later
  // after the slower full dlState() resolves.
  if (window.tv.dlReady) window.tv.dlReady().then((r) => { dlReady = !!r; updateRail(); }).catch(() => {});
  else if (window.tv.dlState) window.tv.dlState().then((st) => { dlReady = !!(st && st.ready); updateRail(); }).catch(() => {});
  if (window.tv.dlQueue) window.tv.dlQueue().then((list) => { q = list || []; refreshDownloadButton(); updateRail(); }).catch(() => {});
}

const ACTIVE = ['queued', 'downloading', 'merging', 'paused'];
const FINISHED = ['done', 'error', 'canceled', 'skipped'];
const isFinished = (it) => FINISHED.includes(it.status);

function onQueue(list) {
  const prevIds = q.map((i) => i.id).join(',');
  const prevFin = q.some(isFinished);
  q = list || [];
  refreshDownloadButton();
  updateRail();
  if (state.currentSection !== 'downloads') return;
  // Rebuild when items are added/removed OR when the "any finished" state changes
  // (so the "Clear finished" card appears the moment a download completes while the
  // screen is open); otherwise just patch progress in place to keep focus.
  if (q.map((i) => i.id).join(',') !== prevIds || q.some(isFinished) !== prevFin) {
    // A rebuild wipes the focused card and Nav would fall back to the rail. If the
    // cursor was in the downloads content, remember it and re-focus the same card
    // after, so a completing download (which adds "Clear finished") doesn't bounce
    // the cursor onto the rail.
    const cur = Nav && Nav.current && Nav.current();
    const inContent = !!(cur && Nav.zone !== 'rail' && cur.classList && cur.classList.contains('dl-card'));
    const focusedId = inContent && cur.dataset ? (cur.dataset.id || '') : '';
    const wasClear = inContent && cur.dataset && cur.dataset.action === 'clear';
    renderScreen();
    if (inContent) {
      let target = focusedId ? grid.querySelector('.dl-card[data-id="' + focusedId + '"]') : null;
      if (!target && wasClear) target = grid.querySelector('.dl-clear');
      if (!target) target = grid.querySelector('.dl-card');
      if (target && Nav.focusElement) Nav.focusElement(target);
    }
  } else patchScreen();
}

// The Downloads rail item is shown once the binaries are installed (regardless of
// whether anything is queued). It also carries a count badge = number of items in
// the queue (any status), hidden when the queue is empty.
function updateRail() {
  const item = document.querySelector('.rail-item[data-section="downloads"]');
  if (!item) return;
  item.classList.toggle('hidden', !dlReady);
  let badge = item.querySelector('.rail-count');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'rail-count';
    (item.querySelector('.rail-ic') || item).appendChild(badge); // sits on the icon corner
  }
  badge.textContent = q.length ? String(q.length) : '';
  badge.classList.toggle('hidden', !q.length);
}

// ---- player transport button ----
function currentDownload() {
  const id = pstate.currentVideoId;
  return id ? q.find((it) => it.videoId === id && ACTIVE.includes(it.status)) : null;
}
export function refreshDownloadButton() {
  const b = pBtn('download');
  if (b) b.classList.toggle('on', !!currentDownload());
}

// Player download button (tap). Quick-download the current video; if it's
// already downloading, offer to cancel (a player-safe menu that returns to the
// player, not to browse).
export function quickDownloadCurrent() {
  const id = pstate.currentVideoId;
  if (!id) { toast('No video to download'); return; }
  const dl = currentDownload();
  if (dl) {
    openMenuFromPlayer([
      { label: 'Cancel download', run: () => window.tv.dlCancel(dl.id) },
      { label: 'Keep downloading', run: () => {} }
    ], 'Download in progress');
    return;
  }
  enqueue({ videoId: id, title: (pstate.currentVideoObj && pstate.currentVideoObj.title) || '' });
}

// Context-menu quick download (from a video card).
export function quickDownload(info) {
  if (!info || !info.videoId) return;
  enqueue({ videoId: info.videoId, url: info.url, title: info.title || '' });
}

function enqueue(info) {
  window.tv.dlEnqueue(info).then((r) => {
    if (r && r.ok) toast('Added to downloads');
    else toast('Could not start download');
  }).catch(() => toast('Could not start download'));
}

// ---- advanced download popup (shared by player hold-OK + context menu) ----
// One screen of options, seeded from the global download settings:
//   Type (Video/Audio), Container, Quality (the REAL available-formats list),
//   Thumbnail, Metadata, Chapters, Subtitles, SponsorBlock, then Download.
// Every choice is a per-download override. fromPlayer=true keeps us in the player
// on close; else it's a normal menu sub-view (onBack returns to the context menu).
const VC_OPTS = [
  { v: 'mp4', label: 'MP4 (most compatible)' }, { v: 'mkv', label: 'MKV' }, { v: 'webm', label: 'WebM' },
  { v: 'mov', label: 'MOV' }, { v: 'avi', label: 'AVI' }, { v: 'flv', label: 'FLV' }
];
const AC_OPTS = [
  { v: 'mp3', label: 'MP3' }, { v: 'm4a', label: 'M4A (AAC)' }, { v: 'opus', label: 'Opus' },
  { v: 'aac', label: 'AAC' }, { v: 'flac', label: 'FLAC' }, { v: 'wav', label: 'WAV' }, { v: 'vorbis', label: 'Vorbis' }
];
// Output audio bitrate (target for the mp3/m4a/etc conversion). '' = best (source).
const AB_OPTS = [
  { v: '', label: 'Best (source)' }, { v: '320K', label: '320 kbps' }, { v: '256K', label: '256 kbps' },
  { v: '192K', label: '192 kbps' }, { v: '128K', label: '128 kbps' }, { v: '96K', label: '96 kbps' }, { v: '64K', label: '64 kbps' }
];
function labelOf(opts, v) { const o = opts.find((x) => x.v === v); return o ? o.label : String(v); }
const onoff = (b) => (b ? 'On' : 'Off');

export function openFormatMenu(info, fromPlayer, onBack) {
  if (!info || !info.videoId) return;
  warmDownloadFormats(info.videoId, info.url); // start the format fetch now so Quality opens fast
  const close = fromPlayer ? closeToPlayer : closeMenu;
  const back = fromPlayer ? closeToPlayer : (onBack || closeMenu);
  showMenu();
  renderMenu([{ label: 'Loading options…', run: () => {} }], 'Advanced download', back);
  Promise.resolve(window.tv.dlGetSettings ? window.tv.dlGetSettings() : null).then((s) => {
    s = s || {};
    // Per-download selection, seeded from the global settings. format = a specific
    // itag chosen from the Quality list; '' means best for the current Type.
    const sel = {
      mode: (s.type ? s.type === 'audio' : s.audioOnly) ? 'audio' : 'video',
      container: s.container || 'mp4',
      audioContainer: s.audioContainer || 'mp3',
      audioBitrate: s.audioBitrate || '',
      format: '', formatLabel: 'Best available',
      audioLang: '', audioItag: 0, audioTrackId: '', // explicit audio pick for the SABR downloader
      embedThumbnail: s.embedThumbnail !== false,
      embedMetadata: s.embedMetadata !== false,
      embedChapters: s.embedChapters !== false,
      subtitles: !!s.subtitles,
      sponsorblock: (s.sponsorblock && s.sponsorblock !== 'off') ? s.sponsorblock : 'off'
    };
    let cachedFormats = null; // yt-dlp format list, fetched once when Quality is opened

    const render = () => {
      const rows = [];
      rows.push({ label: 'Type: ' + (sel.mode === 'audio' ? 'Audio' : 'Video'), run: () => { sel.mode = sel.mode === 'audio' ? 'video' : 'audio'; sel.format = ''; sel.formatLabel = 'Best available'; render(); } });
      rows.push(sel.mode === 'audio'
        ? { label: 'Container: ' + labelOf(AC_OPTS, sel.audioContainer), run: () => drill('Container', AC_OPTS, 'audioContainer') }
        : { label: 'Container: ' + labelOf(VC_OPTS, sel.container), run: () => drill('Container', VC_OPTS, 'container') });
      rows.push({ label: (sel.mode === 'audio' ? 'Audio quality: ' : 'Video quality: ') + sel.formatLabel, run: () => openQuality() });
      if (sel.mode === 'audio') rows.push({ label: 'Audio bitrate: ' + labelOf(AB_OPTS, sel.audioBitrate), run: () => drill('Audio bitrate', AB_OPTS, 'audioBitrate') });
      rows.push({ label: 'Thumbnail: ' + onoff(sel.embedThumbnail), run: () => { sel.embedThumbnail = !sel.embedThumbnail; render(); } });
      rows.push({ label: 'Metadata: ' + onoff(sel.embedMetadata), run: () => { sel.embedMetadata = !sel.embedMetadata; render(); } });
      rows.push({ label: 'Chapters: ' + onoff(sel.embedChapters), run: () => { sel.embedChapters = !sel.embedChapters; render(); } });
      // Subtitles only apply to video downloads.
      if (sel.mode !== 'audio') rows.push({ label: 'Subtitles: ' + onoff(sel.subtitles), run: () => { sel.subtitles = !sel.subtitles; render(); } });
      rows.push({ label: 'SponsorBlock: ' + onoff(sel.sponsorblock !== 'off'), run: () => { sel.sponsorblock = sel.sponsorblock === 'off' ? 'remove' : 'off'; render(); } });
      rows.push({ label: 'Download', run: () => { close(); enqueue({ videoId: info.videoId, url: info.url, title: info.title, format: sel.format || undefined, opts: buildOpts(sel) }); } });
      // keepIndex: this menu rebuilds itself in place on every toggle; preserve
      // the cursor so it does not jump back to the top (Type/Thumbnail/etc).
      renderMenu(rows, 'Advanced download', back, true);
    };

    // Simple option drill (container).
    const drill = (label, opts, key) => {
      renderMenu(opts.map((o) => ({ label: (o.v === sel[key] ? '• ' : '') + o.label, run: () => { sel[key] = o.v; render(); } })), label, render);
    };

    // Quality = the REAL available formats (the old "specific formats" list),
    // filtered to the current Type, plus a "Best available" option on top.
    const openQuality = () => {
      const title = sel.mode === 'audio' ? 'Audio quality' : 'Video quality';
      const buildList = (formats) => {
        const items = [{ label: (sel.format === '' ? '• ' : '') + 'Best available', run: () => { sel.format = ''; sel.formatLabel = 'Best available'; sel.audioLang = ''; sel.audioItag = 0; sel.audioTrackId = ''; render(); } }];
        for (const f of formats) {
          if ((f.kind || 'video') !== (sel.mode === 'audio' ? 'audio' : 'video')) continue;
          // Match on the full label so several formats sharing a yt-dlp selector
          // (e.g. two bitrates of the same language) stay individually selectable.
          const chosen = sel.formatLabel === f.label;
          items.push({ label: (chosen ? '• ' : '') + f.label, run: () => {
            sel.format = f.format; sel.formatLabel = f.label;
            sel.audioLang = f.audioLang || ''; sel.audioItag = f.itag || 0; sel.audioTrackId = f.audioTrackId || '';
            render();
          } });
        }
        renderMenu(items, title, render);
      };
      if (cachedFormats) return buildList(cachedFormats);
      renderMenu([{ label: 'Loading formats…', run: () => {} }], title, render);
      window.tv.dlFormats(info.videoId, info.url).then((r) => {
        if (state.mode !== 'menu') return;
        if (!r || !r.ok || !r.formats || !r.formats.length) { renderMenu([{ label: (r && r.error) || 'No formats available', run: render }], title, render); return; }
        cachedFormats = r.formats;
        buildList(cachedFormats);
      }).catch(() => { if (state.mode === 'menu') renderMenu([{ label: 'Could not read formats', run: render }], title, render); });
    };

    render();
  }).catch(() => { if (state.mode === 'menu') renderMenu([{ label: 'Could not load options', run: close }], 'Advanced download', back); });
}

// The per-download override object passed to enqueue (merged over global settings
// by main's buildArgs). format is passed separately (as item.format).
function buildOpts(sel) {
  return {
    type: sel.mode === 'audio' ? 'audio' : 'video',  // main prefers `type` over the legacy audioOnly
    audioOnly: sel.mode === 'audio',
    container: sel.container,
    audioContainer: sel.audioContainer,
    audioBitrate: sel.audioBitrate,
    // Explicit audio pick (SABR downloader targets the exact track / bitrate).
    audioLang: sel.mode === 'audio' ? (sel.audioLang || '') : '',
    audioItag: sel.mode === 'audio' ? (sel.audioItag || 0) : 0,
    audioTrackId: sel.mode === 'audio' ? (sel.audioTrackId || '') : '',
    embedThumbnail: sel.embedThumbnail,
    embedMetadata: sel.embedMetadata,
    embedChapters: sel.embedChapters,
    subtitles: sel.subtitles,
    sponsorblock: sel.sponsorblock
  };
}

// Player hold-OK on the download button.
export function openDownloadAdvanced() {
  const id = pstate.currentVideoId;
  if (!id) { toast('No video to download'); return; }
  openFormatMenu({ videoId: id, title: (pstate.currentVideoObj && pstate.currentVideoObj.title) || '' }, true);
}

// Warm the format cache for a video when playback starts / the popup opens, so the
// Quality list opens fast. Fire-and-forget; main no-ops if not ready.
export function warmDownloadFormats(videoId, url) {
  if (!videoId || !window.tv.dlPrefetchFormats) return;
  window.tv.dlPrefetchFormats(videoId, url).catch(() => {});
}

// A menu opened from the player: on any exit, hide the overlay and hand input
// back to the player (the generic menu engine's closeMenu would drop to browse).
function openMenuFromPlayer(items, titleText) {
  showMenu();
  renderMenu(items.map((it) => ({ label: it.label, run: () => { closeToPlayer(); if (it.run) it.run(); } })), titleText, closeToPlayer);
}
function closeToPlayer() {
  hide('menu-overlay');
  state.mode = 'player';
  showTransport();
}

// ---- Downloads sidebar screen ----
export function openScreen() {
  document.body.classList.remove('settings-cats'); // in case we came from Settings
  state.currentSection = 'downloads';
  state.gridSection = null;
  state.mode = 'browse';
  updateRail(); // keep the rail item visible while its screen is open
  title.textContent = 'Downloads';
  if (shelvesBox) { shelvesBox.innerHTML = ''; shelvesBox.classList.add('hidden'); }
  document.body.classList.remove('pl-list');
  grid.classList.remove('hidden');
  renderScreen();
  Nav.setLayout('grid');
  Nav.resetContent();
  $('content').scrollTop = 0;
  if (grid.querySelector('.card')) Nav.enterFirst(); else Nav.focusRail();
}

function statusText(it) {
  switch (it.status) {
    case 'queued': return 'Queued';
    case 'downloading': return 'Downloading ' + (it.pct || 0) + '%' + (it.speed ? ' · ' + it.speed : '') + (it.eta ? ' · ETA ' + it.eta : '');
    case 'merging': return 'Processing…';
    case 'paused': return 'Paused · ' + (it.pct || 0) + '%';
    case 'done': return 'Completed';
    case 'skipped': return 'Already downloaded';
    case 'error': return 'Failed' + (it.error ? ': ' + it.error : '');
    case 'canceled': return 'Canceled';
    default: return it.status;
  }
}

function makeItemCard(it) {
  const card = document.createElement('div');
  card.className = 'card focusable dl-card';
  card.dataset.id = it.id;
  card.innerHTML = '<div class="dl-card-title"></div>'
    + '<div class="dl-bar2"><div class="dl-bar2-fill"></div></div>'
    + '<div class="dl-card-status"></div>';
  card.querySelector('.dl-card-title').textContent = it.title;
  card.querySelector('.dl-bar2-fill').style.width = (it.pct || 0) + '%';
  card.querySelector('.dl-card-status').textContent = statusText(it);
  card.classList.toggle('error', it.status === 'error');
  return card;
}

function renderScreen() {
  grid.innerHTML = '';
  const items = q.slice().reverse(); // newest first
  if (!items.length) {
    const n = document.createElement('div');
    n.className = 'dl-empty';
    n.textContent = 'No downloads yet. Use the Download button in the player, or a video’s menu.';
    grid.appendChild(n);
    return;
  }
  if (items.some(isFinished)) {
    const clear = document.createElement('div');
    clear.className = 'card focusable dl-card dl-clear';
    clear.dataset.action = 'clear';
    clear.innerHTML = '<div class="dl-card-title">Clear finished</div>';
    grid.appendChild(clear);
  }
  for (const it of items) grid.appendChild(makeItemCard(it));
}

// Patch existing cards' progress/status in place (no rebuild -> no focus loss).
function patchScreen() {
  for (const it of q) {
    const card = grid.querySelector('.dl-card[data-id="' + it.id + '"]');
    if (!card) continue;
    const fill = card.querySelector('.dl-bar2-fill'); if (fill) fill.style.width = (it.pct || 0) + '%';
    const st = card.querySelector('.dl-card-status'); if (st) st.textContent = statusText(it);
    card.classList.toggle('error', it.status === 'error');
  }
}

export function clearFinished() { if (window.tv.dlClearFinished) window.tv.dlClearFinished(); }

// Per-item actions (select on a download card). Browse-mode menu, so closeMenu
// (which drops to browse) is correct here.
export function openItemMenu(el) {
  const id = Number(el.dataset.id);
  const it = q.find((x) => x.id === id);
  if (!it) return;
  const items = [];
  if (it.status === 'downloading' || it.status === 'merging') {
    items.push({ label: 'Pause', run: () => window.tv.dlPause(id) });
    items.push({ label: 'Cancel', run: () => window.tv.dlCancel(id) });
  } else if (it.status === 'paused') {
    items.push({ label: 'Resume', run: () => window.tv.dlResume(id) });
    items.push({ label: 'Cancel', run: () => window.tv.dlCancel(id) });
  } else if (it.status === 'queued') {
    items.push({ label: 'Cancel', run: () => window.tv.dlCancel(id) });
  } else if (it.status === 'error') {
    items.push({ label: 'Retry', run: () => window.tv.dlResume(id) });
    items.push({ label: 'Remove', run: () => window.tv.dlRemove(id) });
  } else if (it.status === 'done' || it.status === 'skipped') {
    items.push({ label: 'Remove from list', run: () => window.tv.dlRemove(id) });
  }
  items.push({ label: 'Open download folder', run: () => window.tv.dlOpenFolder() });
  showMenu();
  renderMenu(items.map((x) => ({ label: x.label, run: () => { closeMenu(); x.run(); } })), it.title || 'Download', null);
}
