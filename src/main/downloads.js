// SPDX-License-Identifier: GPL-3.0-or-later
// Download subsystem (yt-dlp + ffmpeg). Main-side: binary management (detect /
// one-click install / update / version check), GLOBAL download settings, and
// (later phases) the serial download queue. No npm dependencies -- Node built-ins
// + PowerShell for zip extraction (same approach as backup.js).
//
// Binaries live in <Data>/bin (yt-dlp.exe, ffmpeg.exe, ffprobe.exe). Settings
// live in <Data>/download_settings.json at the Data ROOT (GLOBAL -- NOT per
// account, unlike ui_settings). The Data dir is the portable userData folder
// index.js redirects to at boot.

const { app, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');
const sabrdl = require('./sabrdl');
let sponsorblock = null;
try { sponsorblock = require('./sponsorblock'); } catch { sponsorblock = null; }

let logger = null;
try { logger = require('./logger'); } catch { logger = null; }
function log(...a) { if (logger && logger.info) logger.info('[downloads]', ...a); else console.log('[downloads]', ...a); }
function logErr(...a) { if (logger && logger.error) logger.error('[downloads]', ...a); else console.error('[downloads]', ...a); }

// ---- paths ----
function dataDir() { return app.getPath('userData'); }
function binDir() {
  const d = path.join(dataDir(), 'bin');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { logErr('mkdir binDir failed:', e.message); }
  return d;
}
function ytdlpPath() { return path.join(binDir(), 'yt-dlp.exe'); }
function ffmpegPath() { return path.join(binDir(), 'ffmpeg.exe'); }
function ffprobePath() { return path.join(binDir(), 'ffprobe.exe'); }
function denoPath() { return path.join(binDir(), 'deno.exe'); }
function settingsPath() { return path.join(dataDir(), 'download_settings.json'); }

// Remote sources. Both are stable direct GitHub release URLs (no HTML scraping).
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const YTDLP_LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
// Deno: yt-dlp offloads YouTube n-signature (nsig) deciphering to an external JS
// runtime, which is FAR faster + more reliable than its built-in interpreter (this
// is how ytdlnis is fast). Deno is enabled by default in yt-dlp and is auto-detected
// when deno.exe sits in the SAME folder as yt-dlp.exe (our bin dir) - no PATH or
// flags needed. Optional but strongly recommended; the download options stay usable
// without it (just slower).
const DENO_ZIP_URL = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';


// ---- GLOBAL settings ----
// Quick-download defaults (all overridable in Settings > Downloads). saveDir
// empty means "resolve to <Windows Downloads>\CouchTube" (see resolveSaveDir).
const DEFAULTS = {
  saveDir: '',
  qualityCap: 1080,          // best video height <= this
  container: 'mp4',          // video container: mp4 | mkv | webm | mov | avi | flv
  type: 'video',             // quick-download type: 'video' | 'audio'
  audioOnly: false,          // legacy boolean (superseded by 'type'); kept for back-compat
  audioContainer: 'mp3',     // audio format when audioOnly: mp3 | m4a | opus | aac | flac | wav
  audioBitrate: '',          // output audio bitrate when audioOnly: '' = best, else e.g. '192K'
  filenameTemplate: '%(title)s [%(id)s].%(ext)s',
  restrictFilenames: true,
  embedThumbnail: true,
  embedMetadata: true,
  embedChapters: true,
  subtitles: false,
  subLangs: 'en',
  sponsorblock: 'off',       // off | mark | remove
  skipDownloaded: true,
  noOverwrite: true,
  concurrentFragments: 4,
  autoUpdateYtdlp: false,
  // Notifications (global). Fired on download completion / failure (Phase 3+).
  notifyInApp: true,
  notifyOs: true
};

function readSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch { raw = {}; }
  const s = Object.assign({}, DEFAULTS, raw);
  // Migrate the legacy "Audio only" boolean to the new Type setting.
  if (raw.type === undefined && raw.audioOnly === true) s.type = 'audio';
  return s;
}
function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch || {});
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); }
  catch (e) { logErr('writeSettings failed:', e.message); }
  return next;
}
// The effective download folder (never returns empty).
function resolveSaveDir() {
  const s = readSettings();
  return s.saveDir && String(s.saveDir).trim()
    ? String(s.saveDir).trim()
    : path.join(app.getPath('downloads'), 'CouchTube');
}

// ---- binary state ----
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Run yt-dlp --version, resolve the trimmed string or null (missing/failed).
function ytdlpVersion() {
  return new Promise((resolve) => {
    if (!fileExists(ytdlpPath())) return resolve(null);
    execFile(ytdlpPath(), ['--version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) { logErr('yt-dlp --version failed:', err.message); return resolve(null); }
      resolve(String(stdout || '').trim() || null);
    });
  });
}

// Run ffmpeg -version, resolve the version token (e.g. "n7.1" / a git hash) or
// null. First stdout line looks like: "ffmpeg version <token> Copyright ...".
function ffmpegVersion() {
  return new Promise((resolve) => {
    if (!fileExists(ffmpegPath())) return resolve(null);
    execFile(ffmpegPath(), ['-version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) { logErr('ffmpeg -version failed:', err.message); return resolve(null); }
      const m = String(stdout || '').match(/ffmpeg version (\S+)/i);
      resolve(m ? m[1] : null);
    });
  });
}

// Parse `deno --version` first line "deno 2.x.x (...)" -> the version token or null.
function denoVersion() {
  return new Promise((resolve) => {
    if (!fileExists(denoPath())) return resolve(null);
    execFile(denoPath(), ['--version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) { logErr('deno --version failed:', err.message); return resolve(null); }
      const m = String(stdout || '').match(/deno\s+(\S+)/i);
      resolve(m ? m[1] : null);
    });
  });
}

// Version detection is the slow part (each binary is spawned with --version, and
// yt-dlp.exe self-unpacks ~1-2 s). Cache the result keyed by the file's mtime so
// repeated getState() calls (e.g. opening Settings > Downloads) are instant; a
// reinstall/update changes the mtime and re-detects once. Warmed at startup.
const verCache = new Map(); // filePath -> { mtimeMs, version }
async function cachedVersion(filePath, computeFn) {
  if (!fileExists(filePath)) return null;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (e) {}
  const c = verCache.get(filePath);
  if (c && c.mtimeMs === mtimeMs) return c.version;
  const version = await computeFn();
  verCache.set(filePath, { mtimeMs, version });
  return version;
}

// Fast readiness check for the rail item: pure file-existence, NO --version
// spawn (getState's version probes are what made the rail item pop in late).
// Used at boot so the Downloads rail item's visibility is correct immediately.
function readyNow() {
  return fileExists(ytdlpPath()) && fileExists(ffmpegPath()) && fileExists(ffprobePath());
}

