// SPDX-License-Identifier: GPL-3.0-or-later
const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

// Portable data: keep ALL app data (credentials, caches, settings, Chromium
// profile) in a 'Data' folder next to the exe - project root in dev - instead
// of %APPDATA%. Must run before anything touches userData. Falls back to the
// default %APPDATA% location only if the exe folder isn't writable
// (e.g. installed under Program Files).
(function makePortable() {
  const fs = require('fs');
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,                      // portable build
    app.isPackaged ? path.dirname(app.getPath('exe')) : null, // unpacked build
    !app.isPackaged ? app.getAppPath() : null                 // dev: project root
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const dataDir = path.join(dir, 'Data');
      fs.mkdirSync(dataDir, { recursive: true });
      const probe = path.join(dataDir, '.write-test');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      app.setPath('userData', dataDir);
      return;
    } catch {}
  }
})();

const yt = require('./innertube');
const sb = require('./sponsorblock');
const dearrow = require('./dearrow');
const logger = require('./logger');
const activeaccount = require('./activeaccount');
const backup = require('./backup');
const downloads = require('./downloads');
const network = require('./network');
const ryd = require('./ryd');
const debug = require('./debug');
const system = require('./system');
const companion = require('./companion');
const update = require('./update');
const volume = require('./volume');
// Apply a staged restore (requested in a previous session) BEFORE the app opens
// the Data profile -- doing it now, while Data is unlocked and the prior
// instance has exited, avoids the EPERM / undecryptable-registry failure of an
// in-place restore (s84).
try { backup.applyPendingRestore(); } catch (e) { logger.error('applyPendingRestore threw:', e && e.message); }

// One-time migration (account isolation, s76): older builds kept settings at the
// Data root. Move any root ui_settings/sb_settings/search_history into the ACTIVE
// account's folder (set by yt.init to the last-selected account, or Guest) so
// existing preferences carry over. Only moves when the destination is absent.
function migrateLegacySettings() {
  const fs2 = require('fs');
  const root = app.getPath('userData');
  const dir = activeaccount.dir();
  for (const name of ['ui_settings.json', 'sb_settings.json', 'search_history.json']) {
    try {
      const src = path.join(root, name);
      const dst = path.join(dir, name);
      if (fs2.existsSync(src) && !fs2.existsSync(dst)) fs2.renameSync(src, dst);
    } catch (e) { logger.error('settings migration failed for', name, e.message); }
  }
}

let win;
let tray = null;
// Set true only for a REAL quit (tray Quit, in-app Exit, app before-quit). While
// false, a window 'close' with exitToTray on hides to the tray instead of ending
// the process.
let isQuitting = false;

// A "launch on startup" login launch carries a --hidden flag (registered by
// system.js only when the user also enabled "start minimized to tray"). When
// present, the first window opens hidden so the app sits in the tray instead of
// on screen. A manual launch never has the flag, so double-clicking the exe (or
// the second-instance / tray path) always opens normally.
const startHidden = process.argv.includes('--hidden');

// Single instance: a second launch must NOT start another process. The OS hands
// the launch off to the already-running instance (second-instance event below),
// which surfaces its window; this duplicate then exits. Top-level return is
// valid in a CommonJS module, so nothing further (whenReady, IPC) registers here.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => showWindow());

// Bring the main window to the foreground, fullscreen, and focus it. Used by the
// tray, the second-instance handoff, and (later) a pushed play-link from the
// companion app. Recreates the window if it was destroyed.
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  try { win.setFullScreen(true); } catch { /* ignore */ }
  win.focus();
}

// System-tray icon + menu. Icon is user-supplied at src/assets/tray.ico (.png
// fallback); a missing file yields an empty image -- Windows shows a blank slot
// but the tray still works, so the app never fails to start over a missing asset.
function trayIcon() {
  for (const f of ['tray.ico', 'tray.png']) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', f));
      if (img && !img.isEmpty()) return img;
    } catch { /* try next */ }
  }
  return nativeImage.createEmpty();
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Cathode');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Cathode', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch (e) { logger.error('tray create failed:', e && e.message); }
}

// Auth device-code state kept main-side so the renderer never supplies
// URLs/text for clipboard or browser opening.
let authState = { url: null, code: null };

