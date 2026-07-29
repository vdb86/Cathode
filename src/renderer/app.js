// SPDX-License-Identifier: GPL-3.0-or-later
// App shell: routes tvinput events, renders sections, handles auth + playback.
// ES module (renderer split, s92): loaded via <script type="module"> in
// index.html. Nav / Settings / window.tv / shaka etc. come from the classic
// scripts that load before this module, so they resolve as globals here.

import { $, toast, show, hide } from './util.js';
import { startClock, updateClock } from './clock.js';
import { initAuth, handleAuthInput } from './auth.js';
import { resetDimTimer, wakeDim, isDimmed } from './dim.js';
import './cardscroll.js'; // sets window.CardScroll (used by nav.js)
import { grid, shelvesBox, title, video } from './dom.js';
import { state } from './state.js';
import {
  applyView, renderFeed, renderVideoGrid, renderMusic,
} from './render.js';
import { initOsk, openSearchOsk, openTextEntry, handleSearchInput, searchFor, editSearch } from './osk.js';
import { initCompanion } from './companion.js';
import { handleMenuInput } from './menu.js';
import { initStats, hideStats } from './stats.js';
import { initVideoMenu, openVideoMenu } from './videomenu.js';
import {
  initAccounts, resetAccountScopedCaches, openAccountSwitcher,
  openAccountsSettings, showPicker, enterAccount, finalizeAccount, handlePickerInput,
} from './accounts.js';
import { resetSponsorBlock, skipAskSegment } from './sb.js';
import {
  initSeek, seekBy, seekPress, commitSeek, cancelSeekScrub, scrubbing,
  resetSeekScrub,
} from './seek.js';
import { initCmd, runPreCommand, runStartCommand, runPostCommand } from './cmd.js';
import {
  moreExhausted, feedErrorHint, applyFeedChunk, appendMusicItems,
  maybeLoadMore, maybeLoadMoreShelf, loadSection, openChannel, backToChannels,
  openPlaylist, backToPlaylists, openChannelPage, backFromChannelPage,
} from './feeds.js';
import { pstate } from './pstate.js';
import {
  initSuggest, prefetchRelatedThumbs, openSuggest, closeSuggest,
  applySuggestDrawerFocus, loadMoreSuggest, warmRelated,
} from './suggest.js';
import { hideSeekPreview, updateSeekPreview } from './seekpreview.js';
import {
  initVideoActions, updateRatingButtons,
  ensureWatchLater, updateSaveButton, toggleWatchLater,
  toggleLike, toggleDislike, toggleSubscribe, saveToWatchLater,
} from './videoactions.js';
import {
  initBgQueue, initRailControls, showNowPlaying, updateRailQueueItem, clearBg,
  applyBgStyle, minimize, restore, addToQueue, removeFromQueue, openQueue,
  playQueueCard, playFromCard, stepRailCtrl, activateRailCtrl, applyRailCtrlFocus,
  updateQueueButtons, playNext,
} from './bgqueue.js';
import {
  SPEEDS, ASPECTS, SVG_PLAY, SVG_PAUSE, SVG_STOP, SVG_TRASH, P_ICONS,
} from './pconst.js';
import {
  initPlayerMenu, applyPlayerMenuFocus, closePlayerMenu, playerMenuActivate,
} from './playermenu.js';
import {
  pBtn, initPlayerButtons, stepPlayerCol, updateSeekBar, updatePlayPause,
  renderSbMarkers, updateControlLabels, showTransport, refreshPlayerButtons,
} from './transport.js';
import {
  initPlayerActions, togglePlay, activatePlayerButton, applyAspect,
  applyPlaybackMode, applyCaption, hideScreenOff, resetPlayerControlLabels, toggleSb,
} from './playeractions.js';
import {
  initLiveChat, chatOnPlay, chatOnStop, closeChat,
  chatReplayTick, chatReplaySeek, toggleChat,
} from './livechat.js';
import {
  initComments, commentsOnPlay, commentsOnStop, handleCommentsInput, toggleComments,
} from './comments.js';
import {
  initDownloads, openScreen as openDownloads, openItemMenu as openDownloadItemMenu,
  openDownloadAdvanced, refreshDownloadButton, clearFinished as clearDownloads,
  warmDownloadFormats,
} from './downloads.js';


  // Feeds / sections / nav (loadSection, drill-in/back handlers,
  // infinite scroll + feed-chunk appenders, feedErrorHint, and the state
  // lastOpenedPlaylistId/channelReturn/listOrigin/moreExhausted) moved to
  // feeds.js (renderer split, s106).
  // Account-scoped caches (state.subsChannels / state.currentPlaylists / state.currentMusic /
  // state.wlIds) moved to state.js (renderer split, s100) so a future menu/account
  // module can reset them; resetAccountScopedCaches() clears them there.
  // OSK / search / suggestions / text-entry state moved to osk.js (renderer split, s97).
  // Menu overlay engine (menuItems/menuIndex/menuBack + render/close/router)
  // moved to menu.js (s98). Video context menu builders + menuVideo moved to
  // videomenu.js (s101).
  // currentAccountName moved to state.js (s102); account system -> accounts.js.

  // ---------- on-screen clock / date ----------
  // The on-screen clock (updateClock / startClock) now lives in clock.js.
  // startClock(() => mode) is wired in boot; showTransport calls updateClock()
  // to reveal/hide the player clock together with the HUD.

  function showError(msg) {
    state.mode = 'error';
    // A dropped/absent internet connection surfaces from youtubei.js/undici as
    // 'fetch failed' (with a DNS/socket cause). Show a plain connection screen
    // for that; keep the generic screen for real library/parse breaks.
    const isNetwork = /fetch failed|failed to fetch|ENOTFOUND|getaddrinfo|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENETDOWN|net::ERR|NetworkError/i.test(msg);
    if (isNetwork) {
      $('error-title').textContent = 'No connection to YouTube';
      $('error-message').textContent = "CouchTube can't reach YouTube right now. Check that this PC is connected to the internet, then try again.";
    } else {
      $('error-title').textContent = 'Something broke';
      $('error-message').textContent = msg;
    }
    window.tv.logError('Fatal: ' + msg);
    window.tv.logPath().then((p) => { $('error-logpath').textContent = p; }).catch(() => {});
    show('error-overlay');
  }

  // True from the start of a play() until the new stream has loaded. During this
  // window we tear down the previous SABR session (CouchTubeSabr.stop unregisters
  // its Shaka schemes), so in-flight segment requests from the OLD video can fail
  // with a transient NETWORK error (e.g. 1000 UNSUPPORTED_SCHEME host=audio when
  // skipping via Next). Those are teardown noise -- the new video then plays
  // fine -- so the Shaka error handler suppresses NETWORK-category errors (and
  // aborts) while this is set, instead of flashing "Playback error".
  let switching = false;

  // Double-press Back (B / Esc / Backspace) on the rail to exit.
  let exitArmed = false;
  let exitTimer = null;

  function armExit() {
    if (Settings.get('appExit') === 'single') return window.tv.quit();
    if (exitArmed) return window.tv.quit();
    exitArmed = true;
    toast('Press Back (B / Esc) again to exit');
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { exitArmed = false; }, 2500);
  }






























  // Feeds / sections / nav moved to feeds.js (renderer split, s106).

  // ---------- playback ----------


  // Player > video presets: cap resolution / frame rate + preferred audio
  // language via Shaka. Read live from settings; safe to call anytime.
  function applyShakaPrefs() {
    if (!pstate.shakaPlayer) return;
    const maxH = Settings.get('maxRes') || 0;
    const maxF = Settings.get('maxFps') || 0;
    const lang = Settings.get('prefAudioLang') || '';
    try {
      pstate.shakaPlayer.configure({
        restrictions: { maxHeight: maxH || Infinity, maxFrameRate: maxF || Infinity },
        preferredAudioLanguage: lang || undefined
      });
    } catch {}
  }

  async function ensureShaka() {
    if (pstate.shakaPlayer) return pstate.shakaPlayer;
    shaka.polyfill.installAll();
    pstate.shakaPlayer = new shaka.Player();
    await pstate.shakaPlayer.attach(video);
    pstate.shakaPlayer.configure({
      streaming: { retryParameters: { maxAttempts: 5, baseDelay: 400, backoffFactor: 2, fuzzFactor: 0.5 } },
      // Prefer Opus for audio: on multi-audio SABR the AAC (itag 140) track
      // intermittently returns an empty UMP (a brief stall on a language switch),
      // while the Opus tracks (249/250/251) are reliable. This is a PREFERENCE,
      // not a restriction - AAC still serves as a fallback if Opus is unavailable.
      preferredAudioCodecs: ['opus']
    });
    applyShakaPrefs();
    // Seek-403 workaround. YouTube's IOS-client stream URLs (currently the only
    // client that returns direct URLs -- WEB/ANDROID/TV are all SABR/URL-less)
    // 403 on the byte-range requests Shaka issues when SEEKING, even though
    // linear playback is fine and the URL already carries our PoToken. The
    // googlevideo edge expects the range as a `&range=A-B` URL query param for
    // these URLs, not (only) as an HTTP Range header -- the technique
    // Invidious-style proxies use. Move Shaka's Range header onto the URL for
    // googlevideo requests; scoped so nothing else is touched. If this ever
    // breaks normal playback, removing this filter reverts it.
    pstate.shakaPlayer.getNetworkingEngine().registerRequestFilter((type, request) => {
      // While a SABR session is active its adapter owns googlevideo requests
      // (POST/UMP); this classic pot/range filter must stay out of the way.
      if (window.CouchTubeSabr && window.CouchTubeSabr.active && window.CouchTubeSabr.active()) return;
      let u = request.uris && request.uris[0];
      if (!u || u.indexOf('googlevideo.com/') === -1) return;
      // (1) Live PoToken: append the GVS pot to segment/manifest requests that
      // lack it. Live plays from YouTube's ready-made HLS/DASH manifest, so its
      // segment URLs never pass through Player.decipher (which is what appends
      // pot for VOD) -- without pot the segments 403 (Shaka 1001). VOD URLs
      // already carry pot, so the guard skips them.
      if (pstate.currentPoToken && !/[?&]pot=/.test(u)) {
        u += (u.indexOf('?') === -1 ? '?' : '&') + 'pot=' + encodeURIComponent(pstate.currentPoToken);
      }
      // (2) Range-as-query (seek-403 workaround): move Shaka's Range header onto
      // the URL as &range=A-B for the clients whose URLs 403 on Range-HEADER
      // byte-range requests (IOS). TVHTML5 URLs must be LEFT ALONE: they honor a
      // standard Range header (main forwards it untouched) and seek fine, so
      // rewriting them to &range= hands the media element the wrong bytes -- the
      // init segment fails to parse -> MediaError 4 "Format error" / Shaka 3016.
      // Detect TV URLs by their c=TVHTML5 client tag and skip the rewrite.
      const isTvUrl = /[?&]c=TVHTML5\b/.test(u);
      const h = request.headers || {};
      const rangeHeader = h.Range || h.range;
      if (rangeHeader && !isTvUrl) {
        const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (m && !/[?&]range=/.test(u)) {
          u += (u.indexOf('?') === -1 ? '?' : '&') + 'range=' + m[1] + '-' + m[2];
        }
        delete h.Range; delete h.range;
        request.headers = h;
      }
      request.uris[0] = u;
    });
    // Force-center captions (s116): strip per-cue position/align settings from
    // every caption VTT before Shaka parses it. YouTube's auto-generated (ASR)
    // tracks ship cues with left/start alignment, so our native #video::cue
    // rendering parks them bottom-left; manual tracks carry none and default to
    // bottom-center. Keeping only `start --> end` on each timing line drops the
    // positioning so everything renders bottom-center. Shaka fetches external
    // text tracks as RequestType.SEGMENT (there is no TEXT type), so we scope to
    // SEGMENT and sniff the WEBVTT signature -- binary media segments never begin
    // with it, so they're left untouched (no full binary decode).
    const SEGMENT_REQ = shaka.net.NetworkingEngine.RequestType.SEGMENT;
    pstate.shakaPlayer.getNetworkingEngine().registerResponseFilter((type, response) => {
      if (type !== SEGMENT_REQ || !response.data) return;
      const bytes = new Uint8Array(response.data);
      if (bytes.length < 6) return;
      const o = (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0; // optional UTF-8 BOM
      // "WEBVTT" == 0x57 45 42 56 54 54
      if (!(bytes[o] === 0x57 && bytes[o + 1] === 0x45 && bytes[o + 2] === 0x42 &&
            bytes[o + 3] === 0x56 && bytes[o + 4] === 0x54 && bytes[o + 5] === 0x54)) return;
      let text;
      try { text = new TextDecoder('utf-8').decode(response.data); } catch { return; }
      const stripped = text.replace(
        /(\d{2}:\d{2}(?::\d{2})?\.\d{3}[ \t]*-->[ \t]*\d{2}:\d{2}(?::\d{2})?\.\d{3})[^\n\r]*/g,
        '$1'
      );
      if (stripped !== text) response.data = new TextEncoder().encode(stripped).buffer;
    });
    // Surface playback errors (e.g. live manifests failing) instead of a
    // silent black screen. Throttled so a seek-time 403 storm can't flood the
    // log, and it logs the HTTP status + host for network errors (1001/1002).
    let lastShakaLog = 0;
    pstate.shakaPlayer.addEventListener('error', (e) => {
      const err = e && e.detail;
      const code = err && err.code;
      let info = '';
      const d = err && err.data;
      if (Array.isArray(d)) {
        let host = ''; try { host = new URL(d[0]).host; } catch {}
        if (host || d[1] != null) info = ' status=' + (d[1] == null ? '?' : d[1]) + (host ? ' host=' + host : '');
      }
      // For non-network errors (e.g. 3016 VIDEO_ERROR) the data isn't a
      // [url,status] pair -- surface the raw data plus the <video> element's
      // underlying MediaError so the log says WHY (code 3=decode,
      // 4=src/codec unsupported), not just the opaque Shaka code.
      if (!info) {
        try {
          let extra = d != null ? ' data=' + JSON.stringify(d).slice(0, 300) : '';
          const me = video && video.error;
          if (me) extra += ' mediaError=' + me.code + (me.message ? '/' + me.message : '');
          info = extra;
        } catch {}
      }
      // Transient teardown noise while switching videos: the old SABR session's
      // in-flight requests fail once its schemes are unregistered (NETWORK cat =
      // 1xxx, e.g. 1000 UNSUPPORTED_SCHEME; or 7001 OPERATION_ABORTED). Don't
      // surface these -- the new video loads right after. Real persistent errors
      // fire outside the switch window and still log + toast.
      if (switching && ((code >= 1000 && code < 2000) || code === 7001)) {
        window.tv.logInfo('Shaka transient during switch: ' + (code || '?') + info);
        return;
      }
      const now = Date.now();
      if (now - lastShakaLog > 3000) {
        lastShakaLog = now;
        window.tv.logError('Shaka error ' + (code || '?') + info + (err && err.message ? ' ' + err.message : ''));
      }
      if (code) toast('Playback error (' + code + ')');
    });
    return pstate.shakaPlayer;
  }

  // SABR (server-ABR) VOD playback: attach googlevideo's adapter to Shaka via
  // sabr.js, then load the SABR DASH manifest it returns.
  async function playSabr(s, startAt) {
    const p = await ensureShaka();
    const uri = window.CouchTubeSabr.start(p, s);
    await p.load(uri, (startAt > 0 ? startAt : null), 'application/dash+xml');
  }

  // In-player audio switch via RELOAD (approach A / processing variants): re-fetch
  // the SABR payload collapsed to the chosen (language, variant) and resume at the
  // current timestamp. Used for Stable Volume / Voice Boost, and for plain-language
  // switches when native multi-audio is off. variant: '' | 'drc' | 'vb' | 'plain'.
  function switchAudio(code, variant) {
    if (!pstate.currentVideoId) return;
    const v = variant || '';
    const cur = v === 'drc' ? 'drc' : v === 'vb' ? 'vb' : ''; // 'plain' -> normal ('')
    if (code === pstate.audioLang && cur === pstate.audioVariant) return;
    const at = video.currentTime || 0;
    const t = (pstate.audioTracks || []).find((x) => x.code === code && (x.variant || '') === cur);
    toast('Audio: ' + ((t && t.name) || code || 'default'));
    play(pstate.currentVideoId, { audioLang: code, audioVariant: v, startAt: at, keepQueue: true, background: pstate.bgPlaying, audioSwitch: true });
  }

  async function playDash(s) {
    const p = await ensureShaka();
    window.tv.logError('classic DASH: loading manifest (' + (s.dash ? s.dash.length : 0) + ' bytes)');
    const blobUrl = URL.createObjectURL(new Blob([s.dash], { type: 'application/dash+xml' }));
    try {
      await p.load(blobUrl, null, 'application/dash+xml');
      window.tv.logError('classic DASH: loaded OK');
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // Live: load YouTube's ready-made HLS/DASH manifest URL directly.
  async function playManifest(s) {
    const p = await ensureShaka();
    window.tv.logInfo('Live: loading manifest type=' + s.manifestType); // diagnostic
    await p.load(s.manifestUrl, null, s.manifestType);
    // Some live DASH manifests (notably the ANDROID client's) leave the
    // playhead OUTSIDE the seekable/buffered window -- the media is buffered
    // far out on the timeline while currentTime sits ~2h back, so readyState
    // stays 1 and the frame is black. Snap to the live edge where the data is.
    try {
      const live = p.isLive && p.isLive();
      const r = p.seekRange ? p.seekRange() : null;
      if (live && r && isFinite(r.end) && r.end > 0) {
        video.currentTime = Math.max(r.start || 0, r.end - 6);
        window.tv.logInfo('Live: snapped to edge, seekRange=[' + (r.start || 0).toFixed(1) + ',' + r.end.toFixed(1) + ']');
      }
    } catch (e) { window.tv.logError('Live edge-snap failed: ' + e.message); }
    // Report the real state + active codec a moment later.
    setTimeout(() => {
      try {
        const bEnd = video.buffered.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 'n/a';
        window.tv.logInfo('Live state: readyState=' + video.readyState + ' vw=' + video.videoWidth + ' paused=' + video.paused + ' ct=' + (video.currentTime || 0).toFixed(1) + ' buffEnd=' + bEnd);
        const tracks = p.getVariantTracks ? p.getVariantTracks() : [];
        const active = tracks.find((t) => t.active);
        if (active) window.tv.logInfo('Live active track: ' + active.width + 'x' + active.height + ' v=' + active.videoCodec + ' a=' + active.audioCodec);
      } catch {}
    }, 2500);
  }

  async function playProgressive(s) {
    if (pstate.shakaPlayer) await pstate.shakaPlayer.unload().catch(() => {});
    let host = '?'; try { host = new URL(s.url).host; } catch (e) {}
    window.tv.logError('progressive: video.src set host=' + host + ' pot=' + /[?&]pot=/.test(s.url || '') + ' c=' + ((/[?&]c=([A-Za-z0-9_]+)/.exec(s.url || '') || [])[1] || '?'));
    video.src = s.url;
  }

  // ---- SponsorBlock ----
  // The skip/notify/ask logic + the "Skip <category>?" prompt + the
  // <video> timeupdate loop moved to sb.js (renderer split, s103).
  // Shared state: state.sbSegments / state.sbEnabled / state.sbAskSeg.
  // renderSbMarkers (seek-bar drawing) + toggleSb (player button) stay here.

  // ---- Playback command hooks (pre-roll / start / post-roll) ----
  // Moved to cmd.js (renderer split, s105). app.js imports runPreCommand/
  // runStartCommand/runPostCommand and injects the current video-obj/id/
  // channel-id accessors via initCmd at boot.

  // Like/dislike counts under the player title (Settings > Player > Show like /
  // dislike counts). Card counts are a separate toggle handled in render.js.
  // Dislikes come from Return YouTube Dislike via the main process; guarded
  // against a stale response arriving after the user moved to another video.
  function updateRatingCounts(videoId) {
    const el = $('player-ratings');
    if (!el) return;
    const on = !(Settings.get && Settings.get('ratingCountsPlayer') === false);
    if (!on || !window.tv.rydGet) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.add('hidden'); el.textContent = '';
    window.tv.rydGet(videoId).then((r) => {
      if (!r || !r.ok || pstate.currentVideoId !== videoId) return;
      el.innerHTML = '';
      const like = document.createElement('span'); like.className = 'rating-like'; like.textContent = '👍 ' + (r.likesText || '0');
      const dis = document.createElement('span'); dis.className = 'rating-dislike'; dis.textContent = '👎 ' + (r.dislikesText || '0');
      el.appendChild(like); el.appendChild(dis);
      el.classList.remove('hidden');
    }).catch(() => {});
  }

  async function play(videoId, opts) {
    opts = opts || {};
    if (pstate.suggestOpen) closeSuggest();
    // opts.audioSwitch = same video reloading only to change the audio language;
    // skip the "Loading video…" toast and the same-video panel re-inits below so
    // the switch reads as a quick blip, not a fresh load.
    if (!opts.audioSwitch) toast('Loading video…');
    const firstPlay = !pstate.playedThisSession; pstate.playedThisSession = true;
    switching = true; // suppress teardown-race Shaka errors until the new stream loads
    if (!opts.audioSwitch) runPreCommand(firstPlay, videoId);
    if (!opts.audioSwitch) resetSponsorBlock(); // same video: keep segments + already-skipped state
    if (window.CouchTubeSabr) window.CouchTubeSabr.stop(); // dispose any prior SABR session
    try {
      // SABR (VOD) first when the vendor bundle is present; otherwise fall back
      // to the classic stream payload. getSabr returns { ok:false } for live /
      // no-sabr / error, so live keeps its manifest path.
      let useSabr = false;
      let s = null;
      // A manual switch passes opts.audioLang; otherwise fall back to the user's
      // preferred audio language (auto-picks that dub on multi-language videos,
      // no-op when it isn't offered or the video is single-audio).
      const wantLang = opts.audioLang || Settings.get('prefAudioLang') || '';
      // A processing-variant switch (Stable Volume / Voice Boost) must reload
      // COLLAPSED to that exact format; plain playback keeps approach C (all
      // tracks) unless the user turned it off.
      // Multi-audio (approach C) is always the default: keep every language +
      // processing-variant track in the manifest for in-stream native switching.
      // If an uncollapsed video fails to SABR-play, play() auto-retries collapsed
      // (A) below, so no user toggle is needed. A processing-variant switch forces
      // the collapse to that exact format.
      const forceCollapse = !!opts.audioVariant;
      const multiAudio = !forceCollapse;
      if (window.GoogleVideo && window.CouchTubeSabr) {
        try {
          const sr = await window.tv.sabr(videoId, wantLang, { multiAudio, preferredVariant: opts.audioVariant || '' });
          if (sr && sr.ok) { s = sr; useSabr = true; }
        } catch (err) { window.tv.logError('SABR probe failed: ' + (err && err.message)); }
      }
      if (!s) s = await window.tv.streams(videoId);
      if (opts.background) {
        pstate.bgPlaying = true; // launched into (or advancing within) the mini-player
      } else {
        clearBg();        // full-screen play: drop any background/mini state
        state.mode = 'player';
      }
      $('player-title').textContent = s.title + (s.author ? ' - ' + s.author : '');
      // DeArrow: replace the player title too (guard against a stale response
      // arriving after the user has moved on to another video).
      if (Settings.da && Settings.da('enabled') && window.tv.dearrowBranding) {
        window.tv.dearrowBranding(videoId).then((b) => {
          if (b && b.title && pstate.currentVideoId === videoId) $('player-title').textContent = b.title + (s.author ? ' - ' + s.author : '');
        }).catch(() => {});
      }
      show('player-overlay');
      hide('player-hud');
      pstate.pRow = 'buttons'; pstate.pCol = 2;
      pstate.qualityIdx = 0; pstate.qualityLabel = 'Auto';
      { let si = SPEEDS.indexOf(Settings.get('lastSpeed')); if (!Settings.get('rememberSpeed') || si < 0) si = 1; pstate.speedIdx = si; video.playbackRate = SPEEDS[si]; }
      pstate.currentVideoId = videoId;
      pstate.currentChannelId = s.channelId || null;
      pstate.isLiveVideo = !!s.isLive; // gates the Comments button (no comments while live)
      if (!opts.audioSwitch) { pstate.currentRating = 'none'; pstate.currentSubscribed = false; }
      pstate.currentPoToken = s.poToken || null; // for the live segment pot-append filter
      const ex = s.extras || {};
      pstate.captionTracks = ex.captions || [];
      pstate.captionIdx = 0; pstate.addedCaptions = new Map();
      pstate.audioLangs = [];
      pstate.audioTracks = s.audioTracks || []; // multi-language audio (SABR); empty on classic fallback
      pstate.audioLang = s.selectedAudioLang || opts.audioLang || wantLang || '';
      pstate.audioVariant = s.selectedAudioVariant || opts.audioVariant || '';
      pstate.storyboard = ex.storyboards || null;
      pstate.chapters = ex.chapters || [];
      // Up-next queue: a manual play (from a card) resets the Previous stack;
      // Next/Prev navigation keeps it (opts.keepQueue).
      if (!opts.keepQueue) pstate.prevStack = [];
      pstate.currentVideoObj = { id: videoId, title: s.title, author: s.author };
      pstate.upNext = (ex.related || []).filter((v) => v.id !== videoId);
      pstate.relatedVideos = pstate.upNext.slice(); // stable copy for the suggestions drawer (upNext is drained by Next)
      if (!opts.audioSwitch) prefetchRelatedThumbs(pstate.relatedVideos); // warm the image cache so the drawer paints instantly on first open (s107c)
      pstate.suggestExhausted = false; pstate.suggestLoading = false;
      // If the stream payload carried no related (anon WEB watch_next_feed empty
      // for this video -- common when reached via the queue), pull them on demand
      // in the background so the drawer is ready before the user opens it (s112).
      if (!pstate.relatedVideos.length && !opts.audioSwitch) warmRelated();
      state.sbEnabled = Settings.sb('enabled') !== false;
      pstate.playbackMode = Settings.get('playbackMode') || 'next';
      pstate.aspectIdx = Math.max(0, ASPECTS.findIndex((a) => a.k === (Settings.get('defaultAspect') || 'fit'))); applyAspect();
      resetPlayerControlLabels();
      hideStats(); hideScreenOff(); closePlayerMenu();
      updateSaveButton();
      updateRatingButtons();
      if (!opts.audioSwitch) chatOnPlay(videoId); // probe live-chat availability -> show the button; re-open if it was open
      if (!opts.audioSwitch) commentsOnPlay();    // reset comments; auto-open on non-live videos if set
      if (!opts.audioSwitch) updateRatingCounts(videoId); // like/dislike counts (RYD), if enabled
      refreshDownloadButton(); // reflect whether THIS video is already downloading
      if (!pstate.isLiveVideo && !opts.audioSwitch) warmDownloadFormats(videoId, pstate.currentVideoObj && pstate.currentVideoObj.url); // warm the advanced-popup format list
      updateQueueButtons();
      hideSeekPreview();
      resetSeekScrub();
      if (!opts.audioSwitch) ensureWatchLater().then(updateSaveButton).catch(() => {});

      if (!opts.audioSwitch) window.tv.sponsorSegments(videoId)
        .then((segs) => { state.sbSegments = segs || []; renderSbMarkers(); })
        .catch(() => {});

      let loaded = false;
      if (useSabr && window.shaka) {
        try {
          await playSabr(s, opts.startAt);
          loaded = true;
        } catch (err) {
          console.error('SABR playback failed, falling back to classic:', err);
          // Capture the FULL Shaka error (code + category + data) so a device log
          // pinpoints WHY SABR failed -- the fall-through to the IOS classic
          // stream is what then 403s on seek. A rejected player.load() is a
          // shaka.util.Error with code/category/data directly; error EVENTS
          // carry it under .detail.
          const se = (err && err.detail) ? err.detail : err;
          let sd;
          try {
            sd = 'code=' + (se && se.code != null ? se.code : '?') +
                 ' cat=' + (se && se.category != null ? se.category : '?') +
                 (se && Array.isArray(se.data) ? ' data=' + JSON.stringify(se.data).slice(0, 400) : '') +
                 (se && se.message ? ' msg=' + se.message : '');
          } catch (_e) { sd = String(err); }
          window.tv.logError('SABR playback failed: ' + sd);
          if (window.CouchTubeSabr) window.CouchTubeSabr.stop();
          // The SABR adapter reconfigures THIS Shaka player's networking engine
          // (custom scheme + request/response filters) and its MediaSource. A
          // failed SABR load can leave that residue behind, which then makes the
          // classic DASH load below fail with a media error (Shaka 3016). Tear
          // the player down so ensureShaka() rebuilds a pristine one for the
          // fallback path (fresh networking filters, fresh MediaSource).
          if (pstate.shakaPlayer) { try { await pstate.shakaPlayer.destroy(); } catch (e3) {} pstate.shakaPlayer = null; }
          // Approach C is the default (all language tracks in the manifest). If
          // that uncollapsed manifest failed to SABR-play, RETRY SABR COLLAPSED
          // (approach A) before dropping to the classic IOS stream (which 403s
          // mid-stream on multi-audio). This keeps A as the real fallback.
          if (multiAudio) {
            try {
              const sr2 = await window.tv.sabr(videoId, wantLang, { multiAudio: false });
              if (sr2 && sr2.ok) {
                s = sr2;
                pstate.currentPoToken = s.poToken || null;
                pstate.audioTracks = s.audioTracks || [];
                pstate.audioLang = s.selectedAudioLang || wantLang || '';
                pstate.audioVariant = s.selectedAudioVariant || '';
                await playSabr(s, opts.startAt);
                loaded = true;
                window.tv.logInfo('SABR retry collapsed (A) succeeded after multi-audio SABR failed');
              }
            } catch (e4) {
              window.tv.logError('SABR collapsed (A) retry failed: ' + (e4 && e4.message));
              if (window.CouchTubeSabr) window.CouchTubeSabr.stop();
              if (pstate.shakaPlayer) { try { await pstate.shakaPlayer.destroy(); } catch (_e) {} pstate.shakaPlayer = null; }
            }
          }
          if (!loaded) {
            try { s = await window.tv.streams(videoId); pstate.currentPoToken = s.poToken || null; }
            catch (e2) { window.tv.logError('classic fallback fetch failed: ' + (e2 && e2.message)); }
          }
        }
      }
      if (!loaded && s.manifestUrl && window.shaka) {
        try {
          await playManifest(s);
          loaded = true;
        } catch (err) {
          console.error('Live manifest playback failed:', err);
        }
      }
      if (!loaded && s.dash && window.shaka) {
        try {
          await playDash(s);
          loaded = true;
        } catch (err) {
          // A rejected classic-DASH load was only visible in the devtools console
          // before -- the device log jumped from "TV DASH codecs" straight to the
          // media-element error the PROGRESSIVE fallback then threw, hiding the
          // real failure. Log the full Shaka error to couchtube.log.
          const se = (err && err.detail) ? err.detail : err;
          let sd;
          try {
            sd = 'code=' + (se && se.code != null ? se.code : '?') +
                 ' cat=' + (se && se.category != null ? se.category : '?') +
                 (se && se.message ? ' msg=' + se.message : '');
            // For BAD_HTTP_STATUS (1001) Shaka's data is [uri, status,
            // responseText, headers, requestType] -- surface the status and the
            // error body FIRST (the URL alone ate the whole truncation budget).
            if (se && se.code === 1001 && Array.isArray(se.data)) {
              sd += ' | http=' + se.data[1] + ' body=' + JSON.stringify(String(se.data[2] == null ? '' : se.data[2]).slice(0, 200));
            }
            if (se && Array.isArray(se.data)) sd += ' data=' + JSON.stringify(se.data).slice(0, 300);
          } catch (e3) { sd = String(err); }
          window.tv.logError('classic DASH load failed (falling back to progressive): ' + sd);
        }
      }
      if (!loaded && s.url) {
        await playProgressive(s);
        loaded = true;
      }
      if (!loaded) {
        hide('player-overlay');
        clearBg();
        state.mode = 'browse';
        toast('No playable stream found');
        return;
      }
      applyShakaPrefs();
      video.play().catch(() => {});
      runStartCommand(firstPlay); // metadata is loaded now, so command vars are populated
      if (opts.background) { applyBgStyle(); showNowPlaying(); } // present as mini/audio
      // Record in account History (fire-and-forget), unless the user turned it off.
      if (Settings.get('recordHistory') !== false) window.tv.recordHistory(videoId).catch(() => {});
    } catch (e) {
      hide('player-overlay');
      clearBg();
      state.mode = 'browse';
      toast('Playback failed: ' + e.message);
      feedErrorHint(e);
    } finally {
      switching = false; // new stream has loaded (or failed) -- resume surfacing Shaka errors
    }
  }

  function stopPlayback(reason) {
    // Post-roll command: fire on a natural end or a manual stop, but NOT on the
    // reasonless teardown used by account switching.
    if (reason === 'end') runPostCommand('end');
    else if (reason === 'manual') runPostCommand('stop');
    if (window.CouchTubeSabr) window.CouchTubeSabr.stop();
    if (pstate.shakaPlayer) pstate.shakaPlayer.unload().catch(() => {});
    resetSponsorBlock();
    hideStats();
    hideScreenOff();
    closePlayerMenu();
    if (pstate.suggestOpen) { pstate.suggestOpen = false; hide('player-suggest'); $('player-overlay').classList.remove('suggesting'); }
    chatOnStop();
    commentsOnStop();
    hideSeekPreview();
    resetSeekScrub();
    clearBg();
    pstate.currentVideoId = null;
    pstate.upNext = []; pstate.prevStack = []; pstate.currentVideoObj = null;
    pstate.captionTracks = []; pstate.captionIdx = 0; pstate.addedCaptions = new Map();
    pstate.chapters = []; pstate.storyboard = null;
    video.style.transform = '';
    video.style.objectFit = '';
    video.loop = false;
    video.pause();
    video.removeAttribute('src');
    video.load();
    hide('player-overlay');
    state.mode = 'browse';
    Nav.apply();
  }

  // ---- Background playback + user queue + in-rail now-playing/controls ----
  // Moved to bgqueue.js (renderer split, s111). app.js imports showNowPlaying/
  // clearBg/applyBgStyle (play), clearBg (stopPlayback), updateRailQueueItem
  // (stopForAccountSwitch), updateQueueButtons (play), minimize (openCurrentChannel
  // + router), restore/openQueue/playQueueCard/playFromCard/stepRailCtrl/
  // activateRailCtrl/removeFromQueue (router), addToQueue/removeFromQueue
  // (initVideoMenu), playNext/playPrev (activatePlayerButton + ended handler),
  // and initRailControls (boot). Player-core/transport deps (play, stopPlayback,
  // togglePlay, showTransport, applyAspect, closePlayerMenu, pBtn) + the SVG icon
  // strings are injected via initBgQueue at boot (before initRailControls).

  // ---- transport bar (on-screen player controls) ----
  // Two focus rows while the bar is visible: the seek track ('seek') and the
  // button row ('buttons'). D-pad left/right scrubs on the seek row and moves
  // between buttons on the button row; bumpers (ff/rw) and the Play button
  // always work regardless of focus.
  // Player constants (SPEEDS/ASPECTS/REPEAT_MODES/SVG_*/P_ICONS/P_WITH_LABEL/
  // P_LABELS/COG_STATEFUL) moved to pconst.js (renderer split, s113); imported
  // at the top. statsTimer moved to stats.js (s99).
  // Player transport HUD -- button strip (fill/order/visibility/step/focus/tip),
  // seek bar, play/pause icon, SponsorBlock seek-track markers, speed/quality
  // value labels, and showTransport -- moved to transport.js (renderer split,
  // s114). app.js imports pBtn/initPlayerButtons/stepPlayerCol/updateSeekBar/
  // updatePlayPause/renderSbMarkers/updateControlLabels/showTransport; pBtn/
  // updateSeekBar/updateControlLabels are re-injected from there into bgqueue/
  // videoactions/playermenu/seek at boot. State on pstate + state.sbSegments.

  // Player slide-up menus (cog + speed/quality/aspect/repeat/cc/audio) moved to
  // playermenu.js (renderer split, s113). app.js imports openCogMenu/
  // openPlayerMenu (activatePlayerButton), applyPlayerMenuFocus/playerMenuActivate/
  // closePlayerMenu (router + stopPlayback + injected into bgqueue) and injects
  // pBtn/activatePlayerButton/applyAspect/applyPlaybackMode/applyCaption/
  // updateControlLabels via initPlayerMenu at boot. Menu state lives on pstate.

  // showTransport() (reveal the HUD + refresh its widgets + auto-hide) moved to
  // transport.js (renderer split, s114); imported at the top.

  // ---- in-player suggestions drawer (Down while the HUD is hidden) ----
  // Moved to suggest.js (renderer split, s108). app.js imports prefetchRelated-
  // Thumbs (called in play), openSuggest/closeSuggest/applySuggestDrawerFocus/
  // loadMoreSuggest (router + openCurrentChannel), and injects applyAspect via
  // initSuggest at boot. All drawer state lives on pstate.

  // ---- seeking + progressive scrubbing ----
  // Moved to seek.js (renderer split, s104). app.js imports seekBy/seekPress/
  // commitSeek/cancelSeekScrub/scrubbing/seekDisplayTime/resetSeekScrub and
  // injects updateSeekBar/updateSeekPreview/getShaka via initSeek at boot.

  // Player action / control layer -- the transport-button dispatch
  // (activatePlayerButton), togglePlay, openCurrentChannel (private), and the
  // per-control toggles applyAspect / toggleSb (private) / applyPlaybackMode /
  // applyCaption / screenOff+hideScreenOff / resetPlayerControlLabels -- moved to
  // playeractions.js (renderer split, s115). app.js imports togglePlay/
  // activatePlayerButton/applyAspect/applyPlaybackMode/applyCaption/hideScreenOff/
  // resetPlayerControlLabels (play + stopPlayback + router + the init* injections)
  // and injects the playback-core stopPlayback via initPlayerActions at boot.

  // Like / Dislike / Subscribe + Watch Later moved to videoactions.js (renderer
  // split, s110). app.js imports updateRatingButtons/toggleLike/toggleDislike/
  // toggleSubscribe/ensureWatchLater/updateSaveButton/toggleWatchLater/
  // saveToWatchLater (used in play + activatePlayerButton; toggleWatchLater is
  // also passed into initVideoMenu) and injects pBtn via initVideoActions.

  // ---- Phase 2: up-next queue (autoplay + Next/Previous) ----
  // updateQueueButtons/playNext/playPrev moved to bgqueue.js (renderer split,
  // s111).

  // ---- Phase 2: captions ----
  // applyCaption moved to playeractions.js (s115); imported at the top.

  // ---- Phase 2: chapters + seek-preview thumbnails ----
  // Moved to seekpreview.js (renderer split, s109). app.js imports
  // renderChapterMarkers (showTransport), hideSeekPreview (play/stopPlayback/
  // minimize), and updateSeekPreview (showTransport + passed into initSeek).
  // currentChapterTitle stayed private there. seekpreview.js reads the scrub
  // position from seek.js via seekDisplayTime (one-way import). State on pstate.

  // screenOff / hideScreenOff (blackout the screen; audio keeps playing) moved to
  // playeractions.js (s115); hideScreenOff imported at the top.

  // ---- Screen dimming (General > Screen dimming) ----
  // Screen dimming (resetDimTimer / wakeDim / isDimmed) now lives in dim.js.

  // Card title autoscroll moved to cardscroll.js (it sets window.CardScroll,
  // used by nav.js) and is imported for its side effect at the top of app.js.

  // The playback stats overlay (hideStats / renderStats / toggleStats) lives in
  // stats.js (renderer split, s99); initStats injects the shaka + videoId
  // accessors at boot.

  // resetPlayerControlLabels (reset the toggle buttons for a freshly opened video)
  // moved to playeractions.js (s115); imported at the top.

  // ---------- auth ----------
  // The account sign-in overlay (device-code URL/code/QR, Copy/Open buttons,
  // focus, the mode==='auth' router branch, and the onAuthPending/Success/Restored
  // IPC handlers) moved to auth.js (renderer split, s117). app.js imports
  // handleAuthInput (router) + initAuth (registers the IPC listeners at boot).

  // Background feed streaming (s53/s55): deeper content arrives as chunks after
  // the first page painted; append like a scroll load-more. Music has its own
  // item shape (playlist cards), so it uses appendMusicItems.
  window.tv.onFeedChunk((chunk) => {
    if (!chunk || state.mode !== 'browse' || !state.gridSection || state.gridSection !== chunk.section) return;
    // Never bleed feed content onto a non-feed screen: the settings category grid
    // carries body.settings-cats the whole time it is shown, so a late chunk from
    // a feed that was still streaming when the user opened Settings is dropped.
    if (document.body.classList.contains('settings-cats')) return;
    if (chunk.section === 'music') return appendMusicItems(chunk.items || []);
    applyFeedChunk(chunk.videos || [], chunk.shelves || [], true);
  });

  // A fresh feed replacing a stale disk snapshot (Home/History/Music): re-render
  // and put the selector back on the card it was on (by video id or playlist id).
  window.tv.onFeedFresh((data) => {
    if (!data || state.mode !== 'browse' || !state.gridSection || state.gridSection !== data.section) return;
    if (document.body.classList.contains('settings-cats')) return; // don't overwrite the settings grid

    const cur = Nav.current();
    const prevId = cur && cur.dataset ? (cur.dataset.id || cur.dataset.playlist) : null;
    moreExhausted.delete(data.section);
    if (data.section === 'music') { state.currentMusic = data.items || []; renderMusic(state.currentMusic); }
    else if (data.section === 'history') renderVideoGrid(data.feed);
    else renderFeed(data.feed);
    if (prevId) {
      const container = Nav.mode === 'shelves' ? shelvesBox : grid;
      const again = container.querySelector('.card[data-id="' + prevId + '"], .card[data-playlist="' + prevId + '"]');
      if (again) Nav.focusElement(again);
    }
  });

  // ---------- on-screen keyboard / search / text-entry ----------
  // Moved to osk.js (renderer split, s97). app.js imports initOsk,
  // openSearchOsk, openTextEntry, and handleSearchInput from there.

  // ---------- video context menu ----------
  // Builders moved to videomenu.js (renderer split, s101). app.js imports
  // openVideoMenu (long-press dispatch) + initVideoMenu (boot dep injection).

  // ---------- accounts (multi-account) ----------
  // The account system (label/avatar, the "Who's watching" picker, and
  // the switch/manage menus) moved to accounts.js (renderer split, s102).
  // stopForAccountSwitch stays here (player teardown) and is injected
  // into accounts.js at boot.

  // Account isolation: a switch must not carry playback across accounts. Tear
  // down any full-screen OR background video + its Shaka/SABR session, then
  // empty the user queue (stopPlayback keeps it, since it normally survives a
  // stop) so the next account starts with nothing playing or queued.
  function stopForAccountSwitch() {
    if (pstate.bgPlaying || state.mode === 'player' || pstate.currentVideoId) stopPlayback();
    pstate.userQueue = [];
    updateRailQueueItem();
  }

  // Picker + account entry/switch/manage builders moved to accounts.js (s102).

  // ---------- input routing ----------

  window.addEventListener('tvinput', async (e) => {
    const a = e.detail.action;
    // Screen dimming: a dimmed screen wakes on ANY input, consuming that press;
    // otherwise every input re-arms the idle timer.
    if (isDimmed()) { wakeDim(); return; }
    resetDimTimer();
    // Fullscreen toggle is global (works in any mode); rebindable via Controls.
    if (a === 'fullscreen') return window.tv.toggleFullscreen();

    // Phone-initiated pairing PIN modal is fully modal and can appear over ANY
    // screen (a phone tapped "Pair"): swallow all input, Back cancels it.
    if (Settings.isCompanionPairOpen && Settings.isCompanionPairOpen()) {
      if (a === 'back') Settings.closeCompanionPair();
      return;
    }

    if (state.mode === 'error') {
      // Retry is useless here -- the user must leave and check what's wrong.
      // A/Enter exits the app.
      if (a === 'select') window.tv.quit();
      return;
    }

    // "Who's watching" startup picker is modal (accounts.js).
    if (state.mode === 'picker') return handlePickerInput(a);

    // Settings dialog is modal (category grid itself lives in browse mode).
    if (state.mode === 'settings') { Settings.handleInput(a); return; }

    if (state.mode === 'player') {
      // Screen-off blackout is modal: any button restores the screen and
      // consumes the press (so 'back' doesn't also stop playback).
      if (!$('screen-off').classList.contains('hidden')) { hideScreenOff(); showTransport(); return; }
      // Slide-up option menu (speed / quality / aspect) is modal too.
      if (pstate.pMenu) {
        if (a === 'back') return closePlayerMenu();
        // Wrap around at the ends (Up on the first item -> last, Down on last -> first).
        const _pn = pstate.pMenu.items.length;
        if (a === 'up') { if (_pn) pstate.pMenu.index = (pstate.pMenu.index - 1 + _pn) % _pn; applyPlayerMenuFocus(); return; }
        if (a === 'down') { if (_pn) pstate.pMenu.index = (pstate.pMenu.index + 1) % _pn; applyPlayerMenuFocus(); return; }
        if (a === 'select') return playerMenuActivate();
        return;
      }
      // Comments panel is a focusable list: it captures all input while open.
      if (pstate.commentsOpen) return handleCommentsInput(a);
      // Live chat panel is an ambient (non-focusable) overlay: Back closes it
      // before it would minimize/stop, and the transport button toggles it.
      if (pstate.chatOpen && a === 'back') { closeChat(); return; }
      // In-player suggestions drawer (opened with Down while the HUD is hidden).
      if (pstate.suggestOpen) {
        if (a === 'back' || a === 'up') return closeSuggest();
        if (a === 'left') { pstate.suggestSel = Math.max(0, pstate.suggestSel - 1); applySuggestDrawerFocus(); return; }
        if (a === 'right') {
          if (pstate.suggestSel >= pstate.relatedVideos.length - 1) { loadMoreSuggest(); return; } // at the end -> fetch more
          pstate.suggestSel = Math.min(pstate.relatedVideos.length - 1, pstate.suggestSel + 1); applySuggestDrawerFocus(); return;
        }
        if (a === 'play') { togglePlay(); return; }
        if (a === 'select') {
          const v = pstate.relatedVideos[pstate.suggestSel];
          closeSuggest();
          if (v) { if (pstate.currentVideoObj) pstate.prevStack.push(pstate.currentVideoObj); play(v.id, { keepQueue: true }); }
          return;
        }
        return;
      }
      // SponsorBlock 'Ask' mode: while a prompt is up, OK skips the segment.
      if (state.sbAskSeg && a === 'select') { skipAskSegment(); return; }
      const wasVisible = !$('player-hud').classList.contains('hidden');
      // Back cancels a pending scrub (progressive seek) before it stops playback.
      if (a === 'back' && cancelSeekScrub()) return showTransport();
      // With Background playback on, Back minimizes (keeps playing) instead of
      // stopping; the "Now Playing" rail item then stops or re-expands it.
      if (a === 'back') return Settings.get('bgPlay') ? minimize() : stopPlayback('manual');
      // Bumpers and the dedicated Play button always act, bar visible or not.
      if (a === 'play') { togglePlay(); return showTransport(); }
      if (a === 'ff') { if (Settings.get('bumperAccel')) seekPress(1); else seekBy(10); return showTransport(); }
      if (a === 'rw') { if (Settings.get('bumperAccel')) seekPress(-1); else seekBy(-10); return showTransport(); }
      // A nav press with the bar hidden just reveals it (no accidental action);
      // except Down, which opens the in-player suggestions drawer.
      if (!wasVisible) { if (a === 'down') return openSuggest(); return showTransport(); }
      if (a === 'up') pstate.pRow = 'seek';
      else if (a === 'down') {
        if (scrubbing()) commitSeek();
        // Rows run top-to-bottom seek -> buttons -> (suggestions drawer). Down
        // from the seek row drops to the buttons; Down again (already on buttons)
        // dismisses the HUD and opens the drawer in one press, instead of doing
        // nothing until the HUD auto-hides.
        if (pstate.pRow === 'seek') { pstate.pRow = 'buttons'; }
        else { hide('player-hud'); updateClock(); openSuggest(); return; }
      }
      else if (a === 'left') { if (pstate.pRow === 'seek') seekPress(-1); else stepPlayerCol(-1); }
      else if (a === 'right') { if (pstate.pRow === 'seek') seekPress(1); else stepPlayerCol(1); }
      else if (a === 'select') { if (scrubbing()) commitSeek(); else if (pstate.pRow === 'seek') togglePlay(); else activatePlayerButton(); }
      // Hold-OK on the Download button opens the advanced "choose format" popup.
      else if (a === 'longpress' && pstate.pRow === 'buttons' && pstate.P_BUTTONS[pstate.pCol] === 'download') { openDownloadAdvanced(); return; }
      showTransport();
      return;
    }

    if (state.mode === 'auth') { handleAuthInput(a); return; }

    if (state.mode === 'search') return handleSearchInput(a);

    if (state.mode === 'menu') return handleMenuInput(a);

    // Background playback: the Play/Pause key re-expands the mini-player.
    if (pstate.bgPlaying && a === 'play') return restore();

    // A long-press of A/OK (or 'c') on a focused video card opens its context menu.
    if (a === 'longpress') {
      const el = Nav.current();
      // Long-press a card in the Queue view removes it from the queue.
      if (state.currentSection === 'queue' && el && el.classList.contains('card') && el.dataset.id) return removeFromQueue(el.dataset.id);
      // Playlist cards have no long-press menu: the TV client can't delete a
      // real YouTube playlist (playlist/delete 400s). Only video cards.
      if (el && el.classList.contains('card') && el.dataset.id) return openVideoMenu(el);
      return;
    }

    if (['up', 'down', 'left', 'right'].includes(a)) {
      // In-rail now-playing controls row: left/right steps the control buttons.
      const focused = Nav.current();
      if (focused && focused.id === 'rail-controls' && (a === 'left' || a === 'right')) {
        stepRailCtrl(a === 'right' ? 1 : -1);
        return;
      }
      const before = Nav.current();
      Nav.move(a);
      if (a === 'down' || a === 'right') maybeLoadMore();
      // Right that couldn't move = at the right end of a shelf row -> grow it.
      if (a === 'right' && Nav.mode === 'shelves' && Nav.current() === before) maybeLoadMoreShelf();
      applyRailCtrlFocus(); // re-highlight the controls row's active button if we landed on it
      return;
    }

    if (a === 'back') {
      // While a video is playing, Back on the rail stops it first; a later Back
      // on the rail then warns / exits the app as usual.
      if (pstate.bgPlaying && Nav.zone === 'rail') return stopPlayback('manual');
      // Rail: first press warns, second exits. From a channel's videos: back
      // to the channel list. From other content: back to the rail.
      if (Nav.zone === 'rail') return armExit();
      if (state.currentSection === 'channel') return backToChannels();
      if (state.currentSection === 'playlist') return backToPlaylists();
      if (state.currentSection === 'channelpage') return backFromChannelPage();
      return Nav.focusRail();
    }

    if (a === 'select') {
      const el = Nav.current();
      if (!el) return;

      if (el.classList.contains('card')) {
        if (el.classList.contains('settings-card')) return Settings.openCard(el.dataset.cat);
        if (el.dataset.channel !== undefined) return openChannel(el.dataset.name, el.dataset.channel);
        if (el.dataset.playlist !== undefined) return openPlaylist(el.dataset.playlist, el.dataset.name);
        if (state.currentSection === 'downloads') { if (el.dataset.action === 'clear') return clearDownloads(); return openDownloadItemMenu(el); }
        if (state.currentSection === 'queue') return playQueueCard(el);
        return playFromCard(el);
      }

      const section = el.dataset.section;
      if (section === 'nowplaying') return restore();
      if (section === 'npcontrols') return activateRailCtrl();
      if (section === 'queue') return openQueue();
      if (['home', 'subscriptions', 'trending', 'music', 'history', 'playlists', 'watchlater'].includes(section)) {
        // Selecting a menu item moves the selector to the FIRST item in the
        // loaded list (arrow Right, by contrast, lands on the nearest item).
        // Only if the user is STILL on this rail item when it finishes -- if
        // they moved on while it loaded, don't yank their focus.
        const from = Nav.current();
        await loadSection(section);
        if (Nav.current() === from) Nav.enterFirst();
        return;
      }
      // Bump loadToken so an in-flight feed load (e.g. Home still streaming at
      // startup) is discarded instead of rendering ITS videos into the settings
      // grid; gridSection stays null so background feed chunks are ignored too.
      if (section === 'settings') { ++state.loadToken; state.currentSection = 'settings'; state.gridSection = null; Settings.openScreen(); return; }
      if (section === 'downloads') { openDownloads(); return; }
      if (section === 'quit') return window.tv.quit();
      if (section === 'search') return openSearchOsk();
      if (section === 'signin') return openAccountSwitcher();
    }
  });

  video.addEventListener('ended', () => {
    // While background-playing (mode is 'browse') the queue must still advance,
    // so only stop outright when neither foreground nor background is active.
    if (state.mode !== 'player' && !pstate.bgPlaying) return stopPlayback('end');
    // Playback mode decides the end-of-video behaviour. ('one' never reaches
    // here -- native <video> loop restarts without firing 'ended'.)
    if (pstate.playbackMode === 'pause') { runPostCommand('end'); video.pause(); updatePlayPause(); if (state.mode === 'player') showTransport(); return; }
    if (pstate.playbackMode === 'stop') return stopPlayback('end');
    // 'next' (default) + safety net: advance to the queue / related list, else close.
    if (pstate.userQueue.length || pstate.upNext.length) playNext();
    else stopPlayback('end');
  });
  video.addEventListener('play', updatePlayPause);
  video.addEventListener('pause', updatePlayPause);
  video.addEventListener('timeupdate', () => {
    if (state.mode === 'player' && !$('player-hud').classList.contains('hidden')) updateSeekBar();
    chatReplayTick(); // reveal replay chat up to the current position (no-op unless replay chat is open)
  });
  video.addEventListener('seeking', () => chatReplaySeek()); // re-sync replay chat after a seek

  window.addEventListener('error', (e) => {
    window.tv.logError((e.message || 'window.onerror') + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.tv.logError('unhandledrejection: ' + (e.reason?.stack || e.reason?.message || String(e.reason)));
  });

  // ---------- companion remote (Phase 2) ----------
  // Jump to a rail section on a phone 'section' command, mirroring the rail
  // selection logic. Drops out of the fullscreen player first so the target
  // grid is actually visible.
  // Switch to account `pid` before opening a pushed link, only if it exists and
  // differs from the active one (enterAccount reloads feeds + resets caches).
  async function switchProfile(pid) {
    try {
      const data = await window.tv.listAccounts();
      const accts = (data && data.accounts) || [];
      const cur = accts.find((a) => a.selected);
      if (pid && accts.some((a) => a.id === pid) && (!cur || cur.id !== pid)) await enterAccount(pid);
    } catch { /* stay on current profile */ }
  }

  // Snapshot for the phone's now-playing / queue readout (Phase 4). Thumbnails
  // are derived from the video id (currentVideoObj only carries id/title/author).
  function companionStatus() {
    const id = pstate.currentVideoId || null;
    const vo = pstate.currentVideoObj || null;
    const thumbFor = (vid) => vid ? ('https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg') : '';
    const nowPlaying = id ? {
      videoId: id,
      title: (vo && vo.title) || '',
      channel: (vo && vo.author) || '',
      thumb: thumbFor(id),
      duration: (video && isFinite(video.duration)) ? video.duration : 0,
      position: (video && isFinite(video.currentTime)) ? video.currentTime : 0,
      paused: video ? !!video.paused : true,
      speed: (video && video.playbackRate) || 1,
    } : null;
    const mapQ = (v) => ({ videoId: v.id || v.videoId, title: v.title || '', channel: v.author || v.channel || '', thumb: (v.thumbnail || thumbFor(v.id || v.videoId)), duration: v.duration || 0 });
    const queue = [...(pstate.userQueue || []), ...(pstate.upNext || [])].map(mapQ);
    const captions = { on: pstate.captionIdx > 0, index: pstate.captionIdx || 0, tracks: (pstate.captionTracks || []).map((t) => t.name || t.lang || '') };
    const audio = { current: pstate.audioLang || '', tracks: (pstate.audioTracks || []).map((a) => ({ code: a.code, name: a.name || a.code })) };
    let qOptions = ['auto'];
    try {
      if (pstate.shakaPlayer && pstate.shakaPlayer.getVariantTracks) {
        const hs = [...new Set(pstate.shakaPlayer.getVariantTracks().map((t) => t.height).filter(Boolean))].sort((a, b) => b - a);
        qOptions = ['auto', ...hs];
      }
    } catch { /* no tracks yet */ }
    const quality = { current: pstate.qualityLabel || 'Auto', options: qOptions };
    return {
      mode: state.mode, bgPlaying: !!pstate.bgPlaying, nowPlaying, queue,
      captions, audio, quality,
      sponsorblock: { enabled: state.sbEnabled !== false },
    };
  }

  // Companion track control (caption / audio / quality) - mirror the player-menu
  // apply logic so the phone can drive them without opening the on-screen menu.
  function setCaptionIndex(i) {
    const max = (pstate.captionTracks || []).length;
    pstate.captionIdx = Math.max(0, Math.min(Number(i) || 0, max));
    applyCaption();
  }
  function toggleCaptionCmd() {
    setCaptionIndex(pstate.captionIdx > 0 ? 0 : ((pstate.captionTracks || []).length ? 1 : 0));
  }
  function setAudioCode(code) { if (code) switchAudio(code, 'plain'); }
  function setQualityChoice(choice) {
    const p = pstate.shakaPlayer;
    if (!p) return;
    try {
      if (choice === 'auto' || choice == null) {
        p.configure({ abr: { enabled: true } });
        pstate.qualityLabel = 'Auto'; pstate.qualityIdx = 0;
      } else {
        const h = Number(choice);
        p.configure({ abr: { enabled: false } });
        const best = (p.getVariantTracks() || []).filter((t) => t.height === h).sort((a, b) => b.bandwidth - a.bandwidth)[0];
        if (best) p.selectVariantTrack(best, true);
        pstate.qualityLabel = h + 'p';
      }
      updateControlLabels();
    } catch (e) { /* quality unavailable */ }
  }

  async function gotoSection(name) {
    if (name === 'search') return openSearchOsk();
    if (name === 'settings') { ++state.loadToken; state.currentSection = 'settings'; state.gridSection = null; Settings.openScreen(); return; }
    if (['home', 'subscriptions', 'music', 'history', 'playlists', 'watchlater'].includes(name)) {
      if (state.mode === 'player') stopPlayback('stop');
      await loadSection(name);
      Nav.enterFirst();
    }
  }

  // ---------- boot ----------

  (async function boot() {
    try {
      const ui = await window.tv.getUiSettings();
      if (ui && ui.view === 'shelves') state.viewMode = 'shelves';
    } catch { /* default grid */ }

    initOsk({ moreExhausted, feedErrorHint });
    initPlayerButtons();
    initBgQueue({
      play, stopPlayback, togglePlay, applyAspect, closePlayerMenu, pBtn,
      icons: { play: SVG_PLAY, pause: SVG_PAUSE, stop: SVG_STOP, trash: SVG_TRASH, next: P_ICONS.next },
    });
    initRailControls();
    initAuth();
    initPlayerActions({ stopPlayback });
    initPlayerMenu({ pBtn, activatePlayerButton, applyAspect, applyPlaybackMode, applyCaption, updateControlLabels, switchAudio });
    initStats({ getShaka: () => pstate.shakaPlayer, getVideoId: () => pstate.currentVideoId });
    initVideoMenu({ play, addToQueue, removeFromQueue, openChannelPage, toggleWatchLater, openPlaylist });
    initAccounts({ stopForAccountSwitch, loadSection });
    initSeek({ updateSeekBar, updateSeekPreview, getShaka: () => pstate.shakaPlayer });
    initCmd({ getVideoObj: () => pstate.currentVideoObj, getVideoId: () => pstate.currentVideoId, getChannelId: () => pstate.currentChannelId });
    initSuggest({ applyAspect });
    initVideoActions({ pBtn });
    initLiveChat({ applyAspect, refreshPlayerButtons });
    initComments({ togglePlay, applyAspect });
    initDownloads();
    // Companion remote: route authed phone commands (nav / section / text /
    // transport / act) into the same functions on-device input uses. nav is a
    // synthesized 'tvinput' event; the rest call these injected primitives.
    initCompanion({
      section: gotoSection,
      // Standalone profile switch (no playback) - the phone's profile picker.
      switchProfile: (id) => switchProfile(id),
      search: (v, submit) => searchFor(v, submit),
      edit: (op) => editSearch(op),
      // Play a pushed link now (main brings the window to the front + fullscreen
      // first). An optional profileId switches account before playing.
      playNow: async (id, profileId) => { if (profileId) await switchProfile(profileId); play(id); },
      queue: (id) => addToQueue({ id, title: '', author: '', thumbnail: '' }, false),
      openPlaylist: (id, name) => openPlaylist(id, name || ''),
      openChannel: (id, name) => openChannelPage(id, name || ''),
      getStatus: companionStatus,
      transport: {
        toggle: () => togglePlay(),
        play: () => { if (video && video.paused) togglePlay(); },
        pause: () => { if (video && !video.paused) togglePlay(); },
        stop: () => stopPlayback('stop'),
        next: () => playNext(),
        skip: (d) => seekBy(Number(d) || 0),
        seekTo: (p) => { if (video && isFinite(Number(p))) video.currentTime = Number(p); },
        speed: (x) => { if (video && isFinite(Number(x)) && Number(x) > 0) video.playbackRate = Number(x); },
        fullscreen: () => window.tv.toggleFullscreen(),
        mini: () => minimize(),
        // volume + mute are handled in MAIN as Windows system-volume media keys
        // (single OS volume; no in-app <video> volume), so they are intentionally
        // not wired here - main never forwards them to the renderer.
      },
      act: {
        sbtoggle: () => toggleSb(),
        watchlater: () => saveToWatchLater(),
        save: () => saveToWatchLater(),
        like: () => toggleLike(),
        dislike: () => toggleDislike(),
        subscribe: () => toggleSubscribe(),
        comments: () => toggleComments(),
        livechat: () => toggleChat(),
      },
      track: {
        caption: (i) => setCaptionIndex(i),
        captionToggle: () => toggleCaptionCmd(),
        audio: (code) => setAudioCode(code),
        quality: (q) => setQualityChoice(q),
      },
    });
    // Phone-initiated pairing: main pushes the PIN info (after bringing the window
    // to the front + fullscreen); show the PIN modal over whatever is on screen.
    if (window.tv.onCompanionPairRequested) {
      window.tv.onCompanionPairRequested((info) => { try { Settings.openCompanionPair(info); } catch (e) { /* ignore */ } });
    }
    // Settings hooks: opening/closing a settings dialog flips the input mode;
    // the Accounts category card launches the existing accounts flow.
    // Settings.init() also runs applyAll() to push visual settings into CSS.
    await Settings.init({
      toast,
      onOpenDialog: () => { state.mode = 'settings'; },
      onCloseDialog: () => { state.mode = 'browse'; Nav.apply(); },
      onLaunchAccounts: openAccountsSettings,
      editText: openTextEntry,
      // Content language / country changed: main rebuilt the sessions + cleared
      // its feed cache, so just drop the renderer-side account-scoped caches.
      // Do NOT reload here: locale is always changed from inside the Settings
      // screen (currentSection === 'settings', which is not a feed), and
      // reloading would also wipe the settings category grid. Every section
      // refetches on the next navigation (Home always hits the network; the
      // other sections use the caches cleared here).
      onLocaleChange: () => { resetAccountScopedCaches(); },
      // Home layout (categories/grid) changed in Settings > Interface: sync the
      // renderer's viewMode and re-render Home if we're on it.
      onViewChange: (v) => { state.viewMode = v; if (state.currentSection === 'home') applyView(); }
    });
    // On-screen clock: tick once a second (reads the clock settings live).
    startClock(() => state.mode);
    resetDimTimer(); // arm the screen-dimming idle timer (General > Screen dimming)
    // One-shot update check on launch (opt-in via Settings > About "Notify me
    // about updates"). Unlike the manual About button it does NOT open the
    // browser - it only toasts, so the user can update from Settings > About when
    // convenient. Delayed + fire-and-forget so it never blocks boot or collides
    // with boot toasts; offline / rate-limited failures are silently ignored.
    if (Settings.get && Settings.get('autoUpdateNotify')) {
      setTimeout(async () => {
        try {
          const r = await window.tv.checkUpdate();
          if (r && r.ok && r.newer) toast('CouchTube v' + r.latest + ' is available - see Settings > About to update', 6000);
        } catch (e) { /* offline or rate-limited: ignore */ }
      }, 8000);
    }
    // If a self-update was just applied (the new version booted for the first
    // time), confirm it once. Separate from the check above so it shows even with
    // update notifications turned off.
    if (window.tv.updateStatus) {
      setTimeout(async () => {
        try {
          const us = await window.tv.updateStatus();
          if (us && us.justUpdated) toast('Updated to CouchTube v' + us.justUpdated, 5000);
        } catch (e) { /* ignore */ }
      }, 3000);
    }
    // Account isolation (s76): cover the main UI with the account overlay
    // IMMEDIATELY so the chooser -- not the rail/feed -- is what shows at
    // startup. It reads "Connecting…" until init resolves, then becomes the
    // picker (or hides and loads the feed for last/default startup).
    $('picker-list').innerHTML = '';
    $('picker-title').textContent = 'Connecting to YouTube…';
    show('picker-overlay');
    state.mode = 'picker';
    try {
      const info = await window.tv.init();
      const startup = (info && info.startup) || 'ask';
      if (info && info.recovered) {
        // Accounts were recovered from the plaintext sidecar after a restore
        // (tokens couldn't be decrypted). Always show the picker so the user
        // sees their flagged accounts and can sign in again, regardless of the
        // persisted startup mode.
        await showPicker();
      } else if (startup === 'ask') {
        await showPicker();                       // "Who's watching" every launch
      } else if (startup === 'default' && info.defaultId) {
        hide('picker-overlay');
        await enterAccount(info.defaultId);       // always this account
      } else {
        // 'last' (or 'default' with no saved id): the last-used account is
        // already active from init -- just load its settings + feed.
        hide('picker-overlay');
        await finalizeAccount(info && info.accountName);
      }
    } catch (e) {
      hide('picker-overlay');
      showError('Could not connect to YouTube: ' + e.message);
    }
  })();