// Full binary + settings snapshot for the renderer settings screen.
async function getState() {
  const [ver, ffver, dver] = await Promise.all([
    cachedVersion(ytdlpPath(), ytdlpVersion),
    cachedVersion(ffmpegPath(), ffmpegVersion),
    cachedVersion(denoPath(), denoVersion)
  ]);
  const ffmpeg = fileExists(ffmpegPath());
  const ffprobe = fileExists(ffprobePath());
  const ytdlp = fileExists(ytdlpPath());
  return {
    ytdlp: { present: ytdlp, version: ver, path: ytdlpPath() },
    ffmpeg: { present: ffmpeg, version: ffver, path: ffmpegPath() },
    ffprobe: { present: ffprobe, path: ffprobePath() },
    deno: { present: fileExists(denoPath()), version: dver, path: denoPath() }, // optional nsig runtime
    ready: ytdlp && ffmpeg && ffprobe,   // download options unlock only when true (Deno is optional)
    saveDir: resolveSaveDir()
  };
}

// ---- HTTP helpers (redirect-following; GitHub 302s to a CDN host) ----
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CouchTube', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(httpsGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

// Download url -> dest, following redirects; onProgress({ received, total }).
function httpsDownload(url, dest, onProgress, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'CouchTube' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(httpsDownload(res.headers.location, dest, onProgress, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let received = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (d) => { received += d.length; if (onProgress) onProgress({ received, total }); });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

// Extract a zip via .NET ZipFile (memory-light; PS 5.1 ships on Win10).
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const cmd = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null; if (Test-Path -LiteralPath ${q(destDir)}) { Remove-Item -LiteralPath ${q(destDir)} -Recurse -Force }; [System.IO.Compression.ZipFile]::ExtractToDirectory(${q(zipPath)}, ${q(destDir)})`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) { err.message += stderr ? (' | ' + String(stderr).trim()) : ''; reject(err); }
      else resolve();
    });
  });
}

// Find a named file anywhere under dir (BtbN nests exes in <root>/bin/).
function findFile(dir, name) {
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return null;
}

// ---- one-click install / repair ----
// Downloads yt-dlp.exe + a static ffmpeg build + Deno into <Data>/bin. onProgress
// gets an absolute { label, pct } across whichever binaries are being installed, so
// the renderer's row shows one monotonic bar. Resolves with the post-install
// getState(); rejects on the first hard failure.
// which: 'ytdlp' | 'ffmpeg' | 'deno' | 'both' (default = all three).
async function installBinaries(onProgress, which) {
  which = which || 'both';
  binDir();
  const doY = which === 'both' || which === 'ytdlp';
  const doF = which === 'both' || which === 'ffmpeg';
  const doD = which === 'both' || which === 'deno';
  const n = (doY ? 1 : 0) + (doF ? 1 : 0) + (doD ? 1 : 0) || 1;
  let idx = 0;
  // Overall pct = (finished tasks + this task's fraction) / total tasks.
  const emit = (label, frac) => {
    if (!onProgress) return;
    const f = frac == null ? 0.5 : Math.max(0, Math.min(1, frac));
    onProgress({ label, pct: Math.round(((idx + f) / n) * 100) });
  };

  // 1. yt-dlp.exe (small, ~12 MB).
  if (doY) {
    emit('Downloading yt-dlp…', 0);
    await httpsDownload(YTDLP_URL, ytdlpPath(), ({ received, total }) => emit('Downloading yt-dlp…', total ? received / total : null));
    log('yt-dlp installed ->', ytdlpPath());
    idx++;
  }

  // 2. ffmpeg static build (zip, ~80 MB) -> temp, extract, lift out the exes.
  if (doF) {
    const tmpZip = path.join(os.tmpdir(), 'couchtube-ffmpeg.zip');
    const tmpDir = path.join(os.tmpdir(), 'couchtube-ffmpeg');
    emit('Downloading ffmpeg…', 0);
    await httpsDownload(FFMPEG_ZIP_URL, tmpZip, ({ received, total }) => emit('Downloading ffmpeg…', total ? received / total : null));
    emit('Extracting ffmpeg…', 0.92);
    await extractZip(tmpZip, tmpDir);
    const srcFfmpeg = findFile(tmpDir, 'ffmpeg.exe');
    const srcFfprobe = findFile(tmpDir, 'ffprobe.exe');
    if (!srcFfmpeg || !srcFfprobe) throw new Error('ffmpeg.exe / ffprobe.exe not found in the downloaded archive');
    fs.copyFileSync(srcFfmpeg, ffmpegPath());
    fs.copyFileSync(srcFfprobe, ffprobePath());
    log('ffmpeg installed ->', ffmpegPath());
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpZip); } catch {}
    idx++;
  }

  // 3. Deno (zip, ~40 MB) -> temp, extract deno.exe into bin (same folder as
  // yt-dlp.exe, so yt-dlp auto-detects it for nsig).
  if (doD) {
    const tmpZip = path.join(os.tmpdir(), 'couchtube-deno.zip');
    const tmpDir = path.join(os.tmpdir(), 'couchtube-deno');
    emit('Downloading Deno…', 0);
    await httpsDownload(DENO_ZIP_URL, tmpZip, ({ received, total }) => emit('Downloading Deno…', total ? received / total : null));
    emit('Extracting Deno…', 0.92);
    await extractZip(tmpZip, tmpDir);
    const srcDeno = findFile(tmpDir, 'deno.exe');
    if (!srcDeno) throw new Error('deno.exe not found in the downloaded archive');
    fs.copyFileSync(srcDeno, denoPath());
    log('deno installed ->', denoPath());
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpZip); } catch {}
    idx++;
  }

  if (onProgress) onProgress({ label: 'Done', pct: 100 });
  return getState();
}

// ---- update yt-dlp (self-update; ffmpeg rarely needs it) ----
// yt-dlp -U works because we installed our own writable binary. Resolves
// { ok, version, message }.
function updateYtdlp() {
  return new Promise((resolve) => {
    if (!fileExists(ytdlpPath())) return resolve({ ok: false, message: 'yt-dlp is not installed yet' });
    execFile(ytdlpPath(), ['-U'], { windowsHide: true, timeout: 120000 }, async (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (err) { logErr('yt-dlp -U failed:', err.message); return resolve({ ok: false, message: (out || err.message) }); }
      const version = await ytdlpVersion();
      log('yt-dlp -U:', out.split('\n').pop());
      resolve({ ok: true, version, message: out.split('\n').filter(Boolean).pop() || 'Up to date' });
    });
  });
}

// Compare installed yt-dlp version against the latest GitHub release.
// Resolves { current, latest, upToDate }.
async function checkUpdates() {
  const current = await ytdlpVersion();
  let latest = null;
  try { const rel = await httpsGetJson(YTDLP_LATEST_API); latest = (rel && rel.tag_name) ? String(rel.tag_name) : null; }
  catch (e) { logErr('checkUpdates: GitHub API failed:', e.message); }
  return { current, latest, upToDate: !!(current && latest && current === latest) };
}

// ================= Download queue (serial: one at a time) =================
// Items: {id, videoId, url, title, format, status, pct, speed, eta, error, dest, addedAt}
// status: queued | downloading | merging | paused | done | error | canceled
function queuePath() { return path.join(dataDir(), 'download_queue.json'); }
let queue = [];
let active = null;   // item currently downloading
let child = null;    // its child process
let sender = null;   // (channel, payload) => renderer push
let idSeq = 1;

function setSender(fn) { sender = fn; }

// PoToken provider (injected from index.js): async (videoId) -> {poToken,
// visitorData} | null. Used ONLY for downloads that go through yt-dlp's web
// client (dubbed / language-specific tracks), which YouTube gates behind a
// web.gvs PO token. null return -> token-less best-effort download (old
// behaviour). Reuses the app's in-process minter, so a just-played video is
// already cached.
let poTokenProvider = null;
function setPoTokenProvider(fn) { poTokenProvider = fn; }

// SABR payload provider (injected from index.js -> innertube.getSabrForDownload).
// SABR is the PRIMARY downloader for AUDIO (it reuses the playback path, handles
// dubs without a 403, and now embeds metadata/cover/chapters/SponsorBlock). On
// any SABR failure - live / gated / a transient InnerTube break - the item falls
// back to yt-dlp. VIDEO downloads stay on yt-dlp.
let sabrProvider = null;
function setSabrProvider(fn) { sabrProvider = fn; }
// An item is an audio download when its effective Type is audio (new 'type'
// setting; legacy 'audioOnly' boolean still honoured).
function isAudioDownload(item) {
  const s = Object.assign({}, readSettings(), (item && item.opts) || {});
  return s.type ? s.type === 'audio' : !!s.audioOnly;
}
function useSabr(item) { return !!(sabrProvider && fileExists(ffmpegPath()) && isAudioDownload(item)); }

// A download uses the WEB client only for a dubbed / alternate-language audio
// track (a per-language id like 251-1, or a language-filtered selector) - the
// one case where a PO token is needed. Everything else stays on yt-dlp's
// default clients.
function usesWebClient(item) {
  return !!(item && item.format && (/language/.test(item.format) || /\d+-\d+/.test(item.format)));
}
function push() { try { if (sender) sender('dl:queue-update', getQueue()); } catch (e) {} }
function getQueue() {
  return queue.map((it) => ({
    id: it.id, videoId: it.videoId, title: it.title, status: it.status,
    pct: Math.round(it.pct || 0), speed: it.speed || '', eta: it.eta || '',
    error: it.error || '', dest: it.dest || '', format: it.format || ''
  }));
}
function loadQueue() {
  try { queue = JSON.parse(fs.readFileSync(queuePath(), 'utf8')) || []; } catch { queue = []; }
  if (!Array.isArray(queue)) queue = [];
  for (const it of queue) if (typeof it.id === 'number' && it.id >= idSeq) idSeq = it.id + 1;
}
function saveQueue() { try { fs.writeFileSync(queuePath(), JSON.stringify(queue)); } catch (e) { logErr('saveQueue failed:', e.message); } }
function findById(id) { return queue.find((it) => it.id === id); }

// Fire a completion / failure notification per the global notify settings. The
// OS notification (Electron) shows even when the window is backgrounded; the
// renderer decides whether to also toast (toast flag = notifyInApp).
function notify(title, body) {
  const s = readSettings();
  if (s.notifyOs) { try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (e) {} }
  try { if (sender) sender('dl:notify', { toast: !!s.notifyInApp, text: title + (body ? ' - ' + body : '') }); } catch (e) {}
}

// Build yt-dlp args from the global settings (+ an explicit format for the
// advanced popup). ffmpeg is pointed at our own bin dir.
function buildArgs(item, pot) {
  // Per-download overrides (from the advanced popup) win over the global settings.
  const s = Object.assign({}, readSettings(), (item && item.opts) || {});
  const dir = resolveSaveDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const args = ['-P', dir, '-o', s.filenameTemplate || DEFAULTS.filenameTemplate];
  // Effective Type (new 'type' setting; legacy 'audioOnly' boolean still honoured).
  const audioOnly = s.type ? s.type === 'audio' : !!s.audioOnly;
  if (audioOnly) {
    // Audio-only: a chosen audio itag if the advanced menu picked one, else best
    // audio; extract/convert to the chosen audio format either way.
    args.push('-f', item.format || 'bestaudio/best');
    // --audio-quality: '0' = best VBR, else a target bitrate like '192K'.
    args.push('-x', '--audio-format', s.audioContainer || DEFAULTS.audioContainer, '--audio-quality', s.audioBitrate ? s.audioBitrate : '0');
    // Windows File Explorer only renders MP3 cover thumbnails from ID3v2.3;
    // ffmpeg (which yt-dlp drives for extract/thumbnail) defaults to 2.4. Force
    // 2.3 on the ffmpeg postprocessors for mp3 output so the art shows in Explorer.
    if ((s.audioContainer || DEFAULTS.audioContainer) === 'mp3') args.push('--ppa', 'ffmpeg:-id3v2_version 3');
  } else if (item.format) {
    // A specific video format id picked from the quality list.
    args.push('-f', item.format);
  } else {
    const cap = Number(s.qualityCap) || 0;
    args.push('-f', cap > 0 ? `bv*[height<=${cap}]+ba/b[height<=${cap}]/bv*+ba/b` : 'bv*+ba/b');
  }
  if (!audioOnly) {
    if (s.container) args.push('--merge-output-format', s.container);
    if (s.container === 'mp4') args.push('-S', 'vcodec:h264,acodec:m4a');
  }
  if (s.restrictFilenames) args.push('--restrict-filenames');
  if (s.embedThumbnail) args.push('--embed-thumbnail');
  if (s.embedMetadata) args.push('--embed-metadata');
  if (s.embedChapters) args.push('--embed-chapters');
  if (s.subtitles) args.push('--write-subs', '--write-auto-subs', '--embed-subs', '--sub-langs', s.subLangs || 'en');
  if (s.sponsorblock === 'mark') args.push('--sponsorblock-mark', 'all');
  else if (s.sponsorblock === 'remove') args.push('--sponsorblock-remove', 'all');
  // "Skip already downloaded" + "Never overwrite" both key on the ACTUAL FILE in
  // the download folder (yt-dlp --no-overwrites), NOT a persistent .txt archive.
  // The old --download-archive got out of sync with the folder: deleting the file
  // left the id in the archive, so re-downloads were wrongly skipped. File
  // existence is self-correcting (delete the file -> it downloads again) and, since
  // audio vs video produce different filenames, downloading one never blocks the
  // other. Overwrite only when the user explicitly turned BOTH off.
  if (s.skipDownloaded || s.noOverwrite) args.push('--no-overwrites');
  else args.push('--force-overwrites');
  if (s.concurrentFragments) args.push('--concurrent-fragments', String(s.concurrentFragments));
  // A dubbed / alternate-language audio track (a language-filtered selector, or a
  // yt-dlp per-language id like 251-1) needs a web-family client. mweb exposes the
  // per-language tracks AND yields DOWNLOADABLE https (DASH) formats WHEN a GVS PO
  // token is supplied - yt-dlp's own recommended setup (`-F` confirmed: without a
  // token mweb's https formats are skipped; plain web is SABR-only and web_safari
  // returned nothing for these videos). So pin mweb + the mweb.gvs token. Deno
  // keeps the signature step fast.
  if (usesWebClient(item)) {
    let ea = 'youtube:player_client=mweb';
    if (pot && pot.poToken) {
      ea += ';po_token=mweb.gvs+' + pot.poToken;
      // The GVS pot is bound to OUR visitor_data, so yt-dlp's GVS request must use
      // the SAME visitor. Without player_skip=configs, yt-dlp downloads the mweb
      // client config which sets ITS OWN visitor_data -> the stream URL binds to a
      // different visitor and 403s our pot. player_skip=webpage,configs forces
      // yt-dlp to use the visitor_data we pass (yt-dlp's documented pattern).
      if (pot.visitorData) ea += ';player_skip=webpage,configs;visitor_data=' + pot.visitorData;
    }
    args.push('--extractor-args', ea);
  }
  args.push('--ffmpeg-location', binDir());
  args.push('--no-playlist', '--newline');
  args.push('--progress-template', 'download:DLPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s');
  args.push(item.url || ('https://www.youtube.com/watch?v=' + item.videoId));
  return args;
}

// Best-effort free-space check (>300 MB). No-ops (returns true) if statfs isn't
// available in this runtime, so it can never wrongly block a download.
function enoughSpace(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return true;
    const st = fs.statfsSync(dir);
    return (st.bavail * st.bsize) > 300 * 1024 * 1024;
  } catch (e) { return true; }
}

function processNext() {
  if (active) return;
  const next = queue.find((it) => it.status === 'queued');
  if (next) startDownload(next);
}

async function startDownload(item) {
  if (!fileExists(ytdlpPath())) { item.status = 'error'; item.error = 'yt-dlp not installed'; saveQueue(); push(); return; }
  if (!enoughSpace(resolveSaveDir())) { item.status = 'error'; item.error = 'Not enough disk space'; saveQueue(); push(); return processNext(); }
  active = item;   // set BEFORE any await so processNext()'s guard holds
  item.status = 'downloading'; item.pct = 0; item.error = '';
  item._ytRetries = 0; // fresh scheduling (incl. a manual retry) resets the auto-retry budget
  saveQueue(); push();
  // Audio -> SABR first (falls back to yt-dlp on failure); video -> yt-dlp.
  if (useSabr(item)) return runSabrDownload(item);
  return startYtdlpDownload(item);
}

// The yt-dlp download path (video, and the audio fallback when SABR can't do it).
// Assumes `active === item` and the item is already marked downloading.
function startYtdlpDownload(item) {
  active = item; child = null; item._ac = null;
  item.status = 'downloading'; item.pct = 0; item.speed = ''; item.eta = ''; item.error = '';
  saveQueue(); push();
  // For a web-client (dubbed) download, mint the content-bound web GVS PO token
  // so YouTube doesn't 403 the stream. Best-effort: on failure we still try the
  // download token-less (may fetch the wrong language, as before).
  return (async () => {
  let pot = null;
  if (usesWebClient(item) && poTokenProvider) {
    try { pot = await poTokenProvider(item.videoId); }
    catch (e) { logErr('PoToken provider failed for', item.videoId, '-', e.message); }
    if (item.status === 'canceled' || item.status === 'paused') { active = null; saveQueue(); push(); return processNext(); }
    log('mweb dub download', item.videoId, 'pot=' + (pot && pot.poToken ? 'yes(visitor-bound)' : 'no'));
  }
  let args;
  try { args = buildArgs(item, pot); }
  catch (e) { item.status = 'error'; item.error = e.message; active = null; saveQueue(); push(); return processNext(); }
  child = spawn(ytdlpPath(), args, { windowsHide: true });
  let buf = '', errText = '';
  const onLine = (raw) => {
    const line = raw.trim(); if (!line) return;
    if (line.indexOf('DLPROG ') === 0) {
      const p = line.slice(7).split('|');
      const pct = parseFloat(String(p[0]).replace('%', ''));
      if (!isNaN(pct)) item.pct = pct;
      item.speed = (p[1] || '').trim();
      item.eta = (p[2] || '').trim();
      if (item.status !== 'merging') item.status = 'downloading';
      push();
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer|Metadata|EmbedSubtitle|ThumbnailsConvertor|VideoConvertor|SponsorBlock)\]/.test(line) || /Merging formats/.test(line)) {
      item.status = 'merging'; push();
    } else if (line.indexOf('[download] Destination:') === 0) {
      item.dest = line.slice('[download] Destination:'.length).trim();
    } else if (/has already been recorded in the archive/i.test(line) || /has already been downloaded/i.test(line)) {
      item._skipped = true; // yt-dlp skipped it (the file already exists in the folder)
    }
  };
  child.stdout.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
  child.stderr.on('data', (d) => { errText += d.toString(); });
  child.on('error', (e) => finishActive(false, e.message));
  child.on('close', (code) => {
    if (!active) { child = null; return processNext(); }
    if (item.status === 'canceled' || item.status === 'paused') {
      if (item.status === 'canceled') cleanupPart(item); // process has exited -> files unlocked
      child = null; active = null; saveQueue(); push(); return processNext();
    }
    if (code === 0) return finishActive(true);
    const err = (errText.trim().split('\n').filter(Boolean).pop() || ('yt-dlp exited ' + code));
    // YouTube often 403s a stream URL transiently (expired/throttled); a fresh
    // yt-dlp run re-extracts a new URL and usually succeeds - which is exactly
    // what a manual "retry" did. Auto-retry a few times on such transient errors
    // before giving up, so one flaky video in a batch doesn't need hand-holding.
    if (isTransientDlError(err) && (item._ytRetries || 0) < MAX_YTDLP_RETRIES) {
      item._ytRetries = (item._ytRetries || 0) + 1;
      logErr('transient download error for', item.title, '- auto-retry', item._ytRetries + '/' + MAX_YTDLP_RETRIES, '(' + err + ')');
      child = null; item.pct = 0; item.speed = ''; item.eta = ''; push();
      setTimeout(() => {
        if (active === item && item.status !== 'canceled' && item.status !== 'paused') startYtdlpDownload(item);
        else if (active === item) { active = null; saveQueue(); push(); processNext(); }
      }, 1500);
      return;
    }
    finishActive(false, err);
  });
  })();
}

// Errors worth an automatic retry (a fresh extraction usually clears them):
// expired/throttled stream URLs (403), 5xx, timeouts, reset connections.
function isTransientDlError(err) {
  return /\b403\b|forbidden|unable to download video data|HTTP Error 5\d\d|read timed out|timed out|temporarily unavailable|connection (reset|aborted|closed)|EOF|incomplete/i.test(String(err || ''));
}
const MAX_YTDLP_RETRIES = 3;

function finishActive(ok, err) {
  const item = active;
  child = null; active = null;
  if (!item) return processNext();
  if (ok && item._skipped) { item.status = 'skipped'; item.pct = 100; item.speed = ''; item.eta = ''; logger && logger.info('[downloads] already downloaded:', item.title); notify('Already downloaded', item.title); }
  else if (ok) { item.status = 'done'; item.pct = 100; item.speed = ''; item.eta = ''; logger && logger.info('[downloads] done:', item.title); notify('Download complete', item.title); }
  else { item.status = 'error'; item.error = err || 'failed'; logErr('download failed:', item.title, '-', err); notify('Download failed', item.title); }
  saveQueue(); push(); processNext();
}

// ---- in-app SABR audio download (dubbed / alternate-language tracks) ----

// Derive the audio selection for sabrdl from the queue item. Preferred source is
// an explicit opts.audioLang (Phase 3); otherwise parse the yt-dlp-style format
// string (`ba[language^=xx]/ba` for a per-language pick, or a bare/`itag-idx` id).
function sabrSelect(item) {
  const o = (item && item.opts) || {};
  // Explicit pick from the format list (Phase 3): itag (+ track id) targets the
  // exact bitrate/language; audioLang alone targets that language's best.
  if (o.audioLang || o.audioItag) return { lang: o.audioLang ? String(o.audioLang).split('-')[0] : '', itag: o.audioItag || 0, audioTrackId: o.audioTrackId || '', drc: !!o.audioDrc, vb: !!o.audioVb };
  const fmt = String((item && item.format) || '');
  const ml = fmt.match(/language\^?=([A-Za-z-]+)/);
  if (ml) return { lang: ml[1].split('-')[0] };
  const mi = fmt.match(/^(\d+)-\d+/);          // yt-dlp per-language id e.g. 251-1
  if (mi) return { itag: parseInt(mi[1], 10) };
  const it = fmt.match(/^(\d+)/);
  if (it) return { itag: parseInt(it[1], 10) };
  return {};
}

// Sanitize one dynamic filename part. Windows-illegal chars always stripped;
// restrictFilenames additionally forces ASCII-safe (mirrors yt-dlp --restrict).
function sanitizePart(s, restrict) {
  s = String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '');
  if (restrict) s = s.replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '_');
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  return s || 'audio';
}

// Render the (subset of the) yt-dlp filename template we support for SABR audio
// files: %(title)s, %(id)s, %(uploader)s / %(channel)s, and %(ext)s.
function renderFilename(tpl, fields, restrict) {
  const v = (k) => sanitizePart(fields[k], restrict);
  return String(tpl || DEFAULTS.filenameTemplate)
    .replace(/%\(title\)s/g, v('title'))
    .replace(/%\(id\)s/g, v('id'))
    .replace(/%\(uploader\)s/g, v('author'))
    .replace(/%\(channel\)s/g, v('author'))
    .replace(/%\(ext\)s/g, String(fields.ext || 'm4a'))
    .replace(/%\([^)]*\)s/g, '')       // drop any template token we don't support
    .replace(/\s{2,}/g, ' ').trim();
}

// ffmpeg audio codec args. Stream-copy when the source codec already fits the
// container (lossless, fast) UNLESS forceEncode is set (SponsorBlock "remove"
// applies a filter, which is incompatible with -c copy); otherwise transcode at
// the requested bitrate (mirrors yt-dlp's ExtractAudio).
function audioEncodeArgs(container, srcMime, bitrate, forceEncode) {
  const src = /mp4a|aac/i.test(srcMime) ? 'aac' : /opus/i.test(srcMime) ? 'opus' : /vorbis/i.test(srcMime) ? 'vorbis' : '';
  const copyOk = !forceEncode && (
    ((container === 'm4a' || container === 'aac') && src === 'aac') ||
    ((container === 'opus' || container === 'webm' || container === 'ogg') && src === 'opus') ||
    (container === 'webm' && src === 'vorbis'));
  if (copyOk) return ['-c:a', 'copy'];
  const enc = ({ mp3: 'libmp3lame', m4a: 'aac', aac: 'aac', opus: 'libopus', flac: 'flac', wav: 'pcm_s16le', vorbis: 'libvorbis' })[container] || 'aac';
  const a = ['-c:a', enc];
  if (bitrate && enc !== 'flac' && enc !== 'pcm_s16le') a.push('-b:a', String(bitrate).replace(/k$/i, '') + 'k');
  return a;
}

// Cover art embeds cleanly into these containers via an attached_pic video
// stream. opus/ogg/wav/webm cover art is unreliable in ffmpeg, so we skip it
// there (audio still downloads; just no embedded thumbnail).
function containerSupportsCover(c) { return c === 'm4a' || c === 'aac' || c === 'mp3' || c === 'flac' || c === 'mp4' || c === 'mov'; }

const SB_LABELS = { sponsor: 'Sponsor', selfpromo: 'Self Promotion', interaction: 'Interaction Reminder', intro: 'Intermission/Intro', outro: 'Endcards/Credits', preview: 'Preview/Recap', music_offtopic: 'Non-Music', filler: 'Filler' };

// Build an ffmetadata file: global tags (title/artist/album/comment) + chapters
// (the video's YouTube chapters, and, when SponsorBlock is in "mark" mode, its
// segments as extra chapters). Returns the file path, or '' if nothing to write.
function buildFfmetaFile(tmpDir, id, payload, s, segments) {
  const wantMeta = !!s.embedMetadata;
  const wantChapters = !!s.embedChapters;
  const wantSbMark = s.sponsorblock === 'mark' && segments && segments.length;
  if (!wantMeta && !wantChapters && !wantSbMark) return '';

  const esc = (v) => String(v == null ? '' : v).replace(/([=;#\\\n])/g, '\\$1');
  let out = ';FFMETADATA1\n';
  if (wantMeta) {
    if (payload.title) out += 'title=' + esc(payload.title) + '\n';
    if (payload.author) { out += 'artist=' + esc(payload.author) + '\n'; out += 'album_artist=' + esc(payload.author) + '\n'; }
    if (payload.description) out += 'comment=' + esc(payload.description) + '\n';
  }

  // Assemble chapters as { startMs, endMs, title }.
  const durMs = payload.durationMs || 0;
  const chaps = [];
  if (wantChapters && Array.isArray(payload.chapters)) {
    const c = payload.chapters;
    for (let i = 0; i < c.length; i++) {
      const startMs = Math.max(0, Math.round((c[i].start || 0) * 1000));
      const endMs = i + 1 < c.length ? Math.round((c[i + 1].start || 0) * 1000) : (durMs || startMs + 1000);
      if (endMs > startMs) chaps.push({ startMs, endMs, title: c[i].title || ('Chapter ' + (i + 1)) });
    }
  }
  if (wantSbMark) {
    for (const seg of segments) {
      const startMs = Math.max(0, Math.round((seg.start || 0) * 1000));
      const endMs = Math.round((seg.end || 0) * 1000);
      if (endMs > startMs) chaps.push({ startMs, endMs, title: '[SponsorBlock] ' + (SB_LABELS[seg.category] || seg.category || 'Segment') });
    }
  }
  chaps.sort((a, b) => a.startMs - b.startMs);
  for (const ch of chaps) {
    out += '[CHAPTER]\nTIMEBASE=1/1000\nSTART=' + ch.startMs + '\nEND=' + ch.endMs + '\ntitle=' + esc(ch.title) + '\n';
  }

  const p = path.join(tmpDir, 'couchtube-sabr-meta-' + id + '.txt');
  try { fs.writeFileSync(p, out, 'utf8'); return p; } catch (e) { logErr('ffmeta write failed:', e.message); return ''; }
}

// Keep-filter for SponsorBlock "remove": select everything NOT inside a removed
// segment, then reset timestamps so the output is gapless.
function sbRemoveFilter(segments) {
  const nots = segments.filter((g) => g.end > g.start).map((g) => 'not(between(t,' + g.start + ',' + g.end + '))');
  if (!nots.length) return '';
  return "aselect='" + nots.join('*') + "',asetpts=N/SR/TB";
}

// Post-process the raw SABR audio into the final file: SponsorBlock remove
// (re-encode) + container/codec + metadata + chapters + cover art. All steps are
// optional per the user's toggles; a failing extra never aborts the file, but a
// hard ffmpeg failure rejects.
async function postProcessSabrAudio(tmpPath, finalPath, container, s, payload, videoId, srcMime) {
  const tmpDir = os.tmpdir();
  let segments = [];
  if (sponsorblock && s.sponsorblock && s.sponsorblock !== 'off') {
    try { segments = await sponsorblock.getSegments(videoId, { force: true }); }
    catch (e) { logErr('SB lookup failed for', videoId, '-', e.message); }
  }
  const sbRemove = s.sponsorblock === 'remove' && segments.length;

  // Cover art (best-effort download).
  let thumbPath = '';
  if (s.embedThumbnail && payload.thumbnailUrl && containerSupportsCover(container)) {
    const tp = path.join(tmpDir, 'couchtube-sabr-thumb-' + Date.now() + '.jpg');
    try { await httpsDownload(payload.thumbnailUrl, tp); thumbPath = tp; }
    catch (e) { logErr('thumbnail download failed:', e.message); }
  }

  const ffmetaPath = buildFfmetaFile(tmpDir, videoId, payload, s, segments);

  const args = ['-y', '-i', tmpPath];
  let idx = 1, ffmetaIdx = -1, thumbIdx = -1;
  if (ffmetaPath) { args.push('-i', ffmetaPath); ffmetaIdx = idx++; }
  if (thumbPath) { args.push('-i', thumbPath); thumbIdx = idx++; }

  if (sbRemove) { const f = sbRemoveFilter(segments); if (f) args.push('-af', f); }
  args.push('-map', '0:a');
  args.push(...audioEncodeArgs(container, srcMime, s.audioBitrate, sbRemove));
  if (ffmetaIdx >= 0) args.push('-map_metadata', String(ffmetaIdx), '-map_chapters', String(ffmetaIdx));
  else args.push('-map_chapters', '-1');
  if (thumbIdx >= 0) {
    args.push('-map', String(thumbIdx), '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
    // Windows File Explorer prefers the embedded picture tagged as the front
    // cover; without this it may ignore the art for the thumbnail.
    if (container === 'mp3') args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  }
  // Windows Explorer only renders MP3 cover thumbnails from ID3v2.3; ffmpeg
  // writes ID3v2.4 by default, which players read but Explorer ignores.
  if (container === 'mp3') args.push('-id3v2_version', '3');
  args.push(finalPath);

  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath(), args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, so, se) => {
        if (err) return reject(new Error((String(se || '').trim().split('\n').filter(Boolean).pop()) || err.message));
        resolve();
      });
    });
  } finally {
    if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch (e) {} }
    if (ffmetaPath) { try { fs.unlinkSync(ffmetaPath); } catch (e) {} }
  }
  log('SABR post-process', videoId, 'sb=' + (s.sponsorblock || 'off') + (segments.length ? '(' + segments.length + ' seg)' : '') + ' chapters=' + (payload.chapters ? payload.chapters.length : 0) + ' thumb=' + !!thumbPath);
}

// SABR couldn't do it (live / gated / transient InnerTube break) -> yt-dlp.
function sabrFallback(item, reason) {
  logErr('SABR failed for', item.videoId, '-', reason, '- falling back to yt-dlp');
  item._ac = null;
  return startYtdlpDownload(item);
}

async function runSabrDownload(item) {
  if (!fileExists(ffmpegPath())) return startYtdlpDownload(item);
  const ac = new AbortController();
  item._ac = ac;
  const select = sabrSelect(item);
  log('SABR download', item.videoId, 'select=' + JSON.stringify(select));

  let payload;
  try { payload = await sabrProvider(item.videoId); }
  catch (e) { return sabrFallback(item, 'payload error: ' + e.message); }
  if (item.status === 'canceled' || item.status === 'paused') { item._ac = null; active = null; saveQueue(); push(); return processNext(); }
  if (!payload || !payload.ok) return sabrFallback(item, 'payload: ' + ((payload && (payload.message || payload.reason)) || 'error'));

  const s = Object.assign({}, readSettings(), (item.opts) || {});
  const container = s.audioContainer || DEFAULTS.audioContainer;
  const dir = resolveSaveDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const finalName = renderFilename(s.filenameTemplate, { title: payload.title, id: item.videoId, author: payload.author, ext: container }, s.restrictFilenames);
  const finalPath = path.join(dir, finalName);

  // Skip if the file already exists (same rule as the yt-dlp path).
  if ((s.skipDownloaded || s.noOverwrite) && fileExists(finalPath)) { item.dest = finalPath; item._skipped = true; item._ac = null; return finishActive(true); }

  // Stream the audio, retrying once on a STALL with a fresh payload before
  // giving up to yt-dlp. A stalled SABR stream (frozen at, e.g., 26% with no
  // error) is exactly what pausing + resuming used to fix by hand; this does it
  // automatically. Non-stall failures fall straight through to yt-dlp.
  const MAX_SABR_TRIES = 2;
  let srcMime = '';
  let tmpPath = '';
  let streamed = false;
  for (let attempt = 1; attempt <= MAX_SABR_TRIES && !streamed; attempt++) {
    const chosen = sabrdl.pickAudioFormat(payload.sabrFormats, select);
    srcMime = (chosen && chosen.mimeType) || '';
    const tmpExt = /webm|opus/i.test(srcMime) ? 'webm' : 'm4a';
    tmpPath = path.join(os.tmpdir(), 'couchtube-sabr-' + item.id + '.' + tmpExt);
    try {
      await sabrdl.streamAudioToFile({
        payload, select, tmpPath, signal: ac.signal,
        onProgress: ({ pct }) => { if (item.status === 'downloading') { item.pct = pct; item.speed = ''; item.eta = ''; push(); } },
        log: (m) => log(m), logErr: (m) => logErr(m)
      });
      streamed = true;
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      if (item.status === 'canceled' || item.status === 'paused') { item._ac = null; active = null; saveQueue(); push(); return processNext(); }
      const stalled = /stalled/i.test(e.message || '');
      if (stalled && attempt < MAX_SABR_TRIES) {
        logErr('SABR download stalled for', item.videoId, '- retrying with a fresh payload (attempt ' + (attempt + 1) + '/' + MAX_SABR_TRIES + ')');
        item.pct = 0; item.speed = ''; item.eta = ''; push();
        try { payload = await sabrProvider(item.videoId); } catch (e2) { payload = null; }
        if (!payload || !payload.ok) return sabrFallback(item, 'stalled; payload refetch failed');
        if (item.status === 'canceled' || item.status === 'paused') { item._ac = null; active = null; saveQueue(); push(); return processNext(); }
        continue;
      }
      return sabrFallback(item, e.message || 'download failed');
    }
  }
  if (item.status === 'canceled' || item.status === 'paused') { try { fs.unlinkSync(tmpPath); } catch (_) {} item._ac = null; active = null; saveQueue(); push(); return processNext(); }

  item.status = 'merging'; push();
  try { await postProcessSabrAudio(tmpPath, finalPath, container, s, payload, item.videoId, srcMime); }
  catch (e) { try { fs.unlinkSync(tmpPath); } catch (_) {} return finishActive(false, 'ffmpeg remux failed: ' + e.message); }
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  item.dest = finalPath; item._ac = null;
  log('SABR download done', item.videoId, '->', finalPath);
  finishActive(true);
}

// Best-effort: remove leftover partial + intermediate files after a cancel. yt-dlp
// leaves behind not just <name>.part / .ytdl but also fragment files (.part-FragN),
// per-stream downloads (<name>.f137.mp4 / .f251.webm) before the merge, and .temp
// files. We scope removal to the canceled video's id so a PREVIOUSLY COMPLETED file
// for the same video (e.g. its audio) is never deleted - completed files have no
// .part / .fNNN marker, so they don't match.
function cleanupPart(item) {
  try {
    const dir = resolveSaveDir();
    const vid = item && item.videoId;
    const isPartial = (f) => /\.part$/i.test(f) || /\.ytdl$/i.test(f) || /\.part-Frag/i.test(f) || /\.temp$/i.test(f) || /\.f\d+\.[a-z0-9]+$/i.test(f);
    for (const f of fs.readdirSync(dir)) {
      if (!isPartial(f)) continue;
      if (vid && !f.includes(vid)) continue; // only this download's leftovers
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
  } catch (e) {}
}

// ---- public queue API ----
function enqueue(info) {
  info = info || {};
  const item = { id: idSeq++, videoId: info.videoId || '', url: info.url || '', title: info.title || info.videoId || 'Video', format: info.format || '', opts: (info.opts && typeof info.opts === 'object') ? info.opts : null, status: 'queued', pct: 0, addedAt: Date.now() };
  queue.push(item); saveQueue(); push(); processNext();
  return { ok: true, id: item.id };
}
function cancel(id) {
  const it = findById(id); if (!it) return { ok: false };
  // yt-dlp: cleanup runs in the child 'close' handler; SABR: the stream loop sees
  // the status + aborts, then cleans its temp file.
  if (it === active) { it.status = 'canceled'; if (child) { try { child.kill(); } catch (e) {} } if (it._ac) { try { it._ac.abort(); } catch (e) {} } }
  queue = queue.filter((x) => x.id !== id);
  saveQueue(); push(); return { ok: true };
}
function pause(id) {
  const it = findById(id); if (!it) return { ok: false };
  if (it === active) { it.status = 'paused'; if (child) { try { child.kill(); } catch (e) {} } if (it._ac) { try { it._ac.abort(); } catch (e) {} } }
  else if (it.status === 'queued') it.status = 'paused';
  saveQueue(); push(); return { ok: true };
}
function resume(id) {
  const it = findById(id); if (!it || (it.status !== 'paused' && it.status !== 'error')) return { ok: false };
  it.status = 'queued'; it.error = ''; saveQueue(); push(); processNext(); return { ok: true };
}
function remove(id) {
  const it = findById(id); if (!it) return { ok: false };
  if (it === active) return cancel(id);
  queue = queue.filter((x) => x.id !== id); saveQueue(); push(); return { ok: true };
}
function clearFinished() {
  queue = queue.filter((it) => ['queued', 'downloading', 'merging', 'paused'].includes(it.status));
  saveQueue(); push(); return { ok: true };
}

// On boot: anything left mid-download reverts to 'queued' (yt-dlp continues from
// the .part by default); paused/done/error keep their state. Then kick the queue.
function resumeIncomplete() {
  loadQueue();
  for (const it of queue) if (it.status === 'downloading' || it.status === 'merging') it.status = 'queued';
  saveQueue();
  processNext();
}

// Advanced popup: list the video's real formats via yt-dlp -J. Lists ALL video
// renditions (each height + codec) and ALL audio-only tracks (incl. dubbed /
// alternate-language tracks, via the WEB client), with file sizes + per-language
// format ids. Used for multi-language videos + as a fallback for the innertube list.
// In-memory cache so an in-player prefetch (fired when a video starts) makes the
// advanced popup's "specific formats" list instant. Keyed by videoId, 5 min TTL.
const formatCache = new Map();
const FORMAT_TTL = 5 * 60 * 1000;
function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return (mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)) + ' MB';
}
function vcodecName(v) { v = String(v || '').split('.')[0]; return ({ avc1: 'H.264', avc3: 'H.264', vp9: 'VP9', vp09: 'VP9', av01: 'AV1', hev1: 'HEVC', hvc1: 'HEVC' })[v] || v; }
function acodecName(a) { a = String(a || '').split('.')[0]; return ({ mp4a: 'AAC', opus: 'Opus', vorbis: 'Vorbis', ec3: 'E-AC3', ac3: 'AC3', dtse: 'DTS' })[a] || a; }
let _langNames = null;
function langName(code) { code = String(code || '').split('-')[0]; if (!code) return ''; try { if (!_langNames) _langNames = new Intl.DisplayNames(['en'], { type: 'language' }); return _langNames.of(code) || code; } catch (e) { return code; } }
async function listFormats(videoId, url, opts) {
  opts = opts || {};
  if (!fileExists(ytdlpPath())) return { ok: false, error: 'yt-dlp not installed' };
  // Cache is keyed by web mode too: the web list (per-language dubs + tiers) is a
  // different result set than the default list, so they must not share an entry.
  const cacheKey = (videoId || '') + (opts.web ? ':web' : '');
  const cached = videoId && formatCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < FORMAT_TTL) return cached.result;
  const target = url || ('https://www.youtube.com/watch?v=' + videoId);
  // Attach the content-bound web GVS PO token to a web extractor-args string when
  // we can mint one (cached from playback, so a played video pays nothing extra).
  const withPot = async (base) => {
    if (!poTokenProvider || !videoId) return base;
    try {
      const pot = await poTokenProvider(videoId);
      if (pot && pot.poToken) {
        base += ';po_token=web.gvs+' + pot.poToken;
        if (pot.visitorData) base += ';visitor_data=' + pot.visitorData;
      }
    } catch (e) { logErr('listFormats pot mint failed:', e.message); }
    return base;
  };
  // Client selection. opts.web (multi-language videos): FORCE the web client - the
  // only one that exposes per-language dubs, each as its own format id (e.g. 251-3)
  // so we can target language AND tier. Default: Deno -> yt-dlp default clients
  // (fast nsig); no Deno -> android,ios,web (pre-deciphered URLs + web sees dubs).
  let clientArgs;
  if (opts.web) {
    clientArgs = ['--extractor-args', await withPot('youtube:player_client=web')];
  } else if (fileExists(denoPath())) {
    clientArgs = [];
  } else {
    clientArgs = ['--extractor-args', await withPot('youtube:player_client=android,ios,web')];
  }
  return new Promise((resolve) => {
    execFile(ytdlpPath(), ['-J', '--no-warnings', '--no-playlist', ...clientArgs, target], { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) { logErr('listFormats failed:', err.message); return resolve({ ok: false, error: 'Could not read formats' }); }
      let info; try { info = JSON.parse(stdout); } catch { return resolve({ ok: false, error: 'Bad format data' }); }
      const fmts = Array.isArray(info.formats) ? info.formats : [];
      const vids = [], auds = [];
      for (const f of fmts) {
        const hasV = f.vcodec && f.vcodec !== 'none';
        const hasA = f.acodec && f.acodec !== 'none';
        const sizeTxt = humanSize(f.filesize || f.filesize_approx || 0);
        if (hasV && f.height) {
          const fpsTxt = (f.fps && f.fps > 30) ? String(Math.round(f.fps)) : '';
          vids.push({
            _h: f.height, _tbr: f.tbr || f.vbr || 0, _prog: hasA ? 1 : 0, _kind: 'video', _id: f.format_id,
            format: hasA ? (f.format_id + '/best') : (f.format_id + '+bestaudio/best'),
            label: f.height + 'p' + fpsTxt + ' · ' + (f.ext || '') + ' · ' + vcodecName(f.vcodec)
              + (hasA ? ' · with audio' : '') + (sizeTxt ? ' · ' + sizeTxt : '')
          });
        } else if (hasA && !hasV) {
          const abr = f.abr || f.tbr || 0;
          const sr = f.asr ? Math.round(f.asr / 1000) + ' kHz' : '';
          const ch = f.audio_channels === 1 ? 'mono' : f.audio_channels === 2 ? 'stereo' : (f.audio_channels ? f.audio_channels + 'ch' : '');
          const lang = (f.language && f.language !== 'und') ? langName(f.language) : '';
          const tierM = (f.format_note || '').match(/ultralow|low|medium|high/i);
          const tier = tierM ? tierM[0].toLowerCase() : '';
          const isDrc = /drc/i.test((f.format_id || '') + ' ' + (f.format_note || ''));
          const isOrig = /original/i.test(f.format_note || '');
          // Lead with the language (so dubs are obvious); the exact per-language
          // format id (e.g. 251-1) is what downloads the right track.
          const parts = [];
          if (lang) parts.push(lang + (isOrig ? ' (original)' : ''));
          parts.push(tier ? acodecName(f.acodec) + ' ' + tier : acodecName(f.acodec));
          if (f.ext) parts.push(f.ext);
          if (abr) parts.push(Math.round(abr) + 'k');
          if (sr) parts.push(sr);
          if (ch) parts.push(ch);
          if (isDrc) parts.push('DRC');
          if (sizeTxt) parts.push(sizeTxt);
          // _lang groups rows by language (original first, then A-Z, unlabeled last)
          // so a multi-language video reads as language blocks, tiers within each.
          const langKey = lang ? (isOrig ? '0' + lang : '1' + lang) : '2';
          auds.push({ _abr: abr, _lang: langKey, _kind: 'audio', _id: f.format_id, format: f.format_id + '/bestaudio', label: parts.filter(Boolean).join(' · ') });
        }
      }
      vids.sort((a, b) => b._h - a._h || b._prog - a._prog || b._tbr - a._tbr);
      // Group audio by language, then highest bitrate (tier) first within a language.
      auds.sort((a, b) => (a._lang < b._lang ? -1 : a._lang > b._lang ? 1 : 0) || b._abr - a._abr);
      const items = [];
      const seen = new Set();
      for (const v of vids.concat(auds)) {
        let label = v.label;
        if (seen.has(label)) label = label + ' · #' + (v._id || ''); // never hide a real stream
        if (seen.has(label)) continue;
        seen.add(label);
        items.push({ format: v.format, label, kind: v._kind });
      }
      const result = { ok: true, title: info.title || videoId, formats: items };
      if (videoId) formatCache.set(cacheKey, { ts: Date.now(), result });
      resolve(result);
    });
  });
}

// Fire-and-forget: warm the format cache for a video (called when playback starts
// so the advanced popup's specific-formats list opens instantly). No-ops if the
// binary is missing or a fresh entry already exists.
function prefetchFormats(videoId, url) {
  if (!videoId || !fileExists(ytdlpPath())) return;
  const cached = formatCache.get(videoId);
  if (cached && (Date.now() - cached.ts) < FORMAT_TTL) return;
  listFormats(videoId, url).catch(() => {});
}

module.exports = {
  // paths + settings
  binDir, ytdlpPath, ffmpegPath, ffprobePath, resolveSaveDir,
  DEFAULTS, readSettings, writeSettings,
  // binary lifecycle
  getState, readyNow, installBinaries, updateYtdlp, checkUpdates,
  // download queue
  setSender, setPoTokenProvider, setSabrProvider, getQueue, enqueue, cancel, pause, resume, remove, clearFinished,
  resumeIncomplete, listFormats, prefetchFormats
};