function createWindow(hidden) {
  // No native application menu -- removes the menu bar the Alt key reveals on
  // Windows (this is a controller-first fullscreen app).
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#0f0f0f',
    // Window + taskbar icon. In a packaged build electron-builder stamps the exe
    // icon, but in dev (and for the taskbar generally) the window needs this or
    // Windows shows the default Electron icon. Reuses the app icon at src/assets.
    icon: path.join(__dirname, '..', 'assets', 'tray.ico'),
    // Hidden startup (login launch + "start minimized"): create the window
    // offscreen and NOT fullscreen so it sits in the tray; showWindow() makes it
    // visible + fullscreen when opened. Normal launch: start fullscreen (F11 toggles).
    show: !hidden,
    fullscreen: !hidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.removeMenu(); // belt-and-suspenders: no per-window menu either, so Alt is inert

  // Exit-to-tray (opt-in, off by default): when enabled, closing the window
  // hides it and the app keeps running in the tray. A real quit (tray Quit,
  // in-app Exit, OS shutdown) sets isQuitting first so the app still exits.
  win.on('close', (e) => {
    if (!isQuitting && system.exitToTray()) {
      e.preventDefault();
      win.hide();
    }
  });

  // DASH/Shaka: googlevideo doesn't send CORS headers for our file:// origin.
  // Strip Origin/Referer on outgoing requests and inject ACAO on responses.
  // Also covers YouTube's timedtext (caption) host so Shaka can fetch WebVTT.
  const filter = { urls: ['*://*.googlevideo.com/*', '*://*.youtube.com/api/timedtext*'] };
  win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    delete details.requestHeaders['Origin'];
    delete details.requestHeaders['Referer'];
    cb({ requestHeaders: details.requestHeaders });
  });
  // Debug: log googlevideo / timedtext request failures (403s, aborts, DNS) so a
  // playback bug report shows which stream call broke. Gated behind debug mode so
  // normal runs stay quiet.
  win.webContents.session.webRequest.onErrorOccurred(filter, (details) => {
    if (debug.isEnabled()) logger.debug('[net] request failed', details.error, details.method || '', String(details.url || '').slice(0, 160));
  });
  win.webContents.session.webRequest.onHeadersReceived(filter, (details, cb) => {
    // Strip any existing access-control-allow-* first (duplicate ACAO hard-fails
    // the CORS check), then inject permissive ones. POST is required for SABR
    // (UMP) segment requests; GET/HEAD cover classic DASH + captions.
    const h = {};
    for (const key of Object.keys(details.responseHeaders || {})) {
      if (!/^access-control-allow-/i.test(key)) h[key] = details.responseHeaders[key];
    }
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['*'];
    h['Access-Control-Allow-Methods'] = ['GET, HEAD, POST, OPTIONS'];
    cb({ responseHeaders: h });
  });

  // Renderer / child-process crash + load-failure capture. These are always
  // logged (not gated) because a crash is exactly what a bug report needs.
  win.webContents.on('render-process-gone', (_e, d) => logger.error('render-process-gone:', d && d.reason, 'exit', d && d.exitCode));
  win.webContents.on('unresponsive', () => logger.error('renderer unresponsive'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logger.error('did-fail-load', code, desc, String(url || '').slice(0, 160)));
  win.webContents.on('preload-error', (_e, p, err) => logger.error('preload-error', p, err && err.message));
  app.on('child-process-gone', (_e, d) => logger.error('child-process-gone:', d && d.type, d && d.reason, 'exit', d && d.exitCode));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Background feed streaming (s53): main pushes yt:feed-chunk (deeper feed
  // content after the first page) and yt:feed-fresh (a real feed replacing a
  // served disk snapshot) to the renderer.
  yt.setPushSender((channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });
  // Download queue -> renderer (progress updates + completion notifications).
  downloads.setSender((channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });
  // PO-token provider for web-client (dubbed) downloads: reuse the app's own
  // content-bound web GVS minter so yt-dlp doesn't 403 on the gated stream URLs.
  downloads.setPoTokenProvider((videoId) => yt.getDownloadPoToken(videoId));
  // SABR payload provider for in-app dub audio downloads: reuse the playback
  // SABR path (which streams dubbed tracks fine) instead of yt-dlp mweb, which
  // 403s on the identity-mismatched token. downloads.js drives googlevideo's
  // SabrStream with this payload.
  downloads.setSabrProvider((videoId) => yt.getSabrForDownload(videoId));
}

// Wrap an IPC handler so failures land in the log file with context.
function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      logger.error(`IPC ${channel} failed:`, e);
      throw e;
    }
  });
}

// After a restore, files under the live Data dir have changed underneath us,
// so relaunch shortly after so the app reopens against the restored data.
function scheduleRelaunch() {
  setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
}

process.on('uncaughtException', (e) => logger.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));

app.whenReady().then(async () => {
  logger.info('App start, version', app.getVersion());
  // Self-updater boot step: consume a "just updated" marker (for the success
  // toast) and wipe any stale update/ staging folder from a previous session.
  try { update.finalizeBoot(); } catch (e) { logger.error('update.finalizeBoot threw:', e && e.message); }
  // Windows taskbar identity: match the packaged appId so the taskbar button
  // groups correctly and uses our icon (not the generic Electron one) in dev too.
  try { app.setAppUserModelId('com.cathode.app'); } catch { /* non-Windows */ }
  // Debug mode (Settings > About): restore the saved flag and apply it to the
  // logger + innertube dumps before anything else runs, so a debug session
  // captures the whole boot. A PII-free account summary feeds the snapshot.
  debug.setInnertube(yt);
  debug.setSnapshotProvider(async () => {
    try {
      const la = yt.listAccounts();
      return { count: (la.accounts || []).length, signedIn: yt.isSignedIn(), startup: la.startup, guestSelected: la.selectedId === (la.accounts && la.accounts[0] && la.accounts[0].id) };
    } catch (e) { return { error: String(e && e.message) }; }
  });
  debug.init();
  // Apply any saved proxy / custom-DNS config BEFORE the window starts loading
  // so the very first network calls already honour it.
  try { await network.apply(); } catch (e) { logger.error('network.apply at boot threw:', e && e.message); }
  // System prefs (tray / launch-on-startup): reconcile the OS login-item with the
  // stored flag before the window opens.
  try { system.init(); } catch (e) { logger.error('system.init threw:', e && e.message); }
  createWindow(startHidden);
  createTray(); // run-in-background tray icon + menu
  startCompanionIfEnabled(); // LAN remote server (opt-in via companionEnabled)
  backup.initScheduler(); // auto-backup cadence (no-op when cadence is 'off')

  // Auto-update yt-dlp on launch when the user enabled it (best-effort, async;
  // no-op when yt-dlp isn't installed). yt-dlp breaks against YouTube often, so
  // keeping it current avoids stale-binary download failures.
  try {
    if (downloads.readSettings().autoUpdateYtdlp) {
      downloads.updateYtdlp()
        .then((r) => { if (r && r.ok) logger.info('[downloads] yt-dlp auto-update:', r.message); })
        .catch(() => {});
    }
  } catch (e) { /* settings unreadable: skip */ }

  // Resume any downloads left incomplete when the app last closed.
  try { downloads.resumeIncomplete(); } catch (e) { logger.error('resumeIncomplete threw:', e && e.message); }

  // Warm the binary-version cache in the background so opening Settings > Downloads
  // is instant (the --version spawns, esp. yt-dlp.exe's self-unpack, happen now).
  downloads.getState().catch(() => {});

  // Stale diagnostic dumps (s83): debug_*.json are raw personalized feed/player
  // captures, only wanted while CATHODE_DEBUG_DUMPS=1. Prune them on a normal
  // boot so they don't linger in Data/ or get swept into backups.
  if (process.env.CATHODE_DEBUG_DUMPS !== '1') {
    try {
      const fsP = require('fs');
      const dd = app.getPath('userData');
      for (const f of fsP.readdirSync(dd)) {
        if (/^debug_.*\.json$/i.test(f)) {
          try { fsP.unlinkSync(path.join(dd, f)); } catch { /* locked: skip */ }
        }
      }
    } catch { /* Data dir unreadable: nothing to prune */ }
  }

  // ---- IPC: data layer (all InnerTube work happens in the main process) ----

  handle('yt:init', async () => {
    const r = await yt.init(
      // auth-pending: remember + forward the device-code info to the renderer
      (data) => {
        const url = data.verification_url || 'https://www.google.com/device';
        const code = data.user_code || '';
        // Pre-filled URL for the QR: prefer what Google returns, else build it.
        const urlComplete = data.verification_url_complete || (code ? url + '?user_code=' + encodeURIComponent(code) : url);
        authState = { url: url, code: code };
        win.webContents.send('yt:auth-pending', { url: url, code: code, urlComplete: urlComplete });
      },
      // fresh device-code sign-in completed
      () => win.webContents.send('yt:auth-success'),
      // stored session restored at boot (s53) -- update the label, nothing else
      () => win.webContents.send('yt:auth-restored')
    );
    migrateLegacySettings(); // active account is now known
    try { await network.apply(); } catch (e) {} // re-apply with the resolved account's net settings
    return r;
  });

  handle('yt:signIn', async () => yt.signIn());
  handle('yt:signOut', async () => yt.signOut());
  handle('yt:isSignedIn', async () => yt.isSignedIn());

  // Multi-account: list / add (device flow) / switch / remove.
  handle('yt:listAccounts', async () => yt.listAccounts());
  handle('yt:addAccount', async () => yt.addAccount());
  handle('yt:selectAccount', async (_e, id) => { const r = await yt.selectAccount(id); try { await network.apply(); } catch (e) {} return r; });
  // Re-apply proxy / custom DNS after the renderer saves Network settings, then
  // rebuild the InnerTube sessions so feeds pick up (or drop) the net-routed
  // fetch. setLocale = clear feed cache + re-init sessions (same as a locale
  // change); safe here since Network settings are only reachable post-init.
  handle('net:apply', async () => {
    const r = await network.apply();
    try { await yt.setLocale(); } catch (e) { logger.error('net:apply session rebuild threw:', e && e.message); }
    return r;
  });
  // Like / dislike counts (Return YouTube Dislike).
  handle('ryd:get', async (_e, id) => ryd.getVotes(id));
  handle('yt:removeAccount', async (_e, id) => yt.removeAccount(id));
  // Startup preference + default account (account isolation, s76).
  handle('yt:setStartup', async (_e, mode) => yt.setStartup(mode));
  handle('yt:setDefaultAccount', async (_e, id) => yt.setDefaultAccount(id));
  handle('yt:startupInfo', async () => yt.getStartupInfo());

  // Content language / country: renderer writes contentLang/contentCountry to
  // ui_settings first, then calls this to rebuild the sessions with the new
  // locale (see innertube.setLocale).
  handle('yt:setLocale', async () => yt.setLocale());

  handle('yt:home', async () => yt.getHomeFeed());
  handle('yt:subscriptions', async () => yt.getSubscriptionsFeed());
  handle('yt:subChannels', async () => yt.getSubscriptionChannels());
  handle('yt:channelFeed', async (_e, params, name) => yt.getChannelFeed(params, name));
  handle('yt:channelPage', async (_e, id, name) => yt.getChannelPage(id, name));
  handle('yt:section', async (_e, name) => yt.getSection(name));
  handle('yt:playlists', async (_e, force) => yt.getPlaylists(force));
  handle('yt:playlistFeed', async (_e, id, name) => yt.getPlaylistFeed(id, name));
  handle('yt:music', async () => yt.getMusic());
  handle('yt:addToPlaylist', async (_e, playlistId, videoId) => yt.addToPlaylist(playlistId, videoId));
  handle('yt:removeFromPlaylist', async (_e, playlistId, videoId) => yt.removeFromPlaylist(playlistId, videoId));
  handle('yt:removePlaylist', async (_e, playlistId) => yt.removePlaylist(playlistId));
  handle('yt:recordHistory', async (_e, videoId) => yt.recordHistory(videoId));
  handle('yt:removeFromHistory', async (_e, token) => yt.removeFromHistory(token));
  handle('yt:rate', async (_e, videoId, rating) => yt.rateVideo(videoId, rating));
  handle('yt:subscribe', async (_e, channelId, subscribe) => yt.setSubscribed(channelId, subscribe));
  handle('yt:more', async (_e, section, view) => yt.getMoreFeed(section, view));
  handle('yt:moreShelf', async (_e, section, title) => yt.loadMoreShelf(section, title));
  handle('yt:moreRelated', async (_e, videoId, exclude) => yt.getMoreRelated(videoId, exclude));
  handle('yt:relatedFresh', async (_e, videoId, exclude) => yt.getRelatedFresh(videoId, exclude));
  // Live chat (read-only): probe availability at play, start/stop the poller
  // when the renderer opens/closes the chat panel. Items stream to the renderer
  // via the push channel (yt:live-chat).
  handle('yt:liveChatProbe', async (_e, videoId) => yt.probeLiveChat(videoId));
  handle('yt:liveChatStart', async (_e, videoId, filter) => yt.startLiveChat(videoId, filter));
  handle('yt:liveChatStop', async () => yt.stopLiveChat());
  // Comments (read-only): fetch a page, paginate, and load a thread's replies.
  handle('yt:comments', async (_e, videoId, sort) => yt.getVideoComments(videoId, sort));
  handle('yt:moreComments', async (_e, videoId) => yt.getMoreComments(videoId));
  handle('yt:commentReplies', async (_e, videoId, commentId) => yt.getCommentReplies(videoId, commentId));
  handle('yt:search', async (_e, query) => yt.search(query));
  handle('yt:searchSuggest', async (_e, query) => yt.searchSuggest(query));
  handle('yt:streams', async (_e, videoId) => yt.getStreams(videoId));
  // SABR streaming (playback rework). yt:sabr returns the server-ABR payload for
  // a VOD (or { ok:false } for live/unsupported -> renderer falls back to
  // yt:streams). yt:sabrReload + yt:sabrPoToken back the adapter's
  // onReloadPlayerResponse / onMintPoToken callbacks.
  handle('yt:sabr', async (_e, videoId, preferredLang, opts) => yt.getSabr(videoId, preferredLang, opts));
  handle('yt:sabrReload', async (_e, videoId, reloadContext) => yt.reloadSabrPlayer(videoId, reloadContext));
  handle('yt:sabrPoToken', async (_e, videoId) => yt.mintPoToken(videoId));
  handle('sb:segments', async (_e, videoId) => sb.getSegments(videoId));
  handle('sb:get', async () => sb.getSettings());
  handle('sb:set', async (_e, patch) => sb.setSettings(patch));
  // DeArrow: crowdsourced titles + thumbnails (settings gate the lookup).
  handle('dearrow:branding', async (_e, videoId) => dearrow.getBranding(videoId));
  handle('dearrow:get', async () => dearrow.getSettings());
  handle('dearrow:set', async (_e, patch) => dearrow.setSettings(patch));

  // ---- UI settings (persisted view preferences, e.g. grid vs categories) ----
  const fsMod = require('fs');
  const uiSettingsPath = () => activeaccount.file('ui_settings.json');
  const readUiSettings = () => {
    try { return JSON.parse(fsMod.readFileSync(uiSettingsPath(), 'utf8')); }
    catch { return {}; }
  };
  // ---- Search history (recent queries, newest first) ----
  const searchHistoryPath = () => activeaccount.file('search_history.json');
  const readSearchHistory = () => {
    try { const a = JSON.parse(fsMod.readFileSync(searchHistoryPath(), 'utf8')); return Array.isArray(a) ? a : []; }
    catch { return []; }
  };
  const writeSearchHistory = (arr) => {
    try { fsMod.writeFileSync(searchHistoryPath(), JSON.stringify(arr)); }
    catch (e) { logger.error('search history write failed:', e); }
  };
  handle('search:historyGet', async () => readSearchHistory());
  handle('search:historyAdd', async (_e, query) => {
    const q = String(query || '').trim();
    if (!q) return readSearchHistory();
    const next = [q, ...readSearchHistory().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 30);
    writeSearchHistory(next);
    return next;
  });
  handle('search:historyClear', async () => { writeSearchHistory([]); return []; });

  handle('ui:get', async () => readUiSettings());
  handle('ui:set', async (_e, patch) => {
    const next = Object.assign(readUiSettings(), patch || {});
    try { fsMod.writeFileSync(uiSettingsPath(), JSON.stringify(next)); }
    catch (e) { logger.error('ui:set failed:', e); }
    return next;
  });

  // ---- Auth convenience (remote-friendly sign-in) ----
  handle('auth:copyCode', async () => {
    if (!authState.code) return false;
    clipboard.writeText(authState.code);
    return true;
  });
  handle('auth:openUrl', async () => {
    if (!authState.url) return false;
    await shell.openExternal(authState.url); // opens default browser on the HTPC
    return true;
  });

  handle('app:copyText', async (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  // ---- About / updates ----
  // GitHub repo to check for releases. app:checkUpdate hits the Releases API,
  // compares tag_name to app.getVersion(), and reports { newer, latest, url }.
  // A blank repo would make it report { configured:false }.
  const UPDATE_REPO = 'vdb86/Cathode';
  const cmpVer = (a, b) => {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  };
  handle('app:about', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));
  handle('app:checkUpdate', async () => {
    if (!UPDATE_REPO) return { configured: false };
    try {
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cathode' }
      });
      if (!res.ok) return { configured: true, ok: false, status: res.status };
      const j = await res.json();
      const latest = String(j.tag_name || '').replace(/^v/i, '');
      const current = app.getVersion();
      return { configured: true, ok: true, current, latest, url: j.html_url || '', newer: !!latest && cmpVer(latest, current) > 0 };
    } catch (e) {
      logger.error('checkUpdate failed:', e);
      return { configured: true, ok: false, error: e.message };
    }
  });
  // In-app self-update (portable Windows build). status() tells the renderer
  // whether in-place update is possible + whether a download is already staged;
  // downloadUpdate streams + extracts + validates the release zip (progress via
  // update:progress); applyUpdateNow launches the hidden applier and forces a
  // real quit so it installs on close and relaunches the new version.
  handle('app:updateStatus', async () => update.status());
  handle('app:downloadUpdate', async () => update.download(win));
  handle('app:applyUpdateNow', async () => {
    const ok = update.applyNow();
    if (ok) { isQuitting = true; setTimeout(() => app.quit(), 200); }
    return { ok };
  });
  handle('app:openExternal', async (_e, url) => {
    const u = String(url || '');
    // Only web URLs: openExternal on a file/UNC path would EXECUTE it (s83).
    if (!/^https?:\/\//i.test(u)) return false;
    await shell.openExternal(u);
    return true;
  });

  // Playback command hooks (pre-roll / post-roll, e.g. an HDMI-CEC helper).
  // SECURITY (s83): the renderer sends only an EVENT NAME ('pre' | 'post-end' |
  // 'post-stop'); the command string is read HERE from the active account's
  // ui_settings. A compromised renderer can therefore only re-trigger what the
  // user configured, never run arbitrary commands. Fire-and-forget + logged;
  // never blocks playback.
  // Substitute {name} tokens in a command TEMPLATE with values from the
  // renderer. Each value is wrapped in double quotes and the characters that
  // could still break out of / expand inside a double-quoted cmd.exe argument
  // (embedded quotes, %VAR% / !VAR! expansion, newlines) are neutralised, so a
  // hostile video title/channel cannot inject extra shell commands. Unknown
  // tokens are left verbatim. This keeps the s83 model: the template is still
  // owned by the user's settings; only the substituted VALUES cross the IPC.
  function shellQuoteWin(val) {
    let x = String(val == null ? '' : val);
    x = x.replace(/[\r\n]+/g, ' ');   // a newline would terminate the command line
    x = x.replace(/"/g, "'");         // embedded quotes -> apostrophes (don't break our quoting)
    x = x.replace(/%/g, ' ');         // no %VAR% environment expansion
    x = x.replace(/!/g, ' ');         // no !VAR! delayed expansion
    return '"' + x + '"';
  }
  function substituteCmdVars(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) ? shellQuoteWin(vars[name]) : m
    ));
  }

  handle('app:playbackEvent', async (_e, event, vars) => {
    const ev = String(event || '');
    const s = readUiSettings();
    let cmd = '';
    if (ev === 'pre') {
      if (s.preCmdEnabled === true) cmd = String(s.preCmd || '').trim();
    } else if (ev === 'start') {
      // 'first' vs 'every' gating is decided renderer-side (needs session state),
      // like the pre-roll command; main just runs it when enabled.
      if (s.startCmdEnabled === true) cmd = String(s.startCmd || '').trim();
    } else if (ev === 'post-end' || ev === 'post-stop') {
      const trig = s.postCmdTrigger || 'end';
      const want = ev === 'post-end' ? 'end' : 'stop';
      if (s.postCmdEnabled === true && (trig === 'both' || trig === want)) {
        cmd = String(s.postCmd || '').trim();
      }
    } else {
      return false;
    }
    if (!cmd) return false;
    // Variable substitution. {event}/{trigger} come from the AUTHORITATIVE ev
    // (main-side), overriding anything the renderer may have sent.
    const v = (vars && typeof vars === 'object') ? Object.assign({}, vars) : {};
    v.event = ev; v.trigger = ev;
    cmd = substituteCmdVars(cmd, v);
    try {
      require('child_process').exec(cmd, { windowsHide: true, timeout: 20000 }, (err) => {
        if (err) logger.error('playback command failed:', cmd, '-', err.message);
      });
      logger.info('playback command (' + ev + '):', cmd);
      return true;
    } catch (e) { logger.error('playback command threw:', e.message); return false; }
  });

  // ---- Backup & Restore (local zip via PowerShell; restore relaunches) ----
  handle('backup:now', async () => backup.createBackup(false, (p) => {
    try { win.webContents.send('backup:progress', p); } catch (e) { /* window gone */ }
  }));
  handle('backup:list', async () => backup.listBackups());
  handle('backup:restore', async (_e, zipPath) => {
    // SECURITY (s83): only zips from the backups folder may come through here
    // (the in-app list). Arbitrary paths must go via backup:browse, where the
    // user picks the file in a MAIN-side native dialog.
    const p = String(zipPath || '');
    if (!backup.listBackups().some((b) => b.path === p)) {
      logger.error('backup:restore rejected non-listed path');
      return { ok: false, error: 'Not a listed backup' };
    }
    const r = await backup.stageRestore(p);
    if (r.ok) scheduleRelaunch();
    return r;
  });
  handle('backup:browse', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Backup', extensions: ['zip'] }]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    const r = await backup.stageRestore(res.filePaths[0]);
    if (r.ok) scheduleRelaunch();
    return r;
  });
  handle('backup:getCadence', async () => backup.getCadence());
  handle('backup:setCadence', async (_e, v) => { backup.setCadence(v); return { ok: true }; });

  // ---- Downloads: yt-dlp / ffmpeg binary management + global settings ----
  handle('dl:state', async () => downloads.getState());
  handle('dl:ready', async () => downloads.readyNow()); // fast (file-exists only) rail gate
  handle('dl:install', async (_e, which) => {
    const st = await downloads.installBinaries((p) => {
      // Tag progress with which binary so parallel installs update the right row.
      try { win.webContents.send('dl:bin-progress', Object.assign({ which }, p)); } catch (e) { /* window gone */ }
    }, which);
    // Let the renderer (rail visibility) know the binary state changed.
    try { win.webContents.send('dl:state-change', st); } catch (e) { /* window gone */ }
    return st;
  });
  handle('dl:updateYtdlp', async () => downloads.updateYtdlp());
  handle('dl:checkUpdates', async () => downloads.checkUpdates());
  handle('dl:getSettings', async () => downloads.readSettings());
  handle('dl:setSettings', async (_e, patch) => downloads.writeSettings(patch));
  handle('dl:chooseDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose download folder',
      defaultPath: downloads.resolveSaveDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    downloads.writeSettings({ saveDir: res.filePaths[0] });
    return { ok: true, dir: res.filePaths[0] };
  });
  handle('dl:enqueue', async (_e, info) => downloads.enqueue(info));
  handle('dl:queue', async () => downloads.getQueue());
  handle('dl:cancel', async (_e, id) => downloads.cancel(id));
  handle('dl:pause', async (_e, id) => downloads.pause(id));
  handle('dl:resume', async (_e, id) => downloads.resume(id));
  handle('dl:remove', async (_e, id) => downloads.remove(id));
  handle('dl:clearFinished', async () => downloads.clearFinished());
  handle('dl:formats', async (_e, videoId, url) => {
    // Build the list from in-process youtubei.js data (no yt-dlp.exe spawn). This
    // WEB extraction (with the app's minted PO token) DOES see dubbed / alternate-
    // language audio, which a separate yt-dlp process often can't. Fall back to
    // yt-dlp -J only if the fast path yields nothing.
    // Per-language TIERS (low/med/high) for a dubbed video live ONLY in the DASH/
    // SABR formats, which are exposed by the web client but are SABR-only -> yt-dlp
    // can't download them ("Requested format is not available"). The downloadable
    // dub path is web_safari's HLS, which carries ONE quality per language (no
    // tiers). So for multi-audio we keep the fast in-process list (one row per
    // language) and let the download fetch the right language via web_safari.
    try {
      const fast = await yt.getDownloadFormats(videoId);
      if (fast && fast.ok && fast.formats && fast.formats.length) return fast;
    } catch (e) { /* fall through */ }
    return downloads.listFormats(videoId, url);
  });
  handle('dl:prefetchFormats', async (_e, videoId, url) => {
    // Warm the youtubei.js info (fast path) in the background; yt-dlp -F as backup.
    yt.getDownloadFormats(videoId).catch(() => {});
    downloads.prefetchFormats(videoId, url);
    return { ok: true };
  });
  handle('dl:openFolder', async () => { try { await shell.openPath(downloads.resolveSaveDir()); return { ok: true }; } catch (e) { return { ok: false }; } });

  // ---- Logging ----
  handle('app:logPath', async () => logger.logPath());
  ipcMain.on('app:logError', (_e, msg) => logger.error('[renderer]', msg));
  ipcMain.on('app:logInfo', (_e, msg) => logger.info('[renderer]', msg));
  // Renderer console mirror (debug mode only): routed through logger.debug so it
  // is double-gated (dropped unless debug is on) and tagged DEBUG in the file.
  ipcMain.on('app:logDebug', (_e, msg) => logger.debug('[renderer]', msg));

  // ---- Debug mode (Settings > About) ----
  handle('debug:get', async () => ({ enabled: debug.isEnabled() }));
  handle('debug:set', async (_e, on) => ({ enabled: debug.setEnabled(!!on) }));
  handle('debug:export', async () => debug.exportBundle());

  // The in-app Exit (Back on the rail, quit item, account chooser) routes here.
  // With exit-to-tray on, that Exit HIDES to the tray (the app keeps running);
  // the tray menu's Quit is then the only true exit. Off: quit as before.
  ipcMain.on('app:quit', () => {
    if (system.exitToTray() && win && !win.isDestroyed()) { win.hide(); return; }
    isQuitting = true;
    app.quit();
  });
  ipcMain.on('app:toggleFullscreen', () => win.setFullScreen(!win.isFullScreen()));

  // ---- System preferences (run-in-tray + launch-on-startup) ----
  // Global (account-independent); persisted in Data/system_settings.json and
  // reflected into the OS login-item on set (see system.js).
  handle('system:get', async () => system.get());
  handle('system:set', async (_e, patch) => {
    const next = system.set(patch);
    // Start / stop (or restart on a port change) the companion server live when
    // its toggle or port changes.
    if (patch && ('companionEnabled' in patch || 'companionPort' in patch || 'companionName' in patch)) {
      companion.stop();
      if (next.companionEnabled) startCompanionIfEnabled();
      pushCompanionClients();
    }
    return next;
  });

  // ---- Companion remote (LAN WebSocket server; see companion.js) ----
  handle('companion:status', async () => ({
    running: companion.isRunning(),
    enabled: !!system.get().companionEnabled,
    connected: companion.connectedCount(),
    pairing: companion.pairingInfo(),
    devices: companion.listDevices()
  }));
  // Enter pairing mode (starts the server first if it wasn't running) and return
  // the QR payload + PIN for the TV screen to display.
  handle('companion:startPairing', async () => { if (!companion.isRunning()) startCompanionIfEnabled(true); return companion.enterPairing(); });
  handle('companion:stopPairing', async () => { companion.exitPairing(); return companion.pairingInfo(); });
  handle('companion:unpair', async (_e, id) => companion.unpair(id));
  handle('companion:unpairAll', async () => companion.unpairAll());
  // State pushed from the renderer -> broadcast to every authed phone (Phase 4).
  // Fire-and-forget; broadcast() is a no-op when no device is connected.
  ipcMain.on('companion:state', (_e, s) => companion.broadcast(Object.assign({ t: 'state' }, s || {})));
  ipcMain.on('companion:queue', (_e, q) => companion.broadcast(Object.assign({ t: 'queue' }, q || {})));
  ipcMain.on('companion:position', (_e, p) => companion.broadcast(Object.assign({ t: 'position' }, p || {})));
  // Toast mirror: the renderer's user-facing toasts are relayed to phones as
  // `notice` - but only while a phone is connected, to avoid pointless IPC.
  ipcMain.on('companion:notice', (_e, m) => { if (companion.connectedCount() > 0) companion.broadcast({ t: 'notice', message: String(m || '') }); });
});

// Tell the renderer how many phones are connected so it only builds/pushes state
// when someone is listening. Called on every device change + server start/stop.
function pushCompanionClients() {
  if (win && !win.isDestroyed()) win.webContents.send('companion:clients', companion.isRunning() ? companion.connectedCount() : 0);
}

// Start the LAN remote server when enabled (or forced, e.g. the user opened the
// pairing screen). onCommand forwards authed phone commands to the renderer
// (Phase 2 wires the renderer side); onDeviceChange pushes the paired/connected
// list to any open Remote settings screen.
function startCompanionIfEnabled(force) {
  if (!force && !system.get().companionEnabled) return;
  companion.start({
    // Empty companionName -> default to "Cathode" (a blank mDNS name left the
    // phone unable to discover the TV; the name must be non-empty).
    tvName: system.get().companionName || 'Cathode',
    port: system.get().companionPort || undefined,
    onCommand: (t, msg, ctx) => {
      // Profiles query: answered entirely in main (the account list lives here),
      // NOT forwarded to the renderer. Lets the phone show a profile picker for
      // open/openList's optional profileId.
      if (t === 'profiles') {
        (async () => {
          try {
            const data = await yt.listAccounts();
            const items = ((data && data.accounts) || []).map((a) => ({ id: a.id, name: a.name, avatar: a.avatar || null, selected: !!a.selected }));
            ctx.reply({ t: 'profiles', items });
          } catch (e) { ctx.reply({ t: 'profiles', items: [] }); }
        })();
        return;
      }
      // Volume / mute drive the WINDOWS master volume via the OS media keys
      // (single system volume - there is no separate in-app <video> volume).
      // Handled here in MAIN because the renderer can't reach the OS mixer; NOT
      // forwarded to the renderer. Only the step commands exist - volup/voldown
      // step one notch each, mute toggles.
      if (t === 'transport' && msg) {
        const cmd = String(msg.cmd || '').toLowerCase();
        if (cmd === 'mute') { volume.toggleMute(); return; }
        if (cmd === 'voldown' || cmd === 'volumedown') { volume.volumeDown(); return; }
        if (cmd === 'volup' || cmd === 'volumeup') { volume.volumeUp(); return; }
        // Window control lives in MAIN: the renderer cannot reliably show or
        // fullscreen a window that is hidden in the tray. `fullscreen` brings the
        // window to the FRONT and makes it fullscreen (works even from the tray -
        // same path the tray click / pushed link uses); `tray` (alias `minimize`)
        // hides it to the tray, and the app keeps running (a tray click, a pushed
        // link, or a `fullscreen` command restores it). Not forwarded to renderer.
        if (cmd === 'fullscreen') { showWindow(); return; }
        if (cmd === 'tray' || cmd === 'minimize') {
          if (win && !win.isDestroyed()) { try { win.setFullScreen(false); } catch { /* ignore */ } win.hide(); }
          return;
        }
      }
      // A pushed link that opens content (play now, or a playlist/channel/search)
      // brings the window to the front + fullscreen first (s154 showWindow).
      // Queueing in the background must NOT steal focus.
      // A profile switch also foregrounds the TV so the user sees the account
      // reload (and any sign-in prompt if that account needs re-login).
      const foreground = t === 'openList' || t === 'profile' || (t === 'open' && (!msg || msg.mode !== 'queue'));
      if (foreground) showWindow();
      // Optimistic receipt ack for the "did it take?" commands.
      if (t === 'open' || t === 'openList' || t === 'profile') { try { ctx.reply({ t: 'ack', for: t, ok: true }); } catch (e) { /* ignore */ } }
      if (win && !win.isDestroyed()) win.webContents.send('companion:command', { t, msg });
    },
    onDeviceChange: () => {
      if (win && !win.isDestroyed()) win.webContents.send('companion:devices', companion.listDevices());
      pushCompanionClients();
    },
    // Phone-initiated pairing: bring the TV to the front + fullscreen (works even
    // when minimized to the tray, via showWindow) and pop the PIN modal so the
    // user can read the code and enter it on the phone.
    onPairRequest: (info) => {
      showWindow();
      if (win && !win.isDestroyed()) win.webContents.send('companion:pairRequested', info);
    }
  });
}

// A genuine quit request (OS shutdown, app.quit from anywhere): let the window
// 'close' handler through instead of hiding to the tray.
app.on('before-quit', () => { isQuitting = true; try { update.applyOnQuit(); } catch { /* no staged update */ } try { companion.stop(); } catch { /* not running */ } try { volume.stop(); } catch { /* not running */ } });

// With exit-to-tray on, closing the last window must NOT end the process; the
// tray keeps it alive. Off (default): quit as before.
app.on('window-all-closed', () => { if (!system.exitToTray()) app.quit(); });
